"""
gb_parser.py — UK Trade Tariff API parser.

Source: https://www.trade-tariff.service.gov.uk/api/v2/
No auth required. Rate limit: 1 request/second.

Endpoints used:
    GET /api/v2/headings/{4-digit}       — discover all commodities under a heading
    GET /api/v2/commodities/{10-digit}   — full commodity detail inc. measures

Tables written:
    COMMODITY_CODE  — (CommodityCode, CountryCode='GB')
    MFN_RATE        — APPLIED rate, EffectiveTo=NULL
    TARIFF_RATE     — summary rate table
    VAT_RATE        — 0% or 20% per commodity

Measure type IDs:
    '103'  — Third-country duty (MFN)
    '142'  — Tariff preference
    '145'  — Preferential tariff quota
    '146'  — Preferential suspension
    '305'  — Value added tax
"""

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Optional

import requests

logger = logging.getLogger(__name__)

BASE_URL = "https://www.trade-tariff.service.gov.uk/api/v2"

# Measure type IDs
MFN_MEASURE_TYPE = "103"
PREF_MEASURE_TYPES = {"142", "145", "146"}
VAT_MEASURE_TYPE = "305"

# Rate parsing
RE_PCT = re.compile(r"(\d+(?:\.\d+)?)\s*%")
RE_SPECIFIC = re.compile(
    r"(\d+(?:\.\d+)?)\s*(GBP|£)\s*/\s*(\w+)", re.IGNORECASE
)


@dataclass
class GBCommodity:
    """One parsed commodity from the UK Trade Tariff API."""
    commodity_code: str          # 10-digit
    subheading_code: str         # 6-digit
    description: str
    mfn_duty_pct: Optional[float] = None
    mfn_duty_expression: str = ""
    mfn_duty_type: str = "AD_VALOREM"
    mfn_specific_amt: Optional[float] = None
    mfn_specific_uom: Optional[str] = None
    vat_rate_pct: float = 20.0   # UK standard VAT; overridden if 0% found
    supplementary_unit: Optional[str] = None


