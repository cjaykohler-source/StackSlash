#!/usr/bin/env bash
# One-off: full 5-year / ~5,000-symbol backtest-triggers run, chunked by
# quarter to stay under any single-call timeout. Run from the mini
# (stackslash-worker-host), inside its repo clone, on main, after
# `git pull`. NOT meant to be run from a laptop (see README's
# HTTP/2 session-timeout note).
#
# Usage: ./run-backtest-full.sh
#   START_CHUNK=6 ./run-backtest-full.sh   # resume from chunk 6 (1-indexed)
#                                           # after a mid-run failure — earlier
#                                           # chunks already accumulated into
#                                           # backtest_returns_raw, so this is
#                                           # safe and won't re-reset them.
#
# Each chunk gets up to 3 attempts (with a pause between) before the whole
# script gives up — the in-process retry inside backtest-triggers.ts isn't
# always enough to outlast an HTTP/2 GOAWAY on a long-lived local session;
# a fresh process (fresh connection) usually clears it.
set -euo pipefail

set -a && . ./.env && set +a

START_CHUNK="${START_CHUNK:-1}"

CHUNKS=(
  "2021-09-10:2021-12-10"
  "2021-12-10:2022-03-10"
  "2022-03-10:2022-06-10"
  "2022-06-10:2022-09-10"
  "2022-09-10:2022-12-10"
  "2022-12-10:2023-03-10"
  "2023-03-10:2023-06-10"
  "2023-06-10:2023-09-10"
  "2023-09-10:2023-12-10"
  "2023-12-10:2024-03-10"
  "2024-03-10:2024-06-10"
  "2024-06-10:2024-09-10"
  "2024-09-10:2024-12-10"
  "2024-12-10:2025-03-10"
  "2025-03-10:2025-06-10"
  "2025-06-10:2025-09-10"
  "2025-09-10:2025-12-10"
  "2025-12-10:2026-03-10"
  "2026-03-10:2026-06-10"
  "2026-06-10:2026-09-10"
)

for i in "${!CHUNKS[@]}"; do
  CHUNK_NUM=$((i + 1))
  if [ "$CHUNK_NUM" -lt "$START_CHUNK" ]; then continue; fi
  IFS=":" read -r START END <<< "${CHUNKS[$i]}"
  RESET="false"
  if [ "$i" -eq 0 ]; then RESET="true"; fi
  echo "=== chunk $CHUNK_NUM/${#CHUNKS[@]}: $START -> $END (reset=$RESET) ==="
  for attempt in 1 2 3; do
    if npx tsx -e "
      import fn from './netlify/functions/backtest-triggers.ts';
      fn(new Request('http://x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startDate: '$START', endDate: '$END', reset: $RESET })
      })).then(r => r.text()).then(console.log);
    "; then
      break
    fi
    if [ "$attempt" -eq 3 ]; then
      echo "=== chunk $CHUNK_NUM failed after 3 attempts — resume later with START_CHUNK=$CHUNK_NUM ./run-backtest-full.sh ==="
      exit 1
    fi
    echo "=== chunk $CHUNK_NUM attempt $attempt failed (likely GOAWAY) — retrying in a fresh process in 10s ==="
    sleep 10
  done
done

echo "=== done — check trigger_stats in Supabase ==="
