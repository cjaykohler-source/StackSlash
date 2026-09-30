#!/bin/bash
# Reddit catalyst collector (launchd: com.stackslash.reddit-collect, every
# 15 minutes). Forward-only: Reddit serves recent listings only, so a gap in
# runs is lost for good. Needs REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET /
# REDDIT_USER_AGENT in .env. Writes only research/data/catalysts/raw/reddit.duckdb.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.."
LOGDIR="$HOME/Library/Logs/stackslash-reddit-collect"
mkdir -p "$LOGDIR"
set -a; . ./.env; set +a
research/.venv/bin/python -u research/catalysts/reddit_collect.py >> "$LOGDIR/reddit-collect.log" 2>&1
