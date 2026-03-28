"""
za_tariff_monitor.py — South Africa / SACU tariff monitoring.

Checks if the SARS Schedule 1 PDF has been updated by comparing
the HTTP Last-Modified header and Content-Length against stored values.
If changed, downloads and re-parses the full PDF.

Usage:
    export $(grep -v '^#' .env | xargs)
    python3 -m scripts.za_tariff_monitor
    python3 -m scripts.za_tariff_monitor --force-download
"""

import argparse
import hashlib
import logging
import os
import sys
import tempfile
from datetime import datetime, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")
logger = logging.getLogger("za_monitor")

SARS_PDF_URL = (
    "https://www.sars.gov.za/wp-content/uploads/Legal/SCEA1964/"
    "Legal-LPrim-CE-Sch1P1Chpt1-to-99-Schedule-No-1-Part-1-Chapters-1-to-99.pdf"
)


class ZAMonitor:
    def __init__(self, supabase_url: str, supabase_key: str):
        self.url = supabase_url.rstrip("/")
        self.key = supabase_key
        self.headers = {
            "apikey": self.key, "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal",
        }

    def check_for_updates(self) -> dict:
        """Check if SARS PDF has changed using HEAD request."""
        logger.info("Checking SARS tariff PDF for updates...")
        try:
            resp = requests.head(SARS_PDF_URL, timeout=30, allow_redirects=True)
            remote_modified = resp.headers.get("Last-Modified", "")
            remote_size = resp.headers.get("Content-Length", "")
            remote_etag = resp.headers.get("ETag", "")

            logger.info("  Remote: modified=%s, size=%s, etag=%s", remote_modified, remote_size, remote_etag)

            # Get stored sync info
            r = requests.get(
                f"{self.url}/rest/v1/data_freshness?countrycode=eq.ZA&datatype=eq.BCD_RATES&select=*",
                headers={**self.headers, "Prefer": ""}, timeout=10)
            stored = r.json()
            stored_version = stored[0].get("sourceversion", "") if stored else ""

            # Compare
            current_sig = f"{remote_modified}|{remote_size}|{remote_etag}"
            is_changed = current_sig != stored_version

            if is_changed:
                logger.info("  CHANGE DETECTED (stored: %s)", stored_version)
            else:
                logger.info("  No change detected")

            return {
                "changed": is_changed,
                "remote_modified": remote_modified,
                "remote_size": remote_size,
                "current_sig": current_sig,
                "stored_sig": stored_version,
            }

        except Exception as e:
            logger.error("SARS check failed: %s", e)
            return {"changed": False, "error": str(e)}

    def download_and_parse(self, force: bool = False) -> dict:
        """Download SARS PDF, parse, and update DB."""
        check = self.check_for_updates()
        if not check.get("changed") and not force:
            logger.info("No update needed")
            return {"status": "current", "changed": False}

        logger.info("Downloading SARS PDF...")
        try:
            resp = requests.get(SARS_PDF_URL, timeout=120)
            resp.raise_for_status()
            pdf_bytes = resp.content
            pdf_hash = hashlib.sha256(pdf_bytes).hexdigest()
            logger.info("Downloaded %d bytes, hash: %s", len(pdf_bytes), pdf_hash[:16])
        except Exception as e:
            logger.error("Download failed: %s", e)
            return {"status": "error", "error": str(e)}

        # Save to temp and parse
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes)
            tmp_path = tmp.name

        try:
            from tariff_parser.parsers.za_parser import ZAParser
            from tariff_parser.writers.db_writer import SupabaseWriter

            parser = ZAParser()
            rows = parser.parse(tmp_path)
            logger.info("Parsed %d tariff rows", len(rows))

            writer = SupabaseWriter(self.url, self.key)
            for country in ["ZA", "NA"]:
                stats = writer.write_za_rows(rows, country)
                logger.info("%s: wrote %d rows", country, stats.get("inserted", 0))

            # Update freshness
            now = datetime.now(timezone.utc).isoformat()
            for country in ["ZA", "NA"]:
                requests.post(f"{self.url}/rest/v1/data_freshness", headers=self.headers, json=[{
                    "countrycode": country, "datatype": "BCD_RATES",
                    "lastsyncat": now, "rowcount": len(rows),
                    "sourcename": "SARS Schedule 1 Part 1 PDF",
                    "sourceversion": check.get("current_sig", ""),
                    "nextexpectedupdate": "Check weekly", "staleafterhours": 336,
                }], timeout=10)

            # Log notification
            requests.post(f"{self.url}/rest/v1/notification_tracker", headers=self.headers, json=[{
                "source": "CBIC_TARIFF", "notificationref": f"SARS-PDF-UPDATE-{now[:10]}",
                "title": f"SARS Schedule 1 PDF updated — {len(rows)} rows re-parsed",
                "status": "APPLIED", "priority": "HIGH", "countrycode": "ZA",
            }], timeout=10)

            return {"status": "updated", "rows": len(rows), "hash": pdf_hash}

        except Exception as e:
            logger.error("Parse failed: %s", e)
            return {"status": "error", "error": str(e)}
        finally:
            os.unlink(tmp_path)


def main():
    parser = argparse.ArgumentParser(description="South Africa tariff monitor")
    parser.add_argument("--force-download", action="store_true", help="Download and re-parse even if unchanged")
    args = parser.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not supabase_url or not supabase_key:
        logger.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
        sys.exit(1)

    monitor = ZAMonitor(supabase_url, supabase_key)

    if args.force_download:
        result = monitor.download_and_parse(force=True)
    else:
        result = monitor.download_and_parse()

    logger.info("Result: %s", result)
    sys.exit(0 if result.get("status") in ("current", "updated") else 1)


if __name__ == "__main__":
    main()
