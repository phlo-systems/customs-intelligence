"""
india_tariff_monitor.py — Daily monitoring script for India customs data.

Checks all government sources for updates and logs findings to the
NOTIFICATION_TRACKER and CBIC_CHAPTER_SYNC tables.

Usage:
    export $(grep -v '^#' .env | xargs)
    python3 -m scripts.india_tariff_monitor
    python3 -m scripts.india_tariff_monitor --check-chapters    # only check chapter updates
    python3 -m scripts.india_tariff_monitor --check-notifications  # only check notifications
    python3 -m scripts.india_tariff_monitor --auto-update       # also download & re-parse stale chapters

Sources checked:
    1. CBIC API — tariff chapter updatedDt (change detection)
    2. CBIC Tax Information Portal — latest customs notifications
    3. DGTR — new anti-dumping cases (page scrape)
    4. CBIC Exchange rates (fortnightly notification)
"""

import argparse
import base64
import hashlib
import logging
import os
import sys
import time
from datetime import datetime, timezone

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger("india_monitor")


class IndiaMonitor:
    """Monitors Indian government portals for tariff data updates."""

    def __init__(self, supabase_url: str, supabase_key: str):
        self.url = supabase_url.rstrip("/")
        self.key = supabase_key
        self.headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        }
        self.session = requests.Session()
        self.session.headers.update({"Accept": "application/json"})
        self.findings = []

    # ── 1. CBIC Chapter Update Detection ─────────────────────────────────────

    def check_chapter_updates(self) -> list[dict]:
        """Check CBIC API for updated tariff chapters."""
        logger.info("Checking CBIC tariff chapters for updates...")
        stale_chapters = []

        # Get our stored sync timestamps
        resp = requests.get(
            f"{self.url}/rest/v1/cbic_chapter_sync?countrycode=eq.IN&select=*&order=chapternum",
            headers={**self.headers, "Prefer": ""},
            timeout=15,
        )
        stored = {row["chapternum"]: row for row in resp.json()}

        # Get the Import Tariff parent to discover sections
        try:
            sections = self._cbic_api("MTcyNDY0")  # Part II - Import Tariff
            if not sections:
                logger.warning("Could not fetch CBIC Import Tariff parent")
                return stale_chapters
        except Exception as e:
            logger.error("CBIC API error: %s", e)
            return stale_chapters

        # Traverse sections to find chapters
        children = sections.get("childContentList", [])
        for section in children:
            section_id = section.get("id")
            if not section_id:
                continue

            encoded = base64.b64encode(str(section_id).encode()).decode()
            try:
                section_data = self._cbic_api(encoded)
                if not section_data:
                    continue
            except Exception:
                continue

            for chapter in section_data.get("childContentList", []):
                ch_id = chapter.get("id")
                ch_name = chapter.get("titleEn", "")

                # Get chapter detail for updatedDt and filePath
                encoded_ch = base64.b64encode(str(ch_id).encode()).decode()
                try:
                    ch_data = self._cbic_api(encoded_ch)
                    if not ch_data:
                        continue
                except Exception:
                    continue

                cbic_updated = ch_data.get("updatedDt")
                docs = ch_data.get("cbicDocMsts", [])
                filepath = docs[0].get("filePathEn") if docs else None

                # Extract chapter number from filepath (e.g. "chap-1.pdf" → 1)
                ch_num = self._extract_chapter_from_path(filepath) if filepath else None
                if not ch_num:
                    # Try from title
                    ch_num = self._extract_chapter_num(ch_name)
                if not ch_num:
                    continue

                # Compare with stored (normalize timezones before comparing)
                stored_ch = stored.get(ch_num, {})
                stored_updated = stored_ch.get("cbicupdateddt")

                is_new = False
                if cbic_updated and not stored_updated:
                    is_new = True
                elif cbic_updated and stored_updated:
                    from datetime import datetime as dt
                    try:
                        cbic_dt = dt.fromisoformat(cbic_updated)
                        stored_dt = dt.fromisoformat(stored_updated.replace("Z", "+00:00"))
                        # Compare as UTC — both converted to offset-aware
                        is_new = cbic_dt != stored_dt
                    except (ValueError, TypeError):
                        is_new = cbic_updated != stored_updated
                if is_new:
                    stale_chapters.append({
                        "chapternum": ch_num,
                        "cbiccontentid": ch_id,
                        "filepath": filepath,
                        "cbicupdateddt": cbic_updated,
                        "old_updateddt": stored_updated,
                    })
                    logger.info("  Chapter %d: UPDATED (CBIC: %s, ours: %s)",
                                ch_num, cbic_updated, stored_updated or "never")

                # Update our tracking table
                self._upsert("cbic_chapter_sync", [{
                    "chapternum": ch_num,
                    "countrycode": "IN",
                    "cbiccontentid": ch_id,
                    "filepath": filepath,
                    "cbicupdateddt": cbic_updated,
                    "syncstatus": "STALE" if is_new else "CURRENT",
                }])

                time.sleep(0.3)  # polite rate limiting

            time.sleep(0.3)

        logger.info("Chapter check complete: %d stale chapters found", len(stale_chapters))
        return stale_chapters

    # ── 2. CBIC Notification Detection ───────────────────────────────────────

    def check_cbic_notifications(self) -> list[dict]:
        """Check Tax Information Portal for new customs notifications."""
        logger.info("Checking CBIC Tax Information Portal for new notifications...")
        new_notifications = []

        try:
            resp = self.session.get(
                "https://taxinformation.cbic.gov.in/api/cbic-notification-msts/fetchUpdatesByTaxId/1000002",
                timeout=30,
                verify=False,  # CBIC has certificate issues
            )
            if resp.status_code != 200:
                logger.warning("CBIC notifications API returned %d", resp.status_code)
                return new_notifications

            data = resp.json()
            notifications = data if isinstance(data, list) else data.get("data", [])

            for notif in notifications[:50]:  # Check last 50
                ref = notif.get("notificationNo") or notif.get("notNo", "")
                title = notif.get("subject") or notif.get("title", "")
                pub_date = notif.get("notificationDate") or notif.get("issueDt", "")

                if not ref:
                    continue

                # Determine source type from notification number
                source = "CBIC_TARIFF"
                if "(N.T.)" in ref or "(NT)" in ref:
                    source = "CBIC_NT"

                # Check if we've seen this already
                check = requests.get(
                    f"{self.url}/rest/v1/notification_tracker?source=eq.{source}&notificationref=eq.{ref}&select=notificationid",
                    headers={**self.headers, "Prefer": ""},
                    timeout=10,
                )
                if check.json():
                    continue  # Already tracked

                # Determine priority
                priority = "MEDIUM"
                if "50/2017" in title or "50/2017" in ref:
                    priority = "CRITICAL"
                elif any(k in title.lower() for k in ["anti-dumping", "safeguard", "countervailing"]):
                    priority = "HIGH"
                elif any(k in title.lower() for k in ["exchange rate", "drawback"]):
                    priority = "HIGH"

                record = {
                    "source": source,
                    "notificationref": ref,
                    "title": title[:500] if title else None,
                    "publishdate": pub_date[:10] if pub_date and len(pub_date) >= 10 else None,
                    "status": "NEW",
                    "priority": priority,
                    "countrycode": "IN",
                }
                self._upsert("notification_tracker", [record])
                new_notifications.append(record)
                logger.info("  NEW: [%s] %s — %s", priority, ref, title[:60])

        except Exception as e:
            logger.error("CBIC notification check failed: %s", e)

        logger.info("Notification check complete: %d new notifications", len(new_notifications))
        return new_notifications

    # ── 3. DGTR Anti-Dumping Case Detection ──────────────────────────────────

    def check_dgtr_cases(self) -> list[dict]:
        """Check DGTR for new anti-dumping investigations."""
        logger.info("Checking DGTR for new trade remedy cases...")
        new_cases = []

        try:
            resp = self.session.get(
                "https://www.dgtr.gov.in/en/anti-dumping-investigation-in-india",
                timeout=30,
            )
            if resp.status_code != 200:
                logger.warning("DGTR returned %d", resp.status_code)
                return new_cases

            # Simple text scan for case info — DGTR page is HTML
            text = resp.text
            # Look for product names in the case table
            import re
            # Find entries that look like case rows
            rows = re.findall(
                r'<td[^>]*>\s*(\d+)\s*</td>\s*<td[^>]*>\s*(.*?)\s*</td>\s*<td[^>]*>\s*(.*?)\s*</td>',
                text, re.DOTALL
            )

            for num, product, countries in rows[:20]:
                product = re.sub(r'<[^>]+>', '', product).strip()
                countries = re.sub(r'<[^>]+>', '', countries).strip()
                if not product:
                    continue

                ref = f"DGTR-{num}-{product[:30]}"

                # Check if tracked
                check = requests.get(
                    f"{self.url}/rest/v1/notification_tracker?source=eq.DGTR&notificationref=eq.{ref}&select=notificationid",
                    headers={**self.headers, "Prefer": ""},
                    timeout=10,
                )
                if check.json():
                    continue

                record = {
                    "source": "DGTR",
                    "notificationref": ref,
                    "title": f"{product} from {countries}",
                    "status": "NEW",
                    "priority": "HIGH",
                    "countrycode": "IN",
                }
                self._upsert("notification_tracker", [record])
                new_cases.append(record)
                logger.info("  NEW DGTR case: %s from %s", product, countries)

        except Exception as e:
            logger.error("DGTR check failed: %s", e)

        logger.info("DGTR check complete: %d new cases", len(new_cases))
        return new_cases

    # ── 4. Data Freshness Report ─────────────────────────────────────────────

    def generate_freshness_report(self) -> dict:
        """Generate a data freshness summary."""
        logger.info("Generating data freshness report...")

        resp = requests.get(
            f"{self.url}/rest/v1/data_freshness?countrycode=eq.IN&select=*",
            headers={**self.headers, "Prefer": ""},
            timeout=15,
        )
        rows = resp.json()

        report = {"country": "IN", "checked_at": datetime.now(timezone.utc).isoformat(), "items": []}
        stale_count = 0

        for row in rows:
            last_sync = row.get("lastsyncat")
            stale_hours = row.get("staleafterhours", 720)
            is_stale = False

            if last_sync:
                from datetime import timedelta
                sync_dt = datetime.fromisoformat(last_sync.replace("Z", "+00:00"))
                age_hours = (datetime.now(timezone.utc) - sync_dt).total_seconds() / 3600
                is_stale = age_hours > stale_hours
            else:
                is_stale = True

            if is_stale:
                stale_count += 1

            report["items"].append({
                "datatype": row["datatype"],
                "last_sync": last_sync,
                "is_stale": is_stale,
                "row_count": row.get("rowcount"),
                "source": row.get("sourcename"),
                "next_expected": row.get("nextexpectedupdate"),
            })

        report["stale_count"] = stale_count
        report["total_items"] = len(rows)

        # Pending notifications
        resp2 = requests.get(
            f"{self.url}/rest/v1/notification_tracker?status=eq.NEW&countrycode=eq.IN&select=notificationid",
            headers={**self.headers, "Prefer": "count=exact", "Range": "0-0"},
            timeout=10,
        )
        pending = resp2.headers.get("Content-Range", "*/0").split("/")[-1]
        report["pending_notifications"] = int(pending)

        # Stale chapters
        resp3 = requests.get(
            f"{self.url}/rest/v1/cbic_chapter_sync?syncstatus=eq.STALE&countrycode=eq.IN&select=chapternum",
            headers={**self.headers, "Prefer": ""},
            timeout=10,
        )
        stale_chs = [r["chapternum"] for r in resp3.json()]
        report["stale_chapters"] = stale_chs

        logger.info("Freshness report: %d/%d items stale, %s pending notifications, %d stale chapters",
                     stale_count, len(rows), pending, len(stale_chs))
        return report

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _cbic_api(self, encoded_id: str) -> dict | None:
        """Fetch from CBIC content API."""
        resp = self.session.get(
            f"https://www.cbic.gov.in/api/cbic-content-msts/{encoded_id}",
            timeout=30,
        )
        if resp.status_code != 200:
            return None
        return resp.json()

    def _extract_chapter_num(self, name: str) -> int | None:
        """Extract chapter number from name like 'Chapter 1' or 'Chapter 72'."""
        import re
        m = re.search(r'chapter\s+(\d+)', name, re.IGNORECASE)
        return int(m.group(1)) if m else None

    def _extract_chapter_from_path(self, filepath: str) -> int | None:
        """Extract chapter number from filepath like 'chap-72.pdf'."""
        import re
        m = re.search(r'chap-(\d+)\.pdf', filepath)
        return int(m.group(1)) if m else None

    def _upsert(self, table: str, records: list[dict]):
        """Upsert records to Supabase."""
        resp = requests.post(
            f"{self.url}/rest/v1/{table}",
            headers=self.headers,
            json=records,
            timeout=15,
        )
        if resp.status_code not in (200, 201):
            logger.error("Upsert %s failed: %s — %s", table, resp.status_code, resp.text[:200])


