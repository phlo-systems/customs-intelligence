"""
country_monitors.py — Unified monitor for all countries.

Checks each country's data source for updates via HTTP headers or API calls.
Reports changes to notification_tracker and data_freshness tables.

Usage:
    export $(grep -v '^#' .env | xargs)
    python3 -m scripts.country_monitors                    # check all
    python3 -m scripts.country_monitors --country UY       # check one
"""

import argparse
import hashlib
import logging
import os
import sys
from datetime import datetime, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")
logger = logging.getLogger("country_monitors")

# Data sources for each country
COUNTRY_SOURCES = {
    "UY": {
        "name": "Uruguay",
        "url": "https://www.gub.uy/ministerio-economia-finanzas/sites/ministerio-economia-finanzas/files/2025-05/Arancel%20Nacional_10%20d%C3%ADgitos_Febrero%202025%20-final.xlsx",
        "type": "file_header",
        "reload_cmd": "python3 -m tariff_parser.bulk_country_loader --country UY",
    },
    "CL": {
        "name": "Chile",
        "url": "https://www.aduana.cl/aduana/site/docs/20161230/20161230090118/listado_items_arancelarios_capitulos_1_a_97.xlsx",
        "type": "file_header",
        "reload_cmd": "python3 -m tariff_parser.bulk_country_loader --country CL",
    },
    "AE": {
        "name": "UAE (GCC)",
        "url": "https://www.dubaicustoms.gov.ae/en/PoliciesAndNotices/Documents/HSCodeMaster-v3.3customers.xlsx",
        "type": "file_header",
        "reload_cmd": "python3 -m tariff_parser.bulk_country_loader --country AE",
        "also_covers": ["SA", "OM"],
    },
    "AR": {
        "name": "Argentina",
        "url": "https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json?perfil=PUBLICO",
        "type": "content_hash",
        "reload_cmd": "python3 -m tariff_parser.bulk_country_loader --country AR",
        "note": "Shares MERCOSUR TEC with Brazil — monitors same NCM API",
    },
    "AU": {
        "name": "Australia",
        "url": "https://www.abf.gov.au/importing-exporting-and-manufacturing/tariff-classification/current-tariff/schedule-3",
        "type": "page_hash",
        "reload_cmd": "python3 -m tariff_parser.bulk_country_loader --country AU",
        "note": "Check ABF page for tariff updates",
    },
    "MX": {
        "name": "Mexico",
        "url": "https://www.inegi.org.mx/app/tigie/",
        "type": "page_hash",
        "note": "INEGI TIGIE catalog — check for updates",
    },
    "TH": {
        "name": "Thailand",
        "url": "http://itd.customs.go.th/igtf/en/main_frame.jsp",
        "type": "page_hash",
        "note": "Thai Customs ITD database",
    },
    "PH": {
        "name": "Philippines",
        "url": "https://finder.tariffcommission.gov.ph/",
        "type": "page_hash",
        "note": "Philippine Tariff Finder",
    },
    "AO": {
        "name": "Angola",
        "url": "https://www.minfin.gov.ao/fsys/Pauta_Aduaneira.pdf",
        "type": "file_header",
    },
    "DO": {
        "name": "Dominican Republic",
        "url": "https://www.aduanas.gob.do/consultas/consulta-de-arancel/",
        "type": "page_hash",
    },
    "MU": {
        "name": "Mauritius",
        "url": "https://www.mra.mu/download/TariffInformation151225.pdf",
        "type": "file_header",
    },
}


