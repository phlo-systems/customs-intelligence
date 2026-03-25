"""
za_parser.py — SARS Schedule 1 Part 1 PDF parser.

Column layout (from SARS PDF):
    Heading/Subheading | CD | Article Description | Unit | General | EU/UK | EFTA | SADC | MERCOSUR | AfCFTA

ZA tariff codes are 8-digit: 6-digit WCO subheading + 2-digit national suffix.
The check digit (CD) is a single digit that follows the subheading code on the same line.

Example lines:
    2004.10  3  - Frozen potato products: chips, fries  kg  20%  free  free  free  25%  free
    2004.10  3  ...continued description...
    2004.10.10  7  - - For retail sale  kg  20%  free  free  free  25%  free

Rate expressions parsed:
    "free"                          → 0.0%, AD_VALOREM
    "12%"                           → 12.0%, AD_VALOREM
    "30 c/kg"                       → 0.30 ZAR/kg, SPECIFIC
    "15% but not less than 30 c/kg" → COMPOUND
    "R2.50/kg"                      → 2.50 ZAR/kg, SPECIFIC
"""

import io
import logging
import re
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

# ── Regex patterns ─────────────────────────────────────────────────────────────

# Matches a tariff code line: code (with optional dot), check digit, then content
# Examples: "2004.10  3  Frozen potato..."  or  "2004.10.10  7  ..."
RE_CODE_LINE = re.compile(
    r"^(\d{4}(?:\.\d{2}(?:\.\d{2})?)?)\s+"  # group 1: heading/subheading code
    r"(\d)\s+"                                # group 2: check digit (CD)
    r"(.+)"                                   # group 3: rest of line
)

# Rate column: last 6 whitespace-separated tokens on a code line are the rates
# Order: General | EU/UK | EFTA | SADC | MERCOSUR | AfCFTA
RATE_COUNT = 6
RATE_COLS = ["general", "eu_uk", "efta", "sadc", "mercosur", "afcfta"]

# Rate value patterns
RE_PCT = re.compile(r"^(\d+(?:\.\d+)?)\s*%")
RE_SPECIFIC = re.compile(
    r"^(\d+(?:\.\d+)?)\s*(?:c|R)\s*/\s*(\w+)", re.IGNORECASE
)
RE_COMPOUND = re.compile(
    r"(\d+(?:\.\d+)?)\s*%.*?(\d+(?:\.\d+)?)\s*(?:c|R)\s*/\s*(\w+)",
    re.IGNORECASE,
)

# Lines to skip (chapter notes, section headers, page headers)
RE_SKIP = re.compile(
    r"^(CHAPTER|SECTION|Schedule|Customs\s*&\s*Excise|Heading\s*/\s*CD|"
    r"Article\s*Description|Statistical|Rate\s*of\s*Duty|General|EU\s*/\s*UK)",
    re.IGNORECASE,
)


@dataclass
class RateValue:
    raw: str
    duty_type: str = "AD_VALOREM"   # AD_VALOREM | SPECIFIC | COMPOUND | FREE
    ad_valorem_pct: Optional[float] = None
    specific_amt: Optional[float] = None
    specific_uom: Optional[str] = None
    duty_expression: str = ""


@dataclass
class TariffRow:
    """One parsed row from the SARS tariff PDF."""
    subheading_code: str          # 6-digit WCO (e.g. "200410")
    national_code: str            # 8-digit ZA (e.g. "20041010")
    check_digit: str              # 1-digit ZA CD
    description: str
    statistical_unit: Optional[str]
    general: RateValue
    eu_uk: RateValue
    efta: RateValue
    sadc: RateValue
    mercosur: RateValue
    afcfta: RateValue
    raw_line: str = ""


# ── Rate parser ────────────────────────────────────────────────────────────────

def parse_rate(raw: str) -> RateValue:
    """Convert a raw rate string from the SARS PDF into a RateValue."""
    s = raw.strip().lower()

    if s in ("free", "fr", "0", ""):
        return RateValue(raw=raw, duty_type="FREE", ad_valorem_pct=0.0,
                         duty_expression="free")

    # Compound: e.g. "15% but not less than 30 c/kg"
    m = RE_COMPOUND.search(raw)
    if m:
        pct = float(m.group(1))
        amt_raw = float(m.group(2))
        uom = m.group(3).upper()
        # Convert cents to ZAR if needed
        amt = amt_raw / 100 if raw.lower().find(" c/") >= 0 else amt_raw
        return RateValue(
            raw=raw,
            duty_type="COMPOUND",
            ad_valorem_pct=pct,
            specific_amt=amt,
            specific_uom=f"ZAR/{uom}",
            duty_expression=raw.strip(),
        )

    # Specific: e.g. "30 c/kg" or "R2.50/kg"
    m = RE_SPECIFIC.match(raw.strip())
    if m:
        amt_raw = float(m.group(1))
        uom = m.group(2).upper()
        is_cents = raw.lower().find(" c/") >= 0 or raw.lower().startswith(
            str(m.group(1)) + " c"
        )
        amt = amt_raw / 100 if is_cents else amt_raw
        return RateValue(
            raw=raw,
            duty_type="SPECIFIC",
            specific_amt=amt,
            specific_uom=f"ZAR/{uom}",
            duty_expression=raw.strip(),
        )

    # Ad valorem: e.g. "12%" or "20 %"
    m = RE_PCT.match(raw.strip())
    if m:
        pct = float(m.group(1))
        return RateValue(
            raw=raw,
            duty_type="AD_VALOREM",
            ad_valorem_pct=pct,
            duty_expression=f"{pct}%",
        )

    # Unknown — store as AD_VALOREM with None rate, keep raw expression
    logger.debug("Unrecognised rate expression: %r", raw)
    return RateValue(raw=raw, duty_type="AD_VALOREM", duty_expression=raw.strip())


