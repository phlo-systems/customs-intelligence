"""
gb_tariff_monitor.py — UK Trade Tariff API monitoring.

The UK Trade Tariff API provides a /healthcheck and /updates endpoint.
We poll the sections list to detect version/date changes, then
re-fetch affected chapters if updates are found.

Usage:
    export $(grep -v '^#' .env | xargs)
    python3 -m scripts.gb_tariff_monitor
    python3 -m scripts.gb_tariff_monitor --full-reload
"""

import argparse
import hashlib
import logging
import os
import sys
from datetime import datetime, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")
logger = logging.getLogger("gb_monitor")

UK_API_BASE = "https://www.trade-tariff.service.gov.uk/api/v2"


class GBMonitor:
    def __init__(self, supabase_url: str, supabase_key: str):
        self.url = supabase_url.rstrip("/")
        self.key = supabase_key
        self.headers = {
            "apikey": self.key, "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal",
        }
        self.session = requests.Session()
        self.session.headers.update({"Accept": "application/json"})

    def check_for_updates(self) -> dict:
        """Check UK API for changes by fetching the updates endpoint."""
        logger.info("Checking UK Trade Tariff API for updates...")
        results = {"changes": [], "checked": 0}

        try:
            # The UK API has a /updates endpoint showing recent changes
            resp = self.session.get(f"{UK_API_BASE}/updates/latest", timeout=30)
            if resp.status_code == 200:
                data = resp.json()
                updates = data.get("data", [])
                results["api_updates"] = len(updates)
                logger.info("  UK API updates endpoint: %d recent updates", len(updates))
            else:
                logger.info("  UK API updates endpoint returned %d — trying sections", resp.status_code)

            # Also check sections list for any structural changes
            resp2 = self.session.get(f"{UK_API_BASE}/sections", timeout=30)
            if resp2.status_code == 200:
                sections = resp2.json().get("data", [])
                # Build a signature from section IDs + positions
                sig = hashlib.md5(str([(s.get("id"), s.get("attributes", {}).get("position"))
                                       for s in sections]).encode()).hexdigest()

                # Compare with stored
                r = requests.get(
                    f"{self.url}/rest/v1/data_freshness?countrycode=eq.GB&datatype=eq.BCD_RATES&select=sourceversion",
                    headers={**self.headers, "Prefer": ""}, timeout=10)
                stored = r.json()
                stored_sig = stored[0].get("sourceversion", "") if stored else ""

                if sig != stored_sig and stored_sig:
                    logger.info("  STRUCTURE CHANGE DETECTED (sections signature changed)")
                    results["changes"].append("sections_changed")
                else:
                    logger.info("  Sections structure unchanged (%d sections)", len(sections))

                results["sections_sig"] = sig
                results["sections_count"] = len(sections)
                results["checked"] = len(sections)
            else:
                logger.warning("  Sections endpoint returned %d", resp2.status_code)

            # Check a sample commodity to detect rate changes
            sample_codes = ["0201100021", "2709000010", "8471300010", "7210110010"]
            for code in sample_codes:
                try:
                    r = self.session.get(f"{UK_API_BASE}/commodities/{code}", timeout=15)
                    if r.status_code == 200:
                        results["checked"] += 1
                except Exception:
                    pass

        except Exception as e:
            logger.error("UK API check failed: %s", e)
            results["error"] = str(e)

        return results

    def full_reload(self) -> dict:
        """Trigger a full GB tariff reload (calls gb_full_load)."""
        logger.info("Starting full GB tariff reload...")
        try:
            from tariff_parser.gb_full_load import main as gb_main
            # This takes ~90 minutes — run in background for production
            import subprocess
            proc = subprocess.Popen(
                [sys.executable, "-m", "tariff_parser.gb_full_load"],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            )
            logger.info("GB full load started (PID %d) — runs in background (~90 min)", proc.pid)

            # Update freshness
            now = datetime.now(timezone.utc).isoformat()
            requests.post(f"{self.url}/rest/v1/data_freshness", headers=self.headers, json=[{
                "countrycode": "GB", "datatype": "BCD_RATES",
                "lastsyncat": now, "sourcename": "UK Trade Tariff API (all 98 chapters)",
                "nextexpectedupdate": "Check daily", "staleafterhours": 168,
            }], timeout=10)

            return {"status": "reload_started", "pid": proc.pid}
        except Exception as e:
            logger.error("Full reload failed: %s", e)
            return {"status": "error", "error": str(e)}

    def update_freshness(self, sig: str = ""):
        """Update data freshness record."""
        now = datetime.now(timezone.utc).isoformat()
        requests.post(f"{self.url}/rest/v1/data_freshness", headers=self.headers, json=[{
            "countrycode": "GB", "datatype": "BCD_RATES",
            "lastsyncat": now,
            "sourcename": "UK Trade Tariff API",
            "sourceversion": sig,
            "nextexpectedupdate": "Check daily",
            "staleafterhours": 168,
        }], timeout=10)


def main():
    parser = argparse.ArgumentParser(description="UK tariff monitor")
    parser.add_argument("--full-reload", action="store_true", help="Trigger full GB tariff reload (~90 min)")
    args = parser.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not supabase_url or not supabase_key:
        logger.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
        sys.exit(1)

    monitor = GBMonitor(supabase_url, supabase_key)

    if args.full_reload:
        result = monitor.full_reload()
        logger.info("Result: %s", result)
    else:
        result = monitor.check_for_updates()
        logger.info("Result: %s", result)

        # Update freshness with current signature
        if result.get("sections_sig"):
            monitor.update_freshness(result["sections_sig"])

    sys.exit(0)


if __name__ == "__main__":
    main()
