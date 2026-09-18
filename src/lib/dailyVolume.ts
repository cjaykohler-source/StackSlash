import { supabase } from "./supabaseClient";
import type { DailyVolume } from "./volumeBaseline";

export { ADV_WINDOW, volumeBaseline, type DailyVolume, type VolumeBaseline } from "./volumeBaseline";

/**
 * Every daily volume stored for a symbol, oldest first. bars_daily is the
 * consolidated tape (SIP, split-adjusted) since the 2026-09-17 reload, the
 * same tape the symbol page's candles come from, so the scales match.
 * Paginated with an explicit order: an unranged select silently stops at
 * 1,000 rows, and five years is ~1,260.
 */
export async function loadDailyVolumes(symbolId: number): Promise<DailyVolume[]> {
  const out: DailyVolume[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("bars_daily")
      .select("date, volume")
      .eq("symbol_id", symbolId)
      .order("date", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data?.length) break;
    for (const r of data as { date: string; volume: number | null }[]) {
      if (r.volume != null && r.volume > 0) out.push({ date: r.date, volume: Number(r.volume) });
    }
    if (data.length < PAGE) break;
  }
  return out;
}
