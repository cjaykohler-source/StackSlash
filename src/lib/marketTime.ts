/**
 * US-equities session boundaries in Eastern time, as epoch-ms, for the
 * intraday ("Day") chart. The x-axis is fixed to the regular session
 * (9:30a–4:00p ET) with a fixed set of hourly tick labels, and the price
 * line fills in from the left as the day progresses — a half-finished
 * session leaves the right side of the frame empty rather than being
 * stretched to fit.
 */

const ET = "America/New_York";

/** Offset of `tz` relative to UTC, in ms, at the given instant (handles DST). */
function tzOffsetMs(at: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return asUTC - at.getTime();
}

/** Epoch-ms for a wall-clock time (h:m ET) on the given YYYY-MM-DD date. */
export function etWallClock(dateStr: string, h: number, m = 0): number {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, m);
  return guess - tzOffsetMs(new Date(guess), ET);
}

/** The YYYY-MM-DD ET calendar date an instant falls on. */
export function etDateString(at: Date | number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(new Date(at));
}

/** "9:30a" / "4:00p" style ET clock label for an epoch-ms value. */
export function etClockLabel(at: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h12",
  })
    .format(new Date(at))
    .replace(":00", "")
    .replace(" AM", "a")
    .replace(" PM", "p");
}

export interface SessionAxis {
  date: string; // YYYY-MM-DD (ET)
  domain: [number, number]; // regular-session open .. close
  ticks: number[]; // fixed hourly labels, 9:30a → 4:00p
}

// 9:30a, then every hour to 4:00p.
const TICK_HHMM: [number, number][] = [
  [9, 30],
  [10, 0],
  [11, 0],
  [12, 0],
  [13, 0],
  [14, 0],
  [15, 0],
  [16, 0],
];

/**
 * Fixed regular-session axis (9:30a–4:00p ET) for the trading day that
 * `anyTs` falls on. The domain and tick labels never move; the price
 * line just fills in further from the left as more of the session's bars
 * arrive.
 */
export function sessionAxis(anyTs: number): SessionAxis {
  const date = etDateString(anyTs);
  return {
    date,
    domain: [etWallClock(date, 9, 30), etWallClock(date, 16)],
    ticks: TICK_HHMM.map(([h, m]) => etWallClock(date, h, m)),
  };
}
