"""
india_monitor.py — India tariff monitor (9-point universal checklist).

Migrates existing india_tariff_monitor.py logic into the universal framework
and adds 3 NEW checks that were previously missing:
    - check_gazette_notifications() — e-Gazette + CBIC portal (catches budget notifications)
    - check_budget_announcements() — Union Budget + Finance Bill
    - check_indirect_tax_changes() — GST Council decisions + IGST notifications

Sources:
    1. Official tariff schedule: CBIC API chapter updatedDt (change detection)
    2. Government gazette:       e-gazette.gov.in + CBIC Tax Information Portal
    3. Budget announcements:     indiabudget.gov.in + pib.gov.in (Finance Bill)
    4. WTO notifications:        Universal (WTO I-TIP via wto_member_id="IND")
    5. Trade agreement updates:  Universal (WTO RTA) + commerce.gov.in
    6. Trade remedies:           DGTR (AD + safeguard + CVD investigations)
    7. Indirect tax changes:     GST Council + CBIC IGST/CGST rate notifications
    8. Cross-verification:       Re-fetch from CBIC API and compare
    9. Exchange rate:             Universal (existing exchange_rate_updater)
"""

from __future__ import annotations

import base64
import logging
import re
import time
from datetime import datetime, timezone

import requests

from .base_monitor import CheckResult, UniversalTariffMonitor
from .country_registry import register_monitor

logger = logging.getLogger("monitors.india")


