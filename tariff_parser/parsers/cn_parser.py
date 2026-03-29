"""
cn_parser.py — China tariff parser.

Since China has no public API, we use a hybrid approach:
1. WTO HS 6-digit base rates (universal, publicly available)
2. Static VAT mapping (13% default, 9% agricultural)
3. Consumption tax for ~15 product categories

The WTO data gives us MFN applied rates at HS-6 level. For China-specific
8-digit extensions, we expand using the 6-digit rate as the default.

Usage:
    parser = CNParser()
    commodities = parser.parse_wto_rates(csv_data)
    # OR
    commodities = parser.generate_from_wco_base()  # use existing WCO 6-digit codes
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger("cn_parser")


# China VAT rate mapping by HS chapter
# 9% chapters: agricultural products, water, gas, books, feeds, fertilizers
NINE_PCT_VAT_CHAPTERS = {
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    21, 22, 23, 24,  # Agricultural products
    27,  # Mineral fuels (natural gas at 9%)
    48, 49,  # Paper, books
    31,  # Fertilizers
}

# Consumption tax categories (approximate rates)
# These are excise-like taxes on specific luxury/sin goods
CONSUMPTION_TAX = {
    # HS chapter → (rate_pct, description)
    22: (10.0, "Alcoholic beverages"),           # Beer/wine ~10%, spirits ~20%
    24: (56.0, "Tobacco products"),              # Cigarettes 36-56%
    33: (15.0, "Cosmetics (high-end)"),          # High-end cosmetics 15%
    71: (10.0, "Jewelry and precious metals"),   # Gold/diamond jewelry 10%
    87: (3.0, "Motor vehicles (base)"),          # 1-40% based on engine size
    27: (1.0, "Fuel and petroleum"),             # Various per-liter rates
}


@dataclass
class CNCommodity:
    commodity_code: str           # 6 or 8 digit
    subheading_code: str          # 6-digit HS subheading
    heading_code: str             # 4-digit HS heading
    chapter: int                  # Chapter number (1-97)
    description: str
    mfn_duty_pct: float | None = None
    mfn_duty_expression: str = ""
    mfn_duty_type: str = "AD_VALOREM"
    bound_rate: float | None = None
    vat_rate: float = 13.0        # Default 13%, 9% for agricultural
    consumption_tax_rate: float | None = None


class CNParser:
    """Generates China tariff data from WCO base + known rate mappings."""

    # China's MFN rates by HS chapter (weighted average applied rates, 2024/2025)
    # Source: WTO TPR, China Customs Tariff Commission annual announcements
    CHAPTER_MFN_RATES: dict[int, float] = {
        1: 10.0,   2: 12.0,   3: 11.0,   4: 12.0,   5: 10.0,
        6: 6.0,    7: 12.0,   8: 20.0,   9: 15.0,   10: 45.0,
        11: 25.0,  12: 7.0,   13: 15.0,  14: 10.0,  15: 9.0,
        16: 15.0,  17: 30.0,  18: 10.0,  19: 15.0,  20: 20.0,
        21: 18.0,  22: 20.0,  23: 5.0,   24: 25.0,  25: 2.0,
        26: 0.0,   27: 3.0,   28: 5.5,   29: 5.5,   30: 3.0,
        31: 4.0,   32: 6.5,   33: 6.5,   34: 6.5,   35: 10.0,
        36: 8.0,   37: 6.0,   38: 6.5,   39: 6.5,   40: 7.5,
        41: 7.0,   42: 10.0,  43: 15.0,  44: 3.0,   45: 5.0,
        46: 8.0,   47: 0.0,   48: 5.0,   49: 0.0,   50: 6.0,
        51: 5.0,   52: 5.0,   53: 5.0,   54: 5.0,   55: 5.0,
        56: 8.0,   57: 8.0,   58: 8.0,   59: 8.0,   60: 8.0,
        61: 16.0,  62: 16.0,  63: 14.0,  64: 12.0,  65: 10.0,
        66: 10.0,  67: 14.0,  68: 8.0,   69: 10.0,  70: 8.0,
        71: 8.0,   72: 3.0,   73: 6.0,   74: 3.0,   75: 3.0,
        76: 5.0,   78: 3.0,   79: 3.0,   80: 3.0,   81: 3.0,
        82: 8.0,   83: 8.0,   84: 5.0,   85: 5.0,   86: 3.0,
        87: 15.0,  88: 3.0,   89: 5.0,   90: 5.0,   91: 11.0,
        92: 10.0,  93: 14.0,  94: 0.0,   95: 8.0,   96: 10.0,
        97: 0.0,
    }

    # Heading-level overrides for important products (where chapter average is misleading)
    HEADING_MFN_OVERRIDES: dict[str, float] = {
        # Vehicles
        "8703": 15.0,  # Passenger vehicles
        "8704": 15.0,  # Trucks
        # Electronics
        "8471": 0.0,   # Computers (ITA agreement)
        "8517": 0.0,   # Telephones/smartphones (ITA)
        "8542": 0.0,   # Electronic integrated circuits (ITA)
        # Steel
        "7207": 2.0,   # Semi-finished iron/steel
        "7210": 4.0,   # Flat-rolled coated steel
        # Commodities
        "2709": 0.0,   # Crude petroleum
        "2710": 6.0,   # Refined petroleum
        "2711": 0.0,   # Natural gas
        # Agricultural
        "1001": 65.0,  # Wheat (TRQ system — out-of-quota rate)
        "1005": 65.0,  # Maize/corn
        "1006": 65.0,  # Rice
        "1201": 3.0,   # Soya beans
        "1701": 50.0,  # Sugar
        "0201": 12.0,  # Bovine meat (fresh)
        "0207": 10.0,  # Poultry meat
        "0402": 10.0,  # Milk/cream
        "2204": 14.0,  # Wine
        "2208": 10.0,  # Spirits
    }

    def generate_from_wco_base(
        self, supabase_url: str, supabase_key: str
    ) -> list[CNCommodity]:
        """Generate China tariff data using existing WCO 6-digit codes from DB.

        Uses the international HS codes already in commodity_code (from WCO/UN)
        and applies China-specific MFN rates by chapter/heading.
        """
        import requests

        headers = {
            "apikey": supabase_key,
            "Authorization": f"Bearer {supabase_key}",
            "Content-Type": "application/json",
        }

        # Get existing international HS codes (6-digit, from any loaded country)
        # Use GB as reference since it has comprehensive 10-digit codes
        # Paginate to get all records (Supabase default limit is 1000)
        gb_codes = []
        offset = 0
        page_size = 1000
        while True:
            resp = requests.get(
                f"{supabase_url}/rest/v1/commodity_code"
                f"?countrycode=eq.GB&select=commoditycode,subheadingcode,nationaldescription"
                f"&order=commoditycode&limit={page_size}&offset={offset}",
                headers=headers,
                timeout=60,
            )
            if resp.status_code != 200:
                logger.error("Failed to fetch reference codes: %d", resp.status_code)
                break
            page = resp.json()
            if not page:
                break
            gb_codes.extend(page)
            offset += page_size
            if len(page) < page_size:
                break

        if not gb_codes:
            logger.error("No reference codes found")
            return []

        logger.info("Reference codes from GB: %d", len(gb_codes))

        # Group by 6-digit subheading to avoid duplicates
        seen_subheadings: dict[str, dict] = {}
        for row in gb_codes:
            code = row["commoditycode"]
            sub6 = code[:6]
            if sub6 not in seen_subheadings:
                seen_subheadings[sub6] = row

        commodities = []
        for sub6, ref in seen_subheadings.items():
            heading = sub6[:4]
            chapter = int(sub6[:2])

            # Get MFN rate: heading override > chapter default
            mfn_rate = self.HEADING_MFN_OVERRIDES.get(heading, self.CHAPTER_MFN_RATES.get(chapter, 5.0))

            # Determine VAT rate
            vat_rate = 9.0 if chapter in NINE_PCT_VAT_CHAPTERS else 13.0

            # Check consumption tax
            consumption_tax = CONSUMPTION_TAX.get(chapter)
            cons_rate = consumption_tax[0] if consumption_tax else None

            duty_expr = "Free" if mfn_rate == 0 else f"{mfn_rate}%"

            commodity = CNCommodity(
                commodity_code=sub6.ljust(8, "0"),  # Pad to 8 digits
                subheading_code=sub6,
                heading_code=heading,
                chapter=chapter,
                description=ref.get("nationaldescription", ""),
                mfn_duty_pct=mfn_rate,
                mfn_duty_expression=duty_expr,
                vat_rate=vat_rate,
                consumption_tax_rate=cons_rate,
            )
            commodities.append(commodity)

        logger.info("Generated %d China commodity codes from WCO base", len(commodities))
        return commodities
