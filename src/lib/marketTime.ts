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
  domain: [number, number]; // pre-market open .. after-hours close
  ticks: number[];
  open: number; // 9:30 ET
  close: number; // 16:00 ET
}

/** Build the fixed extended-hours axis for the session `lastTs` belongs to. */
export function sessionAxis(lastTs: number): SessionAxis {
  const date = etDateString(lastTs);
  return {
    date,
    domain: [etWallClock(date, 4), etWallClock(date, 20)],
    ticks: [4, 7, 9.5, 12, 14, 16, 18, 20].map((h) => etWallClock(date, Math.floor(h), (h % 1) * 60)),
    open: etWallClock(date, 9, 30),
    close: etWallClock(date, 16),
  };
}
