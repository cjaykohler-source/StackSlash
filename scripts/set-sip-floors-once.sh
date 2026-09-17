#!/bin/bash
# One-shot, 2026-09-17 16:01 ET: move scan_config liquidity floors to SIP
# levels after the session, before eod-scan (17:45) runs on SIP volume.
# Guarded to that date so the yearly launchd calendar can never re-apply it.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
[ "$(TZ=America/New_York date +%F)" = "2026-09-17" ] || exit 0
cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a
mkdir -p "$HOME/Library/Logs/stackslash-set-sip-floors"
npx --yes tsx -e "
import { getSupabaseAdmin } from './netlify/functions/lib/supabaseAdmin';
(async () => {
  const { data, error } = await getSupabaseAdmin().from('scan_config')
    .update({ monitor_min_dollar_vol_20d: 800000, min_dollar_vol_20d: 2500000, updated_at: new Date().toISOString() })
    .eq('id', 1).select('monitor_min_dollar_vol_20d, min_dollar_vol_20d');
  if (error) throw error;
  console.log(new Date().toISOString(), 'floors set', JSON.stringify(data));
})();
" >> "$HOME/Library/Logs/stackslash-set-sip-floors/run.log" 2>&1
