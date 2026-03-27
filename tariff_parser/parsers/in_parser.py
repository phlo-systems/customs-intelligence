"""
in_parser.py — India Customs Tariff Act 1975 PDF parser.

Parses chapter PDFs downloaded from cbic.gov.in.
Each PDF contains a tariff schedule with columns:
    (1) Tariff Item   — 4/6/8-digit HS code (spaces between digit groups)
    (2) Description of goods
    (3) Unit           — kg., u, l, m, sq.m, etc.
    (4) Standard rate  — e.g. 30%, *Free, *7.5%, **27.5%
    (5) Preferential Areas rate — usually "-"

Tables written:
    COMMODITY_CODE  — (CommodityCode, CountryCode='IN')
    MFN_RATE        — APPLIED rate, EffectiveTo=NULL
    TARIFF_RATE     — summary rate table
"""

import logging
import re
from dataclasses import dataclass, field
from typing import Optional

import pdfplumber

logger = logging.getLogger(__name__)

# Patterns
# Tariff item: 4 digits, optionally followed by 2-digit groups separated by space
# e.g. "0101", "0101 21", "0101 21 00", "2801 10 00"
RE_TARIFF_LINE = re.compile(
    r"^\*{0,3}(\d{4}(?:\s+\d{2}){0,2})\s+"  # tariff code (optional leading asterisks)
)

# Rate pattern: optional asterisks + number% or Free
# Also match bare numbers at end of line (some PDFs drop the % sign)
RE_RATE = re.compile(r"\*{0,3}(\d+(?:\.\d+)?)\s*%")
RE_RATE_BARE = re.compile(r"\s(\d+(?:\.\d+))\s*$")  # bare number at end of line
RE_FREE = re.compile(r"\*{0,3}Free%?", re.IGNORECASE)

# Unit patterns — common Indian tariff units
KNOWN_UNITS = {
    "kg.", "kg", "Kg", "KG",
    "u", "U",
    "l", "L", "l.",
    "m", "m.", "M",
    "sq.m", "sq. m", "SQM",
    "m²", "m2",
    "m³", "cu.m",
    "t", "t.", "MT",
    "g", "g.",
    "1000 u", "1000u",
    "pair", "pairs",
    "No.", "no.",
    "carat", "ct",
    "GW", "gw",
    "cm", "cm.",
}

# Lines to skip
RE_HEADER = re.compile(r"^SECTION-[IVXLC]+\s+\d*\s*CHAPTER-\d+")
RE_COL_HEADER = re.compile(r"^\(1\)\s+\(2\)\s+\(3\)")
RE_DIVIDER = re.compile(r"^_{5,}")
RE_SECTION_TITLE = re.compile(r"^[IVX]+\.?\s*[—–-]\s*[A-Z]")
RE_FOOTNOTE = re.compile(r"^\*+\s*w\.?e\.?f")


@dataclass
class INCommodity:
    """One parsed commodity from the India Customs Tariff."""
    commodity_code: str          # 8-digit (no spaces)
    heading_code: str            # 4-digit
    subheading_code: str         # 6-digit
    description: str
    unit: Optional[str] = None
    standard_rate_pct: Optional[float] = None
    standard_rate_expr: str = ""
    duty_type: str = "AD_VALOREM"
    preferential_rate_expr: str = ""


