/**
 * X-axis model for the intraday ("Day") chart.
 *
 * The axis covers the whole extended trading day in Eastern time —
 * pre-market 4:00a, regular session 9:30a–4:00p, after-hours to 8:00p —
 * with a fixed hourly tick for every hour. It is NOT linear in time: an
 * hour of pre-market or after-hours takes up 1/3 the width of an hour of
 * the regular session, so the part of the day that matters gets most of
 * the frame. Tick labels never move; the price line just fills in from
 * the left as the session's bars arrive.
 */

const ET = "America/New_York";

// Session boundaries as ET wall-clock hours (9.5 = 9:30a).
const PRE_START = 4;
const REG_OPEN = 9.5;
const REG_CLOSE = 16;
const AH_END = 20;
// Width of one extended-hours hour relative to one regular-session hour.
const COMPRESS = 1 / 3;

const U_PRE = (REG_OPEN - PRE_START) * COMPRESS;
const U_REG = REG_CLOSE - REG_OPEN;
const U_AH = (AH_END - REG_CLOSE) * COMPRESS;
const U_TOTAL = U_PRE + U_REG + U_AH;

/** ET wall-clock hour → layout coordinate on the [0, U_TOTAL] axis. */
function hourToX(h: number): number {
  const hh = Math.min(AH_END, Math.max(PRE_START, h));
  if (hh <= REG_OPEN) return (hh - PRE_START) * COMPRESS;
  if (hh <= REG_CLOSE) return U_PRE + (hh - REG_OPEN);
  return U_PRE + U_REG + (hh - REG_CLOSE) * COMPRESS;
}

/** Fractional ET wall-clock hour for an instant (DST-correct). */
function etHours(ts: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: ET,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(ts))
      .map((x) => [x.type, x.value]),
  );
  return Number(p.hour) + Number(p.minute) / 60;
}

function hourLabel(h: number): string {
  const suffix = h % 24 < 12 ? "a" : "p";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${suffix}`;
}

/** Offset of ET relative to UTC, in ms, at the given instant (handles DST). */
function tzOffsetMs(at: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
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
  return guess - tzOffsetMs(new Date(guess));
}

/** The YYYY-MM-DD ET calendar date an instant falls on. */
export function etDateString(at: Date | number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(new Date(at));
}

/** "9:30 AM ET" style label for the tooltip. */
export function etTimeLabel(at: number): string {
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: ET,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(at)) + " ET"
  );
}

export interface SessionAxis {
  domain: [number, number];
  ticks: number[];
  tickLabels: Record<number, string>;
  /** epoch-ms → layout coordinate */
  toX: (ts: number) => number;
  open: number; // layout x of 9:30a
  close: number; // layout x of 4:00p
}

const TICK_HOURS = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

/**
 * Piecewise axis for the trading day that `anyTs` falls on: full width is
 * 4:00a–8:00p ET, but each extended-hours hour is 1/3 the width of a
 * regular-session hour.
 */
export function sessionAxis(anyTs: number): SessionAxis {
  void anyTs; // the mapping is wall-clock only; the arg keeps the call site explicit
  const ticks = TICK_HOURS.map(hourToX);
  const tickLabels: Record<number, string> = {};
  TICK_HOURS.forEach((h, i) => {
    tickLabels[ticks[i]] = hourLabel(h);
  });
  return {
    domain: [0, U_TOTAL],
    ticks,
    tickLabels,
    toX: (ts: number) => hourToX(etHours(ts)),
    open: hourToX(REG_OPEN),
    close: hourToX(REG_CLOSE),
  };
}
