"""
base_monitor.py — UniversalTariffMonitor abstract base class.

Every country monitor MUST inherit from this class and implement the
abstract methods. The 9-point checklist ensures no monitoring gap
regardless of which country is added.

Usage:
    class IndiaMonitor(UniversalTariffMonitor):
        country_code = "IN"
        country_name = "India"
        wto_member_id = "IND"

        def check_official_tariff_schedule(self) -> CheckResult: ...
        def check_gazette_notifications(self) -> CheckResult: ...
        def check_trade_remedies(self) -> CheckResult: ...
        def check_indirect_tax_changes(self) -> CheckResult: ...
        def _verify_single_rate(self, commodity_code: str) -> dict: ...
"""

from __future__ import annotations

import logging
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

import requests

logger = logging.getLogger("monitors")


@dataclass
class CheckResult:
    """Standard result from any checklist check."""

    check_name: str
    country_code: str
    status: Literal["OK", "CHANGED", "ERROR", "SKIPPED"]
    findings: list[dict] = field(default_factory=list)
    error: str | None = None
    source_url: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    duration_ms: int = 0
    checked_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    @property
    def findings_count(self) -> int:
        return len(self.findings)


# The 9 checklist item names (used in DB and validation)
CHECKLIST_ITEMS = [
    "official_tariff_schedule",
    "gazette_notifications",
    "budget_announcements",
    "wto_notifications",
    "trade_agreement_updates",
    "trade_remedies",
    "indirect_tax_changes",
    "cross_verification",
    "exchange_rate",
]


