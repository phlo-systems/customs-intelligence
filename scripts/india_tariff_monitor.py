"""
india_tariff_monitor.py — Daily monitoring script for India customs data.

This is now a thin wrapper that delegates to the universal framework
(scripts/monitors/india_monitor.py). Kept for backward compatibility
with run_daily_monitor.sh and existing cron jobs.

Usage:
    export $(grep -v '^#' .env | xargs)
    python3 -m scripts.india_tariff_monitor
    python3 -m scripts.india_tariff_monitor --check-chapters
    python3 -m scripts.india_tariff_monitor --check-notifications
    python3 -m scripts.india_tariff_monitor --report-only
    python3 -m scripts.india_tariff_monitor --full-checklist   # NEW: run all 9 checks
"""

import argparse
import logging
import os
import sys
from datetime import datetime, timezone

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger("india_monitor")


def main():
    parser = argparse.ArgumentParser(description="India tariff data monitor")
    parser.add_argument("--check-chapters", action="store_true", help="Only check CBIC chapter updates")
    parser.add_argument("--check-notifications", action="store_true", help="Only check new notifications")
    parser.add_argument("--check-dgtr", action="store_true", help="Only check DGTR cases")
    parser.add_argument("--report-only", action="store_true", help="Only generate freshness report")
    parser.add_argument("--full-checklist", action="store_true", help="Run all 9 universal checks")
    parser.add_argument("--dry-run", action="store_true", help="Run but don't persist results")
    args = parser.parse_args()

    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not supabase_url or not supabase_key:
        logger.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
        sys.exit(1)

    # Import the universal monitor
    from scripts.monitors.india_monitor import IndiaMonitor

    monitor = IndiaMonitor(supabase_url, supabase_key)

    # ── Full 9-point checklist mode ──────────────────────────────
    if args.full_checklist:
        logger.info("Running full 9-point universal checklist for India...")
        results = monitor.run_full_checklist(skip_cross_verify=True)
        report = monitor.generate_report()

        logger.info("=" * 60)
        logger.info("India Universal Checklist — Summary")
        logger.info("  Total checks:  %d", report["summary"]["total"])
        logger.info("  OK:            %d", report["summary"]["ok"])
        logger.info("  Changed:       %d", report["summary"]["changed"])
        logger.info("  Errors:        %d", report["summary"]["errors"])
        logger.info("  Skipped:       %d", report["summary"]["skipped"])
        logger.info("  Action needed: %s", report["action_required"])

        sys.exit(1 if report["action_required"] else 0)

    # ── Legacy single-check modes ────────────────────────────────
    run_all = not any([args.check_chapters, args.check_notifications, args.check_dgtr, args.report_only])
    has_action_items = False

    if run_all or args.check_chapters:
        result = monitor.check_official_tariff_schedule()
        logger.info("Stale chapters: %d", result.findings_count)
        if result.status == "CHANGED":
            has_action_items = True

    if run_all or args.check_notifications:
        result = monitor.check_gazette_notifications()
        logger.info("New notifications: %d", result.findings_count)
        if result.status == "CHANGED":
            has_action_items = True

    if run_all or args.check_dgtr:
        result = monitor.check_trade_remedies()
        logger.info("New trade remedy cases: %d", result.findings_count)
        if result.status == "CHANGED":
            has_action_items = True

    # NEW: also run the previously-missing checks in legacy mode
    if run_all:
        budget = monitor.check_budget_announcements()
        if budget.status == "CHANGED":
            logger.info("Budget announcements: %d", budget.findings_count)
            has_action_items = True

        indirect = monitor.check_indirect_tax_changes()
        if indirect.status == "CHANGED":
            logger.info("Indirect tax changes: %d", indirect.findings_count)
            has_action_items = True

    # Freshness report
    if run_all or args.report_only:
        _generate_freshness_report(supabase_url, supabase_key)

    logger.info("=" * 60)
    logger.info("India Tariff Monitor — Complete")
    sys.exit(1 if has_action_items else 0)


def _generate_freshness_report(supabase_url: str, supabase_key: str):
    """Generate data freshness summary (kept inline for backward compat)."""
    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
        "Content-Type": "application/json",
    }

    resp = requests.get(
        f"{supabase_url}/rest/v1/data_freshness?countrycode=eq.IN&select=*",
        headers=headers,
        timeout=15,
    )
    rows = resp.json()

    stale_count = 0
    for row in rows:
        last_sync = row.get("lastsyncat")
        stale_hours = row.get("staleafterhours", 720)
        if last_sync:
            sync_dt = datetime.fromisoformat(last_sync.replace("Z", "+00:00"))
            age_hours = (datetime.now(timezone.utc) - sync_dt).total_seconds() / 3600
            if age_hours > stale_hours:
                stale_count += 1
        else:
            stale_count += 1

    # Pending notifications
    resp2 = requests.get(
        f"{supabase_url}/rest/v1/notification_tracker?status=eq.NEW&countrycode=eq.IN&select=notificationid",
        headers={**headers, "Prefer": "count=exact", "Range": "0-0"},
        timeout=10,
    )
    pending = resp2.headers.get("Content-Range", "*/0").split("/")[-1]

    # Stale chapters
    resp3 = requests.get(
        f"{supabase_url}/rest/v1/cbic_chapter_sync?syncstatus=eq.STALE&countrycode=eq.IN&select=chapternum",
        headers=headers,
        timeout=10,
    )
    stale_chs = [r["chapternum"] for r in resp3.json()]

    logger.info("Freshness: %d/%d stale, %s pending notifications, %d stale chapters",
                stale_count, len(rows), pending, len(stale_chs))


if __name__ == "__main__":
    main()
