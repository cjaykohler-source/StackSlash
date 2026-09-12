#!/usr/bin/env bash
# One-off: full 5-year / ~5,000-symbol backtest-triggers run, chunked by
# month to stay under any single-call timeout. Run from the mini
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

# Every chunk is one month. Quarterly chunks hit an HTTP/2 GOAWAY at ~10
# minutes wall time (9m52s-9m58s across retries) — a hard local session
# limit, not flakiness. The first five were left quarterly for a while
# because they had once finished (the last in 8m50s), but that margin was
# too thin: on 2026-09-12 quarterly chunk 5 (2022-09-10 -> 2022-12-10, the
# first with real evaluations after the 260-bar warm-up) failed 3/3 on
# GOAWAY. Monthly chunks land around ~3-5 min. Chunk numbers changed with
# this edit, so a START_CHUNK saved from an older run no longer lines up.
CHUNKS=(
  "2021-09-10:2021-10-10"
  "2021-10-10:2021-11-10"
  "2021-11-10:2021-12-10"
  "2021-12-10:2022-01-10"
  "2022-01-10:2022-02-10"
  "2022-02-10:2022-03-10"
  "2022-03-10:2022-04-10"
  "2022-04-10:2022-05-10"
  "2022-05-10:2022-06-10"
  "2022-06-10:2022-07-10"
  "2022-07-10:2022-08-10"
  "2022-08-10:2022-09-10"
  "2022-09-10:2022-10-10"
  "2022-10-10:2022-11-10"
  "2022-11-10:2022-12-10"
  "2022-12-10:2023-01-10"
  "2023-01-10:2023-02-10"
  "2023-02-10:2023-03-10"
  "2023-03-10:2023-04-10"
  "2023-04-10:2023-05-10"
  "2023-05-10:2023-06-10"
  "2023-06-10:2023-07-10"
  "2023-07-10:2023-08-10"
  "2023-08-10:2023-09-10"
  "2023-09-10:2023-10-10"
  "2023-10-10:2023-11-10"
  "2023-11-10:2023-12-10"
  "2023-12-10:2024-01-10"
  "2024-01-10:2024-02-10"
  "2024-02-10:2024-03-10"
  "2024-03-10:2024-04-10"
  "2024-04-10:2024-05-10"
  "2024-05-10:2024-06-10"
  "2024-06-10:2024-07-10"
  "2024-07-10:2024-08-10"
  "2024-08-10:2024-09-10"
  "2024-09-10:2024-10-10"
  "2024-10-10:2024-11-10"
  "2024-11-10:2024-12-10"
  "2024-12-10:2025-01-10"
  "2025-01-10:2025-02-10"
  "2025-02-10:2025-03-10"
  "2025-03-10:2025-04-10"
  "2025-04-10:2025-05-10"
  "2025-05-10:2025-06-10"
  "2025-06-10:2025-07-10"
  "2025-07-10:2025-08-10"
  "2025-08-10:2025-09-10"
  "2025-09-10:2025-10-10"
  "2025-10-10:2025-11-10"
  "2025-11-10:2025-12-10"
  "2025-12-10:2026-01-10"
  "2026-01-10:2026-02-10"
  "2026-02-10:2026-03-10"
  "2026-03-10:2026-04-10"
  "2026-04-10:2026-05-10"
  "2026-05-10:2026-06-10"
  "2026-06-10:2026-07-10"
  "2026-07-10:2026-08-10"
  "2026-08-10:2026-09-10"
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
      })).then(r => r.text()).then(console.log).catch((e) => {
        // A PostgrestError is a plain object, not an Error, so without this
        // Node reports only an unhandled rejection of '#<Object>'.
        console.error('backtest-triggers failed:', JSON.stringify(e));
        process.exit(1);
      });
    "; then
      break
    fi
    if [ "$attempt" -eq 3 ]; then
      echo "=== chunk $CHUNK_NUM failed after 3 attempts — resume later with START_CHUNK=$CHUNK_NUM ./run-backtest-full.sh ==="
      exit 1
    fi
    echo "=== chunk $CHUNK_NUM attempt $attempt failed (error above; GOAWAY and statement timeouts both land here) — retrying in a fresh process in 10s ==="
    sleep 10
  done
done

echo "=== done — check trigger_stats in Supabase ==="
