import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { fetchProfile } from "./lib/fmp";

/**
 * GET /.netlify/functions/company-profile?symbol=KXIN
 * Company description for the symbol page. Returns the stored FMP
 * description; if there is none yet, fetches the FMP profile once, saves it
 * (description + sector/industry/market cap), and returns that.
 *
 * Guarded so a public endpoint can't drain the free FMP quota (~250
 * calls/day): only active tickers already in `symbols`, and no FMP call when
 * a profile was synced in the last 45 days and simply had no description.
 */
const RESYNC_DAYS = 45;

export default async (req: Request) => {
  const symbol = new URL(req.url).searchParams.get("symbol")?.trim().toUpperCase();
  const json = (body: unknown, cache = "public, max-age=3600") =>
    new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": cache } });
  if (!symbol) return json({ error: "symbol required" }, "no-store");

  const db = getSupabaseAdmin();
  const { data: row } = await db
    .from("symbols")
    .select("id, description, profile_synced_at")
    .eq("ticker", symbol)
    .eq("active", true)
    .maybeSingle();
  if (!row) return json({ symbol, description: null, source: "unknown symbol" }, "public, max-age=300");

  const r = row as { id: number; description: string | null; profile_synced_at: string | null };
  if (r.description) return json({ symbol, description: r.description, source: "stored" });

  const recentlySynced =
    r.profile_synced_at && Date.now() - Date.parse(r.profile_synced_at) < RESYNC_DAYS * 86400_000;
  if (recentlySynced) return json({ symbol, description: null, source: "no FMP description" });

  try {
    const p = await fetchProfile(symbol);
    await db
      .from("symbols")
      .update({
        description: p?.description ?? null,
        sector: p?.sector ?? null,
        industry: p?.industry ?? null,
        market_cap: p?.marketCap ?? null,
        is_etf: p?.isEtf ?? false,
        is_fund: p?.isFund ?? false,
        is_adr: p?.isAdr ?? false,
        profile_synced_at: new Date().toISOString(),
      })
      .eq("id", r.id);
    return json({ symbol, description: p?.description ?? null, source: "fmp" });
  } catch {
    // FMP down or over quota: let the page fall back to Wikipedia.
    return json({ symbol, description: null, source: "fmp unavailable" }, "no-store");
  }
};
