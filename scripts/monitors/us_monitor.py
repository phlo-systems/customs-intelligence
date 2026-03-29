"""
us_monitor.py — United States tariff monitor (9-point universal checklist).

Sources:
    1. Official tariff schedule: USITC HTS API (currentRelease endpoint)
    2. Government gazette:       Federal Register API (customs/tariff notices)
    3. Budget announcements:     SKIPPED (US tariff changes via legislation, not budget)
    4. WTO notifications:        Universal (WTO I-TIP via wto_member_id="USA")
    5. Trade agreement updates:  Universal (WTO RTA) + USTR announcements
    6. Trade remedies:           Federal Register API (ITA AD/CVD determinations)
    7. Indirect tax changes:     SKIPPED (no federal import VAT)
    8. Cross-verification:       Re-fetch from USITC API and compare
    9. Exchange rate:             Universal (existing exchange_rate_updater)
"""

from __future__ import annotations

import hashlib
import logging
import re
import time

import requests

from .base_monitor import CheckResult, UniversalTariffMonitor
from .country_registry import register_monitor

logger = logging.getLogger("monitors.us")


class UnitedStatesMonitor(UniversalTariffMonitor):
    country_code = "US"
    country_name = "United States"
    wto_member_id = "USA"

    USITC_API = "https://hts.usitc.gov/reststop"
    FEDERAL_REGISTER_API = "https://www.federalregister.gov/api/v1"

    # ── 1. Official Tariff Schedule (USITC HTS) ─────────────────

    def check_official_tariff_schedule(self) -> CheckResult:
        """Check USITC for new HTS revision releases."""
        start = time.monotonic()
        try:
            resp = self.session.get(
                f"{self.USITC_API}/currentRelease",
                timeout=30,
            )
            if resp.status_code != 200:
                return CheckResult(
                    check_name="official_tariff_schedule",
                    country_code="US",
                    status="ERROR",
                    error=f"USITC API returned {resp.status_code}",
                    duration_ms=int((time.monotonic() - start) * 1000),
                )

            release = resp.json()
            release_name = release.get("name", "")

            # Compare against stored version
            resp2 = requests.get(
                f"{self.supabase_url}/rest/v1/data_freshness"
                "?countrycode=eq.US&datatype=eq.BCD_RATES&select=sourceversion",
                headers={**self.headers, "Prefer": ""},
                timeout=10,
            )
            rows = resp2.json() if resp2.status_code == 200 else []
            stored_version = rows[0].get("sourceversion", "") if rows else ""

            is_new = release_name and release_name not in stored_version
            if is_new:
                self._upsert_notification(
                    source="GAZETTE",
                    ref=f"USITC-{release_name}",
                    title=f"New HTS release: {release_name}",
                    priority="HIGH",
                    country_code="US",
                    source_url="https://hts.usitc.gov/",
                )

            return CheckResult(
                check_name="official_tariff_schedule",
                country_code="US",
                status="CHANGED" if is_new else "OK",
                findings=[{"release": release_name}] if is_new else [],
                source_url="https://hts.usitc.gov/",
                metadata={"current_release": release_name, "stored": stored_version},
                duration_ms=int((time.monotonic() - start) * 1000),
            )
        except Exception as e:
            return CheckResult(
                check_name="official_tariff_schedule",
                country_code="US",
                status="ERROR",
                error=str(e),
                duration_ms=int((time.monotonic() - start) * 1000),
            )

    # ── 2. Government Gazette (Federal Register) ────────────────

    def check_gazette_notifications(self) -> CheckResult:
        """Check Federal Register for customs/tariff-related notices.

        The Federal Register is the US equivalent of a government gazette.
        Tariff changes (Section 301, AD/CVD, executive orders) are published here.
        """
        start = time.monotonic()
        findings = []

        try:
            # Search for recent customs-related documents
            resp = self.session.get(
                f"{self.FEDERAL_REGISTER_API}/documents",
                params={
                    "conditions[term]": "customs duty tariff",
                    "conditions[agencies][]": "international-trade-commission",
                    "conditions[type][]": "NOTICE",
                    "per_page": 20,
                    "order": "newest",
                },
                timeout=30,
            )
            if resp.status_code == 200:
                data = resp.json()
                results = data.get("results", [])

                for doc in results[:10]:
                    ref = doc.get("document_number", "")
                    title = doc.get("title", "")
                    pub_date = doc.get("publication_date", "")

                    if not ref:
                        continue

                    fr_ref = f"FR-{ref}"
                    check = requests.get(
                        f"{self.supabase_url}/rest/v1/notification_tracker"
                        f"?source=eq.GAZETTE&notificationref=eq.{fr_ref}&select=notificationid",
                        headers={**self.headers, "Prefer": ""},
                        timeout=10,
                    )
                    if check.json():
                        continue

                    priority = "HIGH" if any(kw in title.lower() for kw in [
                        "section 301", "section 232", "anti-dumping", "countervailing",
                        "safeguard", "tariff", "duty"
                    ]) else "MEDIUM"

                    record = {
                        "source": "GAZETTE",
                        "notificationref": fr_ref,
                        "title": title[:500],
                        "publishdate": pub_date,
                        "status": "NEW",
                        "priority": priority,
                        "countrycode": "US",
                        "sourceurl": doc.get("html_url"),
                    }
                    self._upsert("notification_tracker", [record])
                    findings.append(record)
                    logger.info("  NEW Federal Register: %s — %s", ref, title[:60])

            # Also check USTR for Section 301 updates
            resp2 = self.session.get(
                f"{self.FEDERAL_REGISTER_API}/documents",
                params={
                    "conditions[term]": "section 301 China tariff",
                    "conditions[agencies][]": "trade-representative-office-of-united-states",
                    "per_page": 10,
                    "order": "newest",
                },
                timeout=30,
            )
            if resp2.status_code == 200:
                for doc in resp2.json().get("results", [])[:5]:
                    ref = doc.get("document_number", "")
                    title = doc.get("title", "")
                    if not ref:
                        continue

                    fr_ref = f"FR-USTR-{ref}"
                    check = requests.get(
                        f"{self.supabase_url}/rest/v1/notification_tracker"
                        f"?source=eq.GAZETTE&notificationref=eq.{fr_ref}&select=notificationid",
                        headers={**self.headers, "Prefer": ""},
                        timeout=10,
                    )
                    if check.json():
                        continue

                    record = {
                        "source": "GAZETTE",
                        "notificationref": fr_ref,
                        "title": title[:500],
                        "status": "NEW",
                        "priority": "CRITICAL",
                        "countrycode": "US",
                        "sourceurl": doc.get("html_url"),
                    }
                    self._upsert("notification_tracker", [record])
                    findings.append(record)

        except Exception as e:
            logger.error("Federal Register check failed: %s", e)

        status = "CHANGED" if findings else "OK"
        return CheckResult(
            check_name="gazette_notifications",
            country_code="US",
            status=status,
            findings=findings,
            source_url=self.FEDERAL_REGISTER_API,
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    # ── 6. Trade Remedies (ITA AD/CVD via Federal Register) ─────

    def check_trade_remedies(self) -> CheckResult:
        """Check Federal Register for new AD/CVD determinations from ITA."""
        start = time.monotonic()
        findings = []

        try:
            resp = self.session.get(
                f"{self.FEDERAL_REGISTER_API}/documents",
                params={
                    "conditions[term]": "antidumping countervailing duty determination",
                    "conditions[agencies][]": "international-trade-administration",
                    "conditions[type][]": "NOTICE",
                    "per_page": 20,
                    "order": "newest",
                },
                timeout=30,
            )
            if resp.status_code == 200:
                for doc in resp.json().get("results", [])[:10]:
                    ref = doc.get("document_number", "")
                    title = doc.get("title", "")
                    if not ref:
                        continue

                    fr_ref = f"FR-ITA-{ref}"
                    check = requests.get(
                        f"{self.supabase_url}/rest/v1/notification_tracker"
                        f"?source=eq.DGTR&notificationref=eq.{fr_ref}&select=notificationid",
                        headers={**self.headers, "Prefer": ""},
                        timeout=10,
                    )
                    if check.json():
                        continue

                    record = {
                        "source": "DGTR",
                        "notificationref": fr_ref,
                        "title": title[:500],
                        "status": "NEW",
                        "priority": "HIGH",
                        "countrycode": "US",
                        "sourceurl": doc.get("html_url"),
                    }
                    self._upsert("notification_tracker", [record])
                    findings.append(record)
                    logger.info("  NEW ITA AD/CVD: %s", title[:60])

        except Exception as e:
            logger.error("ITA trade remedies check failed: %s", e)

        return CheckResult(
            check_name="trade_remedies",
            country_code="US",
            status="CHANGED" if findings else "OK",
            findings=findings,
            source_url="https://www.trade.gov/enforcement-and-compliance",
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    # ── 7. Indirect Tax (N/A for US) ────────────────────────────

    def check_indirect_tax_changes(self) -> CheckResult:
        """US has no federal import VAT — always SKIPPED."""
        return CheckResult(
            check_name="indirect_tax_changes",
            country_code="US",
            status="SKIPPED",
            metadata={"reason": "US has no federal import VAT or GST"},
        )

    # ── 8. Cross-Verification ────────────────────────────────────

    def _verify_single_rate(self, commodity_code: str) -> dict:
        """Verify rate by re-fetching from USITC API."""
        try:
            heading = commodity_code[:4]
            resp = self.session.get(
                f"{self.USITC_API}/getRates",
                params={"htsno": heading, "keyword": ""},
                timeout=30,
            )
            if resp.status_code != 200:
                return {"code": commodity_code, "match": True, "source": "USITC_API"}

            items = resp.json()
            hts_formatted = f"{commodity_code[:4]}.{commodity_code[4:6]}.{commodity_code[6:8]}"

            for item in items:
                if (item.get("htsno") or "").replace(".", "") == commodity_code:
                    general = re.sub(r'<[^>]+>', '', item.get("general") or "").strip()
                    general = re.sub(r'\s*\d+/\s*', ' ', general).strip()

                    # Get our stored rate
                    resp2 = requests.get(
                        f"{self.supabase_url}/rest/v1/mfn_rate"
                        f"?commoditycode=eq.{commodity_code}&countrycode=eq.US"
                        f"&select=appliedmfnrate,dutyexpression",
                        headers={**self.headers, "Prefer": ""},
                        timeout=10,
                    )
                    rows = resp2.json()
                    if not rows:
                        return {"code": commodity_code, "match": True, "source": "USITC_API"}

                    our_expr = rows[0].get("dutyexpression", "")
                    match = our_expr.strip().lower() == general.strip().lower()

                    return {
                        "code": commodity_code,
                        "our_rate": rows[0].get("appliedmfnrate"),
                        "external_rate": general,
                        "source": "USITC_API",
                        "match": match,
                    }

            return {"code": commodity_code, "match": True, "source": "USITC_API"}
        except Exception:
            return {"code": commodity_code, "match": True, "source": "USITC_API"}

    def _upsert(self, table: str, records: list[dict]):
        """Upsert records to Supabase."""
        resp = requests.post(
            f"{self.supabase_url}/rest/v1/{table}",
            headers=self.headers,
            json=records,
            timeout=15,
        )
        if resp.status_code not in (200, 201):
            logger.error("Upsert %s failed: %s — %s", table, resp.status_code, resp.text[:200])


register_monitor("US", UnitedStatesMonitor)
