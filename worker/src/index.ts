import { config } from "./config.js";
import { supabase } from "./supabaseClient.js";
import { AlpacaTradeStream } from "./alpacaStream.js";
import { RollingOutlierDetector } from "./rollingStats.js";
import { Heartbeat } from "./heartbeat.js";

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  log("starting realtime outlier worker");

  // Alpaca's free IEX websocket caps concurrent trade subscriptions (30
  // on the free plan), so this can't watch the whole ~1,900-symbol
  // universe the scheduled scans cover — asking for all of them gets the
  // stream rejected wholesale ("symbol limit exceeded"). Watch a bounded
  // set instead: every user-tracked symbol first, then the most liquid
  // names (highest 20-day dollar volume from the latest factor_state) to
  // fill the budget. Picked once at startup; restart to refresh.
  const budget = config.maxStreamSymbols;

  // alert_excluded symbols (mega-cap blue chips) produce no signal output,
  // so there's no point spending a subscription slot streaming them.
  const { data: trackedRows } = await supabase
    .from("tracked_symbols")
    .select("symbol_id, symbols!inner(ticker, alert_excluded)")
    .eq("symbols.alert_excluded", false);
  const tracked = (
    (trackedRows ?? []) as unknown as { symbol_id: number; symbols: { ticker: string } | null }[]
  )
    .filter((r) => r.symbols?.ticker)
    .map((r) => ({ id: r.symbol_id, ticker: r.symbols!.ticker }));

  const { data: asOfRow } = await supabase
    .from("factor_state")
    .select("as_of")
    .order("as_of", { ascending: false })
    .limit(1)
    .maybeSingle();

  let liquid: { id: number; ticker: string }[] = [];
  if (asOfRow?.as_of) {
    const { data: liquidRows, error: liqErr } = await supabase
      .from("factor_state")
      .select("symbol_id, dollar_vol_20d, symbols!inner(ticker, alert_excluded)")
      .eq("as_of", asOfRow.as_of)
      .eq("symbols.alert_excluded", false)
      .not("dollar_vol_20d", "is", null)
      .order("dollar_vol_20d", { ascending: false })
      .limit(budget);
    if (liqErr) throw liqErr;
    liquid = ((liquidRows ?? []) as unknown as { symbol_id: number; symbols: { ticker: string } | null }[])
      .filter((r) => r.symbols?.ticker)
      .map((r) => ({ id: r.symbol_id, ticker: r.symbols!.ticker }));
  }

  const symbolIdByTicker = new Map<string, number>();
  const tickers: string[] = [];
  for (const s of [...tracked, ...liquid]) {
    if (symbolIdByTicker.has(s.ticker) || tickers.length >= budget) continue;
    symbolIdByTicker.set(s.ticker, s.id);
    tickers.push(s.ticker);
  }
  if (!tickers.length) throw new Error("No symbols to watch — factor_state empty and nothing tracked?");
  log(`watching ${tickers.length} symbols (${tracked.length} tracked + liquidity fill): ${tickers.join(", ")}`);

  // The trigger row this worker fires into. Seeded via migration (see
  // README) — not evaluated through triggers.ts's declarative evaluator
  // like the scheduled functions' triggers, because this rule is
  // fundamentally streaming/incremental (EWMA updated per tick), not a
  // point-in-time snapshot check. The DB row still exists so fires show
  // up in the same trigger_events table, get the same dossier/alert
  // pipeline via the existing deep_dive_webhook, and respect a real
  // configured cooldown instead of a hardcoded one.
  const { data: trigger, error: trigErr } = await supabase
    .from("triggers")
    .select("id, enabled, cooldown_minutes")
    .eq("name", config.outlierTriggerName)
    .single();
  if (trigErr || !trigger) {
    throw new Error(
      `Trigger "${config.outlierTriggerName}" not found. Seed it first — see worker/README.md.`,
    );
  }
  if (!trigger.enabled) {
    log(`WARNING: trigger "${config.outlierTriggerName}" is disabled — detecting but not firing.`);
  }

  const detector = new RollingOutlierDetector(config.ewmaAlpha, config.minTicksBeforeEval);
  const heartbeat = new Heartbeat();
  await heartbeat.start();

  const lastFiredAt = new Map<number, number>(); // symbol_id -> ms epoch
  const cooldownMs = trigger.cooldown_minutes * 60_000;

  const stream = new AlpacaTradeStream(
    tickers,
    (trade) => {
      heartbeat.recordTick();
      const symbolId = symbolIdByTicker.get(trade.symbol);
      if (symbolId === undefined) return;

      const result = detector.update(trade.symbol, trade.price);
      if (!result) return;

      if (Math.abs(result.zScore) < config.zScoreThreshold) return;
      if (!trigger.enabled) return;

      const last = lastFiredAt.get(symbolId);
      const now = Date.now();
      if (last !== undefined && now - last < cooldownMs) return;

      lastFiredAt.set(symbolId, now);
      log(
        `OUTLIER ${trade.symbol} z=${result.zScore.toFixed(2)} ret=${(result.ret * 100).toFixed(3)}% price=${trade.price} (tick #${result.tickCount})`,
      );

      // Hand the fire to the confluence gate instead of inserting a
      // trigger_event directly: a real outlier spike (or crash) only
      // becomes an alert if it lands in a cluster with >= 1 other same-
      // direction trigger for this symbol in the window. Direction is the
      // sign of the move, not a fixed property of this trigger.
      void fetch(config.confluenceGateUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol_id: symbolId,
          trigger_id: trigger.id,
          direction: result.zScore >= 0 ? "long" : "short",
          source: "worker",
          trade_date: new Date().toISOString().slice(0, 10),
          snapshot: {
            price: trade.price,
            z_score: result.zScore,
            tick_return: result.ret,
            tick_count: result.tickCount,
            trade_ts: trade.timestamp,
          },
        }),
      })
        .then(async (res) => {
          if (!res.ok) console.error("confluence-gate rejected outlier fire", res.status, await res.text());
        })
        .catch((err) => console.error("Failed to POST outlier fire to confluence-gate", err));
    },
    (statusMsg) => log(`stream: ${statusMsg}`),
  );

  stream.start();

  const shutdown = async (signal: string) => {
    log(`received ${signal}, shutting down`);
    stream.stop();
    await heartbeat.stop("ok");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    log(`uncaught exception: ${err.stack ?? err.message}`);
    void heartbeat.stop("error", err.message).finally(() => process.exit(1));
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
