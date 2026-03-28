"""
br_tariff_monitor.py — Brazil NCM tariff monitoring.

Checks the Siscomex NCM JSON API for changes by comparing file hash.
If changed, triggers a full re-parse.

Usage:
    export $(grep -v '^#' .env | xargs)
    python3 -m scripts.br_tariff_monitor
    python3 -m scripts.br_tariff_monitor --force-reload
"""

import argparse
import hashlib
import json
import logging
import os
import sys
from datetime import datetime, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")
logger = logging.getLogger("br_monitor")

NCM_URL = "https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json?perfil=PUBLICO"


class BRMonitor:
    def __init__(self, supabase_url: str, supabase_key: str):
        self.url = supabase_url.rstrip("/")
        self.key = supabase_key
        self.headers = {
            "apikey": self.key, "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal",
        }

    def check_for_updates(self) -> dict:
        """Download NCM JSON, hash it, compare with stored hash."""
        logger.info("Checking Siscomex NCM API for updates...")
        try:
            resp = requests.get(NCM_URL, timeout=60)
            resp.raise_for_status()
            data = resp.json()
            current_hash = hashlib.sha256(resp.content).hexdigest()[:16]
            ncm_date = data.get("Data_Ultima_Atualizacao_NCM", "")
            ncm_count = len([n for n in data.get("Nomenclaturas", []) if len(n.get("Codigo", "").replace(".", "")) == 8])

            logger.info("  NCM date: %s, leaf codes: %d, hash: %s", ncm_date, ncm_count, current_hash)

            # Compare with stored
            r = requests.get(
                f"{self.url}/rest/v1/data_freshness?countrycode=eq.BR&datatype=eq.BCD_RATES&select=sourceversion",
                headers={**self.headers, "Prefer": ""}, timeout=10)
            stored = r.json()
            stored_hash = stored[0].get("sourceversion", "") if stored else ""

            is_changed = current_hash != stored_hash
            if is_changed:
                logger.info("  CHANGE DETECTED (stored hash: %s)", stored_hash)
            else:
                logger.info("  No change detected")

            return {
                "changed": is_changed,
                "ncm_date": ncm_date,
                "ncm_count": ncm_count,
                "current_hash": current_hash,
                "stored_hash": stored_hash,
                "data": data if is_changed else None,
            }

        except Exception as e:
            logger.error("Siscomex check failed: %s", e)
            return {"changed": False, "error": str(e)}

    def reload(self, ncm_data: dict = None) -> dict:
        """Reload all Brazil NCM data."""
        if not ncm_data:
            resp = requests.get(NCM_URL, timeout=60)
            resp.raise_for_status()
            ncm_data = resp.json()

        import tempfile, json as j
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            j.dump(ncm_data, f)
            tmp_path = f.name

        try:
            import subprocess
            result = subprocess.run(
                [sys.executable, "-m", "tariff_parser.br_full_load", "--ncm-file", tmp_path],
                capture_output=True, text=True, timeout=300)
            logger.info(result.stdout[-500:] if result.stdout else "No output")
            if result.returncode != 0:
                logger.error(result.stderr[-300:] if result.stderr else "Unknown error")
            return {"status": "reloaded" if result.returncode == 0 else "error"}
        finally:
            os.unlink(tmp_path)


def main():
    parser = argparse.ArgumentParser(description="Brazil tariff monitor")
    parser.add_argument("--force-reload", action="store_true")
    args = parser.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not supabase_url or not supabase_key:
        logger.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY"); sys.exit(1)

    monitor = BRMonitor(supabase_url, supabase_key)

    if args.force_reload:
        monitor.reload()
    else:
        result = monitor.check_for_updates()
        if result.get("changed") and result.get("data"):
            monitor.reload(result["data"])

    sys.exit(0)


if __name__ == "__main__":
    main()
