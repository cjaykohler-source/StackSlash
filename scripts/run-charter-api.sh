#!/bin/bash
# Charter API (launchd: com.stackslash.charter-api, KeepAlive). Read-only
# query service over the research warehouse for the /charter page; binds
# 127.0.0.1:8787 only. Reached from your own devices through Tailscale Serve
# (https://<this-mac>.<tailnet>.ts.net -> 127.0.0.1:8787, tailnet-only).
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.."
LOGDIR="$HOME/Library/Logs/stackslash-charter-api"
mkdir -p "$LOGDIR"
exec research/.venv/bin/python -u research/charter_api/server.py >> "$LOGDIR/charter-api.log" 2>&1
