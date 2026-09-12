#!/bin/bash
# Runs the SIP minute-bar pull (research/load_minute_bars.py) under launchd
# (com.stackslash.minute-pull.plist) so a multi-day pull survives the
# terminal/session that started it, crashes, and reboots. The loader is
# resumable from its own log, so a restart continues where it stopped; it
# exits 0 once every unit is loaded, and launchd then leaves it down.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.."
LOGDIR="$HOME/Library/Logs/stackslash-minute-pull"
mkdir -p "$LOGDIR"
echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') starting minute pull ===" >> "$LOGDIR/minute-pull.log"
exec research/.venv/bin/python -u research/load_minute_bars.py >> "$LOGDIR/minute-pull.log" 2>&1
