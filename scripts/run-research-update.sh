#!/bin/bash
# Nightly research-warehouse update (launchd: com.stackslash.research-update,
# weekdays 20:30 ET, after the 20:00 close of extended hours plus the free
# plan's 15-minute SIP delay). Order matters:
#   1. corporate actions (current quarter), so step 2 knows today's splits
#   2. SIP daily bars for new sessions, both adjustments; full split-adjusted
#      re-pull for any symbol that split
#   3. SIP minute bars for those sessions (planned from step 2's daily bars)
# Each step is idempotent and resumes from its own log, so a failed night is
# picked up by the next run. Touches only research/data/, never Supabase.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.."
LOGDIR="$HOME/Library/Logs/stackslash-research-update"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/research-update.log"
PY=research/.venv/bin/python
echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') starting research update ===" >> "$LOG"
for step in "research/load_corporate_actions.py" "research/load_from_alpaca.py --update" "research/load_minute_bars.py --update"; do
  echo "--- $step" >> "$LOG"
  # shellcheck disable=SC2086
  $PY -u $step >> "$LOG" 2>&1
done
echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') done ===" >> "$LOG"
