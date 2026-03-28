"""
br_parser.py — Brazil NCM tariff parser.

Source: Siscomex public API
    NCM codes: GET https://portalunico.siscomex.gov.br/classif/api/publico/nomenclatura/download/json?perfil=PUBLICO

NCM (Nomenclatura Comum do Mercosul) codes are 8-digit, based on HS.
Format: XXXX.XX.XX (4-digit heading + 2-digit subheading + 2-digit national)

Tables written:
    COMMODITY_CODE  — (CommodityCode, CountryCode='BR')
    MFN_RATE        — II (Import Tax) rate from TEC
    VAT_RATE        — IPI, PIS, COFINS, ICMS (sequential stacking)

Brazil tax stack (sequential — NOT summed flat):
    CIF → + II → + IPI (on CIF+II) → + PIS (on CIF) → + COFINS (on CIF) → + ICMS (por dentro)
"""

import logging
import re
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class BRCommodity:
    """One parsed NCM commodity code."""
    ncm_code: str           # 8-digit, no dots (e.g. "01012100")
    ncm_formatted: str      # with dots (e.g. "0101.21.00")
    heading_code: str       # 4-digit
    subheading_code: str    # 6-digit
    description: str        # Portuguese
    ii_rate: Optional[float] = None   # Import tax (II) from TEC
    ipi_rate: Optional[float] = None  # IPI from TIPI


class BRParser:
    """Parses Brazil NCM data from Siscomex JSON."""

    def parse_ncm_json(self, data: dict) -> list[BRCommodity]:
        """Parse the Siscomex NCM JSON download."""
        nomenclaturas = data.get("Nomenclaturas", [])
        commodities = []

        for entry in nomenclaturas:
            codigo = entry.get("Codigo", "")
            descricao = entry.get("Descricao", "")

            # Clean code — remove dots
            clean = codigo.replace(".", "")

            # Only keep 8-digit leaf codes
            if len(clean) != 8 or not clean.isdigit():
                continue

            # Check it's currently active
            data_fim = entry.get("Data_Fim", "")
            if data_fim and data_fim != "31/12/9999":
                continue

            commodity = BRCommodity(
                ncm_code=clean,
                ncm_formatted=codigo,
                heading_code=clean[:4],
                subheading_code=clean[:6],
                description=self._clean_description(descricao),
            )
            commodities.append(commodity)

        logger.info("Parsed %d leaf NCM codes from Siscomex JSON", len(commodities))
        return commodities

    def _clean_description(self, text: str) -> str:
        """Clean description text."""
        # Remove leading dashes/hyphens
        text = re.sub(r"^[\s\-–—]+", "", text)
        text = re.sub(r"\s+", " ", text)
        return text.strip()[:500]