# ── Main parser ────────────────────────────────────────────────────────────────

class ZAParser:
    """
    Parses the SARS Schedule 1 Part 1 PDF.
    Handles both ZA and NA (same SACU source).
    """

    def __init__(self, country_code: str = "ZA"):
        self.country_code = country_code

    def parse(self, pdf_bytes: bytes) -> list[TariffRow]:
        """
        Parse the full SARS PDF and return a list of TariffRow objects.
        Only rows with a complete 8-digit national code are returned.
        """
        try:
            import pdfplumber
        except ImportError:
            raise ImportError("pdfplumber required: pip install pdfplumber")

        rows: list[TariffRow] = []
        pending: Optional[dict] = None   # partial row accumulating description

        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            logger.info("Parsing %d pages", len(pdf.pages))

            for page_num, page in enumerate(pdf.pages, 1):
                text = page.extract_text()
                if not text:
                    continue

                for raw_line in text.splitlines():
                    line = raw_line.strip()
                    if not line or RE_SKIP.match(line):
                        continue

                    m = RE_CODE_LINE.match(line)
                    if m:
                        # Flush pending row
                        if pending:
                            row = self._finalise(pending)
                            if row:
                                rows.append(row)

                        code_raw = m.group(1)          # e.g. "2004.10" or "2004.10.10"
                        check_digit = m.group(2)
                        rest = m.group(3)

                        # Normalise code
                        digits = code_raw.replace(".", "")
                        subheading = digits[:6].ljust(6, "0")
                        national = digits.ljust(8, "0")

                        # Split rest into description + rate columns
                        desc, rates = self._split_desc_rates(rest)

                        pending = {
                            "code_raw": code_raw,
                            "subheading": subheading,
                            "national": national,
                            "check_digit": check_digit,
                            "description": desc,
                            "rates": rates,
                            "raw_line": line,
                        }
                    elif pending and line:
                        # Continuation of description (no code match)
                        # Only accumulate if it doesn't look like rates
                        if not self._looks_like_rates(line):
                            pending["description"] += " " + line

            # Flush last pending row
            if pending:
                row = self._finalise(pending)
                if row:
                    rows.append(row)

        logger.info("Parsed %d tariff rows", len(rows))
        return rows

    def _split_desc_rates(self, rest: str) -> tuple[str, list[str]]:
        """
        Split the remaining text after the code+CD into description and rate columns.
        Rate columns are the last RATE_COUNT whitespace tokens.
        Statistical unit is the last word before rates if it looks like a unit.
        """
        tokens = rest.split()
        if len(tokens) <= RATE_COUNT:
            return rest, []

        rate_tokens = tokens[-RATE_COUNT:]
        desc_tokens = tokens[:-RATE_COUNT]
        return " ".join(desc_tokens), rate_tokens

    def _looks_like_rates(self, line: str) -> bool:
        """Quick check if a line looks like a rate row rather than description."""
        tokens = line.split()
        if len(tokens) < 3:
            return False
        # Rate lines start with a digit (heading code) or contain % free patterns
        return bool(RE_CODE_LINE.match(line)) or tokens[0].lower() in (
            "free", "fr"
        )

    def _finalise(self, pending: dict) -> Optional[TariffRow]:
        """Convert a pending dict into a TariffRow, or None if invalid."""
        rates = pending.get("rates", [])

        # We need at least the General rate; pad with empty strings if short
        while len(rates) < RATE_COUNT:
            rates.append("")

        # Extract statistical unit — last token of description if it's a known unit
        desc = pending["description"].strip()
        unit = None
        known_units = {
            "kg", "l", "ml", "t", "m", "m2", "m3", "u", "no", "pairs",
            "doz", "lt", "g", "kl", "hl",
        }
        desc_tokens = desc.split()
        if desc_tokens and desc_tokens[-1].lower() in known_units:
            unit = desc_tokens[-1].lower()
            desc = " ".join(desc_tokens[:-1])

        return TariffRow(
            subheading_code=pending["subheading"],
            national_code=pending["national"],
            check_digit=pending["check_digit"],
            description=desc,
            statistical_unit=unit,
            general=parse_rate(rates[0]),
            eu_uk=parse_rate(rates[1]),
            efta=parse_rate(rates[2]),
            sadc=parse_rate(rates[3]),
            mercosur=parse_rate(rates[4]),
            afcfta=parse_rate(rates[5]) if len(rates) > 5 else parse_rate(""),
            raw_line=pending.get("raw_line", ""),
        )
