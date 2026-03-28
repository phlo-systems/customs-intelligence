"""
Per-country source configuration for the tariff parser.
Each entry drives the fetcher, parser, and DB writer.
"""

from dataclasses import dataclass, field
from typing import Optional


@dataclass
class CountryConfig:
    country_code: str          # ISO 2-letter
    country_name: str
    source_type: str           # API | PDF | HTML | EXCEL
    data_format: str           # JSON | PDF | HTML | CSV
    source_url: str
    valuation_basis: str       # CIF | FOB
    currency_code: str
    poll_frequency_hours: int
    auto_apply_threshold_pct: float = 5.0
    auth_method: str = "NONE"
    auth_credential_ref: Optional[str] = None  # Azure Key Vault name only
    notes: str = ""
    # Parser-specific
    parser_class: str = ""


COUNTRY_CONFIGS: dict[str, CountryConfig] = {

    "ZA": CountryConfig(
        country_code="ZA",
        country_name="South Africa",
        source_type="PDF",
        data_format="PDF",
        source_url=(
            "https://www.sars.gov.za/wp-content/uploads/Legal/SCEA1964/"
            "Legal-LPrim-CE-Sch1P1Chpt1-to-99-Schedule-No-1-Part-1-Chapters-1-to-99.pdf"
        ),
        valuation_basis="CIF",
        currency_code="ZAR",
        poll_frequency_hours=168,   # Weekly — SARS updates are irregular
        auto_apply_threshold_pct=3.0,  # ZA MU threshold: alert on any change > 3%
        notes=(
            "SACU shared tariff — also covers NA (Namibia). "
            "Single PDF for all 99 chapters. Download, SHA-256 hash, "
            "parse only if hash changed. Admin alert on any hash change."
        ),
        parser_class="ZAParser",
    ),

    "NA": CountryConfig(
        country_code="NA",
        country_name="Namibia",
        source_type="PDF",
        data_format="PDF",
        source_url=(
            "https://www.sars.gov.za/wp-content/uploads/Legal/SCEA1964/"
            "Legal-LPrim-CE-Sch1P1Chpt1-to-99-Schedule-No-1-Part-1-Chapters-1-to-99.pdf"
        ),
        valuation_basis="CIF",
        currency_code="NAD",
        poll_frequency_hours=168,
        notes="SACU member — uses same tariff PDF as ZA. Parser reuses ZAParser.",
        parser_class="ZAParser",
    ),

    "GB": CountryConfig(
        country_code="GB",
        country_name="United Kingdom",
        source_type="API",
        data_format="JSON",
        source_url="https://www.trade-tariff.service.gov.uk/uk/api/commodities/{code}",
        valuation_basis="CIF",
        currency_code="GBP",
        poll_frequency_hours=24,
        auto_apply_threshold_pct=5.0,
        notes="No auth required. Respect 1 req/sec. Fetch by 10-digit commodity code.",
        parser_class="GBParser",
    ),

    "IN": CountryConfig(
        country_code="IN",
        country_name="India",
        source_type="API",
        data_format="PDF",
        source_url="https://www.cbic.gov.in/api/cbic-content-msts/MTcyNDY0",
        valuation_basis="CIF",
        currency_code="INR",
        poll_frequency_hours=24,
        notes=(
            "CBIC API for change detection (updatedDt per chapter). "
            "PDFs served as base64-JSON. Auto-monitor + auto-update via cron. "
            "BCD + exemptions (50/2017) + SWS (10% of BCD) + IGST + AD + drawback."
        ),
        parser_class="INParser",
    ),
}


def get_config(country_code: str) -> CountryConfig:
    """Get config for a country. Raises KeyError if not configured."""
    return COUNTRY_CONFIGS[country_code.upper()]