class UniversalTariffMonitor(ABC):
    """
    Abstract base class for all country tariff monitors.

    Subclasses MUST implement:
        - check_official_tariff_schedule()
        - check_gazette_notifications()
        - check_trade_remedies()
        - check_indirect_tax_changes()
        - _verify_single_rate()

    Subclasses MAY override:
        - check_budget_announcements()  (default: SKIPPED)
        - check_wto_notifications()     (default: WTO I-TIP query)
        - check_trade_agreement_updates() (default: WTO RTA query)
        - cross_verify_rates()          (default: sample N random codes)
        - check_exchange_rate()         (default: delegates to exchange_rate_updater)
    """

    # Subclasses MUST set these
    country_code: str = ""
    country_name: str = ""
    wto_member_id: str | None = None

    # Covers multiple countries (e.g., ZA monitor also covers NA)
    additional_countries: list[str] = []

    def __init__(self, supabase_url: str, supabase_key: str):
        self.supabase_url = supabase_url.rstrip("/")
        self.supabase_key = supabase_key
        self.headers = {
            "apikey": self.supabase_key,
            "Authorization": f"Bearer {self.supabase_key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        }
        self.session = requests.Session()
        self.session.headers.update({"Accept": "application/json"})
        self.checklist_results: list[CheckResult] = []

    def __init_subclass__(cls, **kwargs):
        """Validate that subclasses set required class attributes."""
        super().__init_subclass__(**kwargs)
        # Skip validation for intermediate abstract classes
        if ABC in cls.__bases__:
            return
        if not cls.country_code:
            raise TypeError(
                f"{cls.__name__} must set country_code (e.g., 'IN', 'GB')"
            )
        if not cls.country_name:
            raise TypeError(
                f"{cls.__name__} must set country_name (e.g., 'India', 'United Kingdom')"
            )

    # ── THE 9-POINT UNIVERSAL CHECKLIST ──────────────────────────

    # 1. Official tariff schedule (ABSTRACT)
    @abstractmethod
    def check_official_tariff_schedule(self) -> CheckResult:
        """Check the primary tariff data source for file/API changes.

        Examples:
            - India: CBIC chapter PDFs via API updatedDt
            - GB: UK Trade Tariff API /updates/latest
            - ZA: SARS Schedule 1 PDF headers
            - BR: Siscomex NCM JSON hash
            - EU: TARIC database changes
        """
        ...

    # 2. Government gazette / official journal (ABSTRACT)
    @abstractmethod
    def check_gazette_notifications(self) -> CheckResult:
        """Check government gazette for tariff-related notifications.

        This is the check that catches budget-driven rate changes BEFORE
        the official tariff schedule file is updated.

        Examples:
            - India: e-gazette.nic.in + CBIC Tax Information Portal
            - GB: legislation.gov.uk + HMRC announcements
            - ZA: Government Gazette (gpwonline.co.za)
            - EU: EUR-Lex Official Journal
        """
        ...

    # 3. Budget announcements (VIRTUAL — default: SKIPPED)
    def check_budget_announcements(self) -> CheckResult:
        """Check for annual/supplementary budget rate changes.

        Override for countries with budget-driven tariff changes (India, ZA, GB, AU).
        Default: SKIPPED for countries where budgets don't change tariffs directly.
        """
        return CheckResult(
            check_name="budget_announcements",
            country_code=self.country_code,
            status="SKIPPED",
            metadata={"reason": "No budget-driven tariff changes for this country"},
        )

    # 4. WTO notifications (CONCRETE — universal)
    def check_wto_notifications(self) -> CheckResult:
        """Check WTO I-TIP for tariff notifications filed by/against this country.

        Universal implementation using WTO member ID. Override only if
        country-specific WTO integration is needed.
        """
        start = time.monotonic()
        if not self.wto_member_id:
            return CheckResult(
                check_name="wto_notifications",
                country_code=self.country_code,
                status="SKIPPED",
                metadata={"reason": "No WTO member ID configured"},
            )

        try:
            from .wto_checker import WTOChecker

            checker = WTOChecker()
            findings = checker.check_tariff_notifications(self.wto_member_id)
            new_findings = self._filter_known_notifications(findings, source="WTO_TARIFF")

            for f in new_findings:
                self._upsert_notification(
                    source="WTO_TARIFF",
                    ref=f.get("notification_ref", ""),
                    title=f.get("title", ""),
                    priority=f.get("priority", "MEDIUM"),
                    country_code=self.country_code,
                    source_url=f.get("url"),
                    metadata=f,
                )

            status = "CHANGED" if new_findings else "OK"
            return CheckResult(
                check_name="wto_notifications",
                country_code=self.country_code,
                status=status,
                findings=new_findings,
                duration_ms=int((time.monotonic() - start) * 1000),
            )
        except ImportError:
            return CheckResult(
                check_name="wto_notifications",
                country_code=self.country_code,
                status="SKIPPED",
                metadata={"reason": "WTOChecker not yet implemented"},
            )
        except Exception as e:
            return CheckResult(
                check_name="wto_notifications",
                country_code=self.country_code,
                status="ERROR",
                error=str(e),
                duration_ms=int((time.monotonic() - start) * 1000),
            )

    # 5. Trade agreement updates (CONCRETE + hook)
    def check_trade_agreement_updates(self) -> CheckResult:
        """Check for new FTAs, preference schedule changes.

        Base implementation checks WTO RTA database.
        Override to add country-specific FTA portal checks.
        """
        start = time.monotonic()
        if not self.wto_member_id:
            return CheckResult(
                check_name="trade_agreement_updates",
                country_code=self.country_code,
                status="SKIPPED",
                metadata={"reason": "No WTO member ID configured"},
            )

        try:
            from .wto_checker import WTOChecker

            checker = WTOChecker()
            findings = checker.check_new_rtas(self.wto_member_id)
            new_findings = self._filter_known_notifications(findings, source="WTO_RTA")

            for f in new_findings:
                self._upsert_notification(
                    source="WTO_RTA",
                    ref=f.get("notification_ref", ""),
                    title=f.get("title", ""),
                    priority="MEDIUM",
                    country_code=self.country_code,
                    source_url=f.get("url"),
                    metadata=f,
                )

            status = "CHANGED" if new_findings else "OK"
            return CheckResult(
                check_name="trade_agreement_updates",
                country_code=self.country_code,
                status=status,
                findings=new_findings,
                duration_ms=int((time.monotonic() - start) * 1000),
            )
        except ImportError:
            return CheckResult(
                check_name="trade_agreement_updates",
                country_code=self.country_code,
                status="SKIPPED",
                metadata={"reason": "WTOChecker not yet implemented"},
            )
        except Exception as e:
            return CheckResult(
                check_name="trade_agreement_updates",
                country_code=self.country_code,
                status="ERROR",
                error=str(e),
                duration_ms=int((time.monotonic() - start) * 1000),
            )

    # 6. Trade remedies — AD / safeguard / CVD (ABSTRACT)
    @abstractmethod
    def check_trade_remedies(self) -> CheckResult:
        """Check for new anti-dumping, safeguard, or CVD measures.

        Examples:
            - India: DGTR investigations (AD + safeguard + CVD)
            - GB: UK Trade Remedies Authority
            - ZA: ITAC (International Trade Administration Commission)
            - EU: European Commission DG Trade
            - AU: Anti-Dumping Commission
        """
        ...

    # 7. Indirect tax changes — VAT/GST/excise (ABSTRACT)
    @abstractmethod
    def check_indirect_tax_changes(self) -> CheckResult:
        """Check for VAT/GST/excise rate updates.

        Examples:
            - India: GST Council decisions + CBIC IGST notifications
            - GB: HMRC VAT notices
            - ZA: National Treasury VAT changes
            - EU: per member state (EUMemberMonitor)
            - BR: Receita Federal (IPI, PIS, COFINS rates)
        """
        ...

    # 8. Cross-verification (CONCRETE — universal)
    def cross_verify_rates(self, sample_size: int = 10) -> CheckResult:
        """Sample N random codes from our DB and verify against external source.

        Runs weekly (not daily). Catches silent data drift.
        """
        start = time.monotonic()
        try:
            # Pick random commodity codes for this country
            resp = requests.get(
                f"{self.supabase_url}/rest/v1/rpc/random_commodity_codes",
                headers={**self.headers, "Prefer": ""},
                params={"p_country": self.country_code, "p_limit": sample_size},
                timeout=15,
            )

            if resp.status_code != 200:
                # Fallback: direct query with random ordering
                resp = requests.get(
                    f"{self.supabase_url}/rest/v1/mfn_rate"
                    f"?countrycode=eq.{self.country_code}"
                    f"&select=commoditycode,appliedmfnrate"
                    f"&limit={sample_size}"
                    f"&order=commoditycode",
                    headers={**self.headers, "Prefer": ""},
                    timeout=15,
                )
                codes = resp.json() if resp.status_code == 200 else []
            else:
                codes = resp.json()

            mismatches = []
            for row in codes:
                code = row.get("commoditycode", "")
                our_rate = row.get("appliedmfnrate")
                if our_rate is None:
                    continue

                try:
                    verification = self._verify_single_rate(code)
                except Exception as e:
                    logger.warning("Verification failed for %s/%s: %s", self.country_code, code, e)
                    continue

                if verification and not verification.get("match", True):
                    mismatches.append(verification)
                    self._log_cross_verification(
                        code=code,
                        our_rate=our_rate,
                        external_rate=verification.get("external_rate"),
                        source=verification.get("source", "unknown"),
                        is_match=False,
                    )

            status = "CHANGED" if mismatches else "OK"
            return CheckResult(
                check_name="cross_verification",
                country_code=self.country_code,
                status=status,
                findings=mismatches,
                metadata={"sample_size": sample_size, "codes_checked": len(codes)},
                duration_ms=int((time.monotonic() - start) * 1000),
            )
        except Exception as e:
            return CheckResult(
                check_name="cross_verification",
                country_code=self.country_code,
                status="ERROR",
                error=str(e),
                duration_ms=int((time.monotonic() - start) * 1000),
            )

    @abstractmethod
    def _verify_single_rate(self, commodity_code: str) -> dict:
        """Verify one commodity code's rate against an external authoritative source.

        Returns:
            {
                "code": "87031010",
                "our_rate": 70.0,
                "external_rate": 70.0,
                "source": "CBIC_API",
                "match": True
            }
        """
        ...

    # 9. Exchange rate (CONCRETE — delegates to existing updater)
    def check_exchange_rate(self) -> CheckResult:
        """Exchange rate update. Delegates to existing exchange_rate_updater."""
        start = time.monotonic()
        try:
            # Check data_freshness for EXCHANGE_RATE staleness
            resp = requests.get(
                f"{self.supabase_url}/rest/v1/data_freshness"
                f"?countrycode=eq.{self.country_code}"
                f"&datatype=eq.EXCHANGE_RATE"
                f"&select=lastsyncat,staleafterhours",
                headers={**self.headers, "Prefer": ""},
                timeout=10,
            )
            rows = resp.json() if resp.status_code == 200 else []

            if not rows:
                return CheckResult(
                    check_name="exchange_rate",
                    country_code=self.country_code,
                    status="SKIPPED",
                    metadata={"reason": "No exchange rate tracking for this country"},
                    duration_ms=int((time.monotonic() - start) * 1000),
                )

            row = rows[0]
            last_sync = row.get("lastsyncat", "")
            stale_hours = row.get("staleafterhours", 48)

            if last_sync:
                last_dt = datetime.fromisoformat(last_sync.replace("Z", "+00:00"))
                age_hours = (datetime.now(timezone.utc) - last_dt).total_seconds() / 3600
                is_stale = age_hours > stale_hours
            else:
                is_stale = True

            status = "CHANGED" if is_stale else "OK"
            return CheckResult(
                check_name="exchange_rate",
                country_code=self.country_code,
                status=status,
                metadata={"last_sync": last_sync, "stale": is_stale},
                duration_ms=int((time.monotonic() - start) * 1000),
            )
        except Exception as e:
            return CheckResult(
                check_name="exchange_rate",
                country_code=self.country_code,
                status="ERROR",
                error=str(e),
                duration_ms=int((time.monotonic() - start) * 1000),
            )

    # ── ORCHESTRATION ────────────────────────────────────────────

    def run_full_checklist(self, skip_cross_verify: bool = False) -> list[CheckResult]:
        """Run all 9 checks in sequence, collect and persist results."""
        checks = [
            ("official_tariff_schedule", self.check_official_tariff_schedule),
            ("gazette_notifications", self.check_gazette_notifications),
            ("budget_announcements", self.check_budget_announcements),
            ("wto_notifications", self.check_wto_notifications),
            ("trade_agreement_updates", self.check_trade_agreement_updates),
            ("trade_remedies", self.check_trade_remedies),
            ("indirect_tax_changes", self.check_indirect_tax_changes),
            ("cross_verification", self.cross_verify_rates),
            ("exchange_rate", self.check_exchange_rate),
        ]

        self.checklist_results = []
        for name, check_fn in checks:
            if skip_cross_verify and name == "cross_verification":
                result = CheckResult(
                    check_name=name,
                    country_code=self.country_code,
                    status="SKIPPED",
                    metadata={"reason": "Cross-verification skipped (not weekly run)"},
                )
            else:
                start = time.monotonic()
                try:
                    result = check_fn()
                except Exception as e:
                    result = CheckResult(
                        check_name=name,
                        country_code=self.country_code,
                        status="ERROR",
                        error=str(e),
                        duration_ms=int((time.monotonic() - start) * 1000),
                    )

            self.checklist_results.append(result)
            self._persist_check_result(result)
            self._log_result(result)

        return self.checklist_results

    def run_single_check(self, check_name: str) -> CheckResult:
        """Run one specific check by name."""
        check_map = {
            "official_tariff_schedule": self.check_official_tariff_schedule,
            "gazette_notifications": self.check_gazette_notifications,
            "budget_announcements": self.check_budget_announcements,
            "wto_notifications": self.check_wto_notifications,
            "trade_agreement_updates": self.check_trade_agreement_updates,
            "trade_remedies": self.check_trade_remedies,
            "indirect_tax_changes": self.check_indirect_tax_changes,
            "cross_verification": self.cross_verify_rates,
            "exchange_rate": self.check_exchange_rate,
        }

        if check_name not in check_map:
            raise ValueError(f"Unknown check: {check_name}. Valid: {list(check_map)}")

        result = check_map[check_name]()
        self._persist_check_result(result)
        self._log_result(result)
        return result

    # ── REPORT ───────────────────────────────────────────────────

    def generate_report(self) -> dict:
        """Generate a structured report from checklist_results."""
        return {
            "country_code": self.country_code,
            "country_name": self.country_name,
            "run_at": datetime.now(timezone.utc).isoformat(),
            "summary": {
                "total": len(self.checklist_results),
                "ok": sum(1 for r in self.checklist_results if r.status == "OK"),
                "changed": sum(1 for r in self.checklist_results if r.status == "CHANGED"),
                "errors": sum(1 for r in self.checklist_results if r.status == "ERROR"),
                "skipped": sum(1 for r in self.checklist_results if r.status == "SKIPPED"),
            },
            "checks": [
                {
                    "name": r.check_name,
                    "status": r.status,
                    "findings": r.findings_count,
                    "error": r.error,
                    "duration_ms": r.duration_ms,
                }
                for r in self.checklist_results
            ],
            "action_required": any(
                r.status == "CHANGED" for r in self.checklist_results
            ),
        }

    # ── PERSISTENCE HELPERS ──────────────────────────────────────

    def _persist_check_result(self, result: CheckResult):
        """Write check result to monitor_checklist_run table."""
        import json

        try:
            requests.post(
                f"{self.supabase_url}/rest/v1/monitor_checklist_run",
                headers=self.headers,
                json={
                    "countrycode": result.country_code,
                    "checkname": result.check_name,
                    "status": result.status,
                    "findingscount": result.findings_count,
                    "errormessage": result.error,
                    "sourceurl": result.source_url,
                    "metadata": result.metadata if result.metadata else None,
                    "durationms": result.duration_ms,
                },
                timeout=10,
            )
        except Exception as e:
            logger.error("Failed to persist check result: %s", e)

    def _upsert_notification(
        self,
        source: str,
        ref: str,
        title: str,
        priority: str = "MEDIUM",
        country_code: str | None = None,
        source_url: str | None = None,
        metadata: dict | None = None,
    ):
        """Insert into notification_tracker."""
        try:
            requests.post(
                f"{self.supabase_url}/rest/v1/notification_tracker",
                headers=self.headers,
                json={
                    "source": source,
                    "notificationref": ref,
                    "title": title,
                    "priority": priority,
                    "status": "NEW",
                    "countrycode": country_code or self.country_code,
                    "sourceurl": source_url,
                    "aiextract": metadata,
                },
                timeout=10,
            )
        except Exception as e:
            logger.error("Failed to upsert notification: %s", e)

    def _update_data_freshness(self, datatype: str, **kwargs):
        """Update data_freshness for this country."""
        try:
            data = {
                "countrycode": self.country_code,
                "datatype": datatype,
                "lastsyncat": datetime.now(timezone.utc).isoformat(),
                **kwargs,
            }
            requests.post(
                f"{self.supabase_url}/rest/v1/data_freshness",
                headers={**self.headers, "Prefer": "resolution=merge-duplicates,return=minimal"},
                json=data,
                timeout=10,
            )
        except Exception as e:
            logger.error("Failed to update data_freshness: %s", e)

    def _filter_known_notifications(
        self, findings: list[dict], source: str
    ) -> list[dict]:
        """Filter out notifications already in notification_tracker."""
        if not findings:
            return []

        try:
            refs = [f.get("notification_ref", "") for f in findings if f.get("notification_ref")]
            if not refs:
                return findings

            # Check which refs already exist
            resp = requests.get(
                f"{self.supabase_url}/rest/v1/notification_tracker"
                f"?source=eq.{source}"
                f"&countrycode=eq.{self.country_code}"
                f"&notificationref=in.({','.join(refs)})"
                f"&select=notificationref",
                headers={**self.headers, "Prefer": ""},
                timeout=10,
            )
            known = {r["notificationref"] for r in resp.json()} if resp.status_code == 200 else set()
            return [f for f in findings if f.get("notification_ref", "") not in known]
        except Exception:
            return findings

    def _log_cross_verification(
        self,
        code: str,
        our_rate: float,
        external_rate: float | None,
        source: str,
        is_match: bool,
    ):
        """Log to cross_verification_log table."""
        try:
            mismatch_pct = abs(our_rate - (external_rate or 0)) if external_rate is not None else None
            requests.post(
                f"{self.supabase_url}/rest/v1/cross_verification_log",
                headers=self.headers,
                json={
                    "countrycode": self.country_code,
                    "commoditycode": code,
                    "ourrate": our_rate,
                    "externalrate": external_rate,
                    "externalsource": source,
                    "ismatch": is_match,
                    "mismatchpct": mismatch_pct,
                },
                timeout=10,
            )
        except Exception as e:
            logger.error("Failed to log cross-verification: %s", e)

    def _log_result(self, result: CheckResult):
        """Log check result to console."""
        icon = {"OK": "✓", "CHANGED": "⚠", "ERROR": "✗", "SKIPPED": "–"}.get(
            result.status, "?"
        )
        msg = f"  {icon} {result.check_name}: {result.status}"
        if result.findings_count:
            msg += f" ({result.findings_count} findings)"
        if result.error:
            msg += f" — {result.error}"
        if result.duration_ms:
            msg += f" [{result.duration_ms}ms]"
        logger.info(msg)
