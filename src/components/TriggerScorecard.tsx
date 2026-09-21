import { Fragment, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { triggerLabel } from "../lib/triggerInfo";

/**
 * Daily trigger accuracy: did each fire close in the direction its class
 * claimed?
 *
 * Reads the `trigger_scorecard_daily` and `trigger_scorecard` views. The
 * horizon is decided there and differs by trigger speed — a fast trigger
 * fires mid-session and scores against that session's close, a slow one
 * fires at 17:45 when its fire price already IS that close and so scores
 * against the next session.
 *
 * `rth_close` prefers SIP `bars_daily`, which eod-scan writes at 17:45,
 * and falls back to the last IEX print at or before 16:00 so the day is
 * readable from the close rather than two hours later. IEX carries ~1.7%
 * of band volume, so provisional rows are marked rather than quietly
 * mixed in.
 */

type DailyRow = {
  fire_date: string;
  signal_class: "Buy" | "Watch" | "Sell";
  fires: number;
  scored: number;
  pending: number;
  provisional: number;
  closed_above: number;
  closed_below: number;
  correct_n: number;
  directional_n: number;
  accuracy_pct: number | null;
  mean_pct: number | null;
  median_pct: number | null;
  mean_pct_ext: number | null;
};

type TriggerRow = {
  fire_date: string;
  trigger_name: string;
  signal_class: string;
  horizon: string;
  pct_change: number | null;
  rth_close: number | null;
  fire_price: number | null;
  correct: boolean | null;
};

const CLASS_ORDER = ["Buy", "Watch", "Sell"] as const;
const DAYS = 10;

function pct(n: number | null | undefined, digits = 2) {
  return n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function TriggerScorecard() {
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [byTrigger, setByTrigger] = useState<TriggerRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [d, t] = await Promise.all([
        supabase
          .from("trigger_scorecard_daily")
          .select("*")
          .order("fire_date", { ascending: false })
          .limit(DAYS * CLASS_ORDER.length),
        supabase
          .from("trigger_scorecard")
          .select("fire_date, trigger_name, signal_class, horizon, pct_change, rth_close, fire_price, correct")
          .order("fire_date", { ascending: false })
          .limit(2000),
      ]);
      if (cancelled) return;
      if (d.error || t.error) {
        setErr((d.error ?? t.error)!.message);
        return;
      }
      setDaily((d.data as DailyRow[]) ?? []);
      setByTrigger((t.data as TriggerRow[]) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (err) return <p className="error">Scorecard unavailable: {err}</p>;
  if (!daily.length) return <p className="isolator-results-meta">No scored fires yet.</p>;

  const dates = [...new Set(daily.map((r) => r.fire_date))].slice(0, DAYS);

  return (
    <div className="scorecard">
      <p className="isolator-results-meta">
        Did each fire close in the direction its class claimed? Fast triggers score against their own
        session's close; slow triggers fire after the close, so they score against the next session.
        Watch makes no directional claim, so it shows the split without an accuracy figure.
      </p>
      <table className="isolator-table scorecard-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Class</th>
            <th className="col-num">Fires</th>
            <th className="col-num">Above</th>
            <th className="col-num">Below</th>
            <th className="col-num">Accuracy</th>
            <th className="col-num">Mean</th>
            <th className="col-num">Median</th>
            <th className="col-num">After hrs</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {dates.map((date) =>
            CLASS_ORDER.filter((c) => daily.some((r) => r.fire_date === date && r.signal_class === c)).map(
              (cls, i) => {
                const r = daily.find((x) => x.fire_date === date && x.signal_class === cls)!;
                const key = `${date}:${cls}`;
                const detail = byTrigger.filter((x) => x.fire_date === date && x.signal_class === cls);
                const groups = [...new Set(detail.map((x) => x.trigger_name))];
                return (
                  <Fragment key={key}>
                    <tr className={i === 0 ? "scorecard-day-start" : undefined}>
                      <td>{i === 0 ? date : ""}</td>
                      <td>
                        <span className={`scorecard-class scorecard-${cls.toLowerCase()}`}>{cls}</span>
                      </td>
                      <td className="col-num">
                        {r.fires}
                        {r.pending > 0 && <span className="isolator-name"> ({r.pending} pending)</span>}
                      </td>
                      <td className="col-num">{r.closed_above}</td>
                      <td className="col-num">{r.closed_below}</td>
                      <td className="col-num">
                        {r.accuracy_pct == null ? (
                          "—"
                        ) : (
                          <>
                            {r.accuracy_pct}%
                            <span className="isolator-name">
                              {" "}
                              {r.correct_n}/{r.directional_n}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="col-num">{pct(r.mean_pct)}</td>
                      <td className="col-num">{pct(r.median_pct)}</td>
                      <td className="col-num">{pct(r.mean_pct_ext)}</td>
                      <td className="col-num">
                        {r.provisional > 0 && (
                          <span className="scorecard-provisional" title="Reference close is a provisional IEX print; SIP replaces it after 17:45 ET">
                            {r.provisional} prov.
                          </span>
                        )}
                        {groups.length > 0 && (
                          <button className="link-button" onClick={() => setOpen(open === key ? null : key)}>
                            {open === key ? "hide" : "by trigger"}
                          </button>
                        )}
                      </td>
                    </tr>
                    {open === key &&
                      groups.map((name) => {
                        const rows = detail.filter((x) => x.trigger_name === name && x.pct_change != null);
                        const above = rows.filter((x) => (x.pct_change ?? 0) > 0).length;
                        const below = rows.filter((x) => (x.pct_change ?? 0) < 0).length;
                        const mean = rows.length
                          ? rows.reduce((a, x) => a + (x.pct_change ?? 0), 0) / rows.length
                          : null;
                        return (
                          <tr key={`${key}:${name}`} className="scorecard-detail">
                            <td />
                            <td colSpan={2}>
                              <span className="isolator-name">{triggerLabel(name)}</span>
                            </td>
                            <td className="col-num">{above}</td>
                            <td className="col-num">{below}</td>
                            <td className="col-num">{rows.length}</td>
                            <td className="col-num">{pct(mean)}</td>
                            <td colSpan={3} />
                          </tr>
                        );
                      })}
                  </Fragment>
                );
              },
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
