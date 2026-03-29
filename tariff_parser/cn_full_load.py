"""
cn_full_load.py — Load China tariff data.

Generates China MFN rates from WCO base codes + chapter/heading rate mapping,
plus VAT (13%/9%) and consumption tax for applicable categories.

Usage:
    export $(grep -v '^#' .env | xargs)
    python3 -m tariff_parser.cn_full_load              # full load
    python3 -m tariff_parser.cn_full_load --dry-run    # parse only
"""

import argparse
import logging
import os
import sys
import time
from datetime import date, datetime, timezone

import requests

from tariff_parser.parsers.cn_parser import CNParser
from tariff_parser.writers.db_writer import SupabaseWriter

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger("cn_full_load")


def main():
    parser = argparse.ArgumentParser(description="Load China tariff data")
    parser.add_argument("--dry-run", action="store_true", help="Parse only, no DB write")
    args = parser.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not supabase_url or not supabase_key:
        logger.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
        sys.exit(1)

    logger.info("China Tariff Full Load — starting")
    start_time = time.time()

    cn_parser = CNParser()
    commodities = cn_parser.generate_from_wco_base(supabase_url, supabase_key)

    if not commodities:
        logger.error("No commodities generated — check that GB reference data exists")
        sys.exit(1)

    # Stats
    vat_13 = sum(1 for c in commodities if c.vat_rate == 13.0)
    vat_9 = sum(1 for c in commodities if c.vat_rate == 9.0)
    with_consumption = sum(1 for c in commodities if c.consumption_tax_rate)
    avg_mfn = sum(c.mfn_duty_pct or 0 for c in commodities) / len(commodities)
    free_count = sum(1 for c in commodities if (c.mfn_duty_pct or 0) == 0)

    logger.info("Parsed %d commodities:", len(commodities))
    logger.info("  VAT 13%%: %d, VAT 9%%: %d", vat_13, vat_9)
    logger.info("  With consumption tax: %d", with_consumption)
    logger.info("  Average MFN rate: %.1f%%", avg_mfn)
    logger.info("  Free (0%%): %d", free_count)

    if args.dry_run:
        # Show some examples
        for c in commodities[:10]:
            logger.info("  %s | MFN=%s | VAT=%s%% | %s",
                        c.commodity_code, c.mfn_duty_expression, c.vat_rate,
                        c.description[:50])
        logger.info("Dry run complete — no data written")
        return

    writer = SupabaseWriter(supabase_url, supabase_key)
    stats = writer.write_cn_rows(commodities)

    elapsed = time.time() - start_time
    logger.info("=" * 60)
    logger.info("China Tariff Full Load Complete")
    logger.info("  Commodities:  %d", len(commodities))
    logger.info("  Written:      %d", stats.get("inserted", 0))
    logger.info("  Duration:     %.1f seconds", elapsed)

    # Update data_freshness
    try:
        headers = {
            "apikey": supabase_key,
            "Authorization": f"Bearer {supabase_key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        }
        requests.post(
            f"{supabase_url}/rest/v1/data_freshness",
            headers=headers,
            json={
                "countrycode": "CN",
                "datatype": "BCD_RATES",
                "lastsyncat": datetime.now(timezone.utc).isoformat(),
                "rowcount": len(commodities),
                "sourcename": "WCO base + China chapter/heading rates (WTO TPR)",
                "sourceversion": f"CN {date.today().isoformat()}",
                "staleafterhours": 720,
                "notes": f"MFN rates + VAT 13%/9% + consumption tax. {vat_13} items at 13%, {vat_9} at 9%",
            },
            timeout=15,
        )
        logger.info("data_freshness updated for CN")
    except Exception as e:
        logger.error("Failed to update data_freshness: %s", e)


if __name__ == "__main__":
    main()
