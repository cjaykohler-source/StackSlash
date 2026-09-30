#!/bin/bash
# Reddit attention collector (launchd: com.stackslash.reddit-collect, hourly).
# Snapshots ApeWisdom's per-ticker mention counts for r/pennystocks, r/stocks
# and r/wallstreetbets -- no Reddit credentials, no Reddit content stored.
# Forward-only: a missed hour can't be backfilled. Writes only
# research/data/catalysts/raw/reddit.duckdb.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.."
LOGDIR="$HOME/Library/Logs/stackslash-reddit-collect"
mkdir -p "$LOGDIR"
research/.venv/bin/python -u research/catalysts/reddit_collect.py >> "$LOGDIR/reddit-collect.log" 2>&1
