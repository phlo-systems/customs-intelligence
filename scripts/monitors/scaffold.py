"""
scaffold.py — Generate a new country monitor from template.

Usage:
    python3 -m scripts.monitors.scaffold --country KE --name "Kenya"
    python3 -m scripts.monitors.scaffold --country KE --name "Kenya" --wto-id KEN

Generates:
    scripts/monitors/ke_monitor.py  (with all 9 methods stubbed)
    Prints next steps to fill in country-specific sources.
"""

import argparse
import os
import sys
from pathlib import Path

from .country_registry import WTO_MEMBERS

TEMPLATE = '''"""
{country_lower}_monitor.py — {country_name} tariff monitor.

Implements the 9-point universal checklist for {country_name} ({country_code}).

Sources:
    1. Official tariff schedule: TODO — add primary tariff source URL
    2. Government gazette:       TODO — add gazette/official journal URL
    3. Budget announcements:     TODO — add budget portal URL (or leave SKIPPED)
    4. WTO notifications:        Universal (WTO I-TIP via wto_member_id="{wto_id}")
    5. Trade agreement updates:  Universal (WTO RTA) + TODO country-specific FTA portal
    6. Trade remedies:           TODO — add AD/safeguard/CVD authority URL
    7. Indirect tax changes:     TODO — add VAT/GST authority URL
    8. Cross-verification:       TODO — implement _verify_single_rate()
    9. Exchange rate:             Universal (existing exchange_rate_updater)
"""

from __future__ import annotations

import logging
import time

from .base_monitor import CheckResult, UniversalTariffMonitor
from .country_registry import register_monitor

logger = logging.getLogger("monitors.{country_lower}")


class {class_name}(UniversalTariffMonitor):
    country_code = "{country_code}"
    country_name = "{country_name}"
    wto_member_id = {wto_id_repr}

    # If this monitor also covers other countries (e.g., SACU, MERCOSUR), list them:
    # additional_countries = ["XX", "YY"]

    # ── 1. Official Tariff Schedule ──────────────────────────────

    def check_official_tariff_schedule(self) -> CheckResult:
        """TODO: Check {country_name}'s primary tariff data source.

        Options:
            - API endpoint (check for updated timestamp or hash)
            - PDF/Excel file (HTTP HEAD for Last-Modified/Content-Length/ETag)
            - Web page (hash page content after stripping dynamic elements)
        """
        raise NotImplementedError(
            "{class_name}.check_official_tariff_schedule() not yet implemented. "
            "Add the primary tariff source check for {country_name}."
        )

    # ── 2. Government Gazette ────────────────────────────────────

    def check_gazette_notifications(self) -> CheckResult:
        """TODO: Check {country_name}'s government gazette for tariff notifications.

        This catches budget/legislative changes BEFORE the tariff schedule
        file is updated. This is critical — the India Budget 2024/2025
        miss happened because we skipped this check.
        """
        raise NotImplementedError(
            "{class_name}.check_gazette_notifications() not yet implemented. "
            "Add the gazette/official journal check for {country_name}."
        )

    # ── 3. Budget Announcements ──────────────────────────────────

    # Uncomment and implement if {country_name} has budget-driven tariff changes:
    #
    # def check_budget_announcements(self) -> CheckResult:
    #     """Check {country_name}'s annual budget for tariff rate changes."""
    #     ...

    # ── 6. Trade Remedies ────────────────────────────────────────

    def check_trade_remedies(self) -> CheckResult:
        """TODO: Check for new AD/safeguard/CVD measures in {country_name}.

        Find the relevant authority:
            - Anti-dumping investigation body
            - Safeguard measures authority
            - Countervailing duty authority
        """
        raise NotImplementedError(
            "{class_name}.check_trade_remedies() not yet implemented. "
            "Add the trade remedies check for {country_name}."
        )

    # ── 7. Indirect Tax Changes ──────────────────────────────────

    def check_indirect_tax_changes(self) -> CheckResult:
        """TODO: Check for VAT/GST/sales tax rate changes in {country_name}."""
        raise NotImplementedError(
            "{class_name}.check_indirect_tax_changes() not yet implemented. "
            "Add the indirect tax check for {country_name}."
        )

    # ── 8. Cross-Verification ────────────────────────────────────

    def _verify_single_rate(self, commodity_code: str) -> dict:
        """TODO: Verify one rate against {country_name}'s authoritative source.

        Options:
            - Re-fetch from official API and compare
            - Check against WTO bound rate (heading-level, 6-digit)
            - Download a sample page and parse the rate
        """
        raise NotImplementedError(
            "{class_name}._verify_single_rate() not yet implemented. "
            "Add rate verification for {country_name}."
        )


# Register this monitor
register_monitor("{country_code}", {class_name})
'''


def main():
    parser = argparse.ArgumentParser(
        description="Generate a new country monitor from template"
    )
    parser.add_argument(
        "--country", required=True, help="2-letter ISO country code (e.g., KE)"
    )
    parser.add_argument(
        "--name", required=True, help="Full country name (e.g., Kenya)"
    )
    parser.add_argument(
        "--wto-id",
        default=None,
        help="WTO member ID (e.g., KEN). Auto-detected from registry if available.",
    )
    args = parser.parse_args()

    country_code = args.country.upper()
    country_name = args.name
    wto_id = args.wto_id or WTO_MEMBERS.get(country_code)

    # Derive names
    country_lower = country_code.lower()
    class_name = country_name.replace(" ", "").replace("-", "") + "Monitor"
    wto_id_repr = f'"{wto_id}"' if wto_id else "None"

    # Generate file
    monitors_dir = Path(__file__).parent
    output_path = monitors_dir / f"{country_lower}_monitor.py"

    if output_path.exists():
        print(f"ERROR: {output_path} already exists. Remove it first if regenerating.")
        sys.exit(1)

    content = TEMPLATE.format(
        country_code=country_code,
        country_name=country_name,
        country_lower=country_lower,
        class_name=class_name,
        wto_id=wto_id or "N/A",
        wto_id_repr=wto_id_repr,
    )

    output_path.write_text(content)
    print(f"✓ Created {output_path}")
    print()
    print(f"Next steps for {country_name} ({country_code}):")
    print(f"  1. Open {output_path}")
    print(f"  2. Fill in check_official_tariff_schedule() — primary tariff source")
    print(f"  3. Fill in check_gazette_notifications() — government gazette URL")
    print(f"  4. Fill in check_trade_remedies() — AD/safeguard/CVD authority")
    print(f"  5. Fill in check_indirect_tax_changes() — VAT/GST authority")
    print(f"  6. Fill in _verify_single_rate() — rate verification source")
    print(f"  7. Optionally implement check_budget_announcements()")
    print(f"  8. Add 'from .{country_lower}_monitor import {class_name}' to __init__.py")
    print(f"  9. Test: python3 -m scripts.monitors.scaffold --country {country_code} --dry-run")
    print()
    if not wto_id:
        print(f"  ⚠ No WTO member ID found for {country_code}. Set wto_member_id manually or pass --wto-id.")


if __name__ == "__main__":
    main()
