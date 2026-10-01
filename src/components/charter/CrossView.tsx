import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ECharts, EChartsOption } from "echarts";
import { EChart } from "./EChart";
import { CharterApiError, charterGet, fmtValue, type Columnar, type MetricDef } from "../../lib/charterApi";
import { evaluateFormula, FormulaError } from "../../lib/formula";
import { FormulaHelp } from "./FormulaHelp";

/**
 * Charter phase 2: the cross-sectional explorer. Every stock on one date
 * (snapshot), or a sample of stock-days across a range (pooled), with every
 * daily metric, forward outcomes (fwd_*, the FUTURE -- outcomes, never
 * predictors), point-in-time short / share context and trailing catalyst
 * counts from the Charter API's /cross. Filters, formulas and all four
 * views run client-side on the returned rows.
 */

export type CrossChart = "scatter" | "binned" | "histogram" | "table";
export interface CrossFilter {
  metric: string;
  op: ">" | "<" | ">=" | "<=" | "=" | "!=";
  value: number;
}
export interface CrossConfig {
  mode: "snapshot" | "range";
  date: string;
  start: string;
  end: string;
  sample: number;
  price_min: number;
  price_max: number;
  dollar20_min: number;
  exchanges: string[];
  funds: boolean;
  filters: CrossFilter[];
  chart: CrossChart;
  x: string;
  y: string;
  color: string;
  xLog: boolean;
  yLog: boolean;
  bins: number;
  split: string;
  clip: boolean;
  tableCols: string[];
  sort: string;
  sortDesc: boolean;
  formulas: { id: string; name: string; expr: string }[];
}

// default ~6 weeks back, so forward outcomes (fwd_*, up to 20 sessions ahead) exist
const defaultDate = () => {
  const d = new Date(Date.now() - 42 * 86_400_000);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};

export const DEFAULT_CROSS: CrossConfig = {
  mode: "snapshot",
  date: defaultDate(),
  start: "2020-01-01",
  end: "2021-12-31",
  sample: 20000,
  price_min: 0.1,
  price_max: 5,
  dollar20_min: 250000,
  exchanges: [],
  funds: false,
  filters: [],
  chart: "binned",
  x: "vol_ratio",
  y: "fwd_ret_5",
  color: "atr14_pct",
  xLog: false,
  yLog: false,
  bins: 40,
  split: "fwd_hit30_5",
  clip: true,
  tableCols: ["raw_close", "dollar20", "vol_ratio", "ret_1", "ret_20", "atr14_pct", "short_float", "mcap", "fwd_ret_5"],
  sort: "vol_ratio",
  sortDesc: true,
  formulas: [],
};

const EXCH = ["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS", "OTC"];
const TEXT_COLS = new Set(["symbol", "date", "exchange", "name"]);

// labels / groups / units for the /cross columns that aren't in the daily catalog
const EXTRA: Record<string, [string, string, MetricDef["unit"]]> = {
  fwd_ret_1: ["Next-day return (future)", "Forward outcomes (future)", "pct"],
  fwd_ret_5: ["5-day forward return (future)", "Forward outcomes (future)", "pct"],
  fwd_ret_20: ["20-day forward return (future)", "Forward outcomes (future)", "pct"],
  fwd_gap_1: ["Next-day gap (future)", "Forward outcomes (future)", "pct"],
  fwd_max_5: ["Best high next 5 days (future)", "Forward outcomes (future)", "pct"],
  fwd_min_5: ["Worst low next 5 days (future)", "Forward outcomes (future)", "pct"],
  fwd_hit30_5: ["Hit +30% within 5 days (future, 0/1)", "Forward outcomes (future)", "ratio"],
  short_interest: ["Short interest", "Short / shares", "shares"],
  short_float: ["Short float", "Short / shares", "pct"],
  days_to_cover: ["Days to cover", "Short / shares", "ratio"],
  short_age_days: ["Short data age (days)", "Short / shares", "count"],
  shares_outstanding: ["Shares outstanding", "Short / shares", "shares"],
  mcap: ["Market cap", "Short / shares", "usd"],
  share_growth_1y: ["Share growth, 1 year", "Short / shares", "pct"],
  is_fund: ["Is a fund/ETF (0/1)", "Listing", "ratio"],
};
const FAMILIES: Record<string, string> = {
  offering: "Offering filings", halt: "Trading halts", partnership_pr: "Partnership PRs", earnings_beat: "Earnings beats",
  insider_buy: "Insider buys", news: "Typed headlines", filing: "SEC filings (any)",
};
for (const [k, v] of Object.entries(FAMILIES)) {
  EXTRA[`cat20_${k}`] = [`${v}, last 20 days`, "Catalysts (trailing)", "count"];
  EXTRA[`cat60_${k}`] = [`${v}, last 60 days`, "Catalysts (trailing)", "count"];
}

