import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { computeFactors, computeRegime } from "./lib/dailySnapshot";
import { evaluateTrigger, type TriggerDefinition, type TriggerInputs } from "./lib/triggers";

/**
 * Historical simulation of the Phase 1 flip exit engine.
 *
 * Replays the flip-eligible long triggers (enabled, category in
 * technical/breakout — i.e. the non-momentum entries manage-positions.ts
 * would manage) against real bars_daily OHLC over the retained window,
 * band-filtered to scan_config's price/liquidity ceiling. For every fire
 * it opens a position at the signal-day close and walks forward bar by
 * bar applying the same four rules as manage-positions.ts, intrabar:
 *
 *   1. hard stop     bar low  <= stop_price          (fill at open if gapped through)
 *   2. profit target bar high >= entry*(1+target)    (fill at open if gapped through)
 *   3. trailing stop bar low  <= high_water*(1-trail) (armed once hw >= entry*(1+trail))
 *   4. time stop      calendar days held > time_stop_days -> close at that bar's close
 *
 * Rows land in flip_sim (one per fire). POST only; not scheduled.
 * Body: {"months": 18, "startDate": "...", "endDate": "..."} — all optional.
 * Chunk by date range at ~5,000-symbol scale, same as backtest-triggers.
 */

const LOOKBACK_WINDOW = 300;
const MIN_HISTORY_BEFORE_EVAL = 260;
const MAX_FORWARD_BARS = 40; // hard cap on the exit walk

