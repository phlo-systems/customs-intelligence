"""
db_writer.py — Writes parsed tariff rows to Supabase via REST API.

Writes to three tables in order:
    1. COMMODITY_CODE  — upsert by (CommodityCode, CountryCode)
    2. MFN_RATE        — upsert by (CommodityCode, CountryCode, RateCategory, EffectiveFrom)
    3. TARIFF_RATE     — upsert by (CommodityCode, CountryCode, EffectiveFrom)

Also writes to SOURCE_SYNC_CHANGE for any detected changes.

TARIFF_RATE_HIST is written exclusively by the DB trigger — never written here.
"""

import logging
import os
from datetime import date
from typing import Optional

import requests

from tariff_parser.parsers.za_parser import TariffRow, RateValue
from tariff_parser.parsers.gb_parser import GBCommodity

logger = logging.getLogger(__name__)


class SupabaseWriter:
    """
    Writes parsed tariff data to Supabase via the REST API.
    Uses upsert (INSERT ... ON CONFLICT DO UPDATE) throughout.
    """

    def __init__(
        self,
        supabase_url: Optional[str] = None,
        supabase_key: Optional[str] = None,
    ):
        self.url = (supabase_url or os.environ["SUPABASE_URL"]).rstrip("/")
        self.key = supabase_key or os.environ["SUPABASE_SERVICE_KEY"]
        self.headers = {
            "apikey": self.key,
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",   # upsert behaviour
        }
        self.effective_date = date.today().isoformat()

    # ── Public entry point ───────────────────────────────────────────────────

    def write_za_rows(
        self,
        rows: list[TariffRow],
        country_code: str,
        hs_version: str = "HS 2022",
        batch_size: int = 200,
    ) -> dict:
        """
        Write a list of parsed ZA TariffRows to Supabase.
        Returns summary stats: {inserted, updated, errored}
        """
        stats = {"inserted": 0, "updated": 0, "errored": 0}

        commodity_batch = []
        mfn_batch = []
        tariff_batch = []

        for row in rows:
            commodity_batch.append(
                self._build_commodity_code(row, country_code, hs_version)
            )
            # General (MFN applied) rate
            mfn_batch.append(
                self._build_mfn_rate(row, country_code, "APPLIED")
            )
            # Tariff rate summary row
            tariff_batch.append(
                self._build_tariff_rate(row, country_code)
            )

        # Write in batches
        for i in range(0, len(commodity_batch), batch_size):
            chunk = commodity_batch[i:i + batch_size]
            result = self._upsert("commodity_code", chunk)
            stats["inserted"] += result.get("count", 0)

        for i in range(0, len(mfn_batch), batch_size):
            chunk = mfn_batch[i:i + batch_size]
            self._upsert("mfn_rate", chunk)

        for i in range(0, len(tariff_batch), batch_size):
            chunk = tariff_batch[i:i + batch_size]
            self._upsert("tariff_rate", chunk)

        logger.info(
            "Wrote %d rows for %s: commodity=%d mfn=%d tariff=%d",
            len(rows), country_code,
            len(commodity_batch), len(mfn_batch), len(tariff_batch),
        )
        return stats

    # ── GB writer ─────────────────────────────────────────────────────────────

    def write_gb_rows(
        self,
        commodities: list[GBCommodity],
        hs_version: str = "HS 2022",
        batch_size: int = 200,
    ) -> dict:
        """
        Write a list of parsed GBCommodity objects to Supabase.
        Returns summary stats: {inserted, updated, errored}
        """
        stats = {"inserted": 0, "updated": 0, "errored": 0}

        commodity_batch = []
        mfn_batch = []
        tariff_batch = []
        vat_batch = []

        for c in commodities:
            commodity_batch.append({
                "commoditycode": c.commodity_code,
                "countrycode": "GB",
                "subheadingcode": c.subheading_code,
                "hsversion": hs_version,
                "nationaldescription": c.description[:500],
                "supplementaryunit": c.supplementary_unit,
                "codelength": "10-digit",
                "isactive": True,
            })

            duty_basis = self._duty_basis_type_str(c.mfn_duty_type)
            mfn_batch.append({
                "commoditycode": c.commodity_code,
                "countrycode": "GB",
                "ratecategory": "APPLIED",
                "dutybasistype": duty_basis,
                "appliedmfnrate": c.mfn_duty_pct,
                "specificdutyamt": c.mfn_specific_amt,
                "specificdutyuom": c.mfn_specific_uom,
                "dutyexpression": c.mfn_duty_expression,
                "valuationbasis": "CIF",
                "effectivefrom": self.effective_date,
                "effectiveto": None,
            })

            tariff_batch.append({
                "commoditycode": c.commodity_code,
                "countrycode": "GB",
                "subheadingcode": c.subheading_code,
                "appliedmfnrate": c.mfn_duty_pct,
                "valuationbasis": "CIF",
                "dutyexpression": c.mfn_duty_expression,
                "effectivefrom": self.effective_date,
                "effectiveto": None,
                "lastreviewedat": self.effective_date,
            })

            vat_batch.append({
                "commoditycode": c.commodity_code,
                "countrycode": "GB",
                "vatrate": c.vat_rate_pct,
                "vatcategory": "ZERO" if c.vat_rate_pct == 0.0 else "STANDARD",
                "effectivefrom": self.effective_date,
                "effectiveto": None,
            })

        # Write in batches
        for i in range(0, len(commodity_batch), batch_size):
            result = self._upsert("commodity_code", commodity_batch[i:i + batch_size])
            stats["inserted"] += result.get("count", 0)

        for i in range(0, len(mfn_batch), batch_size):
            self._upsert("mfn_rate", mfn_batch[i:i + batch_size])

        for i in range(0, len(tariff_batch), batch_size):
            self._upsert("tariff_rate", tariff_batch[i:i + batch_size])

        for i in range(0, len(vat_batch), batch_size):
            self._upsert("vat_rate", vat_batch[i:i + batch_size])

        logger.info(
            "GB: wrote %d rows — commodity=%d mfn=%d tariff=%d vat=%d",
            len(commodities),
            len(commodity_batch), len(mfn_batch), len(tariff_batch), len(vat_batch),
        )
        return stats

    def _duty_basis_type_str(self, duty_type: str) -> str:
        """Map duty type string to DB enum value."""
        mapping = {
            "FREE": "AD_VALOREM",
            "AD_VALOREM": "AD_VALOREM",
            "SPECIFIC": "SPECIFIC",
            "COMPOUND": "COMPOUND",
        }
        return mapping.get(duty_type, "AD_VALOREM")

    # ── Row builders ─────────────────────────────────────────────────────────

    def _build_commodity_code(
        self, row: TariffRow, country_code: str, hs_version: str
    ) -> dict:
        return {
            "commoditycode": row.national_code,
            "countrycode": country_code,
            "subheadingcode": row.subheading_code,
            "hsversion": hs_version,
            "nationaldescription": row.description[:500],
            "supplementaryunit": row.statistical_unit,
            "codelength": "8-digit",
            "isactive": True,
        }

    def _build_mfn_rate(
        self, row: TariffRow, country_code: str, rate_category: str
    ) -> dict:
        r = row.general
        return {
            "commoditycode": row.national_code,
            "countrycode": country_code,
            "ratecategory": rate_category,
            "dutybasistype": self._duty_basis_type(r),
            "appliedmfnrate": r.ad_valorem_pct,
            "specificdutyamt": r.specific_amt,
            "specificdutyuom": r.specific_uom,
            "dutyexpression": r.duty_expression or r.raw,
            "valuationbasis": "CIF",
            "effectivefrom": self.effective_date,
            "effectiveto": None,   # NULL = current
        }

    def _build_tariff_rate(self, row: TariffRow, country_code: str) -> dict:
        r = row.general
        return {
            "commoditycode": row.national_code,
            "countrycode": country_code,
            "subheadingcode": row.subheading_code,
            "appliedmfnrate": r.ad_valorem_pct,
            "valuationbasis": "CIF",
            "dutyexpression": r.duty_expression or r.raw,
            "effectivefrom": self.effective_date,
            "effectiveto": None,
            "lastreviewedat": self.effective_date,
        }

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _duty_basis_type(self, r: RateValue) -> str:
        mapping = {
            "FREE": "AD_VALOREM",
            "AD_VALOREM": "AD_VALOREM",
            "SPECIFIC": "SPECIFIC",
            "COMPOUND": "COMPOUND",
        }
        return mapping.get(r.duty_type, "AD_VALOREM")

    def _upsert(self, table: str, records: list[dict]) -> dict:
        """POST to Supabase REST with upsert semantics."""
        if not records:
            return {"count": 0}

        url = f"{self.url}/rest/v1/{table}"
        try:
            resp = requests.post(
                url,
                headers={**self.headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
                json=records,
                timeout=30,
            )
            if resp.status_code not in (200, 201):
                logger.error(
                    "Upsert failed for %s: %s — %s",
                    table, resp.status_code, resp.text[:300],
                )
                return {"count": 0, "error": resp.text}
            return {"count": len(records)}
        except requests.RequestException as exc:
            logger.error("Upsert error for %s: %s", table, exc)
            return {"count": 0, "error": str(exc)}
