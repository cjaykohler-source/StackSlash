import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { mapWithConcurrency } from "./lib/concurrency";
import { intradayFactors, type IntradayBar } from "./lib/intradayFactors";
import { evaluateTrigger, type TriggerDefinition, type TriggerInputs } from "./lib/triggers";
import { etDateString, etWallClock } from "./lib/etTime";

/**
 * Backtests the Phase 3 fast flip triggers against the 90-day
 * bars_intraday history: for each symbol/session it walks the minute bars
 * at 5-min checkpoints, recomputes intradayFactors on the bars-so-far,
 * evaluates the fast trigger definitions, and on the first fire simulates
 * a managed flip trade — the same hard/target/trail rules as
 * manage-positions.ts, intraday first, then rolling onto daily bars for a
 * multi-day hold, with the flip time stop.
 *
 * One flip_sim row per fire (run_id = "isim_<trigger>_<ts>"). POST only.
 * Body: {"triggerNames": [...], "days": 90, overrides...}. Defaults to
 * every enabled+disabled speed='fast' trigger whose definition uses only
 * intraday fields (the squeeze one needs a daily factor and is skipped
 * unless explicitly named — it isn't wired for the sim yet).
 */

const CHECKPOINT_MIN = 5;
const MAX_FORWARD_DAYS = 30;
// fields the sim can supply at a checkpoint: intraday factors + a
// news_age_hours computed from backfilled symbol_news.
const SIMULABLE_FIELDS = new Set(["news_age_hours"]);
const PURE_INTRADAY_FIELDS = new Set([
  "rvol",
  "or_break",
  "dist_vwap",
  "session_bars",
  "pct_off_hod",
  "pct_off_lod",
  "gap_pct",
  "session_return",
  "higher_lows",
  "cum_volume",
  "last_price",
  "range_expansion",
]);