type Ohlc = { date: string; open: number; high: number; low: number; close: number; volume: number };

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const db = getSupabaseAdmin();

  let body: {
    months?: number;
    startDate?: string;
    endDate?: string;
    runId?: string;
    // which triggers to replay — explicit list, else all speed='fast'
    triggerNames?: string[];
    // optional rule overrides for parameter sweeps (default: scan_config)
    hardStopPct?: number;
    profitTargetPct?: number;
    trailPct?: number;
    timeStopDays?: number;
  } = {};
  try {
    body = await req.json();
  } catch {
    /* no body ok */
  }
  const runId = body.runId ?? `sim_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;

  const result = await withJobRun(db, "sim-flip-exits", async () => {
    const { data: cfg } = await db
      .from("scan_config")
      .select("price_min, price_max, min_dollar_vol_20d, default_stop_pct, flip_profit_target_pct, flip_trail_pct, flip_time_stop_days")
      .eq("id", 1)
      .maybeSingle();
    const priceMin = Number(cfg?.price_min ?? 0.1);
    const priceMax = Number(cfg?.price_max ?? 5);
    const minVol = Number(cfg?.min_dollar_vol_20d ?? 50_000);
    const rules = {
      hard_stop_pct: body.hardStopPct ?? Number(cfg?.default_stop_pct ?? 0.12),
      profit_target_pct: body.profitTargetPct ?? Number(cfg?.flip_profit_target_pct ?? 0.15),
      trail_pct: body.trailPct ?? Number(cfg?.flip_trail_pct ?? 0.1),
      time_stop_days: body.timeStopDays ?? Number(cfg?.flip_time_stop_days ?? 4),
    };

    const { data: symbols, error: symErr } = await db.from("symbols").select("id, ticker").eq("active", true);
    if (symErr) throw symErr;
    const spy = symbols?.find((s) => s.ticker === "SPY");
    if (!spy) throw new Error("SPY not in symbols");

    const months = body.months ?? 18;
    const fetchFrom = body.startDate
      ? addDays(body.startDate, -500)
      : addDays(new Date().toISOString().slice(0, 10), -Math.round(months * 30.4) - 400);
    const fetchTo = body.endDate ? addDays(body.endDate, 60) : undefined;

    async function loadBars(symbolId: number): Promise<Ohlc[]> {
      const rows: Ohlc[] = [];
      const PAGE = 1000;
      let from = 0;
      for (;;) {
        let q = db
          .from("bars_daily")
          .select("date, open, high, low, close, volume")
          .eq("symbol_id", symbolId)
          .gte("date", fetchFrom)
          .order("date", { ascending: true })
          .range(from, from + PAGE - 1);
        if (fetchTo) q = q.lte("date", fetchTo);
        const { data, error } = await q;
        if (error) throw error;
        if (!data?.length) break;
        for (const b of data as Record<string, number | string>[]) {
          rows.push({
            date: String(b.date),
            open: Number(b.open),
            high: Number(b.high),
            low: Number(b.low),
            close: Number(b.close),
            volume: Number(b.volume),
          });
        }
        if (data.length < PAGE) break;
        from += PAGE;
      }
      return rows;
    }

    const barsBySymbol = new Map<number, Ohlc[]>();
    const CONC = 25;
    for (let i = 0; i < symbols!.length; i += CONC) {
      const batch = symbols!.slice(i, i + CONC);
      const res = await Promise.all(batch.map((s) => loadBars(s.id)));
      batch.forEach((s, j) => barsBySymbol.set(s.id, res[j]));
    }

    const dateIdx = new Map<number, Map<string, number>>();
    for (const [sid, bars] of barsBySymbol) {
      const m = new Map<string, number>();
      bars.forEach((b, i) => m.set(b.date, i));
      dateIdx.set(sid, m);
    }

    const spyBars = barsBySymbol.get(spy.id) ?? [];
    let evalDates = spyBars.slice(MIN_HISTORY_BEFORE_EVAL, spyBars.length - 1).map((b) => b.date);
    if (body.startDate) evalDates = evalDates.filter((d) => d >= body.startDate!);
    if (body.endDate) evalDates = evalDates.filter((d) => d <= body.endDate!);

    let trigQ = db.from("triggers").select("id, name, definition").eq("enabled", true).eq("direction", "long");
    trigQ = body.triggerNames?.length
      ? trigQ.in("name", body.triggerNames)
      : trigQ.eq("speed", "fast");
    const { data: triggers, error: trigErr } = await trigQ;
    if (trigErr) throw trigErr;
    if (!triggers?.length) return { rowsProcessed: 0, result: { runId, fires: 0, evalDates: 0 } };

    const simRows: Record<string, unknown>[] = [];

    for (const date of evalDates) {
      const windowBySymbol = new Map<number, { date: string; close: number; volume: number }[]>();
      const idxBySymbol = new Map<number, number>();
      for (const [sid, bars] of barsBySymbol) {
        const idx = dateIdx.get(sid)?.get(date);
        if (idx === undefined) continue;
        windowBySymbol.set(
          sid,
          bars.slice(Math.max(0, idx + 1 - LOOKBACK_WINDOW), idx + 1).map((b) => ({
            date: b.date,
            close: b.close,
            volume: b.volume,
          })),
        );
        idxBySymbol.set(sid, idx);
      }

      const factors = computeFactors(windowBySymbol);
      const regime = computeRegime(windowBySymbol.get(spy.id));

      for (const [sid, f] of factors) {
        const bars = barsBySymbol.get(sid)!;
        const eIdx = idxBySymbol.get(sid)!;
        const entryPrice = bars[eIdx].close;
        if (!(entryPrice > 0) || entryPrice < priceMin || entryPrice > priceMax) continue;
        if ((f.dollar_vol_20d ?? 0) < minVol) continue;

        const inputs: TriggerInputs = { ...f, risk_on: regime?.risk_on ?? null };
        for (const t of triggers) {
          if (!evaluateTrigger(t.definition as unknown as TriggerDefinition, inputs)) continue;
          const sim = walkExit(bars, eIdx, entryPrice, rules);
          simRows.push({
            run_id: runId,
            trigger_name: t.name,
            symbol_id: sid,
            entry_date: date,
            entry_price: round4(entryPrice),
            exit_date: sim.exitDate,
            exit_reason: sim.reason,
            exit_price: sim.exitPrice != null ? round4(sim.exitPrice) : null,
            pnl_pct: sim.pnlPct != null ? round4(sim.pnlPct) : null,
            bars_held: sim.barsHeld,
            cal_days_held: sim.calDays,
            mfe_pct: sim.mfe != null ? round4(sim.mfe) : null,
            mae_pct: sim.mae != null ? round4(sim.mae) : null,
            incomplete: sim.incomplete,
          });
        }
      }
    }

    const BATCH = 1000;
    for (let i = 0; i < simRows.length; i += BATCH) {
      const { error } = await db.from("flip_sim").insert(simRows.slice(i, i + BATCH));
      if (error) throw error;
    }

    return { rowsProcessed: simRows.length, result: { runId, fires: simRows.length, evalDates: evalDates.length } };
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};

interface WalkRules {
  hard_stop_pct: number;
  profit_target_pct: number;
  trail_pct: number;
  time_stop_days: number;
}

function walkExit(bars: Ohlc[], entryIdx: number, entry: number, r: WalkRules) {
  const stop = entry * (1 - r.hard_stop_pct);
  const target = entry * (1 + r.profit_target_pct);
  const entryDate = bars[entryIdx].date;
  let hw = entry;
  let mfe = 0;
  let mae = 0;

  const end = Math.min(bars.length - 1, entryIdx + MAX_FORWARD_BARS);
  for (let i = entryIdx + 1; i <= end; i++) {
    const b = bars[i];
    if (!(b.high > 0) || !(b.low > 0)) continue;
    const barsHeld = i - entryIdx;
    const calDays = Math.round((Date.parse(b.date) - Date.parse(entryDate)) / 86400_000);
    mfe = Math.max(mfe, b.high / entry - 1);
    mae = Math.min(mae, b.low / entry - 1);

    // 1. hard stop (fill at the open if the bar gapped straight through)
    if (b.low <= stop) {
      const px = b.open <= stop ? b.open : stop;
      return done("hard_stop", b.date, px, entry, barsHeld, calDays, mfe, mae);
    }
    // 2. profit target
    if (b.high >= target) {
      const px = b.open >= target ? b.open : target;
      return done("take_profit", b.date, px, entry, barsHeld, calDays, mfe, mae);
    }
    // 3. trailing stop (armed once we've been up one trail width)
    hw = Math.max(hw, b.high);
    if (hw >= entry * (1 + r.trail_pct)) {
      const trailStop = hw * (1 - r.trail_pct);
      if (b.low <= trailStop) {
        const px = b.open <= trailStop ? b.open : trailStop;
        return done("trail_stop", b.date, px, entry, barsHeld, calDays, mfe, mae);
      }
    }
    // 4. time stop
    if (calDays > r.time_stop_days) {
      return done("time_stop", b.date, b.close, entry, barsHeld, calDays, mfe, mae);
    }
  }

  // ran out of bars before any rule fired
  const last = bars[end];
  const barsHeld = end - entryIdx;
  if (barsHeld <= 0) {
    return { reason: null, exitDate: null, exitPrice: null, pnlPct: null, barsHeld: 0, calDays: 0, mfe, mae, incomplete: true };
  }
  const calDays = Math.round((Date.parse(last.date) - Date.parse(entryDate)) / 86400_000);
  return {
    reason: "open_at_end" as const,
    exitDate: last.date,
    exitPrice: last.close,
    pnlPct: last.close / entry - 1,
    barsHeld,
    calDays,
    mfe,
    mae,
    incomplete: true,
  };
}

function done(
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

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
