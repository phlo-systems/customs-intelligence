"""Universal tariff monitoring framework — 9-point checklist for all countries."""

from .base_monitor import UniversalTariffMonitor, CheckResult
from .country_registry import get_all_registered as _get_all
from .country_registry import validate_coverage

COUNTRY_REGISTRY = _get_all

__all__ = [
    "UniversalTariffMonitor",
    "CheckResult",
    "COUNTRY_REGISTRY",
    "validate_coverage",
]
