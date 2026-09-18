#!/bin/bash
# launchd wrapper for the local Python data syncs:
#   scripts/run-python-job.sh <log-name> <script.py> [args...]
# Each script writes its own job_runs row; this only sets PATH and logging.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.."
NAME="$1"; shift
LOGDIR="$HOME/Library/Logs/stackslash-$NAME"
mkdir -p "$LOGDIR"
echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') $NAME ===" >> "$LOGDIR/$NAME.log"
research/.venv/bin/python -W ignore -u "$@" >> "$LOGDIR/$NAME.log" 2>&1
