"""
pref_rate_writer.py — Write preferential rates from ZA parser output to Supabase.

Reads the eu_uk, efta, sadc, mercosur, afcfta columns already parsed by za_parser.py
and writes them to the PREFERENTIAL_RATE table via SupabaseWriter._upsert().

Place this file at: tariff_parser/pref_rate_writer.py
"""

import logging
from datetime import date
from typing import Any

logger = logging.getLogger(__name__)

# Agreement column → list of (AgreementCode, ExportCountryCode)
# Scoped to countries currently in the COUNTRY table.
# Add more export countries here as you seed more COUNTRY rows.
PREF_COLUMN_MAP: dict[str, list[tuple[str, str]]] = {
    "eu_uk": [
        ("UK-SACU-EPA", "GB"),
        # EU27 — add when seeded: ("EU-SACU-EPA", "DE"), ("EU-SACU-EPA", "FR"), ...
    ],
    "efta": [
        # ("EFTA-SACU", "CH"), ("EFTA-SACU", "NO") — add when seeded
    ],
    "sadc": [
        ("SADC-FTA", "AO"),
        ("SADC-FTA", "NA"),
    ],
    "mercosur": [
        ("SACU-MERCOSUR", "AR"),
        ("SACU-MERCOSUR", "BR"),
        ("SACU-MERCOSUR", "UY"),
    ],
    "afcfta": [
        ("AFCFTA", "AO"),
        ("AFCFTA", "MU"),
        ("AFCFTA", "NA"),
    ],
}

EFFECTIVE_FROM = date(2026, 2, 13).isoformat()   # SARS PDF publication date


def write_pref_rates(
    rows: list,
    writer,                  # SupabaseWriter instance
    country_code: str = "ZA",
    batch_size: int = 500,
    dry_run: bool = False,
) -> dict[str, int]:
    """
    Write preferential rates to PREFERENTIAL_RATE table.

    Args:
        rows:         Parsed TariffRow list from ZAParser.parse()
        writer:       SupabaseWriter instance (uses writer._upsert internally)
        country_code: Import country — always ZA for this parser
        batch_size:   Rows per upsert batch
        dry_run:      If True, log what would be written but don't write

    Returns:
        dict: {written, skipped, errors}
    """
    stats = {"written": 0, "skipped": 0, "errors": 0}
    batch: list[dict[str, Any]] = []

    for row in rows:
        for col_name, agreement_countries in PREF_COLUMN_MAP.items():
            rate_value = getattr(row, col_name, None)
            if rate_value is None or not agreement_countries:
                stats["skipped"] += 1
                continue

            for agreement_code, export_country in agreement_countries:
                # Skip if both pref and MFN are free — no value in writing it
                if rate_value.duty_type == "FREE" and row.general.duty_type == "FREE":
                    stats["skipped"] += 1
                    continue

                pref_rate = rate_value.ad_valorem_pct or 0.0

                batch.append({
                    "commoditycode":     row.national_code,
                    "importcountrycode": country_code,
                    "exportcountrycode": export_country,
                    "agreementcode":     agreement_code,
                    "subheadingcode":    row.subheading_code,
                    "prefrate":          pref_rate,
                    "stagingcategory":   None,
                    "effectivefrom":     EFFECTIVE_FROM,
                    "effectiveto":       None,
                    "notes":             f"col={col_name} raw={rate_value.raw!r} type={rate_value.duty_type}",
                })

                if len(batch) >= batch_size:
                    stats = _flush(batch, writer, stats, dry_run)
                    batch = []

    if batch:
        stats = _flush(batch, writer, stats, dry_run)

    logger.info(
        "Pref rates — written: %d  skipped: %d  errors: %d",
        stats["written"], stats["skipped"], stats["errors"],
    )
    return stats


def _flush(batch: list, writer, stats: dict, dry_run: bool) -> dict:
    if dry_run:
        logger.info("[dry_run] Would write %d pref rate rows", len(batch))
        stats["written"] += len(batch)
        return stats
    try:
        writer._upsert("preferential_rate", batch)
        stats["written"] += len(batch)
    except Exception as exc:
        logger.error("Pref rate batch failed (%d rows): %s", len(batch), exc)
        stats["errors"] += len(batch)
    return stats
