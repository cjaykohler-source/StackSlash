/**
 * US-Eastern date/time helpers for the server functions (DST-correct).
 * A small server-side copy of the pieces src/lib/marketTime.ts exposes to
 * the frontend — the functions bundle can't import from src/.
 */

const ET = "America/New_York";

/** The YYYY-MM-DD ET calendar date an instant falls on. */
export function etDateString(at: Date | number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ET }).format(new Date(at));
}

/** Offset of ET vs UTC (ms) at the given instant — handles DST. */
function tzOffsetMs(at: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: ET,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
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
