"""
india_chapter_updater.py — Downloads and re-parses stale India tariff chapters.

Uses the CBIC base64-JSON PDF download pattern. Only processes chapters
flagged as STALE in cbic_chapter_sync.

Usage:
    export $(grep -v '^#' .env | xargs)
    python3 -m scripts.india_chapter_updater                  # update all stale chapters
    python3 -m scripts.india_chapter_updater --chapters 1 28  # force specific chapters
    python3 -m scripts.india_chapter_updater --dry-run        # check only, no DB write
"""

import argparse
import base64
import hashlib
import logging
import os
import sys
import tempfile
import time
from datetime import datetime, timezone

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger("india_updater")

CBIC_BASE = "https://www.cbic.gov.in/content/pdf"


class ChapterUpdater:
    """Downloads updated chapter PDFs from CBIC and re-parses into DB."""

    def __init__(self, supabase_url: str, supabase_key: str):
        self.url = supabase_url.rstrip("/")
        self.key = supabase_key
        self.headers = {
            "apikey": self.key, "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        }
        self.session = requests.Session()

    def get_stale_chapters(self) -> list[dict]:
        """Get chapters marked as STALE in cbic_chapter_sync."""
        resp = requests.get(
            f"{self.url}/rest/v1/cbic_chapter_sync?syncstatus=eq.STALE&countrycode=eq.IN&select=*&order=chapternum",
            headers={**self.headers, "Prefer": ""},
            timeout=15,
        )
        return resp.json()

    def download_cbic_pdf(self, filepath: str) -> bytes | None:
        """Download PDF from CBIC using the base64-JSON pattern."""
        url = f"{CBIC_BASE}/{filepath}"
        try:
            resp = self.session.get(url, timeout=60)
            if resp.status_code != 200:
                logger.error("Download failed for %s: HTTP %d", filepath, resp.status_code)
                return None

            # CBIC returns JSON with base64-encoded PDF in "data" field
            try:
                json_data = resp.json()
                b64_data = json_data.get("data")
                if b64_data:
                    pdf_bytes = base64.b64decode(b64_data)
                    if pdf_bytes[:5] == b"%PDF-":
                        return pdf_bytes
                    else:
                        logger.error("Decoded data doesn't start with %%PDF- for %s", filepath)
                        return None
            except (ValueError, KeyError):
                # Maybe it's a direct PDF (some URLs serve binary)
                if resp.content[:5] == b"%PDF-":
                    return resp.content
                logger.error("Response is neither JSON nor PDF for %s", filepath)
                return None

        except Exception as e:
            logger.error("Download error for %s: %s", filepath, e)
            return None

    def update_chapter(self, chapter: dict, dry_run: bool = False) -> dict:
        """Download, parse, and upload a single chapter."""
        ch_num = chapter["chapternum"]
        filepath = chapter.get("filepath")

        if not filepath:
            return {"chapter": ch_num, "status": "error", "error": "No filepath in sync table"}

        # Mark as syncing
        if not dry_run:
            self._update_sync_status(ch_num, "SYNCING")

        # Download PDF
        logger.info("Chapter %d: downloading from CBIC...", ch_num)
        pdf_bytes = self.download_cbic_pdf(filepath)
        if not pdf_bytes:
            if not dry_run:
                self._update_sync_status(ch_num, "ERROR", "Download failed")
            return {"chapter": ch_num, "status": "error", "error": "Download failed"}

        pdf_hash = hashlib.sha256(pdf_bytes).hexdigest()

        # Check if content actually changed (hash comparison)
        if chapter.get("synchash") == pdf_hash:
            logger.info("Chapter %d: content unchanged (same hash), skipping parse", ch_num)
            if not dry_run:
                self._update_sync_status(ch_num, "CURRENT")
            return {"chapter": ch_num, "status": "unchanged", "hash": pdf_hash}

        # Save to temp file and parse
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes)
            tmp_path = tmp.name

        try:
            from tariff_parser.parsers.in_parser import INParser
            parser = INParser()
            commodities = parser.parse_chapter_pdf(tmp_path)
            logger.info("Chapter %d: parsed %d commodities", ch_num, len(commodities))

            if dry_run:
                diff = self._compute_diff(ch_num, commodities)
                return {"chapter": ch_num, "status": "dry_run", "commodities": len(commodities),
                        "hash": pdf_hash, "changes": diff}

            # Compute diff BEFORE writing (compare new parse vs current DB)
            diff = self._compute_diff(ch_num, commodities)

            # Write to DB
            from tariff_parser.writers.db_writer import SupabaseWriter
            writer = SupabaseWriter(self.url, self.key)
            stats = writer.write_in_rows(commodities)

            # Upload PDF to storage
            self._upload_pdf(ch_num, pdf_bytes)

            # Log changes to notification_tracker if there are actual changes
            if diff["total_changes"] > 0:
                self._log_change_notification(ch_num, diff)

            # Update sync status
            now = datetime.now(timezone.utc).isoformat()
            requests.post(
                f"{self.url}/rest/v1/cbic_chapter_sync",
                headers=self.headers,
                json=[{
                    "chapternum": ch_num,
                    "countrycode": "IN",
                    "lastsyncdt": now,
                    "commoditycount": len(commodities),
                    "synchash": pdf_hash,
                    "syncstatus": "CURRENT",
                    "errormessage": None,
                }],
                timeout=15,
            )

            return {"chapter": ch_num, "status": "updated", "commodities": len(commodities),
                    "written": stats.get("inserted", 0), "hash": pdf_hash, "changes": diff}

        except Exception as e:
            logger.error("Chapter %d: parse error — %s", ch_num, e)
            if not dry_run:
                self._update_sync_status(ch_num, "ERROR", str(e))
            return {"chapter": ch_num, "status": "error", "error": str(e)}
        finally:
            os.unlink(tmp_path)

    def _compute_diff(self, ch_num: int, new_commodities: list) -> dict:
        """Compare newly parsed commodities against current DB state."""
        chapter_prefix = f"{ch_num:02d}" if ch_num < 10 else str(ch_num)

        # Fetch current rates from DB for this chapter
        old_rates = {}
        offset = 0
        while True:
            resp = requests.get(
                f"{self.url}/rest/v1/mfn_rate?countrycode=eq.IN"
                f"&commoditycode=like.{chapter_prefix}*"
                f"&effectiveto=is.null"
                f"&select=commoditycode,appliedmfnrate,dutyexpression"
                f"&offset={offset}&limit=1000",
                headers={**self.headers, "Prefer": ""},
                timeout=15,
            )
            batch = resp.json()
            if not batch:
                break
            for r in batch:
                old_rates[r["commoditycode"]] = {
                    "rate": r.get("appliedmfnrate"),
                    "expr": r.get("dutyexpression", ""),
                }
            offset += len(batch)
            if len(batch) < 1000:
                break

        # Also fetch old descriptions
        old_descs = {}
        offset = 0
        while True:
            resp = requests.get(
                f"{self.url}/rest/v1/commodity_code?countrycode=eq.IN"
                f"&commoditycode=like.{chapter_prefix}*"
                f"&select=commoditycode,nationaldescription"
                f"&offset={offset}&limit=1000",
                headers={**self.headers, "Prefer": ""},
                timeout=15,
            )
            batch = resp.json()
            if not batch:
                break
            for r in batch:
                old_descs[r["commoditycode"]] = r.get("nationaldescription", "")
            offset += len(batch)
            if len(batch) < 1000:
                break

        # Build new lookup
        new_lookup = {}
        for c in new_commodities:
            new_lookup[c.commodity_code] = {
                "rate": c.standard_rate_pct,
                "expr": c.standard_rate_expr,
                "desc": c.description,
            }

        # Compute changes
        rate_changes = []
        new_codes = []
        removed_codes = []
        desc_changes = []

        all_codes = set(old_rates.keys()) | set(new_lookup.keys())
        for code in sorted(all_codes):
            old = old_rates.get(code)
            new = new_lookup.get(code)

            if old and not new:
                removed_codes.append(code)
            elif new and not old:
                new_codes.append({
                    "code": code,
                    "rate": new["rate"],
                    "description": new["desc"][:80],
                })
            elif old and new:
                # Rate change?
                old_rate = old.get("rate")
                new_rate = new.get("rate")
                if old_rate != new_rate:
                    rate_changes.append({
                        "code": code,
                        "old_rate": old_rate,
                        "new_rate": new_rate,
                        "old_expr": old.get("expr", ""),
                        "new_expr": new.get("expr", ""),
                        "description": new["desc"][:80],
                    })
                # Description change?
                old_desc = old_descs.get(code, "")
                new_desc = new.get("desc", "")
                if old_desc and new_desc and old_desc[:100] != new_desc[:100]:
                    desc_changes.append({"code": code, "old": old_desc[:80], "new": new_desc[:80]})

        total_changes = len(rate_changes) + len(new_codes) + len(removed_codes)

        diff = {
            "chapter": ch_num,
            "total_changes": total_changes,
            "rate_changes": rate_changes,
            "new_codes": new_codes,
            "removed_codes": removed_codes,
            "description_changes": len(desc_changes),
            "old_count": len(old_rates),
            "new_count": len(new_lookup),
        }

        if rate_changes:
            logger.info("Chapter %d: %d rate changes detected", ch_num, len(rate_changes))
            for rc in rate_changes[:5]:
                logger.info("  %s: %s → %s (%s)", rc["code"], rc["old_rate"], rc["new_rate"], rc["description"])
            if len(rate_changes) > 5:
                logger.info("  ... and %d more", len(rate_changes) - 5)
        if new_codes:
            logger.info("Chapter %d: %d new commodity codes", ch_num, len(new_codes))
        if removed_codes:
            logger.info("Chapter %d: %d removed commodity codes", ch_num, len(removed_codes))

        return diff

    def _log_change_notification(self, ch_num: int, diff: dict):
        """Log detected changes as a notification for admin review."""
        # Build summary text
        parts = []
        if diff["rate_changes"]:
            parts.append(f"{len(diff['rate_changes'])} rate changes")
            for rc in diff["rate_changes"][:10]:
                parts.append(f"  {rc['code']}: {rc['old_rate']}% → {rc['new_rate']}% ({rc['description']})")
        if diff["new_codes"]:
            parts.append(f"{len(diff['new_codes'])} new codes added")
        if diff["removed_codes"]:
            parts.append(f"{len(diff['removed_codes'])} codes removed")

        summary = "\n".join(parts)

        # Determine priority
        priority = "LOW"
        if diff["rate_changes"]:
            priority = "HIGH"
        if len(diff["rate_changes"]) > 10 or len(diff["new_codes"]) > 20:
            priority = "CRITICAL"

        affected_codes = [rc["code"] for rc in diff["rate_changes"][:50]]
        affected_codes += [nc["code"] for nc in diff["new_codes"][:50]]

        record = {
            "source": "CBIC_TARIFF",
            "notificationref": f"AUTO-CHAPTER-{ch_num}-{datetime.now(timezone.utc).strftime('%Y%m%d')}",
            "title": f"Chapter {ch_num} auto-update: {diff['total_changes']} changes detected",
            "publishdate": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "status": "APPLIED",
            "priority": priority,
            "countrycode": "IN",
            "affectedtables": ["mfn_rate", "tariff_rate", "commodity_code"],
            "affectedcodes": affected_codes,
            "aiextract": diff,
            "appliednotes": summary[:2000],
        }

        requests.post(
            f"{self.url}/rest/v1/notification_tracker",
            headers=self.headers,
            json=[record],
            timeout=15,
        )
        logger.info("Chapter %d: logged %d changes to notification_tracker", ch_num, diff["total_changes"])

    def _update_sync_status(self, ch_num: int, status: str, error: str = None):
        """Update sync status for a chapter."""
        record = {"chapternum": ch_num, "countrycode": "IN", "syncstatus": status}
        if error:
            record["errormessage"] = error[:500]
        requests.post(
            f"{self.url}/rest/v1/cbic_chapter_sync",
            headers=self.headers,
            json=[record],
            timeout=15,
        )

    def _upload_pdf(self, ch_num: int, pdf_bytes: bytes):
        """Upload chapter PDF to Supabase storage."""
        filename = f"IN/chapter-{ch_num:02d}.pdf"
        upload_url = f"{self.url}/storage/v1/object/tariff-docs/{filename}"
        resp = requests.post(
            upload_url,
            headers={
                "apikey": self.key, "Authorization": f"Bearer {self.key}",
                "Content-Type": "application/pdf", "x-upsert": "true",
            },
            data=pdf_bytes,
            timeout=60,
        )
        if resp.status_code in (200, 201):
            logger.info("Chapter %d: uploaded to storage", ch_num)
        else:
            logger.warning("Chapter %d: storage upload failed — %d", ch_num, resp.status_code)


