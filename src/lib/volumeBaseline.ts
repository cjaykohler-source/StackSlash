/**
 * Pure math for the symbol page's volume baselines (no I/O, so it can be
 * tested outside the browser). lib/dailyVolume.ts loads the data.
 *
 * The baseline is the MEDIAN day over the prior 20 sessions, not the mean.
 * Sub-$5 names spike: on 2026-09-15 FBDT traded 75.9M shares against a
 * normal 0.3-4.5M, and that one day was 71% of its 20-day mean, inflating
 * every "is this heavy?" comparison about 4x for the following month. The
 * median can't be dragged by a single day, so it is labelled "typical".
 */
export interface DailyVolume {
  date: string; // YYYY-MM-DD, the ET session date
  volume: number;
}

/** Sessions in the trailing window. */
export const BASELINE_SESSIONS = 20;
/** Fewer prior sessions than this and there is no honest baseline to draw. */
const MIN_SESSIONS = 15;

export interface VolumeBaseline {
  /** Median daily volume over the BASELINE_SESSIONS sessions strictly before `date`. */
  typicalBefore: (date: string) => number | null;
  /** Trading sessions in [start, endExclusive), from the stored daily rows. */
  sessionsIn: (start: string, endExclusive: string) => number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Point in time: a date's baseline only uses sessions before it, so today's
 * partial row (bars_daily can carry one) and the day being judged never
 * leak into the line it is judged against.
 */
export function volumeBaseline(rows: DailyVolume[]): VolumeBaseline {
  const dates = rows.map((r) => r.date);
  const vols = rows.map((r) => r.volume);
  const cache = new Map<number, number | null>();

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
    typicalBefore(date) {
      const end = lowerBound(date);
      const hit = cache.get(end);
      if (hit !== undefined) return hit;
      const start = Math.max(0, end - BASELINE_SESSIONS);
      const v = end - start < MIN_SESSIONS ? null : median(vols.slice(start, end));
      cache.set(end, v);
      return v;
    },
    sessionsIn(start, endExclusive) {
      return lowerBound(endExclusive) - lowerBound(start);
    },
  };
}
