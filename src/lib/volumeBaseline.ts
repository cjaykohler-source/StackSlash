/**
 * Pure math for the charts' average-volume line (no I/O, so it can be
 * tested outside the browser). lib/dailyVolume.ts loads the data.
 */
export interface DailyVolume {
  date: string; // YYYY-MM-DD, the ET session date
  volume: number;
}

/** Sessions in the trailing "last month" average. */
export const ADV_WINDOW = 21;
/** Fewer prior sessions than this and there is no honest average to draw. */
const ADV_MIN_SESSIONS = 15;

export interface VolumeBaseline {
  /** Average daily volume over the ADV_WINDOW sessions strictly before `date`. */
  advBefore: (date: string) => number | null;
  /** Trading sessions in [start, endExclusive), from the stored daily rows. */
  sessionsIn: (start: string, endExclusive: string) => number;
}

/**
 * Point-in-time baseline: the average for a bar only uses sessions before
 * it, so today's partial row (bars_daily can carry one) and the bar's own
 * volume never leak into the line it is judged against.
 */
export function volumeBaseline(rows: DailyVolume[]): VolumeBaseline {
  const dates = rows.map((r) => r.date);
  const prefix = [0];
  for (const r of rows) prefix.push(prefix[prefix.length - 1] + r.volume);

  // First index whose date is >= d.
  const lowerBound = (d: string) => {
    let lo = 0;
    let hi = dates.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dates[mid] < d) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  return {
    advBefore(date) {
      const end = lowerBound(date);
      const start = Math.max(0, end - ADV_WINDOW);
      const n = end - start;
      if (n < ADV_MIN_SESSIONS) return null;
      return (prefix[end] - prefix[start]) / n;
    },
    sessionsIn(start, endExclusive) {
      return lowerBound(endExclusive) - lowerBound(start);
    },
  };
}