type DayBar = { date: string; open: number; high: number; low: number; close: number };

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const db = getSupabaseAdmin();

  let body: {
    triggerNames?: string[];
    days?: number;
    hardStopPct?: number;
    profitTargetPct?: number;
    trailPct?: number;
    timeStopDays?: number;
  } = {};
  try {
    body = await req.json();
  } catch {
    /* defaults */
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T-]/g, "");

  const result = await withJobRun(db, "sim-intraday-flips", async () => {
    const { data: cfg } = await db
      .from("scan_config")
      .select("price_min, price_max, min_dollar_vol_20d, default_stop_pct, flip_profit_target_pct, flip_trail_pct, flip_time_stop_days")
      .eq("id", 1)
      .maybeSingle();
    const rules = {
      hard_stop_pct: body.hardStopPct ?? Number(cfg?.default_stop_pct ?? 0.12),
      profit_target_pct: body.profitTargetPct ?? Number(cfg?.flip_profit_target_pct ?? 0.15),
      trail_pct: body.trailPct ?? Number(cfg?.flip_trail_pct ?? 0.1),
      time_stop_days: body.timeStopDays ?? Number(cfg?.flip_time_stop_days ?? 4),
    };

    // triggers
    let tq = db.from("triggers").select("id, name, definition").eq("speed", "fast");
    if (body.triggerNames?.length) tq = tq.in("name", body.triggerNames);
    const { data: triggers, error: te } = await tq;
    if (te) throw te;
    const usable = (triggers ?? []).filter((t) => {
      if (body.triggerNames?.includes(t.name)) return true;
      const fields = ((t.definition as TriggerDefinition)?.all ?? []).map((c) => c.field);
      return fields.every((f) => PURE_INTRADAY_FIELDS.has(f) || SIMULABLE_FIELDS.has(f));
    });
    const needsNews = usable.some((t) =>
      ((t.definition as TriggerDefinition)?.all ?? []).some((c) => c.field === "news_age_hours"),
    );
    if (!usable.length) return { rowsProcessed: 0, result: { triggers: [] as string[], symbols: 0, fires: 0, runIds: [] as string[] } };

    // The band symbols backfill-intraday covered (same selection): in-band
    // liquid names from the latest factor_state + tracked.
    const days = body.days ?? 90;
    const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();
    const priceMax = Number(cfg?.price_max ?? 5);
    const minVol = Number(cfg?.min_dollar_vol_20d ?? 50_000);
    const { data: asOfRow } = await db
      .from("factor_state")
      .select("as_of")
      .order("as_of", { ascending: false })
      .limit(1)
      .maybeSingle();
    const asOf = (asOfRow as { as_of: string } | null)?.as_of;
    const [{ data: band }, { data: tracked }] = await Promise.all([
      asOf
        ? db
            .from("factor_state")
            .select("symbol_id")
            .eq("as_of", asOf)
            .not("last_close", "is", null)
            .lte("last_close", priceMax)
            .gte("dollar_vol_20d", minVol).limit(1000)
        : Promise.resolve({ data: [] as unknown[] }),
      db.from("tracked_symbols").select("symbol_id"),
    ]);
    const deepSymbols = [
      ...new Set(
        [...((band as { symbol_id: number }[] | null) ?? []), ...((tracked as { symbol_id: number }[] | null) ?? [])].map(
          (r) => r.symbol_id,
        ),
      ),
    ];
    if (!deepSymbols.length) return { rowsProcessed: 0, result: { triggers: [] as string[], symbols: 0, fires: 0, runIds: [] as string[] } };

    // symbol -> sorted headline timestamps (ms), for a checkpoint-time news_age_hours
    const newsTsBySymbol = new Map<number, number[]>();
    if (needsNews) {
      const { data: tickRows } = await db.from("symbols").select("id, ticker").in("id", deepSymbols);
      const idByTicker = new Map(
        ((tickRows as { id: number; ticker: string }[] | null) ?? []).map((r) => [r.ticker, r.id]),
      );
      for (let from = 0; ; from += 1000) {
        const { data } = await db
          .from("symbol_news")
          .select("created_at, symbols")
          .gte("created_at", sinceIso)
          .order("created_at", { ascending: true })
          .range(from, from + 999);
        const rows = (data as { created_at: string; symbols: string[] }[] | null) ?? [];
        for (const n of rows) {
          const t = Date.parse(n.created_at);
          for (const tk of n.symbols ?? []) {
            const sid = idByTicker.get(tk);
            if (sid == null) continue;
            (newsTsBySymbol.get(sid) ?? newsTsBySymbol.set(sid, []).get(sid)!).push(t);
          }
        }
        if (rows.length < 1000) break;
      }
    }

    const simRows: Record<string, unknown>[] = [];
    let processed = 0;

    await mapWithConcurrency(deepSymbols, 6, async (symbolId) => {
      // intraday bars for the window
      const intraday: { ts: number; price: number; volume: number }[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await db
          .from("bars_intraday")
          .select("ts, price, volume")
          .eq("symbol_id", symbolId)
          .gte("ts", sinceIso)
          .order("ts", { ascending: true })
          .range(from, from + 999);
        if (error) throw error;
        for (const b of (data as { ts: string; price: number; volume: number }[] | null) ?? [])
          intraday.push({ ts: Date.parse(b.ts), price: Number(b.price), volume: Number(b.volume) });
        if (!data || data.length < 1000) break;
      }
      if (intraday.length < 100) return;

      const { data: dailyRows } = await db
        .from("bars_daily")
        .select("date, open, high, low, close")
        .eq("symbol_id", symbolId)
        .gte("date", new Date(Date.now() - (days + 40) * 86400_000).toISOString().slice(0, 10))
        .order("date", { ascending: true });
      const daily: DayBar[] = ((dailyRows as Record<string, string | number>[] | null) ?? []).map((b) => ({
        date: String(b.date),
        open: Number(b.open),
        high: Number(b.high),
        low: Number(b.low),
        close: Number(b.close),
      }));
      const dailyIdx = new Map(daily.map((b, i) => [b.date, i]));

      // group intraday by ET session
      const sessions = new Map<string, { ts: number; price: number; volume: number }[]>();
      for (const b of intraday) {
        const d = etDateString(b.ts);
        (sessions.get(d) ?? sessions.set(d, []).get(d)!).push(b);
      }

      for (const [sessionDate, allBars] of sessions) {
        const dIdx = dailyIdx.get(sessionDate);
        if (dIdx === undefined || dIdx < 21) continue;
        const priorClose = daily[dIdx - 1].close;
        const openTs = etWallClock(sessionDate, 9, 30);
        const regBars: IntradayBar[] = allBars
          .filter((b) => b.ts >= openTs && b.ts < openTs + 390 * 60_000)
          .sort((a, b) => a.ts - b.ts);
        if (regBars.length < 20) continue;

        // build the time-of-day volume norm from this symbol's OTHER sessions
        // (leave-one-out is overkill; just use a flat per-minute mean here)
        const minuteVol = perMinuteMean(sessions, sessionDate, openTs);

        const newsTs = newsTsBySymbol.get(symbolId);

        // walk checkpoints
        let fired: { trigger: string; idx: number; price: number } | null = null;
        for (let i = 20; i < regBars.length && !fired; i += CHECKPOINT_MIN) {
          const soFar = regBars.slice(0, i + 1);
          const f = intradayFactors({ bars: soFar, priorClose, openTs, minuteVolume: minuteVol, atr20: null });
          const inputs: TriggerInputs = { ...f };
          if (newsTs?.length) {
            const nowMs = soFar[soFar.length - 1].ts;
            // newest headline at or before this checkpoint
            let newest = -1;
            for (const ts of newsTs) {
              if (ts <= nowMs && ts > newest) newest = ts;
              if (ts > nowMs) break;
            }
            if (newest > 0) inputs.news_age_hours = (nowMs - newest) / 3_600_000;
          }
          for (const t of usable) {
            if (evaluateTrigger(t.definition as unknown as TriggerDefinition, inputs)) {
              fired = { trigger: t.name, idx: i, price: soFar[soFar.length - 1].price };
              break;
            }
          }
        }
        if (!fired) continue;

        const entry = fired.price;
        const sim = walkFlipExit(regBars, fired.idx, daily, dIdx, entry, rules, sessionDate);
        simRows.push({
          run_id: `isim_${fired.trigger}_${stamp}`,
          trigger_name: fired.trigger,
          symbol_id: symbolId,
          entry_date: sessionDate,
          entry_price: round4(entry),
          exit_date: sim.exitDate,
          exit_reason: sim.reason,
          exit_price: sim.exitPrice != null ? round4(sim.exitPrice) : null,
          pnl_pct: sim.pnlPct != null ? round4(sim.pnlPct) : null,
          bars_held: sim.barsHeld,
          cal_days_held: sim.calDays,
          mfe_pct: round4(sim.mfe),
          mae_pct: round4(sim.mae),
          incomplete: sim.incomplete,
        });
      }
      processed++;
    });

    const BATCH = 1000;
    for (let i = 0; i < simRows.length; i += BATCH) {
      const { error } = await db.from("flip_sim").insert(simRows.slice(i, i + BATCH));
      if (error) throw error;
    }

    return {
      rowsProcessed: simRows.length,
      result: {
        triggers: usable.map((t) => t.name),
        symbols: processed,
        fires: simRows.length,
        runIds: [...new Set(simRows.map((r) => r.run_id))],
      },
    };
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};

/** Mean volume per session-minute across all of a symbol's sessions except `exclude`. */
function perMinuteMean(
  sessions: Map<string, { ts: number; price: number; volume: number }[]>,
  exclude: string,
  refOpenTs: number,
): number[] {
  const sum = new Array(390).fill(0);
  const cnt = new Array(390).fill(0);
  for (const [d, bars] of sessions) {
    if (d === exclude) continue;
    const openTs = etWallClock(d, 9, 30);
    for (const b of bars) {
      const m = Math.floor((b.ts - openTs) / 60_000);
      if (m >= 0 && m < 390) {
        sum[m] += b.volume;
        cnt[m]++;
      }
    }
  }
  void refOpenTs;
  return sum.map((s, i) => (cnt[i] > 0 ? s / cnt[i] : 0));
}

interface Rules {
  hard_stop_pct: number;
  profit_target_pct: number;
  trail_pct: number;
  time_stop_days: number;
}

function walkFlipExit(
  regBars: IntradayBar[],
  entryIdx: number,
  daily: DayBar[],
  entryDailyIdx: number,
  entry: number,
  r: Rules,
  entryDate: string,
) {
  const stop = entry * (1 - r.hard_stop_pct);
  const target = entry * (1 + r.profit_target_pct);
  let hw = entry;
  let mfe = 0;
  let mae = 0;

  // --- rest of the entry session, minute by minute (close-only) ---
  for (let i = entryIdx + 1; i < regBars.length; i++) {
    const px = regBars[i].price;
    mfe = Math.max(mfe, px / entry - 1);
    mae = Math.min(mae, px / entry - 1);
    if (px <= stop) return fin("hard_stop", entryDate, stop, entry, i - entryIdx, 0, mfe, mae);
    if (px >= target) return fin("take_profit", entryDate, target, entry, i - entryIdx, 0, mfe, mae);
    hw = Math.max(hw, px);
    if (hw >= entry * (1 + r.trail_pct) && px <= hw * (1 - r.trail_pct))
      return fin("trail_stop", entryDate, hw * (1 - r.trail_pct), entry, i - entryIdx, 0, mfe, mae);
  }
  const sessionBars = regBars.length - entryIdx - 1;

  // --- roll onto daily bars from the next session ---
  const end = Math.min(daily.length - 1, entryDailyIdx + MAX_FORWARD_DAYS);
  for (let d = entryDailyIdx + 1; d <= end; d++) {
    const b = daily[d];
    if (!(b.high > 0) || !(b.low > 0)) continue;
    const cal = Math.round((Date.parse(b.date) - Date.parse(entryDate)) / 86400_000);
    mfe = Math.max(mfe, b.high / entry - 1);
    mae = Math.min(mae, b.low / entry - 1);
    if (b.low <= stop) return fin("hard_stop", b.date, b.open <= stop ? b.open : stop, entry, sessionBars + (d - entryDailyIdx), cal, mfe, mae);
    if (b.high >= target) return fin("take_profit", b.date, b.open >= target ? b.open : target, entry, sessionBars + (d - entryDailyIdx), cal, mfe, mae);
    hw = Math.max(hw, b.high);
    if (hw >= entry * (1 + r.trail_pct)) {
      const t = hw * (1 - r.trail_pct);
      if (b.low <= t) return fin("trail_stop", b.date, b.open <= t ? b.open : t, entry, sessionBars + (d - entryDailyIdx), cal, mfe, mae);
    }
    if (cal > r.time_stop_days) return fin("time_stop", b.date, b.close, entry, sessionBars + (d - entryDailyIdx), cal, mfe, mae);
  }

  const last = daily[end];
  const cal = Math.round((Date.parse(last.date) - Date.parse(entryDate)) / 86400_000);
  return {
    reason: "open_at_end" as const,
    exitDate: last.date,
    exitPrice: last.close,
    pnlPct: last.close / entry - 1,
    barsHeld: sessionBars + (end - entryDailyIdx),
    calDays: cal,
    mfe,
    mae,
    incomplete: true,
  };
}

function fin(
  reason: string,
  exitDate: string,
  exitPrice: number,
  entry: number,
  barsHeld: number,
  calDays: number,
  mfe: number,
  mae: number,
) {
  return { reason, exitDate, exitPrice, pnlPct: exitPrice / entry - 1, barsHeld, calDays, mfe, mae, incomplete: false };
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
