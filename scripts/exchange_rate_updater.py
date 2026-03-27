"""
exchange_rate_updater.py — Fetches current exchange rates and loads into DB.

Sources:
    - Primary: open.er-api.com (free, no auth, daily updates)
    - Future: CBIC notified rates (fortnightly Customs NT notification)

Loads rates for all country bases in our system (INR, ZAR, GBP).
Run daily or on-demand from admin dashboard.

Usage:
    export $(grep -v '^#' .env | xargs)
    python3 -m scripts.exchange_rate_updater
"""

import logging
import os
import sys
from datetime import date, datetime, timezone

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger("exchange_rates")

# Currencies we care about for customs
CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CNY", "AED", "ZAR", "INR",
              "BRL", "AUD", "THB", "MXN", "CLP", "PHP", "OMR", "SAR",
              "UYU", "ARS", "MUR", "AOA", "NAD"]

# Country → base currency mapping
COUNTRY_BASES = {
    "IN": "INR",
    "ZA": "ZAR",
    "GB": "GBP",
    "NA": "ZAR",  # Namibia pegged to ZAR
}


def fetch_rates(base: str) -> dict:
    """Fetch exchange rates from open.er-api.com."""
    url = f"https://open.er-api.com/v6/latest/{base}"
    resp = requests.get(url, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    if data.get("result") != "success":
        raise ValueError(f"API error: {data}")
    return data.get("rates", {})


def main():
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not supabase_url or not supabase_key:
        logger.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY")
        sys.exit(1)

    headers = {
        "apikey": supabase_key,
        "Authorization": f"Bearer {supabase_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }

    today = date.today().isoformat()
    records = []

    # Fetch rates for each base currency
    for country, base_currency in COUNTRY_BASES.items():
        try:
            rates = fetch_rates(base_currency)
            logger.info("Fetched %d rates for %s (%s)", len(rates), country, base_currency)
        except Exception as e:
            logger.error("Failed to fetch rates for %s: %s", base_currency, e)
            continue

        for currency in CURRENCIES:
            if currency == base_currency:
                continue
            rate = rates.get(currency)
            if not rate:
                continue

            record = {
                "currencycode": currency,
                "countrycode": country,
                "rateperinr": None,
                "inrperunit": None,
                "rateperzar": None,
                "zarperunit": None,
                "ratepergbp": None,
                "gbpperunit": None,
                "ratetype": "MARKET",
                "effectivefrom": today,
                "effectiveto": None,
                "source": "open.er-api.com",
                "updatedat": datetime.now(timezone.utc).isoformat(),
            }

            # Set the appropriate rate columns based on base
            if base_currency == "INR":
                record["rateperinr"] = round(rate, 6)
                record["inrperunit"] = round(1 / rate, 6) if rate else None
            elif base_currency == "ZAR":
                record["rateperzar"] = round(rate, 6)
                record["zarperunit"] = round(1 / rate, 6) if rate else None
            elif base_currency == "GBP":
                record["ratepergbp"] = round(rate, 6)
                record["gbpperunit"] = round(1 / rate, 6) if rate else None

            records.append(record)

    # Close out previous rates
    resp = requests.patch(
        f"{supabase_url}/rest/v1/exchange_rate?effectiveto=is.null&effectivefrom=neq.{today}",
        headers=headers,
        json={"effectiveto": today},
        timeout=15,
    )
    logger.info("Closed previous rates: %s", resp.status_code)

    # Insert new rates
    batch_size = 100
    total = 0
    for i in range(0, len(records), batch_size):
        chunk = records[i:i + batch_size]
        resp = requests.post(
            f"{supabase_url}/rest/v1/exchange_rate",
            headers=headers,
            json=chunk,
            timeout=15,
        )
        if resp.status_code in (200, 201):
            total += len(chunk)
        else:
            logger.error("Insert failed: %s — %s", resp.status_code, resp.text[:200])

    # Update data_freshness
    requests.post(
        f"{supabase_url}/rest/v1/data_freshness",
        headers=headers,
        json=[{
            "countrycode": "IN",
            "datatype": "EXCHANGE_RATE",
            "lastsyncat": datetime.now(timezone.utc).isoformat(),
            "rowcount": total,
            "sourcename": "open.er-api.com (market rates)",
            "sourceversion": today,
            "nextexpectedupdate": "Daily",
            "staleafterhours": 48,
            "notes": "Market rates. CBIC notified rates may differ slightly.",
        }],
        timeout=15,
    )

    logger.info("Loaded %d exchange rates for %d countries", total, len(COUNTRY_BASES))


if __name__ == "__main__":
    main()
