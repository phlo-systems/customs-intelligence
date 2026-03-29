"""
us_parser.py — US Harmonized Tariff Schedule (HTS) parser.

Fetches from the USITC API at hts.usitc.gov/reststop/getRates.
Returns structured USCommodity objects for writing to Supabase.

Source: https://hts.usitc.gov/
API: https://hts.usitc.gov/reststop/getRates?htsno={heading}&keyword=
No authentication required.

Usage:
    parser = USParser()
    commodities = parser.fetch_chapter("09")  # all items in chapter 09
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field

import requests

logger = logging.getLogger("us_parser")


@dataclass
class USCommodity:
    commodity_code: str           # 8-digit HTS (dots stripped)
    subheading_code: str          # 6-digit HS subheading
    heading_code: str             # 4-digit HS heading
    description: str
    mfn_duty_pct: float | None = None
    mfn_duty_expression: str = ""
    mfn_duty_type: str = "AD_VALOREM"
    mfn_specific_amt: float | None = None
    mfn_specific_uom: str | None = None
    special_rates: str = ""       # FTA preference codes + rates
    column2_rate: str = ""        # Non-NTR rate (Cuba, NK)
    supplementary_unit: str | None = None
    indent: int = 0
    section_301_ref: str | None = None  # e.g., "9903.88.15"


class USParser:
    """Parses US HTS data from the USITC API."""

    API_BASE = "https://hts.usitc.gov/reststop"

    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "Accept": "application/json",
            "User-Agent": "CustomsIntelligence/1.0 (tariff-research)",
        })

    def fetch_chapter(self, chapter: str) -> list[USCommodity]:
        """Fetch all commodity items for a chapter (e.g., '09', '87')."""
        chapter = chapter.zfill(2)
        heading = f"{chapter}01"

        logger.info("Fetching US HTS chapter %s...", chapter)
        try:
            resp = self.session.get(
                f"{self.API_BASE}/getRates",
                params={"htsno": heading, "keyword": ""},
                timeout=60,
            )
            if resp.status_code != 200:
                logger.error("Chapter %s: HTTP %d", chapter, resp.status_code)
                return []

            items = resp.json()
            if not isinstance(items, list):
                logger.error("Chapter %s: unexpected response type", chapter)
                return []

        except Exception as e:
            logger.error("Chapter %s fetch failed: %s", chapter, e)
            return []

        commodities = []
        # Build description hierarchy for inheriting parent descriptions
        desc_stack: list[str] = []

        for item in items:
            htsno = (item.get("htsno") or "").strip()
            if not htsno:
                continue

            # Strip dots to get clean code
            code_clean = htsno.replace(".", "")

            # We want 8+ digit codes (leaf items with rates)
            general = item.get("general") or ""
            if not general and len(code_clean) < 8:
                continue  # heading/subheading without rate

            # Skip if no rate data at all
            if not general:
                continue

            # Parse the HTS number
            if len(code_clean) < 4:
                continue

            heading_code = code_clean[:4]
            subheading_code = code_clean[:6] if len(code_clean) >= 6 else code_clean.ljust(6, "0")
            commodity_code = code_clean[:8] if len(code_clean) >= 8 else code_clean.ljust(8, "0")

            # Clean HTML from rate fields
            general_clean = self._strip_html(general)
            special = self._strip_html(item.get("special") or "")
            other = self._strip_html(item.get("other") or "")
            description = (item.get("description") or "").strip()

            # Parse the general (MFN) duty rate
            duty_pct, specific_amt, specific_uom, duty_type = self._parse_rate(general_clean)

            # Check for Section 301 references in footnotes
            section_301_ref = None
            for fn in (item.get("footnotes") or []):
                fn_text = fn.get("value", "")
                m = re.search(r'9903\.88\.\d+', fn_text)
                if m:
                    section_301_ref = m.group(0)

            # Get units
            units = item.get("units")
            unit_str = None
            if units and isinstance(units, list) and units:
                unit_str = units[0] if isinstance(units[0], str) else str(units[0])
            elif units and isinstance(units, str):
                unit_str = units

            commodity = USCommodity(
                commodity_code=commodity_code,
                subheading_code=subheading_code,
                heading_code=heading_code,
                description=description,
                mfn_duty_pct=duty_pct,
                mfn_duty_expression=general_clean,
                mfn_duty_type=duty_type,
                mfn_specific_amt=specific_amt,
                mfn_specific_uom=specific_uom,
                special_rates=special,
                column2_rate=other,
                supplementary_unit=unit_str,
                indent=int(item.get("indent") or 0),
                section_301_ref=section_301_ref,
            )
            commodities.append(commodity)

        logger.info("Chapter %s: %d commodities parsed", chapter, len(commodities))
        return commodities

    def fetch_all_chapters(self, delay: float = 0.5) -> list[USCommodity]:
        """Fetch all 99 chapters (skip 77 — reserved)."""
        all_commodities = []
        for ch in range(1, 100):
            if ch == 77:
                continue  # Chapter 77 is reserved
            chapter = str(ch).zfill(2)
            commodities = self.fetch_chapter(chapter)
            all_commodities.extend(commodities)
            logger.info("Running total: %d commodities", len(all_commodities))
            time.sleep(delay)
        return all_commodities

    @staticmethod
    def _strip_html(text: str) -> str:
        """Remove HTML tags from rate text."""
        if not text:
            return ""
        # Remove HTML tags
        clean = re.sub(r'<[^>]+>', '', text)
        # Normalize whitespace
        clean = re.sub(r'\s+', ' ', clean).strip()
        # Remove footnote markers like "1/" or "2/"
        clean = re.sub(r'\s*\d+/\s*', ' ', clean).strip()
        return clean

    @staticmethod
    def _parse_rate(rate_str: str) -> tuple[float | None, float | None, str | None, str]:
        """Parse a US HTS rate expression into components.

        Examples:
            "Free"                    → (0.0, None, None, "AD_VALOREM")
            "6.4%"                    → (6.4, None, None, "AD_VALOREM")
            "2.5%"                    → (2.5, None, None, "AD_VALOREM")
            "1.5¢/kg"                → (None, 0.015, "USD/kg", "SPECIFIC")
            "$1.05/kg"               → (None, 1.05, "USD/kg", "SPECIFIC")
            "3.5¢/kg + 7.5%"        → (7.5, 0.035, "USD/kg", "COMPOUND")
            "17.5%  2/"             → (17.5, None, None, "AD_VALOREM")

        Returns: (ad_valorem_pct, specific_amt, specific_uom, duty_type)
        """
        if not rate_str:
            return (None, None, None, "AD_VALOREM")

        rate_str = rate_str.strip()

        # Free
        if rate_str.lower() in ("free", "free."):
            return (0.0, None, None, "AD_VALOREM")

        ad_valorem_pct = None
        specific_amt = None
        specific_uom = None

        # Look for percentage: "6.4%" or "7.5%"
        pct_match = re.search(r'(\d+\.?\d*)\s*%', rate_str)
        if pct_match:
            ad_valorem_pct = float(pct_match.group(1))

        # Look for specific duty: "1.5¢/kg" or "$1.05/kg" or "3.5cents/kg"
        # Cents per unit
        cent_match = re.search(r'(\d+\.?\d*)\s*[¢c](?:ents?)?/(\w+)', rate_str, re.IGNORECASE)
        if cent_match:
            specific_amt = float(cent_match.group(1)) / 100.0  # Convert cents to dollars
            specific_uom = f"USD/{cent_match.group(2)}"

        # Dollars per unit
        dollar_match = re.search(r'\$(\d+\.?\d*)/(\w+)', rate_str)
        if dollar_match:
            specific_amt = float(dollar_match.group(1))
            specific_uom = f"USD/{dollar_match.group(2)}"

        # Determine duty type
        if ad_valorem_pct is not None and specific_amt is not None:
            duty_type = "COMPOUND"
        elif specific_amt is not None:
            duty_type = "SPECIFIC"
        else:
            duty_type = "AD_VALOREM"

        return (ad_valorem_pct, specific_amt, specific_uom, duty_type)
