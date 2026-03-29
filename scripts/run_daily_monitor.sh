#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Customs Intelligence — Daily Monitoring Pipeline
# Runs all country monitors, exchange rates, and rules engine.
# Schedule: daily at 00:30 UTC (6:00 AM IST / 2:30 AM SAST / 12:30 AM GMT)
#
# Can run on: local Mac (cron), Linux server, Docker, GitHub Actions
# ═══════════════════════════════════════════════════════════════

set -e

PROJ_DIR="${CI_PROJECT_DIR:-/Users/saurabh/Desktop/Customs-Intelligence}"
PYTHON="${CI_PYTHON:-/Library/Frameworks/Python.framework/Versions/3.12/bin/python3}"
LOG_DIR="$PROJ_DIR/scripts/logs"

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/daily-monitor-$(date +%Y-%m-%d).log"

cd "$PROJ_DIR"

# Load environment
if [ -f "$PROJ_DIR/.env" ]; then
    export $(grep -v '^#' "$PROJ_DIR/.env" | xargs)
fi

echo "═══════════════════════════════════════════════════════════" >> "$LOG_FILE"
echo "  Daily Monitor — $(date)" >> "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" >> "$LOG_FILE"

# ── 1. India Monitor ─────────────────────────────────────────
echo "" >> "$LOG_FILE"
echo "── INDIA ──────────────────────────────────────────────" >> "$LOG_FILE"
$PYTHON -m scripts.india_tariff_monitor >> "$LOG_FILE" 2>&1
IN_EXIT=$?
if [ $IN_EXIT -ne 0 ]; then
    echo "  India: action items found — running auto-updater" >> "$LOG_FILE"
    $PYTHON -m scripts.india_chapter_updater >> "$LOG_FILE" 2>&1 || true
fi

# ── 2. South Africa Monitor ──────────────────────────────────
echo "" >> "$LOG_FILE"
echo "── SOUTH AFRICA ───────────────────────────────────────" >> "$LOG_FILE"
$PYTHON -m scripts.za_tariff_monitor >> "$LOG_FILE" 2>&1 || true

# ── 3. Brazil Monitor ─────────────────────────────────────────
echo "" >> "$LOG_FILE"
echo "── BRAZIL ─────────────────────────────────────────────" >> "$LOG_FILE"
$PYTHON -m scripts.br_tariff_monitor >> "$LOG_FILE" 2>&1 || true

# ── 4. UK Monitor ────────────────────────────────────────────
echo "" >> "$LOG_FILE"
echo "── UNITED KINGDOM ─────────────────────────────────────" >> "$LOG_FILE"
$PYTHON -m scripts.gb_tariff_monitor >> "$LOG_FILE" 2>&1 || true

# ── 5. All other country monitors ─────────────────────────────
echo "" >> "$LOG_FILE"
echo "── OTHER COUNTRIES (UY,CL,AE,AR,AU,MX,TH,PH,AO,DO,MU) ─" >> "$LOG_FILE"
$PYTHON -m scripts.country_monitors >> "$LOG_FILE" 2>&1 || true

# ── 6. Exchange Rates ────────────────────────────────────────
echo "" >> "$LOG_FILE"
echo "── EXCHANGE RATES ─────────────────────────────────────" >> "$LOG_FILE"
$PYTHON -m scripts.exchange_rate_updater >> "$LOG_FILE" 2>&1 || true

# ── 7. Rules Engine ──────────────────────────────────────────
echo "" >> "$LOG_FILE"
echo "── RULES ENGINE + OPPORTUNITIES ──────────────────────" >> "$LOG_FILE"
$PYTHON -c "
import os, requests, json
url = os.environ['SUPABASE_URL']; key = os.environ['SUPABASE_SERVICE_KEY']
hdrs = {'apikey':key,'Authorization':f'Bearer {key}','Content-Type':'application/json'}

r1 = requests.post(f'{url}/rest/v1/rpc/run_rules_engine', headers=hdrs,
    json={'p_lookback_days':7}, timeout=30)
print('Rules engine:', json.dumps(r1.json(), indent=2))

r2 = requests.post(f'{url}/rest/v1/rpc/generate_personalised_opportunities', headers=hdrs,
    json={}, timeout=30)
print('Personalised opps:', json.dumps(r2.json(), indent=2))

r3 = requests.post(f'{url}/rest/v1/rpc/analyse_erp_intelligence', headers=hdrs,
    json={'p_lookback_days':180}, timeout=30)
print('ERP intelligence:', json.dumps(r3.json(), indent=2))

# Classify unclassified ERP line items (top 30 per run)
r4 = requests.post(f'{url}/functions/v1/admin', headers=hdrs,
    json={'action':'classify_erp_items','limit':30}, timeout=120)
print('ERP classify:', r4.text[:200] if r4.ok else f'Error: {r4.status_code}')
" >> "$LOG_FILE" 2>&1 || true

# ── 8. Summary ───────────────────────────────────────────────
echo "" >> "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" >> "$LOG_FILE"
echo "  Daily Monitor Complete — $(date)" >> "$LOG_FILE"
echo "═══════════════════════════════════════════════════════════" >> "$LOG_FILE"

# Clean up old logs (keep 30 days)
find "$LOG_DIR" -name "*.log" -mtime +30 -delete 2>/dev/null || true
