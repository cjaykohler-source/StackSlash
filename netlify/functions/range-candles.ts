import { fetchSipBars } from "./lib/alpaca";

/**
 * On-demand candles for the symbol page's multi-day ranges, from the
 * consolidated tape (SIP), split-adjusted so reverse splits don't show as
 * cliffs. Nothing is stored.
 *
 *   GET /.netlify/functions/range-candles?symbol=AAPL&range=year
 *
 * Replaces the old line charts drawn from production bars_daily, which is
 * IEX-only (on sub-$5 names ~39% of closes are >1% off the SIP close,
 * measured 2026-09-11) and only holds ~18 months.
 *
 * The free data plan serves SIP data older than 15 minutes, so every
 * range ends at now - 16 min.
 */
type RangeKey = "week" | "month" | "year" | "18mo" | "5y" | "since2016";
type Timeframe = "30Min" | "1Day" | "1Week" | "1Month";

const DAY_MS = 86_400_000;
const SIP_DELAY_MS = 16 * 60_000;

// range -> candle size and how far back it starts
const RANGES: Record<RangeKey, { timeframe: Timeframe; start: (now: number) => number }> = {
  week: { timeframe: "30Min", start: (now) => now - 7 * DAY_MS },
  month: { timeframe: "1Day", start: (now) => now - 31 * DAY_MS },
  year: { timeframe: "1Day", start: (now) => now - 365 * DAY_MS },
  "18mo": { timeframe: "1Week", start: (now) => now - 548 * DAY_MS },
  "5y": { timeframe: "1Week", start: (now) => now - 5 * 365 * DAY_MS },
  since2016: { timeframe: "1Month", start: () => Date.UTC(2016, 0, 1) },
};

/** Minutes since midnight ET for an instant (DST-correct). */
function etMinuteOfDay(ms: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", hour: "2-digit", minute: "2-digit" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return Number(p.hour) * 60 + Number(p.minute);
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const ticker = url.searchParams.get("symbol")?.trim().toUpperCase();
  const range = url.searchParams.get("range") as RangeKey | null;
  const json = (body: unknown, status = 200, maxAge = 60) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${maxAge}` },
    });

  if (!ticker || !/^[A-Z][A-Z0-9./-]{0,9}$/.test(ticker)) return json({ error: "missing or invalid ?symbol" }, 400, 0);
  if (!range || !(range in RANGES)) return json({ error: `range must be one of ${Object.keys(RANGES).join(", ")}` }, 400, 0);

  const { timeframe, start } = RANGES[range];
  const now = Date.now();
  try {
    let bars = await fetchSipBars(
      ticker,
      timeframe,
      new Date(start(now)).toISOString(),
      new Date(now - SIP_DELAY_MS).toISOString(),
      "split",
    );
    // Intraday candles: regular session only (9:30a-4:00p ET), matching
    // the Session view; 30-min bars are stamped at their start.
    if (timeframe === "30Min") {
      bars = bars.filter((b) => {
        const m = etMinuteOfDay(Date.parse(b.t));
        return m >= 570 && m < 960;
      });
    }
    return json(
      {
        symbol: ticker,
        range,
        timeframe,
        bars: bars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })),
      },
      200,
      // The week view moves every half hour; longer views barely move intraday.
      timeframe === "30Min" ? 300 : 3600,
    );
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "fetch failed" }, 502, 0);
  }
};
