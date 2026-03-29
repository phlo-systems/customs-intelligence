"""
us_full_load.py — Load all US HTS tariff data from USITC API.

Fetches all 98 chapters (01-99, skip 77) from the USITC REST API,
parses duty rates, and writes to Supabase.

Usage:
    export $(grep -v '^#' .env | xargs)
    python3 -m tariff_parser.us_full_load                    # all chapters
    python3 -m tariff_parser.us_full_load --chapters 09 87   # specific chapters
    python3 -m tariff_parser.us_full_load --resume-from 44   # resume after failure
    python3 -m tariff_parser.us_full_load --dry-run          # parse only, no DB write
"""

import argparse
import logging
import os
import sys
import time
from datetime import date, datetime, timezone

import requests

from tariff_parser.parsers.us_parser import USParser
from tariff_parser.writers.db_writer import SupabaseWriter

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger("us_full_load")

ALL_CHAPTERS = [str(ch).zfill(2) for ch in range(1, 100) if ch != 77]


def main():
    parser = argparse.ArgumentParser(description="Load US HTS tariff data")
    parser.add_argument("--chapters", nargs="+", help="Specific chapters to load (e.g., 09 87)")
    parser.add_argument("--resume-from", type=int, help="Resume from chapter N")
    parser.add_argument("--dry-run", action="store_true", help="Parse only, no DB write")
    parser.add_argument("--delay", type=float, default=0.5, help="Delay between API calls (seconds)")
    args = parser.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not args.dry_run and (not supabase_url or not supabase_key):
        logger.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
        sys.exit(1)

    # Determine chapters to load
    if args.chapters:
        chapters = [ch.zfill(2) for ch in args.chapters]
    elif args.resume_from:
        chapters = [ch for ch in ALL_CHAPTERS if int(ch) >= args.resume_from]
    else:
        chapters = ALL_CHAPTERS

    logger.info("US HTS Full Load — %d chapters to process", len(chapters))

    us_parser = USParser()
    writer = SupabaseWriter(supabase_url, supabase_key) if not args.dry_run else None

    total_commodities = 0
    total_written = 0
    start_time = time.time()

    for chapter in chapters:
        try:
            commodities = us_parser.fetch_chapter(chapter)
            total_commodities += len(commodities)

            if writer and commodities:
                stats = writer.write_us_rows(commodities)
                total_written += stats.get("inserted", 0)
                logger.info("Chapter %s: %d parsed, %d written",
                            chapter, len(commodities), stats.get("inserted", 0))
            else:
                logger.info("Chapter %s: %d parsed (dry-run)", chapter, len(commodities))

        except Exception as e:
            logger.error("Chapter %s failed: %s", chapter, e)

        time.sleep(args.delay)

    elapsed = time.time() - start_time
    logger.info("=" * 60)
    logger.info("US HTS Full Load Complete")
    logger.info("  Chapters:     %d", len(chapters))
    logger.info("  Commodities:  %d", total_commodities)
    logger.info("  Written:      %d", total_written)
    logger.info("  Duration:     %.1f minutes", elapsed / 60)

    # Update data_freshness
    if writer:
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
                    "countrycode": "US",
                    "datatype": "BCD_RATES",
                    "lastsyncat": datetime.now(timezone.utc).isoformat(),
                    "rowcount": total_commodities,
                    "sourcename": "USITC Harmonized Tariff Schedule",
                    "sourceversion": f"HTS {date.today().isoformat()}",
                    "staleafterhours": 720,
                    "notes": f"Loaded {len(chapters)} chapters via USITC API",
                },
                timeout=15,
            )
            logger.info("data_freshness updated for US")
        except Exception as e:
            logger.error("Failed to update data_freshness: %s", e)


if __name__ == "__main__":
    main()