type Col = (number | null)[];

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export function CrossView({
  cfg,
  set,
  catalog,
  onApiError,
  onOpenSymbol,
}: {
  cfg: CrossConfig;
  set: (p: Partial<CrossConfig>) => void;
  catalog: MetricDef[];
  onApiError: (m: string | null) => void;
  onOpenSymbol: (symbol: string, date: string) => void;
}) {
  const [res, setRes] = useState<(Columnar & { total_matching: number; sampled: boolean }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [draft, setDraft] = useState({ name: "", expr: "" });
  const [ferr, setFerr] = useState<string | null>(null);
  const formulaRef = useRef<HTMLInputElement>(null);

  const run = useCallback(() => {
    setLoading(true);
    const t0 = performance.now();
    const p: Record<string, string> = {
      price_min: String(cfg.price_min), price_max: String(cfg.price_max), dollar20_min: String(cfg.dollar20_min),
      exchanges: cfg.exchanges.join(","), funds: cfg.funds ? "1" : "0",
    };
    if (cfg.mode === "snapshot") p.date = cfg.date;
    else Object.assign(p, { start: cfg.start, end: cfg.end, sample: String(cfg.sample) });
    charterGet<Columnar & { total_matching: number; sampled: boolean }>("/cross", p)
      .then((r) => {
        setRes(r);
        onApiError(null);
      })
      .catch((e: CharterApiError) => onApiError(e.message))
      .finally(() => {
        setLoading(false);
        setElapsed((performance.now() - t0) / 1000);
      });
  }, [cfg.mode, cfg.date, cfg.start, cfg.end, cfg.sample, cfg.price_min, cfg.price_max, cfg.dollar20_min, cfg.exchanges, cfg.funds, onApiError]);

  // first load
  const ran = useRef(false);
  useEffect(() => {
    if (!ran.current) {
      ran.current = true;
      run();
    }
  }, [run]);

  const meta = useMemo(() => {
    const m: Record<string, { label: string; group: string; unit: MetricDef["unit"] }> = {};
    for (const c of catalog) if (c.kind === "daily") m[c.id] = { label: c.label, group: c.group, unit: c.unit };
    for (const [id, [label, group, unit]] of Object.entries(EXTRA)) m[id] = { label, group, unit };
    for (const f of cfg.formulas) m[f.id] = { label: `ƒ ${f.name}`, group: "My formulas", unit: "ratio" };
    return m;
  }, [catalog, cfg.formulas]);
  const label = (id: string) => meta[id]?.label ?? id;
  const unit = (id: string) => meta[id]?.unit;

  // columns (+ formulas), then filters -> kept row indices
  const table = useMemo(() => {
    if (!res) return null;
    const cols: Record<string, Col> = {};
    for (const c of res.columns) if (!TEXT_COLS.has(c)) cols[c] = (res.data[c] as unknown[]).map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : (v as number | null)));
    const errors: string[] = [];
    for (const f of cfg.formulas) {
      try {
        cols[f.id] = evaluateFormula(f.expr, cols, true);
      } catch (e) {
        errors.push(`${f.name}: ${e instanceof Error ? e.message : e}`);
        cols[f.id] = new Array(res.rows).fill(null);
      }
    }
    const keep: number[] = [];
    rowLoop: for (let i = 0; i < res.rows; i++) {
      for (const fl of cfg.filters) {
        const v = cols[fl.metric]?.[i];
        if (v == null) continue rowLoop;
        const ok = fl.op === ">" ? v > fl.value : fl.op === "<" ? v < fl.value : fl.op === ">=" ? v >= fl.value
          : fl.op === "<=" ? v <= fl.value : fl.op === "=" ? v === fl.value : v !== fl.value;
        if (!ok) continue rowLoop;
      }
      keep.push(i);
    }
    return { cols, keep, errors, sym: res.data.symbol as string[], date: res.data.date as string[] };
  }, [res, cfg.formulas, cfg.filters]);

  const numericIds = useMemo(() => (table ? Object.keys(table.cols) : []), [table]);
  const grouped = useMemo(() => {
    const g: Record<string, string[]> = {};
    for (const id of numericIds) (g[meta[id]?.group ?? "Other"] ??= []).push(id);
    return g;
  }, [numericIds, meta]);

  const MetricSelect = ({ value, onChange, allowNone }: { value: string; onChange: (v: string) => void; allowNone?: boolean }) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {allowNone && <option value="">(none)</option>}
      {Object.entries(grouped).map(([g, ids]) => (
        <optgroup key={g} label={g}>
          {ids.map((id) => (
            <option key={id} value={id}>{label(id)}</option>
          ))}
        </optgroup>
      ))}
    </select>
  );

  const pointIdx = useRef<number[]>([]);
  const option = useMemo<EChartsOption | null>(() => {
    if (!table || !table.keep.length || cfg.chart === "table") return null;
    const { cols, keep } = table;
    const axisFmt = (id: string) => (v: number) => fmtValue(v, unit(id));
    const base = {
      backgroundColor: "transparent",
      animation: false,
      grid: { left: 80, right: 90, top: 30, bottom: 60 },
      tooltip: { backgroundColor: "#131722", borderColor: "#2a3142", textStyle: { color: "#e6e9f0", fontSize: 12 } },
    };
    if (cfg.chart === "scatter") {
      const xs = cols[cfg.x], ys = cols[cfg.y], cs = cfg.color ? cols[cfg.color] : null;
      const pts: number[][] = [];
      const idx: number[] = [];
      for (const i of keep) {
        const x = xs?.[i], y = ys?.[i];
        if (x == null || y == null || (cfg.xLog && x <= 0) || (cfg.yLog && y <= 0)) continue;
        pts.push([x, y, cs?.[i] ?? 0]);
        idx.push(i);
      }
      pointIdx.current = idx;
      const cvals = pts.map((p) => p[2]).sort((a, b) => a - b);
      return {
        ...base,
        tooltip: {
          ...base.tooltip,
          trigger: "item",
          formatter: (p: unknown) => {
            const pp = p as { dataIndex: number };
            const i = idx[pp.dataIndex];
            return `<b>${table.sym[i]}</b> ${table.date[i]}<br/>${label(cfg.x)}: ${fmtValue(cols[cfg.x][i], unit(cfg.x))}<br/>${label(cfg.y)}: ${fmtValue(cols[cfg.y][i], unit(cfg.y))}${cfg.color ? `<br/>${label(cfg.color)}: ${fmtValue(cols[cfg.color][i], unit(cfg.color))}` : ""}<br/><span style="color:#8b93a7">click to open in the deep dive</span>`;
          },
        },
        xAxis: { type: cfg.xLog ? "log" : "value", name: label(cfg.x), nameLocation: "middle", nameGap: 32, scale: true, axisLabel: { formatter: axisFmt(cfg.x), color: "#8b93a7" }, splitLine: { lineStyle: { color: "#1c2230" } } },
        yAxis: { type: cfg.yLog ? "log" : "value", name: label(cfg.y), nameLocation: "middle", nameGap: 60, scale: true, axisLabel: { formatter: axisFmt(cfg.y), color: "#8b93a7" }, splitLine: { lineStyle: { color: "#1c2230" } } },
        visualMap: cfg.color
          ? { type: "continuous", dimension: 2, min: quantile(cvals, 0.02), max: quantile(cvals, 0.98), right: 0, top: "middle", calculable: true, inRange: { color: ["#4f8cff", "#f0a020", "#e74c3c"] }, textStyle: { color: "#8b93a7" }, formatter: (v: unknown) => fmtValue(v as number, unit(cfg.color)) }
          : undefined,
        dataZoom: [{ type: "inside", xAxisIndex: 0 }, { type: "inside", yAxisIndex: 0 }],
        series: [{ type: "scatter", data: pts, symbolSize: pts.length > 20000 ? 2 : 4, large: pts.length > 5000, itemStyle: { opacity: 0.6, color: "#4f8cff" } }],
      };
    }
    if (cfg.chart === "binned") {
      const pairs = keep.map((i) => [cols[cfg.x]?.[i], cols[cfg.y]?.[i]] as const).filter(([x, y]) => x != null && y != null) as [number, number][];
      if (!pairs.length) return null;
      pairs.sort((a, b) => a[0] - b[0]);
      const nb = 10;
      const rows: { lo: number; hi: number; mean: number; se: number; n: number; med: number }[] = [];
      for (let b = 0; b < nb; b++) {
        const seg = pairs.slice(Math.floor((b * pairs.length) / nb), Math.floor(((b + 1) * pairs.length) / nb));
        if (!seg.length) continue;
        const ys = seg.map((p) => p[1]);
        const mean = ys.reduce((s, v) => s + v, 0) / ys.length;
        const sd = Math.sqrt(ys.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, ys.length - 1));
        rows.push({ lo: seg[0][0], hi: seg[seg.length - 1][0], mean, se: sd / Math.sqrt(ys.length), n: ys.length, med: quantile([...ys].sort((a, b2) => a - b2), 0.5) });
      }
      const overall = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
      const cats = rows.map((r, k) => `D${k + 1}\n${fmtValue(r.lo, unit(cfg.x))}…${fmtValue(r.hi, unit(cfg.x))}`);
      return {
        ...base,
        grid: { ...base.grid, bottom: 80 },
        tooltip: {
          ...base.tooltip,
          trigger: "axis",
          formatter: (p: unknown) => {
            const k = (p as { dataIndex: number }[])[0].dataIndex;
            const r = rows[k];
            return `<b>${label(cfg.x)} decile ${k + 1}</b> (${fmtValue(r.lo, unit(cfg.x))} to ${fmtValue(r.hi, unit(cfg.x))})<br/>mean ${label(cfg.y)}: <b>${fmtValue(r.mean, unit(cfg.y))}</b> ± ${fmtValue(1.96 * r.se, unit(cfg.y))}<br/>median ${fmtValue(r.med, unit(cfg.y))} · n = ${r.n.toLocaleString()}<br/>all rows: ${fmtValue(overall, unit(cfg.y))}`;
          },
        },
        xAxis: { type: "category", data: cats, name: `${label(cfg.x)} (deciles)`, nameLocation: "middle", nameGap: 58, axisLabel: { color: "#8b93a7", fontSize: 10 } },
        yAxis: { type: "value", name: `mean ${label(cfg.y)}`, nameLocation: "middle", nameGap: 60, scale: true, axisLabel: { formatter: axisFmt(cfg.y), color: "#8b93a7" }, splitLine: { lineStyle: { color: "#1c2230" } } },
        series: [
          { type: "bar", data: rows.map((r) => r.mean), itemStyle: { color: (p: { value: unknown }) => ((p.value as number) >= overall ? "#2ecc71aa" : "#e74c3caa") } as never, markLine: { symbol: "none", data: [{ yAxis: overall, name: "all rows" }], lineStyle: { color: "#8b93a7", type: "dashed" }, label: { formatter: "all rows", color: "#8b93a7" } } },
          { type: "custom", renderItem: ((_: unknown, api: { value: (i: number) => number; coord: (p: number[]) => number[] }) => {
              const k = api.value(0), lo = api.value(1), hi = api.value(2);
              const a = api.coord([k, lo]), b = api.coord([k, hi]);
              return { type: "group", children: [
                { type: "line", shape: { x1: a[0], y1: a[1], x2: b[0], y2: b[1] }, style: { stroke: "#e6e9f0", lineWidth: 1 } },
                { type: "line", shape: { x1: a[0] - 5, y1: a[1], x2: a[0] + 5, y2: a[1] }, style: { stroke: "#e6e9f0" } },
                { type: "line", shape: { x1: b[0] - 5, y1: b[1], x2: b[0] + 5, y2: b[1] }, style: { stroke: "#e6e9f0" } },
              ] };
            }) as never, data: rows.map((r, k) => [k, r.mean - 1.96 * r.se, r.mean + 1.96 * r.se]), z: 10 },
        ],
      };
    }
    // histogram
    const vals = keep.map((i) => cols[cfg.x]?.[i]).filter((v) => v != null) as number[];
    if (!vals.length) return null;
    const sorted = [...vals].sort((a, b) => a - b);
    const lo = cfg.clip ? quantile(sorted, 0.01) : sorted[0];
    const hi = cfg.clip ? quantile(sorted, 0.99) : sorted[sorted.length - 1];
    const nb = Math.max(5, Math.min(200, cfg.bins));
    const w = (hi - lo) / nb || 1;
    const groups: [string, number[]][] = [];
    if (cfg.split) {
      const sp = cols[cfg.split];
      const uniq = [...new Set(keep.map((i) => sp?.[i]).filter((v) => v != null))] as number[];
      const binary = uniq.length <= 2;
      if (binary) for (const u of uniq.sort()) groups.push([`${label(cfg.split)} = ${u}`, keep.filter((i) => sp[i] === u)]);
      else {
        const med = quantile(keep.map((i) => sp[i]).filter((v) => v != null).sort((a, b) => (a as number) - (b as number)) as number[], 0.5);
        groups.push([`${label(cfg.split)} below median`, keep.filter((i) => sp[i] != null && (sp[i] as number) < med)]);
        groups.push([`${label(cfg.split)} at/above median`, keep.filter((i) => sp[i] != null && (sp[i] as number) >= med)]);
      }
    } else groups.push(["all rows", keep]);
    const centers = Array.from({ length: nb }, (_, b) => lo + w * (b + 0.5));
    const colors = ["#4f8cff", "#f0a020", "#2ecc71", "#e74c3c"];
    return {
      ...base,
      legend: { top: 0, textStyle: { color: "#8b93a7" } },
      tooltip: { ...base.tooltip, trigger: "axis" },
      xAxis: { type: "category", data: centers.map((c) => fmtValue(c, unit(cfg.x))), name: label(cfg.x), nameLocation: "middle", nameGap: 36, axisLabel: { color: "#8b93a7" } },
      yAxis: { type: "value", name: "share of rows", axisLabel: { formatter: (v: number) => `${(v * 100).toFixed(1)}%`, color: "#8b93a7" }, splitLine: { lineStyle: { color: "#1c2230" } } },
      series: groups.map(([name, rows], gi) => {
        const counts = new Array(nb).fill(0);
        let n = 0;
        for (const i of rows) {
          const v = cols[cfg.x]?.[i];
          if (v == null) continue;
          const b = Math.min(nb - 1, Math.max(0, Math.floor((v - lo) / w)));
          if (cfg.clip && (v < lo || v > hi)) continue;
          counts[b]++;
          n++;
        }
        return { type: "bar", name: `${name} (n=${n.toLocaleString()})`, data: counts.map((c) => (n ? c / n : 0)), barGap: "-100%", itemStyle: { color: colors[gi % 4], opacity: groups.length > 1 ? 0.55 : 0.85 } };
      }),
    };
  }, [table, cfg.chart, cfg.x, cfg.y, cfg.color, cfg.xLog, cfg.yLog, cfg.bins, cfg.split, cfg.clip, meta]);

  const onReady = useCallback(
    (chart: ECharts) => {
      chart.on("click", (p: unknown) => {
        const pp = p as { seriesType?: string; dataIndex?: number };
        if (pp.seriesType !== "scatter" || pp.dataIndex == null) return;
        const i = pointIdx.current[pp.dataIndex];
        if (i != null && tableRef.current) onOpenSymbol(tableRef.current.sym[i], tableRef.current.date[i]);
      });
    },
    [onOpenSymbol],
  );
  const tableRef = useRef(table);
  tableRef.current = table;

  function addFormula() {
    setFerr(null);
    if (!draft.expr.trim() || !table) return;
    try {
      evaluateFormula(draft.expr, table.cols, true);
    } catch (e) {
      setFerr(e instanceof FormulaError ? e.message : String(e));
      return;
    }
    const id = `f_${Date.now().toString(36)}`;
    set({ formulas: [...cfg.formulas, { id, name: draft.name.trim() || draft.expr.trim(), expr: draft.expr.trim() }] });
    setDraft({ name: "", expr: "" });
  }

  function exportCsv() {
    if (!table || !res) return;
    const keys = ["symbol", "date", "exchange", ...Object.keys(table.cols)];
    const lines = [keys.join(",")];
    for (const i of table.keep)
      lines.push([table.sym[i], table.date[i], res.data.exchange[i] ?? "", ...Object.keys(table.cols).map((k) => table.cols[k][i] ?? "")].join(","));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `charter_cross_${cfg.mode === "snapshot" ? cfg.date : `${cfg.start}_${cfg.end}`}.csv`;
    a.click();
  }

  const sortedRows = useMemo(() => {
    if (!table || cfg.chart !== "table") return [];
    const col = table.cols[cfg.sort];
    return [...table.keep]
      .sort((a, b) => {
        const va = col?.[a], vb = col?.[b];
        if (va == null) return 1;
        if (vb == null) return -1;
        return cfg.sortDesc ? vb - va : va - vb;
      })
      .slice(0, 500);
  }, [table, cfg.chart, cfg.sort, cfg.sortDesc]);

  const n = (v: string, fallback: number) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : fallback);

  return (
    <section>
      <div className="charter-controls">
        <span className="charter-presets">
          <button className={`research-tab${cfg.mode === "snapshot" ? " active" : ""}`} onClick={() => set({ mode: "snapshot" })}>One date</button>
          <button className={`research-tab${cfg.mode === "range" ? " active" : ""}`} onClick={() => set({ mode: "range" })}>Date range (pooled)</button>
        </span>
        {cfg.mode === "snapshot" ? (
          <input type="date" value={cfg.date} min="2016-01-04" onChange={(e) => set({ date: e.target.value })} />
        ) : (
          <>
            <input type="date" value={cfg.start} min="2016-01-04" onChange={(e) => set({ start: e.target.value })} />
            <span className="ops-dim">→</span>
            <input type="date" value={cfg.end} onChange={(e) => set({ end: e.target.value })} />
            <label className="ops-dim">sample
              <select value={cfg.sample} onChange={(e) => set({ sample: Number(e.target.value) })}>
                {[5000, 20000, 50000, 100000, 200000].map((s) => <option key={s} value={s}>{s.toLocaleString()}</option>)}
              </select>
            </label>
          </>
        )}
        <button className="link-button charter-run" onClick={run} disabled={loading}>{loading ? "Loading…" : "Run"}</button>
        {res && (
          <span className="ops-dim">
            {res.sampled ? `${res.rows.toLocaleString()} sampled of ${res.total_matching.toLocaleString()}` : `${res.rows.toLocaleString()} stock-days`}
            {table && ` · ${table.keep.length.toLocaleString()} after filters`}
            {elapsed != null && ` · ${elapsed.toFixed(1)}s`}
          </span>
        )}
      </div>

      <div className="charter-controls charter-toggles">
        <span className="ops-dim">Universe</span>
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
        <span className="ops-dim">(none ticked = all)</span>
        <label><input type="checkbox" checked={cfg.funds} onChange={(e) => set({ funds: e.target.checked })} /> include funds/ETFs</label>
        <span className="ops-dim">· universe changes apply on Run</span>
      </div>

      <div className="charter-controls charter-toggles">
        <span className="ops-dim">Filters</span>
        {cfg.filters.map((f, k) => (
          <span key={k} className="charter-chip">
            {label(f.metric)} {f.op} {f.value}
            <button onClick={() => set({ filters: cfg.filters.filter((_, j) => j !== k) })}>×</button>
          </span>
        ))}
        <FilterAdder grouped={grouped} label={label} onAdd={(f) => set({ filters: [...cfg.filters, f] })} />
      </div>

      <div className="charter-controls charter-toggles">
        <span className="ops-dim">Formula</span>
        <input className="charter-formula-name" placeholder="name (optional)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <input ref={formulaRef} className="charter-formula" placeholder="e.g. short_float * vol_ratio   or   (cat60_offering > 0) * atr14_pct" value={draft.expr}
               onChange={(e) => setDraft({ ...draft, expr: e.target.value })} onKeyDown={(e) => e.key === "Enter" && addFormula()} />
        <FormulaHelp context="rowwise" inputRef={formulaRef} value={draft.expr} onChange={(v) => setDraft((d) => ({ ...d, expr: v }))}
                     metrics={Object.entries(grouped).flatMap(([g, ids]) => ids.map((id) => ({ id, label: label(id), group: g, unit: unit(id) })))} />
        <button className="link-button" onClick={addFormula}>Add metric</button>
        {ferr && <span className="neg">{ferr}</span>}
        {cfg.formulas.map((f) => (
          <span key={f.id} className="charter-chip" title={f.expr}>
            ƒ {f.name}
            <button onClick={() => set({ formulas: cfg.formulas.filter((x) => x.id !== f.id) })}>×</button>
          </span>
        ))}
        {table?.errors.map((er) => <span key={er} className="neg">{er}</span>)}
      </div>

      <div className="charter-controls charter-toggles">
        <span className="charter-presets">
          {(["binned", "scatter", "histogram", "table"] as CrossChart[]).map((c) => (
            <button key={c} className={`research-tab${cfg.chart === c ? " active" : ""}`} onClick={() => set({ chart: c })}>
              {{ binned: "Binned (does X predict Y?)", scatter: "Scatter", histogram: "Histogram", table: "Ranked table" }[c]}
            </button>
          ))}
        </span>
        {table && cfg.chart !== "table" && (
          <>
            <label>{cfg.chart === "histogram" ? "metric" : "X"} <MetricSelect value={cfg.x} onChange={(v) => set({ x: v })} /></label>
            {cfg.chart !== "histogram" && <label>Y <MetricSelect value={cfg.y} onChange={(v) => set({ y: v })} /></label>}
            {cfg.chart === "scatter" && (
              <>
                <label>colour <MetricSelect value={cfg.color} onChange={(v) => set({ color: v })} allowNone /></label>
                <label><input type="checkbox" checked={cfg.xLog} onChange={(e) => set({ xLog: e.target.checked })} /> log X</label>
                <label><input type="checkbox" checked={cfg.yLog} onChange={(e) => set({ yLog: e.target.checked })} /> log Y</label>
              </>
            )}
            {cfg.chart === "histogram" && (
              <>
                <label>split by <MetricSelect value={cfg.split} onChange={(v) => set({ split: v })} allowNone /></label>
                <label>bins <input className="charter-num" value={cfg.bins} onChange={(e) => set({ bins: n(e.target.value, 40) })} /></label>
                <label><input type="checkbox" checked={cfg.clip} onChange={(e) => set({ clip: e.target.checked })} /> clip 1–99%</label>
              </>
            )}
          </>
        )}
        {table && cfg.chart === "table" && (
          <>
            <label>sort by <MetricSelect value={cfg.sort} onChange={(v) => set({ sort: v })} /></label>
            <label><input type="checkbox" checked={cfg.sortDesc} onChange={(e) => set({ sortDesc: e.target.checked })} /> highest first</label>
            <label>add column <MetricSelect value="" allowNone onChange={(v) => v && !cfg.tableCols.includes(v) && set({ tableCols: [...cfg.tableCols, v] })} /></label>
          </>
        )}
        <button className="link-button" onClick={exportCsv} disabled={!table}>Export filtered rows CSV</button>
      </div>

      {cfg.chart === "binned" && (
        <p className="research-note">
          Rows split into 10 equal-count groups by X; bars show the mean of Y in each (whiskers = 95% range of that mean), the dashed line the
          mean across all rows. A pattern that rises or falls steadily across groups is evidence X relates to Y — use a <b>future</b> metric as
          Y to ask whether X predicts it.
        </p>
      )}

      <div className="ops-panel charter-chart">
        {loading && !res && <p className="empty-state">Loading the cross-section…</p>}
        {table && !table.keep.length && <p className="empty-state">No rows match the filters.</p>}
        {table && table.keep.length > 0 && !option && cfg.chart !== "table" && (
          <p className="empty-state">
            Nothing to plot: {label(cfg.chart === "histogram" ? cfg.x : cfg.y)} has no values for these rows
            {[cfg.x, cfg.y].some((m) => m.startsWith("fwd_")) &&
              " — forward (future) metrics need 1–20 trading days after the chosen date, so they're empty for the latest dates. Pick an earlier date or a date range"}
            .
          </p>
        )}
        {option && <EChart option={option} height={560} onReady={onReady} />}
        {table && cfg.chart === "table" && (
          <div className="charter-events-scroll" style={{ maxHeight: 640 }}>
            <table className="ops-table research-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Date</th>
                  {cfg.tableCols.map((c) => (
                    <th key={c} className="col-num">
                      <span className="charter-th" onClick={() => set(cfg.sort === c ? { sortDesc: !cfg.sortDesc } : { sort: c, sortDesc: true })}>
                        {label(c)}{cfg.sort === c ? (cfg.sortDesc ? " ▼" : " ▲") : ""}
                      </span>
                      <button className="charter-th-x" title="remove column" onClick={() => set({ tableCols: cfg.tableCols.filter((x) => x !== c) })}>×</button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((i, k) => (
                  <tr key={i} className={`ops-row research-row${k % 2 ? " ops-row-alt" : ""}`} onClick={() => onOpenSymbol(table.sym[i], table.date[i])}>
                    <td><b>{table.sym[i]}</b></td>
                    <td className="catalyst-date">{table.date[i]}</td>
                    {cfg.tableCols.map((c) => (
                      <td key={c} className="col-num">{fmtValue(table.cols[c]?.[i], unit(c))}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {table.keep.length > 500 && <p className="research-note">Showing the top 500 of {table.keep.length.toLocaleString()} rows — export for all.</p>}
          </div>
        )}
      </div>
    </section>
  );
}

function FilterAdder({
  grouped,
  label,
  onAdd,
}: {
  grouped: Record<string, string[]>;
  label: (id: string) => string;
  onAdd: (f: CrossFilter) => void;
}) {
  const [metric, setMetric] = useState("");
  const [op, setOp] = useState<CrossFilter["op"]>(">");
  const [value, setValue] = useState("");
  return (
    <span className="charter-filter-add">
      <select value={metric} onChange={(e) => setMetric(e.target.value)}>
        <option value="">+ filter on…</option>
        {Object.entries(grouped).map(([g, ids]) => (
          <optgroup key={g} label={g}>
            {ids.map((id) => <option key={id} value={id}>{label(id)}</option>)}
          </optgroup>
        ))}
      </select>
      {metric && (
        <>
          <select value={op} onChange={(e) => setOp(e.target.value as CrossFilter["op"])}>
            {[">", ">=", "<", "<=", "=", "!="].map((o) => <option key={o}>{o}</option>)}
          </select>
          <input className="charter-num" placeholder="value (0.05 = 5%)" value={value} onChange={(e) => setValue(e.target.value)}
                 onKeyDown={(e) => {
                   if (e.key === "Enter" && Number.isFinite(parseFloat(value))) {
                     onAdd({ metric, op, value: parseFloat(value) });
                     setMetric(""); setValue("");
                   }
                 }} />
          <button className="link-button" disabled={!Number.isFinite(parseFloat(value))}
                  onClick={() => { onAdd({ metric, op, value: parseFloat(value) }); setMetric(""); setValue(""); }}>Add</button>
        </>
      )}
    </span>
  );
}
