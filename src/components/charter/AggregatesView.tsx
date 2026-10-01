import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EChartsOption } from "echarts";
import { EChart } from "./EChart";
import { FormulaHelp } from "./FormulaHelp";
import { CharterApiError, charterGet, fmtValue, type MetricDef } from "../../lib/charterApi";

/**
 * Charter phase 4: aggregates over time. Market-wide statistics across the
 * gated universe by day / week / month from the Charter API's /aggregates:
 * breadth, big moves, volatility, short data, catalyst counts and the SPY
 * regime, plus up to three custom formula series ("share of stocks where
 * <formula>" or "median of <formula>"). One zoom-linked panel per series,
 * with periods where SPY was below its 200-day average shaded.
 */

export interface AggConfig {
  start: string;
  end: string;
  freq: "day" | "week" | "month";
  price_min: number;
  price_max: number;
  dollar20_min: number;
  exchanges: string[];
  funds: boolean;
  selected: string[];
  custom: { name: string; expr: string; how: "share" | "median" }[];
  regime: boolean;
}

export const DEFAULT_AGG: AggConfig = {
  start: "2016-01-01",
  end: new Date().toISOString().slice(0, 10),
  freq: "week",
  price_min: 0.1,
  price_max: 5,
  dollar20_min: 250000,
  exchanges: [],
  funds: false,
  selected: ["ew_index", "above_sma50", "breakouts", "median_atr", "median_short_float", "cat_offering"],
  custom: [],
  regime: true,
};

interface SeriesDef {
  id: string;
  label: string;
  group: string;
  unit: MetricDef["unit"];
  kind: "mean" | "count" | "level";
}
interface AggRes {
  freq: string;
  periods: string[];
  sessions: number[];
  series: Record<string, (number | null)[]>;
  custom: { id: string; expr: string; how: string }[];
  universe_rows: number;
}

const EXCH = ["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS", "OTC"];
const COLORS = ["#4f8cff", "#f0a020", "#2ecc71", "#c86bff", "#ff6bd6", "#f5c542", "#e74c3c", "#8b93a7"];

