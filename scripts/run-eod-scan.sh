#!/bin/bash
# Runs eod-scan on the always-on host (Mac-mini) instead of Netlify's
# scheduled function, which has a ~3-4 min platform timeout that
# eod-scan blows past at the ~5,000-symbol universe scale. Invoked by
# launchd (com.stackslash.eod-scan.plist) daily ~5 min after market
# close. Idempotent — safe to also let the Netlify cron attempt it.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.."
set -a
[ -f .env ] && . ./.env
set +a
LOGDIR="$HOME/Library/Logs/stackslash-eod-scan"
mkdir -p "$LOGDIR"
echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') starting eod-scan ===" >> "$LOGDIR/eod-scan.log"
npx --yes tsx -e "import r from './netlify/functions/eod-scan'; const t=Date.now(); r().then(x=>x.text()).then(o=>console.log('RESULT:',o,'in',((Date.now()-t)/1000).toFixed(0)+'s')).catch(e=>{console.error('ERR:', e && e.stack || (e && typeof e==='object' ? JSON.stringify(e) : e)); process.exit(1)})" \
  >> "$LOGDIR/eod-scan.log" 2>&1
echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') done ===" >> "$LOGDIR/eod-scan.log"
