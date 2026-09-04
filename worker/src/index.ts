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

  // Same universe as eod-scan/intraday-scan — one table, one source of
  // truth for "what symbols does this whole system care about."
  const { data: symbols, error: symErr } = await supabase
    .from("symbols")
    .select("id, ticker")
    .eq("active", true);
  if (symErr) throw symErr;
  if (!symbols?.length) throw new Error("No active symbols in `symbols` table.");

  const symbolIdByTicker = new Map(symbols.map((s) => [s.ticker, s.id] as const));
  const tickers = symbols.map((s) => s.ticker);
  log(`watching ${tickers.length} symbols: ${tickers.join(", ")}`);

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

      void supabase
        .from("trigger_events")
        .insert({
          trigger_id: trigger.id,
          symbol_id: symbolId,
          snapshot: {
            price: trade.price,
            z_score: result.zScore,
            tick_return: result.ret,
            tick_count: result.tickCount,
            trade_ts: trade.timestamp,
          },
        })
        .then(({ error }) => {
          if (error) console.error("Failed to insert outlier trigger_event", error);
        });
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