export function AggregatesView({
  catalog,
  cfg,
  set,
  onApiError,
}: {
  catalog: MetricDef[];
  cfg: AggConfig;
  set: (p: Partial<AggConfig>) => void;
  onApiError: (m: string | null) => void;
}) {
  const [defs, setDefs] = useState<SeriesDef[]>([]);
  const [res, setRes] = useState<AggRes | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ name: string; expr: string; how: "share" | "median" }>({ name: "", expr: "", how: "share" });
  const formulaRef = useRef<HTMLInputElement>(null);
  const helpMetrics = useMemo(
    () => catalog.filter((m) => m.kind === "daily").map((m) => ({ id: m.id, label: m.label, group: m.group, unit: m.unit })),
    [catalog],
  );

  useEffect(() => {
    charterGet<{ series: SeriesDef[] }>("/aggregate_catalog")
      .then((r) => setDefs(r.series))
      .catch((e: CharterApiError) => onApiError(e.message));
  }, [onApiError]);

  const run = useCallback(() => {
    setLoading(true);
    setErr(null);
    const t0 = performance.now();
    const p: Record<string, string> = {
      start: cfg.start, end: cfg.end, freq: cfg.freq,
      price_min: String(cfg.price_min), price_max: String(cfg.price_max), dollar20_min: String(cfg.dollar20_min),
      exchanges: cfg.exchanges.join(","), funds: cfg.funds ? "1" : "0",
    };
    cfg.custom.forEach((c, i) => {
      p[`f${i + 1}`] = c.expr;
      p[`f${i + 1}_how`] = c.how;
    });
    charterGet<AggRes>("/aggregates", p)
      .then((r) => {
        setRes(r);
        onApiError(null);
      })
      .catch((e: CharterApiError) => (e.status === 400 ? setErr(e.message) : onApiError(e.message)))
      .finally(() => {
        setLoading(false);
        setElapsed((performance.now() - t0) / 1000);
      });
  }, [cfg.start, cfg.end, cfg.freq, cfg.price_min, cfg.price_max, cfg.dollar20_min, cfg.exchanges, cfg.funds, cfg.custom, onApiError]);

  const ran = useRef(false);
  useEffect(() => {
    if (!ran.current) {
      ran.current = true;
      run();
    }
  }, [run]);

  // the custom series are named f1..f3 by position in the request that produced `res`
  const allDefs = useMemo<SeriesDef[]>(() => {
    const custom = (res?.custom ?? []).map((c, i) => ({
      id: c.id,
      label: `${cfg.custom[i]?.name || c.expr} (${c.how === "share" ? "share of stocks where true" : "median"})`,
      group: "My formulas",
      unit: (c.how === "share" ? "pct" : "ratio") as MetricDef["unit"],
      kind: "mean" as const,
    }));
    return [...defs, ...custom];
  }, [defs, res, cfg.custom]);
  const byId = useMemo(() => new Map(allDefs.map((d) => [d.id, d])), [allDefs]);
  const grouped = useMemo(() => {
    const g: Record<string, SeriesDef[]> = {};
    for (const d of allDefs) (g[d.group] ??= []).push(d);
    return g;
  }, [allDefs]);

  // periods where SPY closed below its 200-day average (last value in the period)
  const regimeAreas = useMemo(() => {
    if (!res || !cfg.regime) return [];
    const flag = res.series.spy_above_200 ?? [];
    const areas: [{ xAxis: string }, { xAxis: string }][] = [];
    let open: number | null = null;
    flag.forEach((v, i) => {
      if (v === 0 && open == null) open = i;
      if (v !== 0 && open != null) {
        areas.push([{ xAxis: res.periods[open] }, { xAxis: res.periods[i - 1] }]);
        open = null;
      }
    });
    if (open != null) areas.push([{ xAxis: res.periods[open] }, { xAxis: res.periods[flag.length - 1] }]);
    return areas;
  }, [res, cfg.regime]);

  const shown = useMemo(
    () => [...cfg.selected.filter((id) => !id.startsWith("f")), ...(res?.custom.map((c) => c.id) ?? [])].filter((id) => byId.has(id) && res?.series[id]),
    [cfg.selected, res, byId],
  );

  const charts = useMemo(() => {
    if (!res) return [];
    return shown.map((id, k) => {
      const d = byId.get(id)!;
      const color = COLORS[k % COLORS.length];
      const last = k === shown.length - 1;
      const option: EChartsOption = {
        backgroundColor: "transparent",
        animation: false,
        grid: { left: 80, right: 24, top: 30, bottom: last ? 64 : 24 },
        title: { text: d.label, left: 80, top: 2, textStyle: { color: "#e6e9f0", fontSize: 12, fontWeight: "normal" } },
        tooltip: {
          trigger: "axis",
          backgroundColor: "#131722", borderColor: "#2a3142", textStyle: { color: "#e6e9f0", fontSize: 12 },
          formatter: (p: unknown) => {
            const i = (p as { dataIndex: number }[])[0]?.dataIndex ?? 0;
            const spy = res.series.spy_above_200?.[i];
            return `<b>${res.periods[i]}</b> (${res.sessions[i]} session${res.sessions[i] === 1 ? "" : "s"})<br/>${d.label}: <b>${fmtValue(res.series[id][i], d.unit)}</b>${
              spy === 0 ? '<br/><span style="color:#8b93a7">SPY below its 200-day average</span>' : ""}`;
          },
        },
        xAxis: { type: "category", data: res.periods, axisLabel: { color: "#8b93a7", show: last } },
        yAxis: { type: "value", scale: d.kind !== "count", axisLabel: { formatter: (v: number) => fmtValue(v, d.unit), color: "#8b93a7" },
                 splitLine: { lineStyle: { color: "#1c2230" } } },
        // no wheel zoom: full-width panels would swallow page scrolling; the bottom slider zooms every panel (connected group)
        dataZoom: last ? [{ type: "slider", height: 20, bottom: 8, textStyle: { color: "#8b93a7" } }] : [{ type: "slider", show: false }],
        series: [
          {
            type: d.kind === "count" ? "bar" : "line",
            data: res.series[id],
            symbol: "none",
            connectNulls: id === "median_short_float",
            itemStyle: { color },
            lineStyle: { color, width: 1.5 },
          } as never,
          // the regime shading lives on its own empty line series: on a bar series ECharts placed
          // the same category ranges differently from the line panels (shifted, some missing)
          ...(regimeAreas.length
            ? [{ type: "line", data: res.periods.map(() => null), symbol: "none", silent: true, tooltip: { show: false },
                 markArea: { silent: true, itemStyle: { color: "rgba(231, 76, 60, 0.08)" }, data: regimeAreas } } as never]
            : []),
        ],
      };
      return { id, option, height: last ? 230 : 190 };
    });
  }, [res, shown, byId, regimeAreas]);

  function toggle(id: string, on: boolean) {
    set({ selected: on ? [...cfg.selected, id] : cfg.selected.filter((x) => x !== id) });
  }

  function addCustom() {
    if (!draft.expr.trim() || cfg.custom.length >= 3) return;
    set({ custom: [...cfg.custom, { name: draft.name.trim(), expr: draft.expr.trim(), how: draft.how }] });
    setDraft({ name: "", expr: "", how: draft.how });
  }

  function exportCsv() {
    if (!res) return;
    const ids = shown;
    const lines = [["period", "sessions", ...ids].join(",")];
    res.periods.forEach((p, i) => lines.push([p, res.sessions[i], ...ids.map((id) => res.series[id][i] ?? "")].join(",")));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `charter_aggregates_${cfg.freq}_${cfg.start}_${cfg.end}.csv`;
    a.click();
  }

  const n = (v: string, fallback: number) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : fallback);

  return (
    <section>
      <div className="charter-controls">
        <input type="date" value={cfg.start} min="2016-01-04" onChange={(e) => set({ start: e.target.value })} />
        <span className="ops-dim">→</span>
        <input type="date" value={cfg.end} onChange={(e) => set({ end: e.target.value })} />
        <span className="charter-presets">
          {(["day", "week", "month"] as const).map((f) => (
            <button key={f} className={`research-tab${cfg.freq === f ? " active" : ""}`} onClick={() => set({ freq: f })}>
              {{ day: "Daily", week: "Weekly", month: "Monthly" }[f]}
            </button>
          ))}
        </span>
        <button className="link-button charter-run" onClick={run} disabled={loading}>{loading ? "Running…" : "Run"}</button>
        {res && (
          <span className="ops-dim">
            {res.periods.length.toLocaleString()} periods · {res.universe_rows.toLocaleString()} stock-days
            {elapsed != null && ` · ${elapsed.toFixed(1)}s`}
          </span>
        )}
        <button className="link-button" onClick={exportCsv} disabled={!res}>Export CSV</button>
        {err && <span className="neg">{err}</span>}
      </div>

      <div className="charter-controls charter-toggles">
        <span className="ops-dim">Universe (previous close)</span>
        <label>price $<input className="charter-num" value={cfg.price_min} onChange={(e) => set({ price_min: n(e.target.value, 0) })} /></label>
        <label>to $<input className="charter-num" value={cfg.price_max} onChange={(e) => set({ price_max: n(e.target.value, 100000) })} /></label>
        <label>20d $vol ≥ <input className="charter-num" value={cfg.dollar20_min} onChange={(e) => set({ dollar20_min: n(e.target.value, 0) })} /></label>
        {EXCH.map((x) => (
          <label key={x}>
            <input type="checkbox" checked={cfg.exchanges.includes(x)}
                   onChange={(e) => set({ exchanges: e.target.checked ? [...cfg.exchanges, x] : cfg.exchanges.filter((y) => y !== x) })} />
            {x}
          </label>
        ))}
        <label><input type="checkbox" checked={cfg.funds} onChange={(e) => set({ funds: e.target.checked })} /> include funds/ETFs</label>
        <label><input type="checkbox" checked={cfg.regime} onChange={(e) => set({ regime: e.target.checked })} /> shade SPY below its 200-day average</label>
      </div>

      <details className="charter-agg-picker" open>
        <summary className="ops-dim">Series ({shown.length} shown) — tick to show; universe and formula changes apply on Run; zoom with the slider under the last panel</summary>
        <div className="charter-agg-groups">
          {Object.entries(grouped)
            .filter(([g]) => g !== "My formulas")
            .map(([g, ds]) => (
              <div key={g} className="charter-agg-group">
                <div className="ops-dim">{g}</div>
                {ds.map((d) => (
                  <label key={d.id} className="charter-agg-item">
                    <input type="checkbox" checked={cfg.selected.includes(d.id)} onChange={(e) => toggle(d.id, e.target.checked)} />
                    {d.label}
                  </label>
                ))}
              </div>
            ))}
        </div>
      </details>

      <div className="charter-controls charter-toggles">
        <span className="ops-dim">Formula series</span>
        <select value={draft.how} onChange={(e) => setDraft({ ...draft, how: e.target.value as "share" | "median" })}>
          <option value="share">share of stocks where</option>
          <option value="median">median of</option>
        </select>
        <input ref={formulaRef} className="charter-formula" placeholder={draft.how === "share" ? "e.g. dist_sma20 > 0   or   change(close, 5) > 0.5" : "e.g. close_vs_vwap   or   zscore(volume, 20)"}
               value={draft.expr} onChange={(e) => setDraft({ ...draft, expr: e.target.value })} onKeyDown={(e) => e.key === "Enter" && addCustom()} />
        <FormulaHelp context="server" inputRef={formulaRef} value={draft.expr} onChange={(v) => setDraft((d) => ({ ...d, expr: v }))} metrics={helpMetrics} />
        <input className="charter-formula-name" placeholder="name (optional)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <button className="link-button" onClick={addCustom} disabled={cfg.custom.length >= 3}>Add</button>
        {cfg.custom.map((c, i) => (
          <span key={i} className="charter-chip" title={c.expr}>
            ƒ {c.name || c.expr} · {c.how}
            <button onClick={() => set({ custom: cfg.custom.filter((_, j) => j !== i) })}>×</button>
          </span>
        ))}
      </div>

      <p className="research-note">
        A stock counts on a day if it passed the universe gates at the <b>previous</b> close. Counts are totals over each period's sessions;
        shares, medians and formula series are averages of the daily values; the index, SPY and the regime flag are the period's last value.
        Catalysts are dated to the first universe session on or after the event. SMA and 52-week measures stay blank until the warehouse
        (from 2016-01) has enough history. Shaded: SPY below its 200-day average.
      </p>

      {loading && !res && <p className="empty-state">Aggregating the warehouse…</p>}
      {res && !charts.length && <p className="empty-state">Tick a series above to plot it.</p>}
      {charts.map(({ id, option, height }) => (
        <div key={id} className="ops-panel charter-chart charter-agg-panel">
          <EChart option={option} height={height} group="charter-agg" />
        </div>
      ))}
    </section>
  );
}
