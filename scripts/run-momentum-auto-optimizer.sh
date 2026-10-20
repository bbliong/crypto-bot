#!/usr/bin/env bash
# Momentum Auto-Optimizer Runner (30-Minute Cron)
# Runs walk-forward optimization on Oct 14-18 + live rolling chunks.
# Updates config/momentum-evolved-lanes.json and src/distribution-evolved-momentum-lanes.ts.

set -euo pipefail

LOCK_FILE="/tmp/momentum_optimizer.lock"
LOG_FILE="/home/bbliong/project/crypto-bot/data/profit4-watch/momentum-optimizer.log"
PROJECT_DIR="/home/bbliong/project/crypto-bot"

mkdir -p "$(dirname "$LOG_FILE")"

exec 200>"$LOCK_FILE"
if ! flock -n 200; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Another optimizer instance is currently running. Skipping." >> "$LOG_FILE"
  exit 0
fi

echo "==========================================================" >> "$LOG_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting 30-min Momentum Optimizer Run" >> "$LOG_FILE"

cd "$PROJECT_DIR"
/usr/bin/python3 "$PROJECT_DIR/scripts/momentum-auto-optimizer.py" >> "$LOG_FILE" 2>&1

EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Optimizer finished successfully." >> "$LOG_FILE"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Optimizer failed with exit code $EXIT_CODE." >> "$LOG_FILE"
fi

echo "==========================================================" >> "$LOG_FILE"