class GBParser:
    """
    Fetches and parses UK commodity data from the Trade Tariff API.
    """

    def __init__(self, sleep_seconds: float = 1.0):
        self.sleep_seconds = sleep_seconds
        self.session = requests.Session()
        self.session.headers.update({
            "Accept": "application/json",
            "User-Agent": "PhloCustomsIntelligence/1.0",
        })

    # ── Public API ────────────────────────────────────────────────────────────

    def fetch_heading(self, heading_code: str) -> list[str]:
        """
        Fetch all 10-digit commodity codes under a 4-digit heading.
        Returns list of commodity code strings.
        """
        url = f"{BASE_URL}/headings/{heading_code}"
        data = self._get(url)
        if not data:
            return []

        codes = []
        # The relationships.commodities.data has internal IDs, not commodity codes.
        # The actual 10-digit codes are in the included array.
        for item in data.get("included", []):
            if item.get("type") != "commodity":
                continue
            attrs = item.get("attributes", {})
            goods_id = attrs.get("goods_nomenclature_item_id", "")
            is_leaf = attrs.get("leaf", False)
            # Only collect leaf commodities (actual tradeable codes)
            if is_leaf and len(goods_id) == 10:
                codes.append(goods_id)

        logger.info("Heading %s: found %d commodity codes", heading_code, len(codes))
        return codes

    def fetch_commodity(self, commodity_code: str) -> Optional[GBCommodity]:
        """
        Fetch a single commodity and parse its measures.
        Returns GBCommodity or None if fetch fails.
        """
        url = f"{BASE_URL}/commodities/{commodity_code}"
        data = self._get(url)
        if not data:
            return None

        attrs = data.get("data", {}).get("attributes", {})
        goods_id = attrs.get("goods_nomenclature_item_id", commodity_code)
        description = self._clean_description(
            attrs.get("formatted_description", "")
            or attrs.get("description", "")
        )

        # Build lookup of included objects by (type, id)
        included = {}
        for item in data.get("included", []):
            key = (item.get("type"), str(item.get("id")))
            included[key] = item

        # Parse measures
        measures = (
            data.get("data", {})
            .get("relationships", {})
            .get("import_measures", {})
            .get("data", [])
        )

        commodity = GBCommodity(
            commodity_code=goods_id,
            subheading_code=goods_id[:6],
            description=description[:500],
        )

        for mref in measures:
            measure_id = str(mref.get("id", ""))
            measure_obj = included.get(("measure", measure_id))
            if not measure_obj:
                continue

            measure_type_id = self._get_measure_type_id(measure_obj, included)
            if not measure_type_id:
                continue

            duty_expr = self._get_duty_expression(measure_obj, included)

            if measure_type_id == MFN_MEASURE_TYPE:
                pct, specific_amt, specific_uom, duty_type = self._parse_duty(duty_expr)
                # Keep the highest / most restrictive MFN duty when multiple 103 measures exist
                if not commodity.mfn_duty_expression or duty_type not in ("FREE",):
                    # Prefer non-free over free; prefer specific/compound over ad-valorem 0%
                    is_better = (
                        not commodity.mfn_duty_expression
                        or (commodity.mfn_duty_type == "FREE" and duty_type != "FREE")
                        or (duty_type in ("SPECIFIC", "COMPOUND") and commodity.mfn_duty_type not in ("SPECIFIC", "COMPOUND"))
                        or (pct is not None and (commodity.mfn_duty_pct or 0) < pct)
                    )
                    if is_better:
                        commodity.mfn_duty_pct = pct
                        commodity.mfn_duty_expression = duty_expr
                        commodity.mfn_duty_type = duty_type
                        commodity.mfn_specific_amt = specific_amt
                        commodity.mfn_specific_uom = specific_uom

            elif measure_type_id == VAT_MEASURE_TYPE:
                pct, _, _, _ = self._parse_duty(duty_expr)
                if pct is not None:
                    commodity.vat_rate_pct = pct

        return commodity

    def parse_headings(self, heading_codes: list[str]) -> list[GBCommodity]:
        """
        Fetch and parse all commodities for a list of 4-digit headings.
        This is the main entry point for batch processing.
        """
        all_codes: list[str] = []
        for heading in heading_codes:
            codes = self.fetch_heading(heading)
            all_codes.extend(codes)
            time.sleep(self.sleep_seconds)

        logger.info("Total commodity codes to fetch: %d", len(all_codes))

        commodities: list[GBCommodity] = []
        for i, code in enumerate(all_codes):
            commodity = self.fetch_commodity(code)
            if commodity:
                commodities.append(commodity)
            else:
                logger.warning("Failed to fetch commodity %s", code)

            if (i + 1) % 50 == 0:
                logger.info("Progress: %d / %d commodities fetched", i + 1, len(all_codes))

            time.sleep(self.sleep_seconds)

        logger.info("Parsed %d commodities from %d headings", len(commodities), len(heading_codes))
        return commodities

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _get(self, url: str) -> Optional[dict]:
        """GET with error handling."""
        try:
            resp = self.session.get(url, timeout=30)
            if resp.status_code == 404:
                logger.debug("404 for %s — skipping", url)
                return None
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as exc:
            logger.error("Request failed for %s: %s", url, exc)
            return None

    def _get_measure_type_id(self, measure_obj: dict, included: dict) -> Optional[str]:
        """Extract the measure_type id from a measure's relationships."""
        mt_data = (
            measure_obj.get("relationships", {})
            .get("measure_type", {})
            .get("data", {})
        )
        mt_id = str(mt_data.get("id", ""))

        # Sometimes the id is directly the type code, sometimes we need to look it up
        if mt_id:
            mt_obj = included.get(("measure_type", mt_id))
            if mt_obj:
                return mt_obj.get("attributes", {}).get("id", mt_id)
            return mt_id
        return None

    def _get_duty_expression(self, measure_obj: dict, included: dict) -> str:
        """Build duty expression string from measure's duty_expression relationships."""
        de_list = (
            measure_obj.get("relationships", {})
            .get("duty_expression", {})
            .get("data", {})
        )
        # Could be a single object or a list
        if isinstance(de_list, dict):
            de_list = [de_list]
        if not isinstance(de_list, list):
            return ""

        parts = []
        for de_ref in de_list:
            de_id = str(de_ref.get("id", ""))
            de_obj = included.get(("duty_expression", de_id))
            if de_obj:
                expr = de_obj.get("attributes", {}).get("base", "")
                if not expr:
                    expr = de_obj.get("attributes", {}).get("formatted_base", "")
                if expr:
                    parts.append(self._clean_description(str(expr)))

        return " ".join(parts) if parts else ""

    def _parse_duty(self, expr: str) -> tuple[Optional[float], Optional[float], Optional[str], str]:
        """
        Parse a duty expression string.
        Returns: (ad_valorem_pct, specific_amt, specific_uom, duty_type)
        """
        if not expr:
            return None, None, None, "AD_VALOREM"

        s = expr.strip().lower()
        if s in ("free", "0.00 %", "0%", "0.0%", "0 %"):
            return 0.0, None, None, "FREE"

        # Check for specific duty first (before percentage, in case of compound)
        m_specific = RE_SPECIFIC.search(expr)
        m_pct = RE_PCT.search(expr)

        if m_pct and m_specific:
            # Compound
            pct = float(m_pct.group(1))
            amt = float(m_specific.group(1))
            uom = m_specific.group(3).upper()
            return pct, amt, f"GBP/{uom}", "COMPOUND"

        if m_specific:
            amt = float(m_specific.group(1))
            uom = m_specific.group(3).upper()
            return None, amt, f"GBP/{uom}", "SPECIFIC"

        if m_pct:
            pct = float(m_pct.group(1))
            return pct, None, None, "AD_VALOREM" if pct > 0 else "FREE"

        return None, None, None, "AD_VALOREM"

    def _clean_description(self, text: str) -> str:
        """Strip HTML tags and excess whitespace from description."""
        clean = re.sub(r"<[^>]+>", " ", text)
        clean = re.sub(r"\s+", " ", clean)
        return clean.strip()
