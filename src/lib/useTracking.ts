import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";

export interface TrackedSymbol {
  symbol_id: number;
  ticker: string;
  name: string | null;
  /** also drawn as a live chart in the dashboard's Spotlight grid */
  spotlight: boolean;
}

/**
 * The tracked-symbol watchlist (`tracked_symbols`), shared by everything
 * that reads or edits it: the dashboard's Tracking column, the Spotlight
 * chart grid, and the Track button on a symbol page.
 *
 * Every instance subscribes to the table's realtime changes, so tracking a
 * symbol from its own page updates the dashboard's lists without a reload
 * (and vice versa).
 */
export function useTracking() {
  const [tracked, setTracked] = useState<TrackedSymbol[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("tracked_symbols")
      .select("symbol_id, spotlight, symbols(ticker, name)")
      .order("created_at", { ascending: true });
    const rows =
      (data as unknown as {
        symbol_id: number;
        spotlight: boolean | null;
        symbols: { ticker: string; name: string | null } | null;
      }[] | null) ?? [];
    setTracked(
      rows
        .filter((r) => r.symbols)
        .map((r) => ({
          symbol_id: r.symbol_id,
          ticker: r.symbols!.ticker,
          name: r.symbols!.name,
          spotlight: r.spotlight ?? false,
        })),
    );
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    // Unique channel name per hook instance: several components mount this
    // at once and Supabase rejects duplicate channel names.
    const channel = supabase
      .channel(`tracked_symbols_${Math.random().toString(36).slice(2)}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tracked_symbols" }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [load]);

  const trackId = useCallback(
    async (symbolId: number, opts?: { spotlight?: boolean }) => {
      const { error } = await supabase
        .from("tracked_symbols")
        .insert({ symbol_id: symbolId, spotlight: opts?.spotlight ?? false });
      if (error && error.code !== "23505") throw error; // 23505 = already tracked
      await load();
    },
    [load],
  );

  /** Track by ticker. Returns null on success, or a message to show. */
  const trackTicker = useCallback(
    async (rawTicker: string): Promise<string | null> => {
      const ticker = rawTicker.trim().toUpperCase();
      if (!ticker) return null;
      const { data: sym } = await supabase.from("symbols").select("id").eq("ticker", ticker).maybeSingle();
      if (!sym) return `${ticker} isn't in the tracked universe — add it from the search box at the top first.`;
      try {
        await trackId(sym.id as number);
        return null;
      } catch {
        return `Couldn't track ${ticker}.`;
      }
    },
    [trackId],
  );

  const untrack = useCallback(
    async (symbolId: number) => {
      await supabase.from("tracked_symbols").delete().eq("symbol_id", symbolId);
      await load();
    },
    [load],
  );

  const setSpotlight = useCallback(
    async (symbolId: number, spotlight: boolean) => {
      // Optimistic: the toggle should feel instant; realtime/load corrects it.
      setTracked((prev) => prev.map((t) => (t.symbol_id === symbolId ? { ...t, spotlight } : t)));
      await supabase.from("tracked_symbols").update({ spotlight }).eq("symbol_id", symbolId);
      await load();
    },
    [load],
  );

  const bySymbolId = useMemo(() => new Map(tracked.map((t) => [t.symbol_id, t])), [tracked]);

  return { tracked, bySymbolId, loaded, trackId, trackTicker, untrack, setSpotlight, reload: load };
}