class INParser:
    """Parses India Customs Tariff PDFs using pdfplumber text extraction."""

    def parse_chapter_pdf(self, pdf_path: str) -> list[INCommodity]:
        """
        Parse a single chapter PDF and return list of INCommodity objects.
        Only returns leaf-level codes (8-digit).
        """
        lines = self._extract_lines(pdf_path)
        commodities = self._parse_lines(lines)

        logger.info(
            "Parsed %s: %d leaf commodities from %d lines",
            pdf_path.split("/")[-1], len(commodities), len(lines),
        )
        return commodities

    def _extract_lines(self, pdf_path: str) -> list[str]:
        """Extract all text lines from the PDF."""
        all_lines = []
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                text = page.extract_text() or ""
                # Normalize special characters: í → - (PDF encoding artifact)
                text = text.replace("í", "-")
                for line in text.split("\n"):
                    stripped = line.strip()
                    if stripped:
                        all_lines.append(stripped)
        return all_lines

    def _parse_lines(self, lines: list[str]) -> list[INCommodity]:
        """Parse extracted text lines into commodity objects."""
        commodities = []
        i = 0
        current_heading = ""

        while i < len(lines):
            line = lines[i]

            # Skip headers, dividers, footnotes, column headers
            if (RE_HEADER.match(line) or RE_COL_HEADER.match(line)
                    or RE_DIVIDER.match(line) or RE_FOOTNOTE.match(line)
                    or line.startswith("Tariff Item")
                    or line.startswith("Standard")
                    or line.startswith("ential")
                    or line.startswith("Areas")
                    or line.startswith("NOTE") or line.startswith("NOTES")
                    or "Omitted" in line):
                i += 1
                continue

            # Try to match a tariff item line
            m = RE_TARIFF_LINE.match(line)
            if not m:
                i += 1
                continue

            raw_code = m.group(1)
            code_clean = raw_code.replace(" ", "")
            rest = line[m.end():].strip()

            # Determine code type by digit count
            code_len = len(code_clean)

            if code_len == 4:
                current_heading = code_clean
                i += 1
                continue

            if code_len == 6:
                # 6-digit subheading — skip (not a leaf)
                i += 1
                continue

            if code_len != 8:
                i += 1
                continue

            # 8-digit code — this is a leaf commodity
            heading = code_clean[:4]
            subheading = code_clean[:6]

            # Parse the rest of the line: description, unit, rate, preferential
            description, unit, rate_expr, rate_pct, duty_type, pref_expr = (
                self._parse_rest(rest, lines, i)
            )

            # Collect continuation lines for description
            # (next lines that don't start with a tariff code)
            j = i + 1
            while j < len(lines):
                next_line = lines[j]
                if (RE_TARIFF_LINE.match(next_line)
                        or RE_HEADER.match(next_line)
                        or RE_COL_HEADER.match(next_line)
                        or RE_DIVIDER.match(next_line)
                        or RE_FOOTNOTE.match(next_line)
                        or RE_SECTION_TITLE.match(next_line)
                        or next_line.startswith("Tariff Item")
                        or next_line.startswith("*w.e.f")
                        or next_line.startswith("* w.e.f")):
                    break
                # This is a continuation of description (or contains unit/rate we missed)
                if rate_pct is None:
                    # Try to parse unit/rate from continuation
                    _, cont_unit, cont_rate_expr, cont_rate_pct, cont_duty_type, cont_pref = (
                        self._parse_rest(next_line, lines, j)
                    )
                    if cont_rate_pct is not None:
                        unit = cont_unit or unit
                        rate_expr = cont_rate_expr or rate_expr
                        rate_pct = cont_rate_pct
                        duty_type = cont_duty_type or duty_type
                    elif cont_unit:
                        unit = cont_unit
                    else:
                        description += " " + next_line
                else:
                    # Already have rate, this is just description continuation
                    # Only append if it looks like text (not a rate/unit fragment)
                    if not RE_RATE.search(next_line) and not RE_FREE.search(next_line):
                        description += " " + next_line
                j += 1

            commodity = INCommodity(
                commodity_code=code_clean,
                heading_code=heading,
                subheading_code=subheading,
                description=self._clean_description(description),
                unit=self._normalize_unit(unit),
                standard_rate_pct=rate_pct,
                standard_rate_expr=rate_expr,
                duty_type=duty_type,
                preferential_rate_expr=pref_expr,
            )
            commodities.append(commodity)
            i = j
            continue

        return commodities

    def _parse_rest(self, text: str, lines: list[str], line_idx: int):
        """
        Parse the portion after the tariff code.
        Returns: (description, unit, rate_expr, rate_pct, duty_type, pref_expr)
        """
        # Strategy: work backwards from end of line
        # The line typically ends with: <unit> <rate> <pref>
        # where pref is usually "-"

        description = text
        unit = None
        rate_expr = ""
        rate_pct = None
        duty_type = "AD_VALOREM"
        pref_expr = ""

        # Remove leading dashes that indicate hierarchy
        description = re.sub(r"^-{1,3}\s*", "", description)

        # Try to find rate at end of line
        # Pattern: ... <unit> <rate>% <pref>
        # or: ... <unit> *Free <pref>

        # Check for Free rate
        free_match = RE_FREE.search(text)
        rate_match = RE_RATE.search(text)

        if free_match or rate_match:
            if free_match and (not rate_match or free_match.start() > rate_match.start()):
                match = free_match
                rate_pct = 0.0
                duty_type = "FREE"
                rate_expr = match.group(0)
            else:
                match = rate_match
                rate_pct = float(match.group(1))
                rate_expr = match.group(0)
                duty_type = "FREE" if rate_pct == 0 else "AD_VALOREM"

            # Everything before the rate match is description + unit
            before_rate = text[:match.start()].strip()
            after_rate = text[match.end():].strip()

            # Preferential is usually what's after the rate
            pref_expr = after_rate.strip(" -") if after_rate else "-"

            # Extract unit from end of before_rate
            unit, description = self._extract_unit(before_rate)
        else:
            # Try bare number at end of line (some PDFs drop the % sign)
            bare_match = RE_RATE_BARE.search(text)
            if bare_match:
                rate_pct = float(bare_match.group(1))
                rate_expr = bare_match.group(1) + "%"
                duty_type = "FREE" if rate_pct == 0 else "AD_VALOREM"
                before_rate = text[:bare_match.start()].strip()
                unit, description = self._extract_unit(before_rate)

        # Clean description
        description = re.sub(r"^-{1,3}\s*", "", description).strip()
        # Remove trailing colons from parent descriptions
        description = description.rstrip(":")

        return description, unit, rate_expr, rate_pct, duty_type, pref_expr

    def _extract_unit(self, text: str) -> tuple[Optional[str], str]:
        """Extract unit from end of text. Returns (unit, remaining_text)."""
        text = text.rstrip()

        # Try matching common units at end of string
        unit_patterns = [
            (r"\s+(1000\s*u)\s*$", None),
            (r"\s+(sq\.?\s*m\.?)\s*$", None),
            (r"\s+(cu\.?\s*m\.?)\s*$", None),
            (r"\s+(kg\.?)\s*$", re.IGNORECASE),
            (r"\s+(m[²2³3]?\.?)\s*$", None),
            (r"\s+(l\.?)\s*$", None),
            (r"\s+(t\.?)\s*$", None),
            (r"\s+(g\.?)\s*$", None),
            (r"\s+(u)\s*$", None),
            (r"\s+(pair|pairs)\s*$", re.IGNORECASE),
            (r"\s+(No\.?)\s*$", None),
            (r"\s+(carat|ct)\s*$", re.IGNORECASE),
            (r"\s+(GW|gw)\s*$", None),
            (r"\s+(cm\.?)\s*$", None),
            (r"\s+(Tu)\s*$", None),
        ]

        for pattern, flags in unit_patterns:
            if flags:
                m = re.search(pattern, text, flags)
            else:
                m = re.search(pattern, text)
            if m:
                unit = m.group(1).strip()
                remaining = text[:m.start()].strip()
                return unit, remaining

        return None, text

    def _normalize_unit(self, unit: Optional[str]) -> Optional[str]:
        """Normalize unit strings."""
        if not unit:
            return None
        u = unit.strip().lower().rstrip(".")
        mapping = {
            "kg": "kg",
            "u": "u",
            "l": "l",
            "m": "m",
            "t": "t",
            "g": "g",
            "sq m": "m2",
            "sq.m": "m2",
            "sqm": "m2",
            "m²": "m2",
            "m2": "m2",
            "cu m": "m3",
            "cu.m": "m3",
            "m³": "m3",
            "m3": "m3",
            "1000 u": "1000u",
            "1000u": "1000u",
            "pair": "pair",
            "pairs": "pair",
            "no": "u",
            "carat": "carat",
            "ct": "carat",
            "gw": "GW",
            "cm": "cm",
            "tu": "Tu",
        }
        return mapping.get(u, unit)

    def _clean_description(self, text: str) -> str:
        """Clean up description text."""
        # Remove leading dashes/hyphens used for hierarchy
        text = re.sub(r"^[-–—]+\s*", "", text)
        # Collapse whitespace
        text = re.sub(r"\s+", " ", text)
        return text.strip()[:500]