def main():
    parser = argparse.ArgumentParser(description="India tariff chapter auto-updater")
    parser.add_argument("--chapters", nargs="+", type=int, help="Force update specific chapters")
    parser.add_argument("--dry-run", action="store_true", help="Parse only, no DB write")
    args = parser.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not supabase_url or not supabase_key:
        logger.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
        sys.exit(1)

    updater = ChapterUpdater(supabase_url, supabase_key)

    if args.chapters:
        # Force-update specific chapters
        chapters = [{"chapternum": ch, "countrycode": "IN",
                     "filepath": f"CONTENTREPO/Customs/Tariff/Tariff(ason30.06.2024)/CUSTOMS_TARIFF_VOL-I/chap-{ch}.pdf"}
                    for ch in args.chapters]
    else:
        chapters = updater.get_stale_chapters()

    if not chapters:
        logger.info("No stale chapters to update")
        sys.exit(0)

    logger.info("Processing %d chapters...", len(chapters))
    results = []
    for ch in chapters:
        result = updater.update_chapter(ch, dry_run=args.dry_run)
        results.append(result)
        time.sleep(1)  # polite rate limiting

    # Summary
    updated = sum(1 for r in results if r["status"] == "updated")
    unchanged = sum(1 for r in results if r["status"] == "unchanged")
    errors = sum(1 for r in results if r["status"] == "error")

    logger.info("=" * 60)
    logger.info("Chapter update complete: %d updated, %d unchanged, %d errors",
                updated, unchanged, errors)


if __name__ == "__main__":
    main()
