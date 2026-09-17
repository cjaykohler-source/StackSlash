import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { evaluateTrigger, type TriggerDefinition, type TriggerInputs } from "./lib/triggers";
import { filterByCooldown } from "./lib/cooldown";
import { openAlertPositions } from "./lib/alertPositions";
import { isRoundupHeadline } from "./lib/newsFilter";
import type { ConfluenceMeta, PromotedEvent } from "./lib/confluenceGate";
import { etDateString, etWallClock } from "./lib/etTime";

/**
 * Live intraday alert engine. Every 5 minutes during the session (launchd,
 * two minutes after intraday-factors-scan refreshes intraday_factor_state
 * for the monitored band), it evaluates every enabled speed='fast' trigger
 * — buy or sell side — against live session factors and alerts the moment
 * a condition holds.
 *
 * It deliberately does NOT go through the confluence gate. The gate stages
 * fires in pending_fires, deduped per (symbol, trigger, trade_date), and
 * folds any later same-direction fire into the day's existing event — so an
 * intraday trigger could fire at most once a day, and a second setup on the
 * same stock in the afternoon could never alert. Instead:
 *   - repeat control is each trigger's own cooldown_minutes against
 *     trigger_events (lib/cooldown.ts), so a stock can re-alert later in the
 *     session once the cooldown has passed;
 *   - a busy scan is ranked (relative volume, then size of the move) and
 *     capped at scan_config.intraday_alert_cap, strongest first;
 *   - events are inserted directly, which fires the deep_dive webhook
 *     (dossier + Discord card) exactly as a promoted event does;
 *   - every buy alert is followed by live exit timing (openAlertPositions).
 */

const FRESH_MINUTES = 15; // ignore factor rows the factors scan hasn't refreshed recently
const START_MIN_AFTER_OPEN = 5; // 09:35 ET, once the opening range exists
const SESSION_MINUTES = 390;