class CountryMonitor:
    def __init__(self, supabase_url: str, supabase_key: str):
        self.url = supabase_url.rstrip("/")
        self.key = supabase_key
        self.headers = {
            "apikey": self.key, "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        }

    def check_country(self, country_code: str) -> dict:
        """Check a single country's data source for updates."""
        source = COUNTRY_SOURCES.get(country_code)
        if not source:
            return {"country": country_code, "error": "No source configured"}

        logger.info("Checking %s (%s)...", source["name"], country_code)
        result = {"country": country_code, "name": source["name"], "changed": False}

        try:
            if source["type"] == "file_header":
                result.update(self._check_file_header(source["url"]))
            elif source["type"] == "content_hash":
                result.update(self._check_content_hash(source["url"]))
            elif source["type"] == "page_hash":
                result.update(self._check_page_hash(source["url"]))
        except Exception as e:
            result["error"] = str(e)
            logger.error("  %s check failed: %s", country_code, e)
            return result

        # Compare with stored signature
        current_sig = result.get("signature", "")
        stored_sig = self._get_stored_sig(country_code)

        if current_sig and current_sig != stored_sig:
            result["changed"] = True
            logger.info("  %s: CHANGE DETECTED", country_code)
            self._update_sig(country_code, current_sig)

            # Log notification
            requests.post(f"{self.url}/rest/v1/notification_tracker", headers=self.headers, json=[{
                "source": "CBIC_TARIFF",
                "notificationref": f"AUTO-{country_code}-{datetime.now(timezone.utc).strftime('%Y%m%d')}",
                "title": f"{source['name']} tariff data source has been updated",
                "status": "NEW", "priority": "HIGH", "countrycode": country_code,
            }], timeout=10)
        else:
            logger.info("  %s: no change", country_code)

        return result

    def _check_file_header(self, url: str) -> dict:
        """Check HTTP headers for file changes."""
        resp = requests.head(url, timeout=30, allow_redirects=True)
        modified = resp.headers.get("Last-Modified", "")
        size = resp.headers.get("Content-Length", "")
        etag = resp.headers.get("ETag", "")
        sig = f"{modified}|{size}|{etag}"
        return {"signature": sig, "last_modified": modified, "size": size}

    def _check_content_hash(self, url: str) -> dict:
        """Download content and hash it."""
        resp = requests.get(url, timeout=60)
        sig = hashlib.sha256(resp.content).hexdigest()[:16]
        return {"signature": sig, "content_size": len(resp.content)}

    def _check_page_hash(self, url: str) -> dict:
        """Fetch page and hash key content."""
        resp = requests.get(url, timeout=30)
        # Hash only the text content (ignore dynamic elements)
        import re
        text = re.sub(r'<script[^>]*>.*?</script>', '', resp.text, flags=re.DOTALL)
        text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL)
        text = re.sub(r'<[^>]+>', '', text)
        sig = hashlib.sha256(text.encode()).hexdigest()[:16]
        return {"signature": sig, "page_size": len(resp.content)}

    def _get_stored_sig(self, country_code: str) -> str:
        resp = requests.get(
            f"{self.url}/rest/v1/data_freshness?countrycode=eq.{country_code}&datatype=eq.BCD_RATES&select=sourceversion",
            headers={**self.headers, "Prefer": ""}, timeout=10)
        data = resp.json()
        return data[0].get("sourceversion", "") if data else ""

    def _update_sig(self, country_code: str, sig: str):
        requests.post(f"{self.url}/rest/v1/data_freshness", headers=self.headers, json=[{
            "countrycode": country_code, "datatype": "BCD_RATES", "sourceversion": sig,
        }], timeout=10)

    def check_all(self) -> list:
        results = []
        for cc in COUNTRY_SOURCES:
            result = self.check_country(cc)
            results.append(result)
        return results


def main():
    parser = argparse.ArgumentParser(description="Country tariff monitor")
    parser.add_argument("--country", help="Check specific country (e.g. UY, CL, AE)")
    args = parser.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not supabase_url or not supabase_key:
        logger.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
        sys.exit(1)

    monitor = CountryMonitor(supabase_url, supabase_key)

    if args.country:
        result = monitor.check_country(args.country.upper())
        logger.info("Result: %s", result)
    else:
        results = monitor.check_all()
        changes = [r for r in results if r.get("changed")]
        errors = [r for r in results if r.get("error")]
        logger.info("Checked %d countries: %d changed, %d errors",
                     len(results), len(changes), len(errors))

    sys.exit(0)


if __name__ == "__main__":
    main()
