#!/bin/bash
# Daily India tariff monitor — designed to run from cron.
# Logs to scripts/logs/india-monitor-YYYY-MM-DD.log
# Exit code 1 = action items found (new notifications or stale chapters)

set -e

PROJ_DIR="/Users/saurabh/Desktop/Customs-Intelligence"
PYTHON="/Library/Frameworks/Python.framework/Versions/3.12/bin/python3"
LOG_DIR="$PROJ_DIR/scripts/logs"

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/india-monitor-$(date +%Y-%m-%d).log"

cd "$PROJ_DIR"

# Load environment
export $(grep -v '^#' "$PROJ_DIR/.env" | xargs)

echo "=== India Tariff Monitor — $(date) ===" >> "$LOG_FILE"

# Run monitor (check notifications + chapters + DGTR)
$PYTHON -m scripts.india_tariff_monitor >> "$LOG_FILE" 2>&1
EXIT_CODE=$?

# Auto-update any stale chapters
if [ $EXIT_CODE -ne 0 ]; then
    echo "" >> "$LOG_FILE"
    echo "=== Auto-updating stale chapters ===" >> "$LOG_FILE"
    $PYTHON -m scripts.india_chapter_updater >> "$LOG_FILE" 2>&1 || true
fi

# Run rules engine to generate data-driven alerts & opportunities
echo "" >> "$LOG_FILE"
echo "=== Running rules engine ===" >> "$LOG_FILE"
$PYTHON -c "
import os, requests, json
url = os.environ['SUPABASE_URL']; key = os.environ['SUPABASE_SERVICE_KEY']
resp = requests.post(f'{url}/rest/v1/rpc/run_rules_engine',
    headers={'apikey':key,'Authorization':f'Bearer {key}','Content-Type':'application/json'},
    json={'p_lookback_days':7,'p_country':'IN'}, timeout=30)
print(json.dumps(resp.json(), indent=2))
" >> "$LOG_FILE" 2>&1 || true

# Clean up old logs (keep 30 days)
find "$LOG_DIR" -name "india-monitor-*.log" -mtime +30 -delete 2>/dev/null || true

exit $EXIT_CODE
