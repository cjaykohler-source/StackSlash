import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { fetchNewsFeed } from "./lib/alpaca";

/**
 * Polls the whole-market Alpaca/Benzinga news feed and upserts it into
 * symbol_news. catalyst_momentum (and the deep-dive news flags) read from
 * this instead of a per-fire fetch, so a headline is on record the moment
 * it lands rather than only when something already fired.
 *
 * Scheduled via netlify.toml, every 5 min 12:00-21:00 UTC weekdays
 * (covers the pre-market catalyst window too). GCs rows older than
 * RETAIN_DAYS on each run — cheap, keeps the table bounded.
 */

const LOOKBACK_MIN = 20; // overlap the 5-min cadence so nothing slips between polls
const RETAIN_DAYS = 30;

export default async () => {
  const db = getSupabaseAdmin();

  await withJobRun(db, "news-scan", async () => {
    const start = new Date(Date.now() - LOOKBACK_MIN * 60_000).toISOString();
    const items = await fetchNewsFeed(start, { maxPages: 20 });

    if (items.length) {
      const rows = items.map((n) => ({
        id: n.id,
        headline: n.headline,
        summary: n.summary ?? null,
        source: n.source ?? null,
        url: n.url ?? null,
        created_at: n.created_at,
        symbols: n.symbols ?? [],
      }));
      const { error } = await db.from("symbol_news").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;
    }

    const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400_000).toISOString();
    await db.from("symbol_news").delete().lt("created_at", cutoff);

    return { rowsProcessed: items.length, result: { fetched: items.length } };
  });

  return new Response("ok");
};
