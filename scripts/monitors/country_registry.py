"""
country_registry.py — Maps country codes to their monitor classes.

Also provides validate_coverage() which checks that every country with
data in the DB has a registered monitor. Called at the start of every
daily cron run to catch unmonitored countries.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING

import requests

if TYPE_CHECKING:
    from .base_monitor import UniversalTariffMonitor

logger = logging.getLogger("monitors.registry")


# ── WTO Member IDs ───────────────────────────────────────────────
WTO_MEMBERS = {
    "AO": "AGO", "AR": "ARG", "AU": "AUS", "BR": "BRA", "CL": "CHL",
    "CN": "CHN", "DO": "DOM", "GB": "GBR", "IN": "IND", "MU": "MUS",
    "MX": "MEX", "NA": "NAM", "OM": "OMN", "PH": "PHL", "SA": "SAU",
    "TH": "THA", "AE": "ARE", "UY": "URY", "ZA": "ZAF",
    # EU members
    "AT": "AUT", "BE": "BEL", "BG": "BGR", "HR": "HRV", "CY": "CYP",
    "CZ": "CZE", "DK": "DNK", "EE": "EST", "FI": "FIN", "FR": "FRA",
    "DE": "DEU", "GR": "GRC", "HU": "HUN", "IE": "IRL", "IT": "ITA",
    "LV": "LVA", "LT": "LTU", "LU": "LUX", "MT": "MLT", "NL": "NLD",
    "PL": "POL", "PT": "PRT", "RO": "ROU", "SK": "SVK", "SI": "SVN",
    "ES": "ESP", "SE": "SWE",
}

EU_MEMBERS = [
    "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR",
    "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL",
    "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]


# ── COUNTRY REGISTRY ─────────────────────────────────────────────
# Maps country code → monitor class (lazy import to avoid circular deps).
# Populated by register_monitor() or by importing country modules.

_REGISTRY: dict[str, type[UniversalTariffMonitor]] = {}


def register_monitor(country_code: str, monitor_class: type[UniversalTariffMonitor]):
    """Register a monitor class for a country code."""
    _REGISTRY[country_code] = monitor_class


def get_monitor(country_code: str) -> type[UniversalTariffMonitor] | None:
    """Get the monitor class for a country code."""
    return _REGISTRY.get(country_code)


def get_all_registered() -> dict[str, type[UniversalTariffMonitor]]:
    """Get all registered monitors."""
    return dict(_REGISTRY)


def get_covered_countries() -> set[str]:
    """Get all country codes that have a registered monitor."""
    covered = set(_REGISTRY.keys())
    # Also include countries covered by monitors with additional_countries
    for cls in _REGISTRY.values():
        if hasattr(cls, "additional_countries"):
            covered.update(cls.additional_countries)
    return covered


# ── COVERAGE VALIDATION ──────────────────────────────────────────

def validate_coverage(supabase_url: str, supabase_key: str) -> list[str]:
    """
    Check that every country with data in commodity_code has a registered monitor.

    Returns list of unmonitored country codes. If non-empty, logs a CRITICAL
    alert to notification_tracker.

    Called at the start of every daily cron run.
    """
    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
        "Content-Type": "application/json",
    }

    # Get all countries with commodity data
    try:
        resp = requests.get(
            f"{supabase_url}/rest/v1/commodity_code"
            "?select=countrycode"
            "&limit=1000",
            headers=headers,
            timeout=15,
        )
        if resp.status_code != 200:
            logger.error("Failed to query commodity_code: HTTP %d", resp.status_code)
            return []

        db_countries = {row["countrycode"] for row in resp.json()}
    except Exception as e:
        logger.error("Failed to query commodity_code: %s", e)
        return []

    # Compare against registered monitors
    covered = get_covered_countries()
    unmonitored = sorted(db_countries - covered)

    if unmonitored:
        logger.critical(
            "UNMONITORED COUNTRIES with data in DB: %s — "
            "Run 'python3 -m scripts.monitors.scaffold --country XX' to create monitors",
            ", ".join(unmonitored),
        )

        # Log CRITICAL alert to notification_tracker
        for cc in unmonitored:
            try:
                ref = f"UNMONITORED-{cc}-{datetime.now(timezone.utc).strftime('%Y%m%d')}"
                requests.post(
                    f"{supabase_url}/rest/v1/notification_tracker",
                    headers={**headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
                    json={
                        "source": "CROSS_VERIFY",
                        "notificationref": ref,
                        "title": f"Country {cc} has tariff data but no registered monitor",
                        "priority": "CRITICAL",
                        "status": "NEW",
                        "countrycode": cc,
                        "affectedtables": ["commodity_code", "mfn_rate"],
                    },
                    timeout=10,
                )
            except Exception as e:
                logger.error("Failed to log unmonitored alert for %s: %s", cc, e)
    else:
        logger.info(
            "Coverage OK: all %d countries with data have registered monitors",
            len(db_countries),
        )

    return unmonitored
