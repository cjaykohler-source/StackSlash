import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

/**
 * Company blurb for the SymbolDetail header. Sources, in order:
 *  1. symbols.description — the FMP profile description, stored by
 *     fundamentals-sync / deep-dive;
 *  2. the company-profile function, which fetches and stores the FMP
 *     profile on demand when nothing is stored yet;
 *  3. Wikipedia's summary API by company name — the original source, kept
 *     as a fallback because it has no page for most sub-$5 companies.
 *
 * Full page width, visually clamped to 4 lines via CSS rather than a hard
 * character cut, so it degrades gracefully across viewport widths. When
 * the text runs past 4 lines (measured, so it tracks resizes) a "See
 * more" toggle expands it in place.
 */
export function CompanyDescription({ ticker, name }: { ticker: string | null; name: string | null }) {
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
    if (!name && !ticker) {
      setStatus("loading");
      return;
    }
    let cancelled = false;
    setStatus("loading");

    async function load() {
      try {
        // 1-2. Stored FMP description, else fetched and stored on demand.
        if (ticker) {
          const { data: sym } = await supabase.from("symbols").select("description").eq("ticker", ticker).maybeSingle();
          let text = (sym as { description: string | null } | null)?.description ?? null;
          if (!text) {
            const r = await fetch(`/.netlify/functions/company-profile?symbol=${encodeURIComponent(ticker)}`).catch(() => null);
            const body = r && r.ok ? ((await r.json()) as { description?: string | null }) : null;
            text = body?.description ?? null;
          }
          if (cancelled) return;
          if (text) {
            setExtract(text);
            setStatus("ok");
            return;
          }
        }
        // 3. Wikipedia fallback (needs the company name).
        if (!name) {
          setStatus("unavailable");
          return;
        }
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
  }, [name, ticker]);

  if ((!name && !ticker) || status === "loading") return null;
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
