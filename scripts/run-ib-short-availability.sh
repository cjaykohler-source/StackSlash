#!/bin/bash
# launchd wrapper: IBKR shortable shares for every active symbol
# (worker/src/ibShortAvailability.ts). Needs IB Gateway logged in on :4001;
# if it isn't, the job_runs row records the failure.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "$(dirname "$0")/../worker"
LOGDIR="$HOME/Library/Logs/stackslash-ib-short-availability"
mkdir -p "$LOGDIR"
echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') ===" >> "$LOGDIR/ib-short-availability.log"
node --env-file=../.env --import tsx src/ibShortAvailability.ts >> "$LOGDIR/ib-short-availability.log" 2>&1
