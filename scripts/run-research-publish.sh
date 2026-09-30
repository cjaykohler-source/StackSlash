#!/bin/bash
# Nightly catalyst refresh + publish (launchd: com.stackslash.research-publish,
# daily 05:30 ET: after SEC regenerates its bulk files overnight, before the
# open). Refreshes every catalyst source incrementally, rebuilds the event
# tables, and publishes to the research_* Supabase tables behind /research
# and the symbol-page catalyst timeline.
#   1. EDGAR bulk: submissions.zip nightly (filings), companyfacts.zip Sundays
#   2. Alpaca news: current + previous month
#   3. Going-concern full-text search: last two months, merged into the cache
#   4. Earnings: DoltHub eps_history re-pulled Mondays (its weekend update)
#   5. Form 4: new filings only
#   6. Rebuild event tables; 7. publish
# A failed step is logged and the rest still run; publish runs if the event
# rebuild produced at least the unaffected sources. Touches research/data/
# and the research_* tables only.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.."
LOGDIR="$HOME/Library/Logs/stackslash-research-publish"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/research-publish.log"
set -a; . ./.env; set +a
PY=research/.venv/bin/python
DOW=$(date +%u)   # 1 = Monday ... 7 = Sunday
FAILED=()
step() {  # step <name> <command...>
  local name=$1; shift
  echo "--- $(date -u '+%H:%M:%SZ') $name" >> "$LOG"
  if ! "$@" >> "$LOG" 2>&1; then
    echo "!!! $name failed" >> "$LOG"
    FAILED+=("$name")
  fi
}
fetch_bulk() {  # fetch_bulk <file> <url>: download to a temp file, swap in only when complete
  curl -sSf -A "$SEC_USER_AGENT" -o "research/data/edgar/$1.new" "$2" && mv "research/data/edgar/$1.new" "research/data/edgar/$1"
}

echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') starting research publish ===" >> "$LOG"
step "submissions.zip" fetch_bulk submissions.zip https://www.sec.gov/Archives/edgar/daily-index/bulkdata/submissions.zip
if [ "$DOW" = 7 ]; then
  step "companyfacts.zip" fetch_bulk companyfacts.zip https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip
  step "load_edgar (full)" $PY -u research/load_edgar.py
else
  step "load_edgar (filings)" $PY -u research/load_edgar.py --skip-facts
fi
step "news crawl" $PY -u research/catalysts/news_crawl.py
step "form4 crawl" $PY -u research/catalysts/form4_crawl.py
EXTRA=()
[ "$DOW" = 1 ] && EXTRA+=(--refresh-earnings)
step "event tables" $PY -u research/catalysts/sources.py edgar corporate_actions earnings going_concern news form4 ${EXTRA[@]+"${EXTRA[@]}"}
step "publish" $PY -u research/publish_research.py
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') done with failures: ${FAILED[*]} ===" >> "$LOG"
  exit 1
fi
echo "=== $(date -u '+%Y-%m-%dT%H:%M:%SZ') done ===" >> "$LOG"
