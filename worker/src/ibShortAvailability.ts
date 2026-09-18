/**
 * Shares available to borrow at IBKR for every active symbol, into
 * Supabase `short_availability`. Reads IB Gateway on this host (read-only
 * API, 127.0.0.1:4001); requests DELAYED data, so it needs no paid market
 * data subscription — generic tick 236 (shortable tier + shortable shares)
 * is served on the delayed feed.
 *
 * IB allows ~100 concurrent market-data lines, so symbols go in batches:
 * subscribe, wait for the ticks, cancel. ~5k symbols takes ~25 minutes.
 * Writes its own job_runs row. Run with:
 *   node --env-file=../.env --import tsx src/ibShortAvailability.ts
 */
import { createClient } from "@supabase/supabase-js";
import ib from "@stoqey/ib";

const { IBApi, EventName, SecType } = ib;
// Measured 2026-09-18: 90 lines x 4 s returned ticks for only the first
// ~135 symbols of a run (no error from IB); 45 x 12 s returned all of them.
const BATCH = 45;
const WAIT_MS = 12000;
const PORT = Number(process.env.IB_GATEWAY_PORT ?? "4001");

const db = createClient(process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const errorCounts = new Map<number, number>();

type Sample = { shortable_shares?: number; shortable_tier?: number };

async function activeSymbols(): Promise<{ id: number; ticker: string }[]> {
  const out: { id: number; ticker: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("symbols").select("id,ticker").eq("active", true).order("id").range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

function connect(): Promise<InstanceType<typeof IBApi>> {
  const api = new IBApi({ host: "127.0.0.1", port: PORT, clientId: 931 });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`IB Gateway not reachable on :${PORT}`)), 10000);
    api.once(EventName.connected, () => {
      clearTimeout(timer);
      api.reqMarketDataType(3);
      resolve(api);
    });
    api.on(EventName.error, (err, code, reqId) => {
      if (code === 502 || code === 504) reject(new Error(`IB Gateway: ${err.message}`));
      // 10167/10089 = "delayed data" notices, 200 = unknown contract: expected, not errors.
      if (![10167, 10089, 200, 2104, 2106, 2158, 2108].includes(code)) errorCounts.set(code, (errorCounts.get(code) ?? 0) + 1);
      if (process.env.IB_DEBUG && code !== 10167) console.log("ib", code, reqId, err.message);
    });
    api.connect();
  });
}

async function run(): Promise<number> {
  const symbols = await activeSymbols();
  const api = await connect();
  const samples = new Map<number, Sample>();
  api.on(EventName.tickGeneric, (reqId, field, value) => {
    if (field === 46) (samples.get(reqId) ?? samples.set(reqId, {}).get(reqId)!).shortable_tier = value;
  });
  api.on(EventName.tickSize, (reqId, field, value) => {
    if (field === 89) (samples.get(reqId) ?? samples.set(reqId, {}).get(reqId)!).shortable_shares = value;
  });

  const capturedAt = new Date().toISOString();
  let written = 0;
  try {
    for (let i = 0; i < symbols.length; i += BATCH) {
      const batch = symbols.slice(i, i + BATCH);
      batch.forEach((s, j) =>
        api.reqMktData(i + j + 1, { symbol: s.ticker.replace(".", " "), secType: SecType.STK, exchange: "SMART", currency: "USD" }, "236", false, false),
      );
      await new Promise((r) => setTimeout(r, WAIT_MS));
      batch.forEach((_, j) => api.cancelMktData(i + j + 1));
      const rows = batch
        .map((s, j) => ({ s, sample: samples.get(i + j + 1) }))
        .filter(({ sample }) => sample && (sample.shortable_shares != null || sample.shortable_tier != null))
        .map(({ s, sample }) => ({ symbol_id: s.id, captured_at: capturedAt, ...sample }));
      if (rows.length) {
        const { error } = await db.from("short_availability").upsert(rows, { onConflict: "symbol_id,captured_at" });
        if (error) throw error;
        written += rows.length;
      }
      if ((i / BATCH) % 10 === 0) console.log(`${Math.min(i + BATCH, symbols.length)}/${symbols.length} written=${written}`);
    }
  } finally {
    api.disconnect();
  }
  console.log(`done: ${symbols.length} symbols, ${written} rows, ib errors ${JSON.stringify(Object.fromEntries(errorCounts))}`);
  return written;
}

const { data: job, error: jobErr } = await db.from("job_runs").insert({ job_name: "ib-short-availability", status: "running" }).select("id").single();
if (jobErr) throw jobErr;
try {
  const n = await run();
  await db.from("job_runs").update({ status: "ok", rows_processed: n, finished_at: new Date().toISOString() }).eq("id", job.id);
  process.exit(0);
} catch (e) {
  await db.from("job_runs").update({ status: "failed", error: String(e).slice(0, 1000), finished_at: new Date().toISOString() }).eq("id", job.id);
  console.error(e);
  process.exit(1);
}
