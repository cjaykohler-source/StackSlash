import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import {
  fetchCatalystTypes,
  SOURCE_LABEL,
  VERDICT_LABEL,
  type CatalystEvent,
  type CatalystType,
} from "../lib/research";

/**
 * A symbol's catalyst history for the past year — SEC filings, earnings
 * surprises, insider trades, classified headlines, corporate actions —
 * each tagged with the research verdict for its type (see the Research
 * page). Published nightly from the research warehouse.
 */
export function CatalystTimeline({ ticker }: { ticker: string }) {
  const [events, setEvents] = useState<CatalystEvent[] | null>(null);
  const [types, setTypes] = useState<Map<string, CatalystType>>(new Map());
  const [all, setAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    Promise.all([
      supabase
        .from("research_catalyst_events")
        .select("*")
        .eq("symbol", ticker)
        .order("event_date", { ascending: false })
        .limit(300),
      fetchCatalystTypes(),
    ]).then(([ev, ty]) => {
      if (cancelled) return;
      setEvents((ev.data ?? []) as CatalystEvent[]);
      setTypes(ty);
    });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  if (events === null) return <p className="empty-state">Loading catalysts…</p>;

  const flagged = events.filter((e) => {
    const v = types.get(e.type)?.verdict;
    return v === "avoid" || v === "positive" || v === "watch";
  });
  const shown = all ? events : flagged;

  return (
    <div className="catalyst-timeline">
      <div className="catalyst-timeline-head">
        <h3 className="profile-subheading">Catalysts · past year</h3>
        <label className="catalyst-toggle">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          show all {events.length}
        </label>
      </div>
      {shown.length === 0 ? (
        <p className="empty-state">
          {events.length === 0
            ? "No catalyst events in the past year."
            : `No events of a type with a research verdict — ${events.length} other events (tick "show all").`}
        </p>
      ) : (
        <ul className="catalyst-list">
          {shown.map((e) => {
            const t = types.get(e.type);
            const verdict = t?.verdict ?? "untested";
            return (
              <li key={e.id} title={t?.verdict_note ?? undefined}>
                <span className="catalyst-date">{e.event_date}</span>
                <span className={`verdict-badge verdict-${verdict}`}>{VERDICT_LABEL[verdict]}</span>
                <span className="catalyst-type">{t?.label ?? e.type}</span>
                <span className="catalyst-source">{SOURCE_LABEL[e.source] ?? e.source}</span>
                {e.detail && <span className="catalyst-detail">{e.detail}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
