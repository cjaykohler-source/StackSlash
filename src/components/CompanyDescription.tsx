import { useEffect, useRef, useState } from "react";

/**
 * Company blurb for the SymbolDetail header, sourced from Wikipedia's
 * free public summary API — no API key, no new vendor, matching the
 * "avoid a new paid vendor" bias this project's already applied once
 * (the market-breadth-over-macro-data decision). Fetched client-side,
 * keyed by company name (not ticker — Wikipedia's title-matching/
 * redirect handling is far more reliable against a full legal name like
 * "Ciena Corporation" than a bare ticker), and not persisted anywhere:
 * always fresh, at the cost of one extra request per symbol page view.
 *
 * Full page width, visually clamped to 4 lines via CSS rather than a hard
 * character cut, so it degrades gracefully across viewport widths. When
 * the text runs past 4 lines (measured, so it tracks resizes) a "See
 * more" toggle expands it in place.
 */
export function CompanyDescription({ name }: { name: string | null }) {
  const [extract, setExtract] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "unavailable">("loading");
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => setExpanded(false), [name]);

  // Measure while clamped: does the text run past 4 lines at this width?
  useEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [extract, status, expanded]);

  useEffect(() => {
    if (!name) {
      setStatus("loading");
      return;
    }
    let cancelled = false;
    setStatus("loading");

    async function load() {
      try {
        const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name!)}`);
        if (cancelled) return;
        if (!res.ok) {
          setStatus("unavailable");
          return;
        }
        const data = (await res.json()) as { type?: string; extract?: string };
        if (data.type === "disambiguation" || !data.extract) {
          setStatus("unavailable");
          return;
        }
        setExtract(data.extract);
        setStatus("ok");
      } catch {
        if (!cancelled) setStatus("unavailable");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [name]);

  if (!name || status === "loading") return null;
  if (status === "unavailable") {
    return <p className="company-description company-description-unavailable">No description available.</p>;
  }
  return (
    <div>
      <p ref={ref} className={`company-description${expanded ? " expanded" : ""}`}>
        {extract}
      </p>
      {(overflows || expanded) && (
        <button className="company-description-toggle" onClick={() => setExpanded((x) => !x)}>
          {expanded ? "See less ▴" : "See more ▾"}
        </button>
      )}
    </div>
  );
}
