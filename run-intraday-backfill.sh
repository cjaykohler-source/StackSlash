#!/usr/bin/env bash
# Band-only 5-year 1-minute backfill into bars_intraday — the data Phase B
# of the session-cohort work needs (see docs/measurement-rebuild-plan.md).
#
# Run from the mini (stackslash-worker-host), on main, after `git pull`.
# This is a long Alpaca pull plus millions of upserts; do not run it from
# a laptop.
#
# Usage: ./run-intraday-backfill.sh
#   START_CHUNK=14 ./run-intraday-backfill.sh    # resume after a failure
#
# Chunked by month for the same reason run-backtest-full.sh is: long
# single invocations reliably hit an HTTP/2 GOAWAY at ~10 minutes.
# backfill-intraday upserts on (symbol_id, ts), so re-running a chunk is
# safe and a partial chunk just gets completed on retry.
#
# Expected size: ~800 band symbols x ~1,260 sessions x ~25 bars/session
# (IEX fills only ~6.4% of the 390 regular-session minutes for these
# names) = roughly 25M rows / ~3.3 GB at the measured 131 bytes/row.
# Check Supabase disk headroom before starting.
set -euo pipefail

set -a && . ./.env && set +a

START_CHUNK="${START_CHUNK:-1}"

# Month starts from 2021-09 through 2026-09. Alpaca's free-tier 1-minute
# history floor is 2020-09-01, so 5 years is reachable; bars_daily starts
# 2021-09-10, so this matches the daily history rather than exceeding it.
CHUNKS=()
y=2021; m=9
while [ "$y" -lt 2026 ] || { [ "$y" -eq 2026 ] && [ "$m" -le 9 ]; }; do
  start=$(printf "%04d-%02d-01" "$y" "$m")
  ny=$y; nm=$((m + 1))
  if [ "$nm" -gt 12 ]; then nm=1; ny=$((ny + 1)); fi
  end=$(printf "%04d-%02d-01" "$ny" "$nm")
  CHUNKS+=("$start:$end")
  y=$ny; m=$nm
done

echo "=== ${#CHUNKS[@]} monthly chunks, starting at $START_CHUNK ==="

for i in "${!CHUNKS[@]}"; do
  CHUNK_NUM=$((i + 1))
  if [ "$CHUNK_NUM" -lt "$START_CHUNK" ]; then continue; fi
  IFS=":" read -r START END <<< "${CHUNKS[$i]}"
  echo "=== chunk $CHUNK_NUM/${#CHUNKS[@]}: $START -> $END ==="
  for attempt in 1 2 3; do
    if npx tsx -e "
      import fn from './netlify/functions/backfill-intraday.ts';
      fn(new Request('http://x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startDate: '$START', endDate: '$END' })
      })).then(r => r.text()).then(console.log);
    "; then
      break
    fi
    if [ "$attempt" -eq 3 ]; then
      echo "=== chunk $CHUNK_NUM failed 3x — resume with START_CHUNK=$CHUNK_NUM ./run-intraday-backfill.sh ==="
      exit 1
    fi
    echo "=== chunk $CHUNK_NUM attempt $attempt failed — fresh process in 10s ==="
    sleep 10
  done
done

echo "=== done — check bars_intraday row count and Supabase disk usage ==="
