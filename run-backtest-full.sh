#!/usr/bin/env bash
# One-off: full 5-year / ~5,000-symbol backtest-triggers run, chunked by
# quarter to stay under any single-call timeout. Run from the mini
# (stackslash-worker-host), inside its repo clone, on main, after
# `git pull`. NOT meant to be run from a laptop (see README's
# HTTP/2 session-timeout note).
#
# Usage: ./run-backtest-full.sh
set -euo pipefail

set -a && . ./.env && set +a

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
  IFS=":" read -r START END <<< "${CHUNKS[$i]}"
  RESET="false"
  if [ "$i" -eq 0 ]; then RESET="true"; fi
  echo "=== chunk $((i+1))/${#CHUNKS[@]}: $START -> $END (reset=$RESET) ==="
  npx tsx -e "
    import fn from './netlify/functions/backtest-triggers.ts';
    fn(new Request('http://x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startDate: '$START', endDate: '$END', reset: $RESET })
    })).then(r => r.text()).then(console.log);
  "
done

echo "=== done — check trigger_stats in Supabase ==="