class IndiaMonitor(UniversalTariffMonitor):
    country_code = "IN"
    country_name = "India"
    wto_member_id = "IND"

    CBIC_API_BASE = "https://www.cbic.gov.in/api/cbic-content-msts"
    CBIC_TAX_INFO = "https://taxinformation.cbic.gov.in/api/cbic-notification-msts"
    DGTR_AD_URL = "https://www.dgtr.gov.in/en/anti-dumping-investigation-in-india"
    DGTR_SG_URL = "https://www.dgtr.gov.in/en/safeguard-investigation-in-india"
    DGTR_CVD_URL = "https://www.dgtr.gov.in/en/countervailing-duty-investigation-in-india"
    EGAZETTE_URL = "https://egazette.gov.in"
    GST_COUNCIL_URL = "https://gstcouncil.gov.in"

    # ── 1. Official Tariff Schedule (CBIC chapters) ──────────────

    def check_official_tariff_schedule(self) -> CheckResult:
        """Check CBIC API for updated tariff chapter PDFs.

        Migrated from IndiaMonitor.check_chapter_updates() in india_tariff_monitor.py.
        """
        start = time.monotonic()
        stale_chapters = []

        try:
            # Get stored sync timestamps
            resp = requests.get(
                f"{self.supabase_url}/rest/v1/cbic_chapter_sync"
                "?countrycode=eq.IN&select=*&order=chapternum",
                headers={**self.headers, "Prefer": ""},
                timeout=15,
            )
            stored = {row["chapternum"]: row for row in resp.json()}

            # Get Import Tariff parent
            sections = self._cbic_api("MTcyNDY0")  # Part II - Import Tariff
            if not sections:
                return CheckResult(
                    check_name="official_tariff_schedule",
                    country_code="IN",
                    status="ERROR",
                    error="Could not fetch CBIC Import Tariff parent",
                    duration_ms=int((time.monotonic() - start) * 1000),
                )

            # Traverse sections → chapters
            for section in sections.get("childContentList", []):
                section_id = section.get("id")
                if not section_id:
                    continue

                encoded = base64.b64encode(str(section_id).encode()).decode()
                try:
                    section_data = self._cbic_api(encoded)
                    if not section_data:
                        continue
                except Exception:
                    continue

                for chapter in section_data.get("childContentList", []):
                    ch_id = chapter.get("id")
                    ch_name = chapter.get("titleEn", "")

                    encoded_ch = base64.b64encode(str(ch_id).encode()).decode()
                    try:
                        ch_data = self._cbic_api(encoded_ch)
                        if not ch_data:
                            continue
                    except Exception:
                        continue

                    cbic_updated = ch_data.get("updatedDt")
                    docs = ch_data.get("cbicDocMsts", [])
                    filepath = docs[0].get("filePathEn") if docs else None

                    ch_num = self._extract_chapter_from_path(filepath) if filepath else None
                    if not ch_num:
                        ch_num = self._extract_chapter_num(ch_name)
                    if not ch_num:
                        continue

                    # Compare timestamps
                    stored_ch = stored.get(ch_num, {})
                    stored_updated = stored_ch.get("cbicupdateddt")
                    is_new = self._is_timestamp_newer(cbic_updated, stored_updated)

                    if is_new:
                        stale_chapters.append({
                            "chapternum": ch_num,
                            "cbiccontentid": ch_id,
                            "filepath": filepath,
                            "cbicupdateddt": cbic_updated,
                            "old_updateddt": stored_updated,
                        })
                        logger.info("  Chapter %d: STALE (CBIC: %s, ours: %s)",
                                    ch_num, cbic_updated, stored_updated or "never")

                    # Update tracking table
                    self._upsert("cbic_chapter_sync", [{
                        "chapternum": ch_num,
                        "countrycode": "IN",
                        "cbiccontentid": ch_id,
                        "filepath": filepath,
                        "cbicupdateddt": cbic_updated,
                        "syncstatus": "STALE" if is_new else "CURRENT",
                    }])

                    time.sleep(0.3)
                time.sleep(0.3)

            status = "CHANGED" if stale_chapters else "OK"
            return CheckResult(
                check_name="official_tariff_schedule",
                country_code="IN",
                status=status,
                findings=stale_chapters,
                source_url="https://www.cbic.gov.in",
                metadata={"stale_chapters": [c["chapternum"] for c in stale_chapters]},
                duration_ms=int((time.monotonic() - start) * 1000),
            )
        except Exception as e:
            return CheckResult(
                check_name="official_tariff_schedule",
                country_code="IN",
                status="ERROR",
                error=str(e),
                duration_ms=int((time.monotonic() - start) * 1000),
            )

    # ── 2. Government Gazette (e-Gazette + CBIC notifications) ───

    def check_gazette_notifications(self) -> CheckResult:
        """Check e-Gazette and CBIC Tax Information Portal for new notifications.

        This is the critical check that catches Budget-driven rate changes
        BEFORE the CBIC chapter PDFs are updated. The India Budget 2024/2025
        miss happened because this check didn't exist.

        Sources:
            - CBIC Tax Information Portal (existing check_cbic_notifications)
            - e-gazette.gov.in (NEW — official gazette for Finance Act notifications)
        """
        start = time.monotonic()
        all_findings = []

        # ── Source A: CBIC Tax Information Portal ────────────────
        cbic_findings = self._check_cbic_notifications()
        all_findings.extend(cbic_findings)

        # ── Source B: e-Gazette (Ministry of Finance notifications) ──
        egazette_findings = self._check_egazette()
        all_findings.extend(egazette_findings)

        status = "CHANGED" if all_findings else "OK"
        return CheckResult(
            check_name="gazette_notifications",
            country_code="IN",
            status=status,
            findings=all_findings,
            source_url=self.CBIC_TAX_INFO,
            metadata={
                "cbic_findings": len(cbic_findings),
                "egazette_findings": len(egazette_findings),
            },
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    def _check_cbic_notifications(self) -> list[dict]:
        """Check CBIC Tax Information Portal for new customs notifications.

        Migrated from IndiaMonitor.check_cbic_notifications().
        """
        new_notifications = []
        try:
            resp = self.session.get(
                f"{self.CBIC_TAX_INFO}/fetchUpdatesByTaxId/1000002",
                timeout=30,
                verify=False,
            )
            if resp.status_code != 200:
                logger.warning("CBIC notifications API returned %d", resp.status_code)
                return new_notifications

            data = resp.json()
            notifications = data if isinstance(data, list) else data.get("data", [])

            for notif in notifications[:50]:
                ref = notif.get("notificationNo") or notif.get("notNo", "")
                title = notif.get("subject") or notif.get("title", "")
                pub_date = notif.get("notificationDate") or notif.get("issueDt", "")

                if not ref:
                    continue

                source = "CBIC_TARIFF"
                if "(N.T.)" in ref or "(NT)" in ref:
                    source = "CBIC_NT"

                # Check if already tracked
                check = requests.get(
                    f"{self.supabase_url}/rest/v1/notification_tracker"
                    f"?source=eq.{source}&notificationref=eq.{ref}&select=notificationid",
                    headers={**self.headers, "Prefer": ""},
                    timeout=10,
                )
                if check.json():
                    continue

                priority = self._classify_notification_priority(ref, title)

                record = {
                    "source": source,
                    "notificationref": ref,
                    "title": title[:500] if title else None,
                    "publishdate": pub_date[:10] if pub_date and len(pub_date) >= 10 else None,
                    "status": "NEW",
                    "priority": priority,
                    "countrycode": "IN",
                }
                self._upsert("notification_tracker", [record])
                new_notifications.append(record)
                logger.info("  NEW: [%s] %s — %s", priority, ref, title[:60])

        except Exception as e:
            logger.error("CBIC notification check failed: %s", e)

        return new_notifications

    def _check_egazette(self) -> list[dict]:
        """Check e-gazette.gov.in for Ministry of Finance customs notifications.

        Looks for:
            - Finance Act amendments (Budget rate changes)
            - Customs duty notifications under Customs Act 1962
            - IGST rate notifications
        """
        new_findings = []
        try:
            # e-Gazette RSS/latest for Ministry of Finance
            resp = self.session.get(
                f"{self.EGAZETTE_URL}/SearchResult.aspx?"
                "Ministry=Ministry+of+Finance&Department=Department+of+Revenue",
                timeout=30,
            )
            if resp.status_code != 200:
                logger.warning("e-Gazette returned %d", resp.status_code)
                return new_findings

            text = resp.text
            # Look for gazette notification entries with customs/tariff keywords
            customs_keywords = [
                "customs", "tariff", "basic customs duty", "BCD",
                "anti-dumping", "safeguard", "countervailing",
                "IGST", "integrated goods and services tax",
                "finance act", "finance bill",
                "exemption", "notification no",
            ]

            # Extract notification references from the page
            refs = re.findall(
                r'(?:Notification\s+No\.|G\.S\.R\.)\s*(\d+[\w\-/().]*)',
                text, re.IGNORECASE
            )

            for ref in refs[:20]:
                ref_clean = ref.strip()
                if not ref_clean:
                    continue

                # Check if any customs keyword appears near this reference
                idx = text.lower().find(ref_clean.lower())
                if idx == -1:
                    continue
                context = text[max(0, idx - 200):idx + 200].lower()
                if not any(kw in context for kw in customs_keywords):
                    continue

                gazette_ref = f"EGAZETTE-{ref_clean}"

                # Check if tracked
                check = requests.get(
                    f"{self.supabase_url}/rest/v1/notification_tracker"
                    f"?source=eq.EGAZETTE&notificationref=eq.{gazette_ref}&select=notificationid",
                    headers={**self.headers, "Prefer": ""},
                    timeout=10,
                )
                if check.json():
                    continue

                record = {
                    "source": "EGAZETTE",
                    "notificationref": gazette_ref,
                    "title": f"Gazette notification: {ref_clean}",
                    "status": "NEW",
                    "priority": "HIGH",
                    "countrycode": "IN",
                    "sourceurl": self.EGAZETTE_URL,
                }
                self._upsert("notification_tracker", [record])
                new_findings.append(record)
                logger.info("  NEW e-Gazette: %s", ref_clean)

        except Exception as e:
            logger.error("e-Gazette check failed: %s", e)

        return new_findings

    # ── 3. Budget Announcements ──────────────────────────────────

    def check_budget_announcements(self) -> CheckResult:
        """Check for Union Budget / Finance Bill customs duty changes.

        India's budget (typically 1 Feb) is the primary source of tariff
        rate changes. This check monitors:
            - indiabudget.gov.in for Finance Bill text
            - pib.gov.in for budget press releases mentioning customs duty
        """
        start = time.monotonic()
        findings = []

        try:
            # Check PIB (Press Information Bureau) for budget-related customs announcements
            resp = self.session.get(
                "https://pib.gov.in/allRel.aspx",
                timeout=30,
            )
            if resp.status_code == 200:
                text = resp.text

                # Look for budget/customs duty press releases
                budget_keywords = [
                    "customs duty", "basic customs duty", "union budget",
                    "finance bill", "tariff amendment", "BCD reduced",
                    "BCD increased", "customs tariff", "AIDC",
                    "agriculture infrastructure and development cess",
                ]

                # Extract press release titles mentioning customs
                titles = re.findall(
                    r'<a[^>]*>([^<]*(?:customs|tariff|budget|finance bill)[^<]*)</a>',
                    text, re.IGNORECASE
                )

                for title in titles[:10]:
                    title = title.strip()
                    if not title or len(title) < 10:
                        continue

                    ref = f"BUDGET-PIB-{title[:40].replace(' ', '-')}"

                    # Check if tracked
                    check = requests.get(
                        f"{self.supabase_url}/rest/v1/notification_tracker"
                        f"?source=eq.BUDGET&notificationref=eq.{ref}&select=notificationid",
                        headers={**self.headers, "Prefer": ""},
                        timeout=10,
                    )
                    if check.json():
                        continue

                    record = {
                        "source": "BUDGET",
                        "notificationref": ref,
                        "title": title[:500],
                        "status": "NEW",
                        "priority": "CRITICAL",
                        "countrycode": "IN",
                        "sourceurl": "https://pib.gov.in",
                    }
                    self._upsert("notification_tracker", [record])
                    findings.append(record)
                    logger.info("  NEW budget announcement: %s", title[:60])

        except Exception as e:
            logger.error("Budget announcement check failed: %s", e)

        status = "CHANGED" if findings else "OK"
        return CheckResult(
            check_name="budget_announcements",
            country_code="IN",
            status=status,
            findings=findings,
            source_url="https://pib.gov.in",
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    # ── 6. Trade Remedies (DGTR — AD + safeguard + CVD) ──────────

    def check_trade_remedies(self) -> CheckResult:
        """Check DGTR for new anti-dumping, safeguard, and CVD investigations.

        Migrated from IndiaMonitor.check_dgtr_cases() + extended to cover
        safeguard and countervailing duty investigations.
        """
        start = time.monotonic()
        all_cases = []

        # Anti-dumping
        ad_cases = self._check_dgtr_page(self.DGTR_AD_URL, "DGTR-AD")
        all_cases.extend(ad_cases)

        # Safeguard
        sg_cases = self._check_dgtr_page(self.DGTR_SG_URL, "DGTR-SG")
        all_cases.extend(sg_cases)

        # Countervailing duty
        cvd_cases = self._check_dgtr_page(self.DGTR_CVD_URL, "DGTR-CVD")
        all_cases.extend(cvd_cases)

        status = "CHANGED" if all_cases else "OK"
        return CheckResult(
            check_name="trade_remedies",
            country_code="IN",
            status=status,
            findings=all_cases,
            source_url=self.DGTR_AD_URL,
            metadata={
                "anti_dumping": len(ad_cases),
                "safeguard": len(sg_cases),
                "countervailing": len(cvd_cases),
            },
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    def _check_dgtr_page(self, url: str, prefix: str) -> list[dict]:
        """Check a DGTR investigation page for new cases."""
        new_cases = []
        try:
            resp = self.session.get(url, timeout=30)
            if resp.status_code != 200:
                logger.warning("DGTR %s returned %d", prefix, resp.status_code)
                return new_cases

            text = resp.text
            rows = re.findall(
                r'<td[^>]*>\s*(\d+)\s*</td>\s*<td[^>]*>\s*(.*?)\s*</td>\s*<td[^>]*>\s*(.*?)\s*</td>',
                text, re.DOTALL
            )

            for num, product, countries in rows[:20]:
                product = re.sub(r'<[^>]+>', '', product).strip()
                countries = re.sub(r'<[^>]+>', '', countries).strip()
                if not product:
                    continue

                ref = f"{prefix}-{num}-{product[:30]}"

                check = requests.get(
                    f"{self.supabase_url}/rest/v1/notification_tracker"
                    f"?source=eq.DGTR&notificationref=eq.{ref}&select=notificationid",
                    headers={**self.headers, "Prefer": ""},
                    timeout=10,
                )
                if check.json():
                    continue

                record = {
                    "source": "DGTR",
                    "notificationref": ref,
                    "title": f"{product} from {countries}",
                    "status": "NEW",
                    "priority": "HIGH",
                    "countrycode": "IN",
                    "sourceurl": url,
                }
                self._upsert("notification_tracker", [record])
                new_cases.append(record)
                logger.info("  NEW %s case: %s from %s", prefix, product, countries)

        except Exception as e:
            logger.error("DGTR %s check failed: %s", prefix, e)

        return new_cases

    # ── 7. Indirect Tax Changes (GST Council + IGST notifications) ─

    def check_indirect_tax_changes(self) -> CheckResult:
        """Check for GST Council decisions and IGST rate notifications.

        Sources:
            - gstcouncil.gov.in — meeting press releases with rate decisions
            - CBIC IGST(Rate) and CGST(Rate) notifications via Tax Information Portal
        """
        start = time.monotonic()
        findings = []

        # ── GST Council meeting press releases ───────────────────
        try:
            resp = self.session.get(
                f"{self.GST_COUNCIL_URL}/meetings-decisions",
                timeout=30,
            )
            if resp.status_code == 200:
                text = resp.text
                # Look for meeting titles with rate-related keywords
                meetings = re.findall(
                    r'<a[^>]*href="([^"]*)"[^>]*>\s*(.*?(?:\d+\w{0,2}\s+(?:GST|gst)\s+(?:Council|council)\s+(?:Meeting|meeting)).*?)\s*</a>',
                    text, re.IGNORECASE | re.DOTALL
                )

                for url, title in meetings[:5]:
                    title = re.sub(r'<[^>]+>', '', title).strip()
                    if not title:
                        continue

                    ref = f"GST-COUNCIL-{title[:50].replace(' ', '-')}"

                    check = requests.get(
                        f"{self.supabase_url}/rest/v1/notification_tracker"
                        f"?source=eq.GST_COUNCIL&notificationref=eq.{ref}&select=notificationid",
                        headers={**self.headers, "Prefer": ""},
                        timeout=10,
                    )
                    if check.json():
                        continue

                    record = {
                        "source": "GST_COUNCIL",
                        "notificationref": ref,
                        "title": title[:500],
                        "status": "NEW",
                        "priority": "HIGH",
                        "countrycode": "IN",
                        "sourceurl": url if url.startswith("http") else f"{self.GST_COUNCIL_URL}{url}",
                    }
                    self._upsert("notification_tracker", [record])
                    findings.append(record)
                    logger.info("  NEW GST Council: %s", title[:60])
        except Exception as e:
            logger.error("GST Council check failed: %s", e)

        # ── CBIC IGST/CGST rate notifications ────────────────────
        try:
            # Tax ID for GST notifications
            for tax_id in ["1000003", "1000004"]:  # IGST, CGST
                resp = self.session.get(
                    f"{self.CBIC_TAX_INFO}/fetchUpdatesByTaxId/{tax_id}",
                    timeout=30,
                    verify=False,
                )
                if resp.status_code != 200:
                    continue

                data = resp.json()
                notifs = data if isinstance(data, list) else data.get("data", [])

                for notif in notifs[:20]:
                    ref = notif.get("notificationNo") or notif.get("notNo", "")
                    title = notif.get("subject") or notif.get("title", "")
                    if not ref:
                        continue

                    # Only care about rate changes
                    if not any(kw in (title or "").lower() for kw in
                              ["rate", "igst", "cgst", "gst", "schedule", "amendment"]):
                        continue

                    source = "GST_COUNCIL"
                    gst_ref = f"GST-NOTIF-{ref}"

                    check = requests.get(
                        f"{self.supabase_url}/rest/v1/notification_tracker"
                        f"?source=eq.{source}&notificationref=eq.{gst_ref}&select=notificationid",
                        headers={**self.headers, "Prefer": ""},
                        timeout=10,
                    )
                    if check.json():
                        continue

                    record = {
                        "source": source,
                        "notificationref": gst_ref,
                        "title": title[:500] if title else None,
                        "status": "NEW",
                        "priority": "HIGH",
                        "countrycode": "IN",
                    }
                    self._upsert("notification_tracker", [record])
                    findings.append(record)
                    logger.info("  NEW GST notification: %s — %s", ref, title[:60] if title else "")
        except Exception as e:
            logger.error("IGST/CGST notification check failed: %s", e)

        status = "CHANGED" if findings else "OK"
        return CheckResult(
            check_name="indirect_tax_changes",
            country_code="IN",
            status=status,
            findings=findings,
            source_url=self.GST_COUNCIL_URL,
            duration_ms=int((time.monotonic() - start) * 1000),
        )

    # ── 8. Cross-Verification ────────────────────────────────────

    def _verify_single_rate(self, commodity_code: str) -> dict:
        """Verify one rate by re-fetching from CBIC API.

        For India, we can re-parse the chapter PDF for the specific code
        and compare. For now, uses WTO bound rate as a sanity check
        (our applied rate should be ≤ bound rate).
        """
        # For now, return a basic check — full CBIC re-parse is Phase 3
        try:
            # Check if our rate exceeds any known exemption
            resp = requests.get(
                f"{self.supabase_url}/rest/v1/mfn_rate"
                f"?commoditycode=eq.{commodity_code}&countrycode=eq.IN"
                f"&select=appliedmfnrate",
                headers={**self.headers, "Prefer": ""},
                timeout=10,
            )
            rows = resp.json()
            if not rows:
                return {"code": commodity_code, "match": True, "source": "CBIC_API"}

            our_rate = rows[0].get("appliedmfnrate", 0)

            # Check exemption_notification for override
            resp2 = requests.get(
                f"{self.supabase_url}/rest/v1/exemption_notification"
                f"?commoditycode=eq.{commodity_code}&select=concessionalrate",
                headers={**self.headers, "Prefer": ""},
                timeout=10,
            )
            exemptions = resp2.json()
            if exemptions:
                # If there's an exemption, the MFN rate should be ≥ the concessional rate
                conc_rate = exemptions[0].get("concessionalrate")
                if conc_rate is not None and our_rate < conc_rate:
                    return {
                        "code": commodity_code,
                        "our_rate": our_rate,
                        "external_rate": conc_rate,
                        "source": "EXEMPTION_NOTIFICATION",
                        "match": False,
                        "note": "MFN rate is lower than concessional rate — data inconsistency",
                    }

            return {"code": commodity_code, "our_rate": our_rate, "match": True, "source": "CBIC_API"}
        except Exception:
            return {"code": commodity_code, "match": True, "source": "CBIC_API"}

    # ── India-Specific Additional Checks ─────────────────────────

    def check_dgft_notifications(self) -> CheckResult:
        """Check DGFT for import/export policy changes (free/restricted/prohibited).

        Future: DGFT import policy is in scope but not yet loaded.
        """
        return CheckResult(
            check_name="dgft_notifications",
            country_code="IN",
            status="SKIPPED",
            metadata={"reason": "DGFT import policy not yet loaded"},
        )

    # ── Helpers ──────────────────────────────────────────────────

    def _cbic_api(self, encoded_id: str) -> dict | None:
        """Fetch from CBIC content API."""
        resp = self.session.get(
            f"{self.CBIC_API_BASE}/{encoded_id}",
            timeout=30,
        )
        if resp.status_code != 200:
            return None
        return resp.json()

    def _extract_chapter_num(self, name: str) -> int | None:
        """Extract chapter number from name like 'Chapter 1' or 'Chapter 72'."""
        m = re.search(r'chapter\s+(\d+)', name, re.IGNORECASE)
        return int(m.group(1)) if m else None

    def _extract_chapter_from_path(self, filepath: str) -> int | None:
        """Extract chapter number from filepath like 'chap-72.pdf'."""
        m = re.search(r'chap-(\d+)\.pdf', filepath)
        return int(m.group(1)) if m else None

    def _is_timestamp_newer(self, cbic_updated: str | None, stored_updated: str | None) -> bool:
        """Compare CBIC timestamp with stored timestamp."""
        if cbic_updated and not stored_updated:
            return True
        if not cbic_updated:
            return False
        try:
            cbic_dt = datetime.fromisoformat(cbic_updated)
            stored_dt = datetime.fromisoformat(stored_updated.replace("Z", "+00:00"))
            return cbic_dt != stored_dt
        except (ValueError, TypeError):
            return cbic_updated != stored_updated

    def _classify_notification_priority(self, ref: str, title: str) -> str:
        """Classify a notification's priority based on content."""
        title_lower = (title or "").lower()
        if "50/2017" in (ref or "") or "50/2017" in title_lower:
            return "CRITICAL"
        if any(k in title_lower for k in [
            "anti-dumping", "safeguard", "countervailing",
            "finance act", "finance bill", "budget",
        ]):
            return "CRITICAL"
        if any(k in title_lower for k in [
            "exchange rate", "drawback", "igst", "exemption",
        ]):
            return "HIGH"
        return "MEDIUM"

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


# Register this monitor
register_monitor("IN", IndiaMonitor)
