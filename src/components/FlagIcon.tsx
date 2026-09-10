/**
 * Monochrome line icons for the trigger-feed Flags column. Every glyph is
 * drawn with `currentColor`, so the square's category colour (red / amber
 * / green, set by `.feed-flag-<level>`) is the icon's colour too.
 *
 * Paths are Feather-icon (MIT) style — 24x24 viewBox, 2px stroke, no fill
 * except where noted. Kept inline rather than adding an icon dependency,
 * matching the rest of this codebase.
 *
 * Risk-flag labels carry dynamic values ("Nano-cap ($30M)", "Fresh news
 * (3h ago)"), so `flagIconName()` matches on the stable label prefix.
 */

export type FlagIconName =
  | "news"
  | "earnings"
  | "volatility"
  | "parabolic"
  | "extended"
  | "volume"
  | "subdollar"
  | "nanocap"
  | "adr"
  | "runway"
  | "dilution"
  | "negbook"
  | "biotech"
  | "sentiment"
  | "zacks"
  | "revenue"
  | "netcash"
  | "generic";

export function flagIconName(label: string): FlagIconName {
  const l = label.toLowerCase();
  if (l.startsWith("fresh news")) return "news";
  if (l.startsWith("earnings")) return "earnings";
  if (l.startsWith("extreme volatility")) return "volatility";
  if (l.includes("in a month")) return "parabolic";
  if (l.includes("200-day avg")) return "extended";
  if (l.startsWith("volume ")) return "volume";
  if (l.startsWith("sub-$1")) return "subdollar";
  if (l.startsWith("nano-cap")) return "nanocap";
  if (l.startsWith("foreign adr")) return "adr";
  if (l.includes("cash left")) return "runway";
  if (l.startsWith("shares +")) return "dilution";
  if (l.startsWith("negative book value")) return "negbook";
  if (l.startsWith("biotech")) return "biotech";
  if (l.startsWith("sentiment-driven")) return "sentiment";
  if (l.startsWith("zacks")) return "zacks";
  if (l.startsWith("revenue +")) return "revenue";
  if (l.startsWith("net cash")) return "netcash";
  return "generic";
}

const PATHS: Record<FlagIconName, JSX.Element> = {
  news: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="16" y2="17" />
    </>
  ),
  earnings: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </>
  ),
  volatility: <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />,
  parabolic: (
    <>
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </>
  ),
  extended: (
    <>
      <polyline points="17 11 12 6 7 11" />
      <polyline points="17 18 12 13 7 18" />
    </>
  ),
  volume: (
    <>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </>
  ),
  subdollar: (
    <>
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </>
  ),
  nanocap: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <rect x="9" y="9" width="6" height="6" fill="currentColor" stroke="none" />
    </>
  ),
  adr: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </>
  ),
  runway: (
    <>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </>
  ),
  dilution: <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />,
  negbook: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </>
  ),
  biotech: (
    <>
      <line x1="9" y1="3" x2="15" y2="3" />
      <path d="M10 3v7L5 19a1.6 1.6 0 0 0 1.4 2.5h11.2A1.6 1.6 0 0 0 19 19l-5-9V3" />
    </>
  ),
  sentiment: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
  zacks: (
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  ),
  revenue: (
    <>
      <line x1="6" y1="20" x2="6" y2="15" />
      <line x1="12" y1="20" x2="12" y2="10" />
      <line x1="18" y1="20" x2="18" y2="4" />
    </>
  ),
  netcash: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  generic: (
    <>
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </>
  ),
};

export function FlagIcon({ name }: { name: FlagIconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
