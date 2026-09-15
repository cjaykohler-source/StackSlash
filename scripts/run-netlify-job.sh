#!/bin/bash
# Runs one netlify/functions/<job>.ts on the worker host, for jobs that
# outgrew Netlify's ~30 s scheduled-function limit (Netlify cut them off
# and re-invoked them 2-3x per slot, leaving duplicate and orphaned
# `running` job_runs rows). Invoked by launchd
# (scripts/launchd/com.stackslash.<job>.plist).
#
#   run-netlify-job.sh JOB [START_HHMM END_HHMM]
#
# With a window, the run is skipped unless it's a weekday and the
# America/New_York wall clock is within [START, END] — launchd fires on
# the clock, this decides whether the market-hours job has work.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
JOB="$1"
if [ $# -ge 3 ]; then
  NOW=$(TZ=America/New_York date +%H%M)
  DOW=$(TZ=America/New_York date +%u) # 1 = Monday
  if (( DOW > 5 || 10#$NOW < 10#$2 || 10#$NOW > 10#$3 )); then
    exit 0
  fi
fi
cd "$(dirname "$0")/.."
set -a
[ -f .env ] && . ./.env
set +a
LOGDIR="$HOME/Library/Logs/stackslash-$JOB"
mkdir -p "$LOGDIR"
echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') starting $JOB ===" >> "$LOGDIR/$JOB.log"
npx --yes tsx -e "import r from './netlify/functions/$JOB'; const t=Date.now(); r().then(x=>x.text()).then(o=>console.log('RESULT:',o.slice(0,500),'in',((Date.now()-t)/1000).toFixed(0)+'s')).catch(e=>{console.error('ERR:', e && e.stack || (e && typeof e==='object' ? JSON.stringify(e) : e)); process.exit(1)})" \
  >> "$LOGDIR/$JOB.log" 2>&1
echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') done ===" >> "$LOGDIR/$JOB.log"
