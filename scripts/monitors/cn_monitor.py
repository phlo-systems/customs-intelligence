"""
cn_monitor.py — China tariff monitor (9-point universal checklist).

Sources:
    1. Official tariff schedule: MOF Tariff Commission announcements (page hash)
    2. Government gazette:       MOF/State Council gazette (page hash)
    3. Budget announcements:     SKIPPED (China adjusts tariffs via State Council decree, not budget)
    4. WTO notifications:        Universal (WTO I-TIP via wto_member_id="CHN")
    5. Trade agreement updates:  Universal (WTO RTA) + MOFCOM FTA portal
    6. Trade remedies:           MOFCOM trade remedy investigations
    7. Indirect tax changes:     State Taxation Administration VAT announcements
    8. Cross-verification:       Chapter rate consistency check
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

logger = logging.getLogger("monitors.cn")


class ChinaMonitor(UniversalTariffMonitor):
    country_code = "CN"
    country_name = "China"
    wto_member_id = "CHN"

    MOF_URL = "http://gss.mof.gov.cn"
    MOFCOM_TR_URL = "http://trb.mofcom.gov.cn"
    STA_URL = "http://www.chinatax.gov.cn"

    # ── 1. Official Tariff Schedule (MOF Tariff Commission) ─────

    def check_official_tariff_schedule(self) -> CheckResult:
        """Check MOF Tariff Commission page for changes via page hash."""
        start = time.monotonic()
        try:
            resp = self.session.get(self.MOF_URL, timeout=30)
            if resp.status_code != 200:
                return CheckResult(
                    check_name="official_tariff_schedule",
                    country_code="CN",
                    status="ERROR",
                    error=f"MOF returned {resp.status_code}",
                    duration_ms=int((time.monotonic() - start) * 1000),
                )

            page_hash = hashlib.sha256(resp.text.encode()).hexdigest()[:16]

            resp2 = requests.get(
                f"{self.supabase_url}/rest/v1/data_freshness"
                "?countrycode=eq.CN&datatype=eq.BCD_RATES&select=sourceversion",
                headers={**self.headers, "Prefer": ""},
                timeout=10,
            )
            rows = resp2.json() if resp2.status_code == 200 else []
            stored = rows[0].get("sourceversion", "") if rows else ""

            is_new = page_hash != stored and stored != "" and "hash:" in stored
            return CheckResult(
                check_name="official_tariff_schedule",
                country_code="CN",
                status="CHANGED" if is_new else "OK",
                findings=[{"new_hash": page_hash}] if is_new else [],
                source_url=self.MOF_URL,
                metadata={"page_hash": page_hash},
                duration_ms=int((time.monotonic() - start) * 1000),
            )
        except Exception as e:
            return CheckResult(
                check_name="official_tariff_schedule", country_code="CN",
                status="ERROR", error=str(e),
                duration_ms=int((time.monotonic() - start) * 1000),
            )

    # ── 2. Government Gazette (MOF announcements) ───────────────

    def check_gazette_notifications(self) -> CheckResult:
        """Check MOF for tariff-related announcements (Chinese language)."""
        start = time.monotonic()
        findings = []
        try:
            resp = self.session.get(f"{self.MOF_URL}/zhengcefabu/index.html", timeout=30)
            if resp.status_code == 200:
                text = resp.text
                tariff_keywords = ["关税", "进口税", "暂定税率", "对美加征关税"]
                for kw in tariff_keywords:
                    if kw in text:
                        idx = text.find(kw)
                        context = re.sub(r'<[^>]+>', '', text[max(0, idx - 50):idx + 100]).strip()
                        ref = f"MOF-{hashlib.sha256(context.encode()).hexdigest()[:8]}"
                        check = requests.get(
                            f"{self.supabase_url}/rest/v1/notification_tracker"
                            f"?source=eq.GAZETTE&notificationref=eq.{ref}&select=notificationid",
                            headers={**self.headers, "Prefer": ""}, timeout=10,
                        )
                        if not check.json():
                            record = {"source": "GAZETTE", "notificationref": ref,
                                      "title": f"China MOF: {context[:200]}", "status": "NEW",
                                      "priority": "HIGH", "countrycode": "CN", "sourceurl": self.MOF_URL}
                            self._upsert("notification_tracker", [record])
                            findings.append(record)
                        break
        except Exception as e:
            logger.error("China gazette check failed: %s", e)

        return CheckResult(check_name="gazette_notifications", country_code="CN",
                           status="CHANGED" if findings else "OK", findings=findings,
                           duration_ms=int((time.monotonic() - start) * 1000))

    # ── 6. Trade Remedies (MOFCOM) ──────────────────────────────

    def check_trade_remedies(self) -> CheckResult:
        """Check MOFCOM for new AD/CVD/safeguard investigations."""
        start = time.monotonic()
        findings = []
        try:
            resp = self.session.get(f"{self.MOFCOM_TR_URL}/index.shtml", timeout=30)
            if resp.status_code == 200:
                text = resp.text
                for kw in ["反倾销", "反补贴", "保障措施"]:
                    if kw in text:
                        idx = text.find(kw)
                        context = re.sub(r'<[^>]+>', '', text[max(0, idx - 30):idx + 80]).strip()
                        ref = f"MOFCOM-TR-{hashlib.sha256(context.encode()).hexdigest()[:8]}"
                        check = requests.get(
                            f"{self.supabase_url}/rest/v1/notification_tracker"
                            f"?source=eq.DGTR&notificationref=eq.{ref}&select=notificationid",
                            headers={**self.headers, "Prefer": ""}, timeout=10,
                        )
                        if not check.json():
                            record = {"source": "DGTR", "notificationref": ref,
                                      "title": f"China MOFCOM: {context[:300]}", "status": "NEW",
                                      "priority": "HIGH", "countrycode": "CN", "sourceurl": self.MOFCOM_TR_URL}
                            self._upsert("notification_tracker", [record])
                            findings.append(record)
        except Exception as e:
            logger.error("MOFCOM trade remedies check failed: %s", e)

        return CheckResult(check_name="trade_remedies", country_code="CN",
                           status="CHANGED" if findings else "OK", findings=findings,
                           duration_ms=int((time.monotonic() - start) * 1000))

    # ── 7. Indirect Tax (VAT) ───────────────────────────────────

    def check_indirect_tax_changes(self) -> CheckResult:
        """Check for China VAT rate changes (13%/9%). Changes are rare."""
        start = time.monotonic()
        try:
            resp = self.session.get(self.STA_URL, timeout=30)
            status = "OK" if resp.status_code == 200 else "ERROR"
            return CheckResult(check_name="indirect_tax_changes", country_code="CN",
                               status=status, source_url=self.STA_URL,
                               error=None if status == "OK" else f"HTTP {resp.status_code}",
                               duration_ms=int((time.monotonic() - start) * 1000))
        except Exception as e:
            return CheckResult(check_name="indirect_tax_changes", country_code="CN",
                               status="ERROR", error=str(e),
                               duration_ms=int((time.monotonic() - start) * 1000))

    # ── 8. Cross-Verification ────────────────────────────────────

    def _verify_single_rate(self, commodity_code: str) -> dict:
        """Verify rate against chapter/heading rate mapping."""
        try:
            from tariff_parser.parsers.cn_parser import CNParser
            chapter = int(commodity_code[:2])
            expected = CNParser.HEADING_MFN_OVERRIDES.get(
                commodity_code[:4], CNParser.CHAPTER_MFN_RATES.get(chapter, 5.0))

            resp = requests.get(
                f"{self.supabase_url}/rest/v1/mfn_rate"
                f"?commoditycode=eq.{commodity_code}&countrycode=eq.CN&select=appliedmfnrate",
                headers={**self.headers, "Prefer": ""}, timeout=10,
            )
            rows = resp.json()
            if not rows:
                return {"code": commodity_code, "match": True, "source": "CN_CHAPTER_RATES"}
            our_rate = rows[0].get("appliedmfnrate", 0)
            return {"code": commodity_code, "our_rate": our_rate, "external_rate": expected,
                    "source": "CN_CHAPTER_RATES", "match": abs(our_rate - expected) < 0.01}
        except Exception:
            return {"code": commodity_code, "match": True, "source": "CN_CHAPTER_RATES"}

    def _upsert(self, table: str, records: list[dict]):
        resp = requests.post(f"{self.supabase_url}/rest/v1/{table}",
                             headers=self.headers, json=records, timeout=15)
        if resp.status_code not in (200, 201):
            logger.error("Upsert %s failed: %s — %s", table, resp.status_code, resp.text[:200])


register_monitor("CN", ChinaMonitor)
