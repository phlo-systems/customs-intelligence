"""
orchestrator.py — Main entry point for the tariff parser.

Usage:
    python -m tariff_parser.orchestrator --country ZA
    python -m tariff_parser.orchestrator --country ZA --mode initial_load
    python -m tariff_parser.orchestrator --country ALL

Environment variables required:
    SUPABASE_URL          — e.g. https://epytgmksddhvwziwxhuq.supabase.co
    SUPABASE_SERVICE_KEY  — service_role key (not anon key)

Optional:
    LAST_HASH_ZA          — SHA-256 of last parsed ZA PDF (skip if unchanged)
"""

import argparse
import logging
import os
import sys
from datetime import datetime, timezone

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger("orchestrator")


def run_za(mode: str = "daily_sync") -> dict:
    """Run the ZA (and optionally NA) tariff parser."""
    from tariff_parser.config.country_config import get_config
    from tariff_parser.fetchers.pdf_fetcher import PDFFetcher
    from tariff_parser.parsers.za_parser import ZAParser
    from tariff_parser.writers.db_writer import SupabaseWriter
    from tariff_parser.pref_rate_writer import write_pref_rates

    config = get_config("ZA")
    last_hash = os.environ.get("LAST_HASH_ZA")

    result = {
        "country": "ZA",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "status": "UNKNOWN",
        "rows_parsed": 0,
        "rows_written": 0,
        "new_hash": None,
    }

    try:
        # 1. Fetch PDF
        fetcher = PDFFetcher()
        pdf_bytes, new_hash, changed = fetcher.fetch(
        url=config.source_url,
        last_hash=None if mode == "initial_load" else last_hash,
        )
        result["new_hash"] = new_hash

        if not changed and mode != "initial_load":
            logger.info("ZA: no change detected — skipping")
            result["status"] = "NO_CHANGE"
            return result

        # 2. Parse PDF
        logger.info("ZA: parsing PDF (%s bytes)", f"{len(pdf_bytes):,}")
        parser = ZAParser(country_code="ZA")
        rows = parser.parse(pdf_bytes)
        result["rows_parsed"] = len(rows)
        logger.info("ZA: parsed %d rows", len(rows))

        if not rows:
            logger.warning("ZA: no rows parsed — check PDF structure")
            result["status"] = "PARTIAL"
            return result

        # 3. Write MFN rates to Supabase
        writer = SupabaseWriter()
        stats = writer.write_za_rows(rows, country_code="ZA")
        result["rows_written"] = stats.get("inserted", 0)
        result["status"] = "SUCCESS"

        # 3b. Write preferential rates (eu_uk, sadc, mercosur, afcfta columns)
        write_pref_rates(rows, writer, country_code="ZA")

        # 4. Also write NA (same data, different country code)
        logger.info("ZA: also writing NA rows (same SACU tariff)")
        writer.write_za_rows(rows, country_code="NA")

        # 5. Print new hash so caller can persist it
        logger.info("ZA: new hash = %s", new_hash)
        logger.info(
            "ZA: set LAST_HASH_ZA=%s to skip unchanged re-runs", new_hash
        )

    except Exception as exc:
        logger.exception("ZA parser failed: %s", exc)
        result["status"] = "FAILED"
        result["error"] = str(exc)

    result["completed_at"] = datetime.now(timezone.utc).isoformat()
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Tariff parser orchestrator")
    parser.add_argument(
        "--country",
        required=True,
        help="Country code (ZA, IN, GB) or ALL",
    )
    parser.add_argument(
        "--mode",
        default="daily_sync",
        choices=["initial_load", "daily_sync"],
        help="initial_load = force re-parse even if hash unchanged",
    )
    args = parser.parse_args()

    # Validate required env vars
    required_env = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"]
    missing = [k for k in required_env if not os.environ.get(k)]
    if missing:
        logger.error("Missing required environment variables: %s", missing)
        sys.exit(1)

    country = args.country.upper()
    results = []

    if country in ("ZA", "ALL"):
        results.append(run_za(mode=args.mode))

    if country not in ("ZA", "ALL"):
        logger.error("Parser not yet implemented for country: %s", country)
        sys.exit(1)

    # Summary
    for r in results:
        status = r.get("status")
        symbol = "✅" if status == "SUCCESS" else "⏭" if status == "NO_CHANGE" else "❌"
        logger.info(
            "%s %s — status=%s rows_parsed=%d rows_written=%d",
            symbol,
            r.get("country"),
            status,
            r.get("rows_parsed", 0),
            r.get("rows_written", 0),
        )

    failed = [r for r in results if r.get("status") not in ("SUCCESS", "NO_CHANGE")]
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