export default async () => {
  const db = getSupabaseAdmin();

  await withJobRun(db, "intraday-flip-scan", async () => {
    const empty = { rowsProcessed: 0, result: { fired: 0, alerted: 0, opened: 0 } };
    if (!isSessionOpen()) return empty;

    const sessionDate = etDateString(Date.now());

    const { data: trigData, error: te } = await db
      .from("triggers")
      .select("id, name, definition, cooldown_minutes, direction")
      .eq("enabled", true)
      .eq("speed", "fast");
    if (te) throw te;
    type Trig = { id: number; name: string; definition: unknown; cooldown_minutes: number; direction: string | null };
    const triggers = (trigData as Trig[] | null) ?? [];
    if (!triggers.length) return empty;
    const trigById = new Map(triggers.map((t) => [t.id, t]));
    const cooldownByTriggerId = new Map(triggers.map((t) => [t.id, t.cooldown_minutes] as const));

    const { data: cfg } = await db
      .from("scan_config")
      .select("price_min, price_max, intraday_alert_cap")
      .eq("id", 1)
      .maybeSingle();
    const priceMin = Number(cfg?.price_min ?? 0.1);
    const priceMax = Number(cfg?.price_max ?? 5);
    const alertCap = Number(cfg?.intraday_alert_cap ?? 10);

    // Live factors for today's session, fresh rows only.
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
    const freshCutoff = Date.now() - FRESH_MINUTES * 60_000;
    const liveRows = ifsRows.filter((r) => {
      const px = Number(r.last_price);
      return Date.parse(String(r.as_of)) >= freshCutoff && px >= priceMin && px <= priceMax;
    });
    if (!liveRows.length) return empty;
    const symIds = liveRows.map((r) => r.symbol_id as number);

    const needs = (field: string) =>
      triggers.some((t) => ((t.definition as TriggerDefinition)?.all ?? []).some((c) => c.field === field));

    // news_age_hours: hours since each symbol's newest headline.
    const newsAgeBySymbol = new Map<number, number>();
    if (needs("news_age_hours")) {
      const { data: tickRows } = await db.from("symbols").select("id, ticker").in("id", symIds);
      const idByTicker = new Map(((tickRows as { id: number; ticker: string }[] | null) ?? []).map((r) => [r.ticker, r.id]));
      const { data: news } = await db
        .from("symbol_news")
        .select("created_at, symbols, headline")
        .gte("created_at", new Date(Date.now() - 4 * 3_600_000).toISOString())
        .order("created_at", { ascending: false });
      for (const n of (news as { created_at: string; symbols: string[]; headline: string }[] | null) ?? []) {
        if (isRoundupHeadline(n.headline)) continue; // a sector roundup is not a catalyst
        const ageH = (Date.now() - Date.parse(n.created_at)) / 3_600_000;
        for (const tk of n.symbols ?? []) {
          const sid = idByTicker.get(tk);
          if (sid != null && !newsAgeBySymbol.has(sid)) newsAgeBySymbol.set(sid, ageH);
        }
      }
    }

    // Daily factor fields a fast trigger may reference (the squeeze measure).
    const dailyBySymbol = new Map<number, { bb_width_percentile_126d: number | null }>();
    if (needs("bb_width_percentile_126d")) {
      const { data: asOfRow } = await db
        .from("factor_state")
        .select("as_of")
        .order("as_of", { ascending: false })
        .limit(1)
        .maybeSingle();
      const asOf = (asOfRow as { as_of: string } | null)?.as_of;
      if (asOf) {
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
    const fires: { trigger_id: number; symbol_id: number; inputs: TriggerInputs }[] = [];
    for (const row of liveRows) {
      const symbolId = row.symbol_id as number;
      const inputs: TriggerInputs = {
        ...(row as Record<string, number | boolean | null>),
        ...(dailyBySymbol.get(symbolId) ?? {}),
      };
      const newsAge = newsAgeBySymbol.get(symbolId);
      if (newsAge != null) inputs.news_age_hours = newsAge;
      for (const t of triggers) {
        const fired = evaluateTrigger(t.definition as unknown as TriggerDefinition, inputs);
        evaluations.push({ trigger_id: t.id, symbol_id: symbolId, inputs, fired });
        if (fired) fires.push({ trigger_id: t.id, symbol_id: symbolId, inputs });
      }
    }
    for (let i = 0; i < evaluations.length; i += 5000) {
      const { error } = await db.from("trigger_evaluations").insert(evaluations.slice(i, i + 5000));
      if (error) throw error;
    }

    const coolable = await filterByCooldown(db, fires, cooldownByTriggerId);
    if (!coolable.length) return { rowsProcessed: liveRows.length, result: { fired: fires.length, alerted: 0, opened: 0 } };

    // Mega-cap blue chips never alert.
    const { data: symRows } = await db
      .from("symbols")
      .select("id, alert_excluded")
      .in("id", [...new Set(coolable.map((f) => f.symbol_id))]);
    const excluded = new Set(
      ((symRows as { id: number; alert_excluded: boolean }[] | null) ?? []).filter((s) => s.alert_excluded).map((s) => s.id),
    );

    // Strongest first: relative volume, then the size of the session move.
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
    const ranked = coolable
      .filter((f) => !excluded.has(f.symbol_id))
      .sort(
        (a, b) =>
          num(b.inputs.rvol) - num(a.inputs.rvol) ||
          Math.abs(num(b.inputs.session_return)) - Math.abs(num(a.inputs.session_return)),
      )
      .slice(0, alertCap);

    const alerted: PromotedEvent[] = [];
    const priceBySymbolId = new Map<number, number>();
    for (const f of ranked) {
      const t = trigById.get(f.trigger_id);
      if (!t) continue;
      const confluence: ConfluenceMeta = {
        count: 1,
        direction: t.direction === "short" ? "short" : "long",
        tier: "normal",
        triggers: [{ id: t.id, name: t.name }],
      };
      const { data: ev, error } = await db
        .from("trigger_events")
        .insert({
          trigger_id: t.id,
          symbol_id: f.symbol_id,
          priority: "normal",
          snapshot: { ...f.inputs, latest_price: f.inputs.last_price, source: "intraday-live", confluence },
        })
        .select("id")
        .single();
      if (error) throw error;
      alerted.push({ id: (ev as { id: number }).id, trigger_id: t.id, symbol_id: f.symbol_id, priority: "normal", confluence });
      const px = num(f.inputs.last_price);
      if (px > 0) priceBySymbolId.set(f.symbol_id, px);
    }

    const opened = await openAlertPositions(db, alerted, priceBySymbolId);
    return {
      rowsProcessed: liveRows.length,
      result: { fired: fires.length, coolable: coolable.length, alerted: alerted.length, opened },
    };
  });

  return new Response("ok");
};

function isSessionOpen(): boolean {
  const now = Date.now();
  const today = etDateString(now);
  const day = new Date(`${today}T12:00:00Z`).getUTCDay();
  if (day < 1 || day > 5) return false;
  const open = etWallClock(today, 9, 30);
  return now >= open + START_MIN_AFTER_OPEN * 60_000 && now < open + SESSION_MINUTES * 60_000;
}
