import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { fmtValue, type MetricDef } from "../../lib/charterApi";

/**
 * The "?" next to every Charter formula field: the formula language on one
 * card, what this tab allows, worked examples, and a searchable list of the
 * metric names valid here. Clicking an example or a name inserts it at the
 * cursor of the field it belongs to.
 *
 * Contexts differ in what they allow:
 *   series    deep dive: one stock's time series; lag/sma/change/zscore run over its rows
 *   rowwise   cross-section: each row a different stock; series functions refused
 *   server    event studies / aggregates: compiled to SQL per stock over its history;
 *             series functions allowed (not nested), future fwd_* metrics refused
 */

export type FormulaContext = "series" | "rowwise" | "server";

export interface HelpMetric {
  id: string;
  label: string;
  group: string;
  unit?: MetricDef["unit"];
}

const NOTES: Record<FormulaContext, string> = {
  series: "Deep dive: the formula runs down this stock's own history, so lag, sma, change and zscore look back over its sessions.",
  rowwise: "Cross-section: every row is a different stock, so lag, sma, change and zscore are refused here — they would mix stocks.",
  server:
    "Runs on the server per stock over its own history: lag, sma, change and zscore work (look back 1–250 sessions, not nested inside each other). Future (fwd_*) metrics are refused — an event or series can't be defined by its own outcome.",
};

const EXAMPLES: Record<FormulaContext, [string, string][]> = {
  series: [
    ["vol_ratio * (close > sma20)", "volume ratio, only on days that closed above the 20-day average"],
    ["change(short_float, 10)", "short float vs 10 sessions earlier"],
    ["zscore(volume, 20)", "how unusual today's volume is vs the last 20 sessions"],
    ["(close - sma50) / atr14_pct / close", "distance from SMA 50 in ATRs"],
  ],
  rowwise: [
    ["short_float * vol_ratio", "crowded shorts on heavy volume"],
    ["(cat60_offering > 0) * atr14_pct", "volatility, only for names with an offering filing in 60 days"],
    ["log(mcap)", "log market cap (an empty value for missing or non-positive)"],
    ["(ret_1 > 0.1) * (close_vs_vwap > 0)", "up 10%+ and closed above VWAP (1 or 0)"],
  ],
  server: [
    ["(ret_1 >= 0.3) * (vol_ratio >= 5)", "up 30%+ on 5x volume"],
    ["change(close, 3) > 0.5", "up 50%+ over three sessions"],
    ["zscore(volume, 20) > 3", "volume three standard deviations above its 20-session norm"],
    ["(gap > 0.1) * (body < 0)", "gapped up 10%+ then closed below the open"],
  ],
};

const OPERATORS: [string, string][] = [
  ["+  -  *  /", "arithmetic; dividing by zero gives an empty value"],
  ["( )", "grouping"],
  [">  <  >=  <=  ==  !=", "comparisons give 1 (true) or 0 (false)"],
  ["a * b", "“and” for comparisons: (x > 1) * (y < 2)"],
  ["max(a, b)", "“or” for comparisons: max(x > 1, y < 2)"],
  ["0.05  1e6", "numbers; percentages are fractions (0.05 = 5%)"],
];
const FUNCS: [string, string, boolean][] = [
  ["abs(x)", "absolute value", false],
  ["log(x)", "natural log (empty if x ≤ 0)", false],
  ["sqrt(x)", "square root (empty if x < 0)", false],
  ["min(a, b)  max(a, b)", "smaller / larger of two", false],
  ["lag(x, n)", "x, n sessions earlier", true],
  ["sma(x, n)", "average of x over the last n sessions", true],
  ["change(x, n)", "x / lag(x, n) − 1", true],
  ["zscore(x, n)", "(x − sma) / standard deviation over n sessions", true],
];

export function FormulaHelp({
  context,
  metrics,
  inputRef,
  value,
  onChange,
}: {
  context: FormulaContext;
  metrics: HelpMetric[];
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLSpanElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  // fixed position measured from the button and clamped to the window, so the card never runs
  // off-screen wherever the field sits in its row; follows the button on scroll / resize
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btn.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(760, window.innerWidth - 32);
      const left = Math.max(16, Math.min(r.right - width, window.innerWidth - 16 - width));
      setPos({ top: r.bottom + 6, left, width });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s ? metrics.filter((m) => m.id.toLowerCase().includes(s) || m.label.toLowerCase().includes(s)) : metrics;
    const g: Record<string, HelpMetric[]> = {};
    for (const m of list) (g[m.group] ??= []).push(m);
    return g;
  }, [metrics, q]);

  // insert at the cursor (or replace the selection) of the formula field
  function insert(text: string, replaceAll = false) {
    const el = inputRef.current;
    const a = replaceAll ? 0 : el?.selectionStart ?? value.length;
    const b = replaceAll ? value.length : el?.selectionEnd ?? value.length;
    const next = value.slice(0, a) + text + value.slice(b);
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(a + text.length, a + text.length);
    });
  }

  return (
    <span className="charter-help" ref={box}>
      <button ref={btn} type="button" className="charter-help-btn" title="Formula language help" aria-expanded={open} onClick={() => setOpen(!open)}>?</button>
      {open && (
        <div className="charter-help-pop" role="dialog" aria-label="Formula language"
             style={pos ? { top: pos.top, left: pos.left, width: pos.width, maxHeight: `min(640px, ${Math.max(240, window.innerHeight - pos.top - 16)}px)` } : { visibility: "hidden" }}>
          <div className="charter-help-head">
            <b>Formula language</b>
            <button type="button" className="charter-th-x" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </div>
          <p className="charter-help-note">{NOTES[context]}</p>
          <div className="charter-help-cols">
            <table className="charter-help-table">
              <tbody>
                {OPERATORS.map(([k, v]) => (
                  <tr key={k}><td><code>{k}</code></td><td>{v}</td></tr>
                ))}
                {FUNCS.map(([k, v, series]) => (
                  <tr key={k} className={series && context === "rowwise" ? "charter-help-off" : undefined}>
                    <td><code>{k}</code></td>
                    <td>{v}{series && context === "rowwise" ? " — not in the cross-section" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div>
              <div className="ops-dim">Examples — click to use</div>
              {EXAMPLES[context].map(([ex, what]) => (
                <button type="button" key={ex} className="charter-help-ex" onClick={() => insert(ex, true)}>
                  <code>{ex}</code>
                  <span>{what}</span>
                </button>
              ))}
              <p className="charter-help-note">
                Missing inputs or division by zero give an empty value, never an error or a made-up number.
                {context !== "server" && " Your own formulas can be used inside later ones by their f_… id (hover a formula chip to see it)."}
              </p>
            </div>
          </div>
          <div className="charter-help-metrics">
            <input className="charter-help-search" placeholder={`search ${metrics.length} metric names…`} value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="charter-help-list">
              {Object.entries(shown).map(([g, ms]) => (
                <div key={g}>
                  <div className="ops-dim">{g}</div>
                  {ms.map((m) => (
                    <button type="button" key={m.id} className="charter-help-metric" onClick={() => insert(m.id)} title={`insert ${m.id}${m.unit ? ` (${m.unit === "pct" ? `fraction, e.g. ${fmtValue(0.05, "pct")} = 0.05` : m.unit})` : ""}`}>
                      <code>{m.id}</code> <span>{m.label}</span>
                    </button>
                  ))}
                </div>
              ))}
              {!Object.keys(shown).length && <p className="ops-dim">No metric matches “{q}”.</p>}
            </div>
          </div>
        </div>
      )}
    </span>
  );
}