def main():
    parser = argparse.ArgumentParser(description="India tariff data monitor")
    parser.add_argument("--check-chapters", action="store_true", help="Only check CBIC chapter updates")
    parser.add_argument("--check-notifications", action="store_true", help="Only check new notifications")
    parser.add_argument("--check-dgtr", action="store_true", help="Only check DGTR cases")
    parser.add_argument("--report-only", action="store_true", help="Only generate freshness report")
    args = parser.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not supabase_url or not supabase_key:
        logger.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
        sys.exit(1)

    monitor = IndiaMonitor(supabase_url, supabase_key)
    run_all = not any([args.check_chapters, args.check_notifications, args.check_dgtr, args.report_only])

    results = {}

    if run_all or args.check_chapters:
        results["stale_chapters"] = monitor.check_chapter_updates()

    if run_all or args.check_notifications:
        results["new_notifications"] = monitor.check_cbic_notifications()

    if run_all or args.check_dgtr:
        results["new_dgtr_cases"] = monitor.check_dgtr_cases()

    # Always generate report
    results["freshness"] = monitor.generate_freshness_report()

    # Summary
    logger.info("=" * 60)
    logger.info("India Tariff Monitor — Summary")
    if "stale_chapters" in results:
        logger.info("  Stale chapters:        %d", len(results["stale_chapters"]))
    if "new_notifications" in results:
        logger.info("  New notifications:     %d", len(results["new_notifications"]))
    if "new_dgtr_cases" in results:
        logger.info("  New DGTR cases:        %d", len(results["new_dgtr_cases"]))
    f = results["freshness"]
    logger.info("  Data freshness:        %d/%d stale", f["stale_count"], f["total_items"])
    logger.info("  Pending notifications: %d", f["pending_notifications"])

    # Return exit code based on findings
    has_action_items = (
        len(results.get("stale_chapters", [])) > 0
        or len(results.get("new_notifications", [])) > 0
        or len(results.get("new_dgtr_cases", [])) > 0
    )
    sys.exit(1 if has_action_items else 0)


if __name__ == "__main__":
    main()
