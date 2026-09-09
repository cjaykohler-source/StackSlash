/**
 * US-equities session boundaries in Eastern time, as epoch-ms, for the
 * intraday ("Day") chart. The x-axis runs the full extended-hours span —
 * pre-market open (04:00 ET) to after-hours close (20:00 ET) — so a
 * partial session's line sits where it actually is in the day instead of
 * being stretched edge to edge.
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
  domain: [number, number]; // first .. last bar of the session we have
  ticks: number[];
  open: number | null; // 9:30 ET, if inside the domain
  close: number | null; // 16:00 ET, if inside the domain
}

/**
 * Axis for the intraday ("Day") chart, spanning the full width of the
 * session we actually have bars for — `firstTs`..`lastTs` — so the line
 * runs edge to edge like the other ranges instead of sitting in a sliver
 * in the middle. Pre-market / after-hours prints (when the feed has them)
 * are inside that span, so the edges naturally reach toward 4:00a / 8:00p.
 * The regular-session open/close are marked only when they fall inside
 * the data we have.
 */
export function sessionAxis(firstTs: number, lastTs: number): SessionAxis {
  const date = etDateString(lastTs);
  const span = Math.max(lastTs - firstTs, 60_000);
  const STEP_MIN = [30, 60, 120, 180, 240];
  const target = span / 6;
  const stepMs = (STEP_MIN.find((m) => m * 60_000 >= target) ?? 360) * 60_000;

  const ticks: number[] = [];
  // stepMs divides an hour (or is a whole number of hours) and ET is a
  // whole-hour offset from UTC, so epoch-aligned steps land on clean ET
  // clock times.
  const firstTick = Math.ceil(firstTs / stepMs) * stepMs;
  for (let t = firstTick; t <= lastTs; t += stepMs) ticks.push(t);

  const open = etWallClock(date, 9, 30);
  const close = etWallClock(date, 16);
  return {
    date,
    domain: [firstTs, lastTs],
    ticks,
    open: open >= firstTs && open <= lastTs ? open : null,
    close: close >= firstTs && close <= lastTs ? close : null,
  };
}
