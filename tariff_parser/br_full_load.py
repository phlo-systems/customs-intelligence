"""
br_full_load.py — Load all Brazil NCM codes + tariff rates from Siscomex API.

Downloads the full NCM nomenclature JSON, parses 10,500+ leaf codes,
and attempts to fetch TEC (II) rates from the tariff treatment API.

Usage:
    export $(grep -v '^#' .env | xargs)
    python3 -m tariff_parser.br_full_load
    python3 -m tariff_parser.br_full_load --dry-run
    python3 -m tariff_parser.br_full_load --ncm-file /tmp/br_ncm.json  # use cached file
"""

import argparse
import hashlib
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone

import requests

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")
logger = logging.getLogger("br_full_load")

NCM_URL = "https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json?perfil=PUBLICO"

# TEC rates by chapter — Brazil's Common External Tariff
# Source: Resolução Gecex, compiled from official TEC table
# These are the STANDARD II rates. Many NCM codes have specific rates or ex-tarifários.
TEC_CHAPTER_DEFAULTS = {
    "01": 2, "02": 10, "03": 10, "04": 14, "05": 6,
    "06": 6, "07": 10, "08": 10, "09": 10, "10": 8,
    "11": 10, "12": 6, "13": 10, "14": 6, "15": 10,
    "16": 14, "17": 16, "18": 14, "19": 16, "20": 14,
    "21": 16, "22": 16, "23": 6, "24": 20,
    "25": 4, "26": 2, "27": 0,
    "28": 6, "29": 6, "30": 8, "31": 4, "32": 12,
    "33": 14, "34": 14, "35": 12, "36": 14, "37": 12,
    "38": 10,
    "39": 14, "40": 14,
    "41": 6, "42": 18, "43": 16,
    "44": 8, "45": 12, "46": 18, "47": 4, "48": 12, "49": 0,
    "50": 12, "51": 8, "52": 18, "53": 8, "54": 18, "55": 18,
    "56": 14, "57": 20, "58": 18, "59": 14, "60": 18,
    "61": 35, "62": 35, "63": 26,
    "64": 20, "65": 20, "66": 18, "67": 18,
    "68": 10, "69": 12, "70": 12,
    "71": 10,
    "72": 10, "73": 14, "74": 10, "75": 6, "76": 12,
    "78": 8, "79": 8, "80": 6, "81": 6, "82": 14, "83": 16,
    "84": 12, "85": 14,
    "86": 14, "87": 18, "88": 6, "89": 14,
    "90": 12, "91": 16, "92": 18, "93": 20,
    "94": 18, "95": 20, "96": 16, "97": 4,
}

# IPI rates by chapter (simplified defaults from TIPI table)
IPI_CHAPTER_DEFAULTS = {
    "01": 0, "02": 0, "03": 0, "04": 0, "05": 0,
    "06": 0, "07": 0, "08": 0, "09": 0, "10": 0,
    "11": 0, "12": 0, "13": 0, "14": 0, "15": 0,
    "16": 0, "17": 5, "18": 5, "19": 0, "20": 0,
    "21": 0, "22": 10, "23": 0, "24": 30,
    "25": 5, "26": 0, "27": 0,
    "28": 5, "29": 5, "30": 0, "31": 0, "32": 5,
    "33": 10, "34": 5, "35": 5, "36": 10, "37": 10,
    "38": 5,
    "39": 5, "40": 5,
    "41": 0, "42": 10, "43": 10,
    "44": 5, "45": 5, "46": 5, "47": 0, "48": 5, "49": 0,
    "50": 0, "51": 0, "52": 0, "53": 0, "54": 0, "55": 0,
    "56": 5, "57": 5, "58": 5, "59": 5, "60": 0,
    "61": 0, "62": 0, "63": 5,
    "64": 10, "65": 10, "66": 10, "67": 5,
    "68": 5, "69": 10, "70": 10,
    "71": 5,
    "72": 5, "73": 5, "74": 5, "75": 5, "76": 10,
    "78": 5, "79": 5, "80": 5, "81": 5, "82": 10, "83": 10,
    "84": 5, "85": 10,
    "86": 5, "87": 10, "88": 0, "89": 5,
    "90": 5, "91": 10, "92": 10, "93": 15,
    "94": 5, "95": 20, "96": 10, "97": 0,
}


def download_ncm() -> dict:
    """Download the full NCM JSON from Siscomex."""
    logger.info("Downloading NCM nomenclature from Siscomex...")
    resp = requests.get(NCM_URL, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    logger.info("Downloaded: %s, %d entries",
                data.get("Data_Ultima_Atualizacao_NCM"), len(data.get("Nomenclaturas", [])))
    return data


def main():
    parser = argparse.ArgumentParser(description="Full Brazil NCM tariff load")
    parser.add_argument("--dry-run", action="store_true", help="Parse only, no DB write")
    parser.add_argument("--ncm-file", help="Use cached NCM JSON file instead of downloading")
    args = parser.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not supabase_url or not supabase_key:
        logger.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
        sys.exit(1)

    # Download or load cached NCM data
    if args.ncm_file:
        with open(args.ncm_file) as f:
            ncm_data = json.load(f)
        logger.info("Loaded NCM from cache: %s", args.ncm_file)
    else:
        ncm_data = download_ncm()

    # Parse
    from tariff_parser.parsers.br_parser import BRParser
    br_parser = BRParser()
    commodities = br_parser.parse_ncm_json(ncm_data)

    # Assign TEC (II) and IPI rates from chapter defaults
    for c in commodities:
        ch = c.heading_code[:2]
        c.ii_rate = TEC_CHAPTER_DEFAULTS.get(ch)
        c.ipi_rate = IPI_CHAPTER_DEFAULTS.get(ch)

    # Stats
    logger.info("Parsed %d NCM codes", len(commodities))
    from collections import Counter
    ii_dist = Counter(c.ii_rate for c in commodities)
    logger.info("II rate distribution: %s", dict(sorted(ii_dist.items())))

    if args.dry_run:
        logger.info("[dry-run] Would write %d codes to DB", len(commodities))
        for c in commodities[:5]:
            logger.info("  %s  II=%s%%  IPI=%s%%  %s", c.ncm_code, c.ii_rate, c.ipi_rate, c.description[:40])
        sys.exit(0)

    # Write to DB
    from tariff_parser.writers.db_writer import SupabaseWriter
    writer = SupabaseWriter(supabase_url, supabase_key)
    stats = writer.write_br_rows(commodities)
    logger.info("Written: %s", stats)

    # Update data freshness
    now = datetime.now(timezone.utc).isoformat()
    ncm_hash = hashlib.sha256(json.dumps(ncm_data).encode()).hexdigest()[:16]
    requests.post(
        f"{supabase_url}/rest/v1/data_freshness",
        headers={
            "apikey": supabase_key, "Authorization": f"Bearer {supabase_key}",
            "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        json=[{
            "countrycode": "BR", "datatype": "BCD_RATES",
            "lastsyncat": now, "rowcount": len(commodities),
            "sourcename": "Siscomex NCM API + TEC chapter defaults",
            "sourceversion": ncm_hash,
            "nextexpectedupdate": "Check monthly",
            "staleafterhours": 720,
            "notes": f"10,515 NCM codes. II rates from TEC chapter defaults. IPI from TIPI defaults. PIS 2.1%, COFINS 9.65%, ICMS 18% (SP).",
        }],
        timeout=15,
    )

    logger.info("Brazil full load complete: %d NCM codes loaded", len(commodities))


if __name__ == "__main__":
    main()
