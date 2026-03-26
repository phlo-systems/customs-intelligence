"""
gb_full_load.py — Load all GB commodity codes from UK Trade Tariff API.

Discovers all headings via /chapters/{ch} endpoint, then fetches
all leaf commodities per heading. Writes to Supabase in batches.

Usage:
    export $(grep -v '^#' .env | xargs)
    python3 -m tariff_parser.gb_full_load
    python3 -m tariff_parser.gb_full_load --chapters 01 02 03   # specific chapters
    python3 -m tariff_parser.gb_full_load --resume-from 44      # resume after failure
"""

import argparse
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
logger = logging.getLogger("gb_full_load")

BASE_URL = "https://www.trade-tariff.service.gov.uk/api/v2"
SLEEP = 0.3  # 300ms between requests — polite, ~3 req/sec


def get_all_chapters() -> list[str]:
    """Fetch all chapter codes (01-99) from the UK API."""
    resp = requests.get(f"{BASE_URL}/chapters",
                        headers={"Accept": "application/json"}, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    codes = []
    for ch in data.get("data", []):
        gid = ch.get("attributes", {}).get("goods_nomenclature_item_id", "")
        if gid:
            codes.append(gid[:2])

    codes.sort()
    logger.info("Found %d chapters", len(codes))
    return codes


def get_headings_for_chapter(chapter: str) -> list[str]:
    """Fetch all 4-digit heading codes for a chapter."""
    resp = requests.get(f"{BASE_URL}/chapters/{chapter}",
                        headers={"Accept": "application/json"}, timeout=30)
    if resp.status_code != 200:
        logger.warning("Chapter %s: HTTP %d", chapter, resp.status_code)
        return []

    data = resp.json()
    heading_refs = (
        data.get("data", {})
        .get("relationships", {})
        .get("headings", {})
        .get("data", [])
    )

    headings = []
    included = {item["id"]: item for item in data.get("included", [])
                if item.get("type") == "heading"}

    for ref in heading_refs:
        hid = ref.get("id", "")
        obj = included.get(hid)
        if obj:
            gid = obj.get("attributes", {}).get("goods_nomenclature_item_id", "")
            if gid and len(gid) >= 4:
                headings.append(gid[:4])

    return headings


def main():
    parser = argparse.ArgumentParser(description="Full GB tariff load")
    parser.add_argument("--chapters", nargs="+", help="Specific chapters to load")
    parser.add_argument("--resume-from", type=str, help="Resume from this chapter")
    parser.add_argument("--dry-run", action="store_true", help="Count only, no DB write")
    args = parser.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not supabase_url or not supabase_key:
        logger.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
        sys.exit(1)

    # Import the parser and writer
    from tariff_parser.parsers.gb_parser import GBParser
    from tariff_parser.writers.db_writer import SupabaseWriter

    gb_parser = GBParser(sleep_seconds=SLEEP)
    writer = SupabaseWriter(supabase_url, supabase_key)

    # Get chapters
    if args.chapters:
        chapters = [c.zfill(2) for c in args.chapters]
    else:
        chapters = get_all_chapters()
        time.sleep(SLEEP)

    if args.resume_from:
        resume = args.resume_from.zfill(2)
        chapters = [c for c in chapters if c >= resume]
        logger.info("Resuming from chapter %s (%d chapters remaining)", resume, len(chapters))

    total_commodities = 0
    total_written = 0
    start = datetime.now(timezone.utc)

    for i, chapter in enumerate(chapters):
        ch_start = time.time()

        # Get headings for this chapter
        headings = get_headings_for_chapter(chapter)
        time.sleep(SLEEP)

        if not headings:
            logger.info("[%02d/%02d] Chapter %s: no headings", i + 1, len(chapters), chapter)
            continue

        # Parse all headings in this chapter
        commodities = gb_parser.parse_headings(headings)
        total_commodities += len(commodities)

        ch_time = time.time() - ch_start

        if args.dry_run:
            logger.info("[%02d/%02d] Chapter %s: %d headings → %d commodities (%.0fs) [dry-run]",
                        i + 1, len(chapters), chapter, len(headings), len(commodities), ch_time)
            continue

        # Write to DB
        if commodities:
            stats = writer.write_gb_rows(commodities)
            total_written += stats.get("inserted", 0)

        logger.info("[%02d/%02d] Chapter %s: %d headings → %d commodities → DB (%.0fs) | Running total: %d",
                    i + 1, len(chapters), chapter, len(headings), len(commodities), ch_time, total_commodities)

    elapsed = (datetime.now(timezone.utc) - start).total_seconds()
    logger.info("=" * 60)
    logger.info("GB full load complete")
    logger.info("  Chapters: %d", len(chapters))
    logger.info("  Commodities parsed: %d", total_commodities)
    logger.info("  Rows written: %d", total_written)
    logger.info("  Time: %.0f seconds (%.1f minutes)", elapsed, elapsed / 60)


if __name__ == "__main__":
    main()
