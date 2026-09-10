import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { evaluateTrigger, type TriggerDefinition, type TriggerInputs } from "./lib/triggers";
import { filterByCooldown } from "./lib/cooldown";
import { stageAndPromote } from "./lib/confluenceGate";
import { etDateString } from "./lib/etTime";

/**
 * Job — intraday flip-trigger evaluator. Reads intraday_factor_state
 * (kept current by intraday-factors-scan) for today's session, joins the
 * handful of daily factor_state fields a fast trigger references
 * (bb_width_percentile_126d for squeeze_release_intraday), evaluates
 * every enabled speed='fast' trigger, and routes fires through the
 * cooldown filter + confluence gate like every other source.
 *
 * A promoted fast fire opens a 'flip' shadow position (eod-scan step 6
 * keys off triggers.speed) which manage-positions.ts then runs.
 *
 * Scheduled via netlify.toml, every 5 min during market hours — staggered
 * ~2 min after intraday-factors-scan so it reads fresh factors.
 */

export default async () => {
  const db = getSupabaseAdmin();

  await withJobRun(db, "intraday-flip-scan", async () => {
    if (!isLikelyMarketHours()) return { rowsProcessed: 0, result: { fired: 0, promoted: 0 } };

    const sessionDate = etDateString(Date.now());
    const today = new Date().toISOString().slice(0, 10);

    const { data: triggers, error: te } = await db
      .from("triggers")
      .select("id, name, definition, cooldown_minutes")
      .eq("enabled", true)
      .eq("speed", "fast")
      .eq("direction", "long");
    if (te) throw te;
    if (!triggers?.length) return { rowsProcessed: 0, result: { fired: 0, promoted: 0 } };
    const cooldownByTriggerId = new Map(triggers.map((t) => [t.id, t.cooldown_minutes] as const));

    // intraday factors for today's session
    const ifsRows: Record<string, unknown>[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("intraday_factor_state")
        .select("*")
        .eq("session_date", sessionDate)
        .range(from, from + 999);
      if (error) throw error;
      ifsRows.push(...((data as Record<string, unknown>[] | null) ?? []));
      if (!data || data.length < 1000) break;
    }
    if (!ifsRows.length) return { rowsProcessed: 0, result: { fired: 0, promoted: 0 } };

    // daily factor fields any fast trigger needs (only squeeze, for now)
    const needsDaily = triggers.some((t) =>
      ((t.definition as TriggerDefinition)?.all ?? []).some((c) => c.field === "bb_width_percentile_126d"),
    );
    const dailyBySymbol = new Map<number, { bb_width_percentile_126d: number | null }>();
    if (needsDaily) {
      const { data: asOfRow } = await db
        .from("factor_state")
        .select("as_of")
        .order("as_of", { ascending: false })
        .limit(1)
        .maybeSingle();
      const asOf = (asOfRow as { as_of: string } | null)?.as_of;
      if (asOf) {
        const symIds = ifsRows.map((r) => r.symbol_id as number);
        for (let i = 0; i < symIds.length; i += 500) {
          const { data } = await db
            .from("factor_state")
            .select("symbol_id, bb_width_percentile_126d")
            .eq("as_of", asOf)
            .in("symbol_id", symIds.slice(i, i + 500));
          for (const r of (data as { symbol_id: number; bb_width_percentile_126d: number | null }[] | null) ?? [])
            dailyBySymbol.set(r.symbol_id, { bb_width_percentile_126d: r.bb_width_percentile_126d });
        }
      }
    }

    const evaluations: Record<string, unknown>[] = [];
    const fires: { trigger_id: number; symbol_id: number; snapshot: unknown }[] = [];

    for (const row of ifsRows) {
      const symbolId = row.symbol_id as number;
      const inputs: TriggerInputs = {
        ...(row as Record<string, number | boolean | null>),
        ...(dailyBySymbol.get(symbolId) ?? {}),
      };
      for (const t of triggers) {
        const fired = evaluateTrigger(t.definition as unknown as TriggerDefinition, inputs);
        evaluations.push({ trigger_id: t.id, symbol_id: symbolId, inputs, fired });
        if (fired) fires.push({ trigger_id: t.id, symbol_id: symbolId, snapshot: inputs });
      }
    }

    for (let i = 0; i < evaluations.length; i += 5000) {
      const { error } = await db.from("trigger_evaluations").insert(evaluations.slice(i, i + 5000));
      if (error) throw error;
    }

    const coolable = await filterByCooldown(db, fires, cooldownByTriggerId);
    const promoted = await stageAndPromote(
      db,
      coolable.map((f) => ({ symbol_id: f.symbol_id, trigger_id: f.trigger_id, direction: "long" as const, snapshot: f.snapshot })),
      { source: "intraday-flip-scan", tradeDate: today },
    );

    return { rowsProcessed: ifsRows.length, result: { fired: coolable.length, promoted: promoted.length } };
  });

  return new Response("ok");
};

function isLikelyMarketHours(): boolean {
  const now = new Date();
  const d = now.getUTCDay();
  const h = now.getUTCHours();
  return d >= 1 && d <= 5 && h >= 13 && h < 21;
}
