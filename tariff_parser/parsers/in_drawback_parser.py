"""
in_drawback_parser.py — India Drawback Schedule parser.

Parses the Drawback Schedule PDF (Notification 77/2023-Customs N.T.)
Columns: Tariff Item, Description, Unit, Drawback Rate (%), Drawback Cap per unit (Rs.)

Drawback rates are applied as % of FOB value of exported goods.
"""

import logging
import re
from dataclasses import dataclass
from typing import Optional

import pdfplumber

logger = logging.getLogger(__name__)

# Tariff code at start of line: 4-8 digits
RE_CODE = re.compile(r"^(\d{4,8})\b")

# Rate: number followed by %
RE_RATE = re.compile(r"(\d+(?:\.\d+)?)\s*%")

# Nil rate
RE_NIL = re.compile(r"\bNil\b", re.IGNORECASE)

# Cap amount: standalone number (not a tariff code, not part of description)
RE_CAP = re.compile(r"(\d+(?:\.\d+)?)\s*$")

# Chapter header
RE_CHAPTER = re.compile(r"^CHAPTER\s*[–—-]\s*\d+", re.IGNORECASE)

# Units
UNITS = {"Kg", "kg", "KG", "Piece", "piece", "Pair", "pair", "Nos", "nos",
         "Mtr", "mtr", "Sq.mtr", "sq.mtr", "cu.m", "Litre", "litre", "gm", "Gm"}

# Lines to skip
SKIP_PATTERNS = [
    re.compile(r"^Schedule\s*$"),
    re.compile(r"^Drawback\b"),
    re.compile(r"^Tariff Item\b"),
    re.compile(r"^Rate\b"),
    re.compile(r"^\(1\)\s+\(2\)"),
    re.compile(r"^unit in Rs"),
    re.compile(r"^CHAPTER\s*[–—-]", re.IGNORECASE),
    # ALL CAPS chapter title lines (e.g. "LIVE ANIMALS" or "DAIRY PRODUCE; BIRDS' EGGS...")
    re.compile(r"^[A-Z][A-Z\s,;'–—-]{10,}$"),
]


@dataclass
class DrawbackEntry:
    """One parsed drawback rate entry."""
    commodity_code: str
    description: str
    unit: Optional[str]
    drawback_rate_pct: Optional[float]
    drawback_cap_amt: Optional[float]


class INDrawbackParser:
    """Parses India Drawback Schedule PDF."""

    def parse_pdf(self, pdf_path: str) -> list[DrawbackEntry]:
        """Parse the drawback schedule PDF."""
        lines = self._extract_lines(pdf_path)
        entries = self._parse_lines(lines)
        logger.info("Parsed %s: %d drawback entries from %d lines",
                     pdf_path.split("/")[-1], len(entries), len(lines))
        return entries

    def _extract_lines(self, pdf_path: str) -> list[str]:
        """Extract text lines from PDF, skipping header pages."""
        all_lines = []
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                text = page.extract_text() or ""
                for line in text.split("\n"):
                    stripped = line.strip()
                    if stripped:
                        all_lines.append(stripped)
        return all_lines

    def _should_skip(self, line: str) -> bool:
        """Check if line should be skipped."""
        for pat in SKIP_PATTERNS:
            if pat.match(line):
                return True
        return False

    def _parse_lines(self, lines: list[str]) -> list[DrawbackEntry]:
        """Parse lines into drawback entries."""
        entries = []
        i = 0
        # Skip preamble pages (notes/conditions) — start from first CHAPTER header
        while i < len(lines):
            if RE_CHAPTER.match(lines[i]):
                break
            i += 1

        while i < len(lines):
            line = lines[i]

            if self._should_skip(line):
                i += 1
                continue

            # Try to match a tariff code
            m = RE_CODE.match(line)
            if not m:
                i += 1
                continue

            code = m.group(1)
            rest = line[m.end():].strip()

            # Collect the full entry (code + description + rate + cap)
            # Rate and cap may be on same line or following lines
            description_parts = []
            unit = None
            rate_pct = None
            cap_amt = None

            # Parse rest of the code line
            unit, rate_pct, cap_amt, desc_part = self._parse_data_segment(rest)
            if desc_part:
                description_parts.append(desc_part)

            # Collect continuation lines
            j = i + 1
            while j < len(lines):
                next_line = lines[j]

                # Stop if we hit another tariff code or chapter header
                if RE_CODE.match(next_line) or RE_CHAPTER.match(next_line):
                    break
                if self._should_skip(next_line):
                    j += 1
                    continue

                # Try to extract rate/cap/unit from continuation
                cont_unit, cont_rate, cont_cap, cont_desc = self._parse_data_segment(next_line)

                if cont_rate is not None and rate_pct is None:
                    rate_pct = cont_rate
                if cont_cap is not None and cap_amt is None:
                    cap_amt = cont_cap
                if cont_unit and not unit:
                    unit = cont_unit
                if cont_desc:
                    description_parts.append(cont_desc)

                j += 1

            description = " ".join(description_parts).strip()
            # Clean up description
            description = re.sub(r"\s+", " ", description)

            entry = DrawbackEntry(
                commodity_code=code,
                description=description[:500],
                unit=unit,
                drawback_rate_pct=rate_pct,
                drawback_cap_amt=cap_amt,
            )
            entries.append(entry)
            i = j

        return entries

    def _parse_data_segment(self, text: str):
        """
        Parse a text segment for unit, rate, cap, and description.
        Returns: (unit, rate_pct, cap_amt, description_remainder)
        """
        unit = None
        rate_pct = None
        cap_amt = None

        # Check for Nil
        if RE_NIL.search(text):
            rate_pct = 0.0
            text = RE_NIL.sub("", text).strip()
            return unit, rate_pct, cap_amt, text

        # Check for rate (%)
        rate_match = RE_RATE.search(text)
        if rate_match:
            rate_pct = float(rate_match.group(1))
            before = text[:rate_match.start()].strip()
            after = text[rate_match.end():].strip()

            # Check for cap amount after rate
            if after:
                cap_match = re.match(r"^(\d+(?:\.\d+)?)\s*$", after)
                if cap_match:
                    cap_amt = float(cap_match.group(1))
                    after = ""

            # Check for unit in before text
            unit, before = self._extract_unit(before)

            desc = (before + " " + after).strip()
            return unit, rate_pct, cap_amt, desc

        # No rate found — check for unit and cap
        unit, text = self._extract_unit(text)

        # Check for standalone cap number at end
        cap_match = RE_CAP.search(text)
        if cap_match:
            val = float(cap_match.group(1))
            # Only treat as cap if it's a reasonable amount (not a tariff code fragment)
            if val < 100000:
                cap_amt = val
                text = text[:cap_match.start()].strip()

        return unit, rate_pct, cap_amt, text

    def _extract_unit(self, text: str):
        """Extract unit from text. Returns (unit, remaining_text)."""
        for u in sorted(UNITS, key=len, reverse=True):
            # Check if unit appears as a standalone word
            pattern = rf"\b{re.escape(u)}\b"
            m = re.search(pattern, text)
            if m:
                remaining = (text[:m.start()] + text[m.end():]).strip()
                return u, remaining
        return None, text
