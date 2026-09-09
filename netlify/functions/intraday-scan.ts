import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { fetchSnapshots } from "./lib/alpaca";
import { evaluateTrigger, type TriggerDefinition, type TriggerInputs } from "./lib/triggers";
import { filterByCooldown } from "./lib/cooldown";
import { stageAndPromote } from "./lib/confluenceGate";

/**
 * Job B — intraday polling scan.
 *
 * Evaluates only technical/entry-timing triggers (category = 'technical')
 * against a bounded candidate set from the latest factor_state — not the
 * whole universe. The set is the union of: top-third cross-sectional
 * momentum names, the liquid in-band universe (the tradeable penny tier,
 * which almost never ranks by momentum), and tracked symbols.
 *
 * Scheduled via netlify.toml: every 10 min, 13:00-20:59 UTC, Mon-Fri.
 * The market-hours check below is a belt-and-suspenders no-op guard in
 * case the cron window is ever widened.
 */
export default async () => {
  const db = getSupabaseAdmin();

  await withJobRun(db, "intraday-scan", async () => {
    if (!isLikelyMarketHours()) {
      return { rowsProcessed: 0, result: null };
    }

    const today = new Date().toISOString().slice(0, 10);

    // factor_state / regime_state carry the *previous* close's values —
    // eod-scan only writes the current date after the market closes, so
    // during the session `as_of = today` doesn't exist yet. Use the most
    // recent snapshot instead (that's the right candidate set anyway:
    // yesterday's momentum ranking timed against today's intraday price).
    const { data: latestFs } = await db
      .from("factor_state")
      .select("as_of")
      .order("as_of", { ascending: false })
      .limit(1)
      .maybeSingle();
    const factorDate = (latestFs as { as_of: string } | null)?.as_of;
    if (!factorDate) {
      return { rowsProcessed: 0, result: null };
    }

    // Candidate universe, merged and de-duped from three sources:
    //  1. top-third cross-sectional momentum (the original design — momentum
    //     leaders getting a timing check),
    //  2. the liquid in-band universe (price <= scan_config ceiling, dollar
    //     volume above the floor) — the tradeable tier for a small penny
    //     account, which almost never ranks in (1),
    //  3. tracked symbols.
    const { data: cfgRow } = await db
      .from("scan_config")
      .select("price_max, min_dollar_vol_20d")
      .eq("id", 1)
      .maybeSingle();
    const priceMax = Number(cfgRow?.price_max ?? 3);
    const minVol = Number(cfgRow?.min_dollar_vol_20d ?? 50000);

    const SELECT = "symbol_id, bb_pctb, rsi14, rsi2, momentum_rank_pct, symbols(ticker, alert_excluded)";
    const IN_BAND_LIMIT = 800;
    const MAX_CANDIDATES = 3000;

    const { data: trackedRows } = await db.from("tracked_symbols").select("symbol_id");
    const trackedIds = ((trackedRows as { symbol_id: number }[] | null) ?? []).map((r) => r.symbol_id);

    const [momoRes, bandRes, trackedFsRes] = await Promise.all([
      db.from("factor_state").select(SELECT).eq("as_of", factorDate).gte("momentum_rank_pct", 0.67),
      db
        .from("factor_state")
        .select(SELECT)
        .eq("as_of", factorDate)
        .not("last_close", "is", null)
        .lte("last_close", priceMax)
        .gte("dollar_vol_20d", minVol)
        .order("dollar_vol_20d", { ascending: false })
        .limit(IN_BAND_LIMIT),
      trackedIds.length
        ? db.from("factor_state").select(SELECT).eq("as_of", factorDate).in("symbol_id", trackedIds)
        : Promise.resolve({ data: [] as unknown[], error: null }),
    ]);
    if (momoRes.error) throw momoRes.error;
    if (bandRes.error) throw bandRes.error;

    type Row = {
      symbol_id: number;
      bb_pctb: number | null;
      rsi14: number | null;
      rsi2: number | null;
      momentum_rank_pct: number | null;
      symbols: { ticker: string; alert_excluded: boolean } | null;
    };
    const byId = new Map<number, Row>();
    for (const r of [
      ...((momoRes.data as unknown as Row[]) ?? []),
      ...((bandRes.data as unknown as Row[]) ?? []),
      ...((trackedFsRes.data as unknown as Row[]) ?? []),
    ]) {
      if (!r.symbols?.ticker || r.symbols.alert_excluded) continue;
      if (!byId.has(r.symbol_id)) byId.set(r.symbol_id, r);
    }
    const candidates = [...byId.values()].slice(0, MAX_CANDIDATES);
    if (!candidates.length) {
      return { rowsProcessed: 0, result: null };
    }

    const tickerBySymbolId = new Map<number, string>();
    for (const c of candidates) {
      if (c.symbols?.ticker) tickerBySymbolId.set(c.symbol_id, c.symbols.ticker);
    }
    const tickers = [...tickerBySymbolId.values()];
    if (!tickers.length) return { rowsProcessed: 0, result: null };

    const snapshots = await fetchSnapshots(tickers);

    const { data: triggers, error: trigErr } = await db
      .from("triggers")
      .select("id, definition, cooldown_minutes, direction")
      .eq("enabled", true)
      .eq("category", "technical");
    if (trigErr) throw trigErr;
    const cooldownByTriggerId = new Map((triggers ?? []).map((t) => [t.id, t.cooldown_minutes] as const));
    const directionByTriggerId = new Map(
      (triggers ?? []).map((t) => [t.id, (t.direction as "long" | "short" | null) ?? "long"] as const),
    );

    const { data: regime } = await db
      .from("regime_state")
      .select("risk_on")
      .order("as_of", { ascending: false })
      .limit(1)
      .maybeSingle();

    const evaluations: Record<string, unknown>[] = [];
    const fires: { trigger_id: number; symbol_id: number; snapshot: unknown }[] = [];

    for (const candidate of candidates) {
      const ticker = tickerBySymbolId.get(candidate.symbol_id);
      const snap = ticker ? snapshots[ticker] : undefined;
      const dailyBar = snap?.dailyBar;
      const latestPrice = snap?.latestTrade?.p ?? dailyBar?.c ?? null;

      // Cheap volume-vs-day-open proxy; a real implementation would compare
      // running intraday volume to the 20-day average volume at this same
      // time of day (needs a small history of intraday-volume-by-minute —
      // left as a follow-up once bars_intraday has real data).
      const inputs: TriggerInputs = {
        bb_pctb: candidate.bb_pctb,
        rsi14: candidate.rsi14,
        rsi2: candidate.rsi2,
        momentum_rank_pct: candidate.momentum_rank_pct,
        latest_price: latestPrice,
        risk_on: regime?.risk_on ?? null,
      };

      for (const trigger of triggers ?? []) {
        const fired = evaluateTrigger(trigger.definition as unknown as TriggerDefinition, inputs);
        evaluations.push({ trigger_id: trigger.id, symbol_id: candidate.symbol_id, inputs, fired });
        if (fired) {
          fires.push({ trigger_id: trigger.id, symbol_id: candidate.symbol_id, snapshot: inputs });
        }
      }
    }

    // Batched — the candidate set can now be a few thousand names.
    const EVAL_BATCH = 5000;
    for (let i = 0; i < evaluations.length; i += EVAL_BATCH) {
      const { error } = await db.from("trigger_evaluations").insert(evaluations.slice(i, i + EVAL_BATCH));
      if (error) throw error;
    }
    // Real cooldown check (lib/cooldown.ts) against the most recent
    // trigger_event for the same trigger+symbol — see eod-scan.ts's own
    // comment on this for why: a condition true since the last real fire
    // shouldn't create a fresh trigger_event/dossier/alert on every
    // 10-minute poll.
    const coolableFires = await filterByCooldown(db, fires, cooldownByTriggerId);

    // Confluence gate — a technical fire here only becomes a trigger_event
    // (dossier + alert) if it lands in a cluster of >= 2 distinct same-
    // direction triggers for the symbol within the rolling window; today's
    // eod-scan / realtime fires count toward that cluster too. Lone fires
    // stay in pending_fires. See lib/confluenceGate.ts.
    const promoted = await stageAndPromote(
      db,
      coolableFires.map((f) => ({
        symbol_id: f.symbol_id,
        trigger_id: f.trigger_id,
        direction: directionByTriggerId.get(f.trigger_id) ?? "long",
        snapshot: f.snapshot,
      })),
      { source: "intraday-scan", tradeDate: today },
    );

    return { rowsProcessed: candidates.length, result: { promoted: promoted.length } };
  });

  return new Response("ok");
};

function isLikelyMarketHours(): boolean {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcDay = now.getUTCDay(); // 0 = Sunday
  // Rough US market hours in UTC (13:30-20:00), Mon-Fri. Doesn't account
  // for holidays — fine for a v1 no-op guard, not a trading calendar.
  return utcDay >= 1 && utcDay <= 5 && utcHour >= 13 && utcHour < 21;
}

// Schedule is configured in netlify.toml under [functions."intraday-scan"].
