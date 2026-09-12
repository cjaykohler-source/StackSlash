#!/bin/bash
# Runs data-integrity-check on the always-on host instead of Netlify's
# scheduled function. Each run takes ~40s (one windowed pass over
# bars_daily), which is past Netlify's scheduled-function limit: on
# 2026-09-11, its first night, Netlify invoked it three times 20s apart
# while the earlier runs kept going, writing three identical snapshots to
# data_quality_issues. Invoked by launchd
# (com.stackslash.data-integrity-check.plist) nightly.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.."
set -a
[ -f .env ] && . ./.env
set +a
LOGDIR="$HOME/Library/Logs/stackslash-data-integrity-check"
mkdir -p "$LOGDIR"
echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') starting data-integrity-check ===" >> "$LOGDIR/data-integrity-check.log"
npx --yes tsx -e "import r from './netlify/functions/data-integrity-check'; const t=Date.now(); r().then(x=>x.text()).then(o=>console.log('RESULT:',o,'in',((Date.now()-t)/1000).toFixed(0)+'s')).catch(e=>{console.error('ERR:', e && e.stack || (e && typeof e==='object' ? JSON.stringify(e) : e)); process.exit(1)})" \
  >> "$LOGDIR/data-integrity-check.log" 2>&1
echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') done ===" >> "$LOGDIR/data-integrity-check.log"
