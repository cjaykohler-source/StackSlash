import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EChartsOption } from "echarts";
import { EChart } from "./EChart";
import { CharterApiError, charterGet, fmtValue, type Columnar, type MetricDef } from "../../lib/charterApi";

/**
 * Charter phase 3: event studies. Pick an event -- a catalyst type, a formula
 * condition, or both -- and see the average path of any daily metric from
 * day -N to +N around it, split winners / losers by the return to day +k,
 * against a random-date control from the same names (the Charter API's
 * /event_study). Everything heavy runs server-side; this view only plots.
 */

export interface EventConfig {
  kind: "catalyst" | "condition";
  type: string;
  align: "entry" | "event";
  cond: string;
  start: string;
  end: string;
  pre: number;
  post: number;
  k: number;
  thr: number;
  cooldown: number;
  sample: number;
  price_min: number;
  price_max: number;
  dollar20_min: number;
  exchanges: string[];
  funds: boolean;
  metrics: string[];
  stat: "mean" | "median";
  show: { winners: boolean; losers: boolean; control: boolean };
  wins: boolean;
}

export const DEFAULT_EVENTS: EventConfig = {
  kind: "catalyst",
  type: "news_halt",
  align: "entry",
  cond: "",
  start: "2016-01-01",
  end: "2021-12-31",
  pre: 20,
  post: 20,
  k: 5,
  thr: 0,
  cooldown: 20,
  sample: 5000,
  price_min: 0.1,
  price_max: 5,
  dollar20_min: 250000,
  exchanges: [],
  funds: false,
  metrics: ["vol_ratio"],
  stat: "mean",
  show: { winners: true, losers: true, control: true },
  wins: true,
};

interface PathStats {
  n: (number | null)[];
  mean: (number | null)[];
  lo: (number | null)[];
  hi: (number | null)[];
  median: (number | null)[];
  q25: (number | null)[];
  q75: (number | null)[];
}
interface AtK {
  n: number;
  mean: number | null;
  sd: number | null;
  median: number | null;
  hit: number | null;
}
interface StudyRes {
  offsets: number[];
  metrics: string[];
  groups: Record<string, Record<string, PathStats>>;
  counts: {
    candidates: number;
    events: number;
    used: number;
    sampled: boolean;
    dropped_artifacts: number;
    control: number;
    winners: number;
    losers: number;
  };
  summary: { k: number; event: AtK; control: AtK; diff?: number; diff_lo?: number; diff_hi?: number };
  events: Columnar;
  day0: string;
  winsorized: boolean;
}
interface CatType {
  type: string;
  source: string;
  n: number;
  first: string;
  last: string;
  label: string;
  desc: string;
}

const EXCH = ["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS", "OTC"];
const SOURCE_LABELS: Record<string, string> = {
  edgar: "SEC filings", news: "News", earnings: "Earnings", form4: "Insider (Form 4)",
  going_concern: "Going concern", corporate_actions: "Corporate actions",
};
const GROUPS: [string, string, string][] = [
  ["event", "All events", "#4f8cff"],
  ["winners", "Winners", "#2ecc71"],
  ["losers", "Losers", "#e74c3c"],
  ["control", "Random dates, same names", "#8b93a7"],
];
const pct = (v: number | null | undefined) => fmtValue(v ?? null, "pct");

export function EventStudyView({
  cfg,
  set,
  catalog,
  onApiError,
  onOpenSymbol,
}: {
  cfg: EventConfig;
  set: (p: Partial<EventConfig>) => void;
  catalog: MetricDef[];
  onApiError: (m: string | null) => void;
  onOpenSymbol: (symbol: string, date: string) => void;
}) {
  const [types, setTypes] = useState<CatType[]>([]);
  const [res, setRes] = useState<StudyRes | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [sortDesc, setSortDesc] = useState(true);
  const [sortCol, setSortCol] = useState("date");

  useEffect(() => {
    charterGet<{ types: CatType[] }>("/event_types")
      .then((r) => setTypes(r.types))
      .catch((e: CharterApiError) => onApiError(e.message));
  }, [onApiError]);

  const daily = useMemo(() => catalog.filter((m) => m.kind === "daily"), [catalog]);
  const meta = useMemo(() => {
    const m: Record<string, { label: string; unit: MetricDef["unit"] }> = { cum_ret: { label: "Return from day-0 close", unit: "pct" } };
    for (const c of daily) m[c.id] = { label: c.label, unit: c.unit };
    return m;
  }, [daily]);
  const grouped = useMemo(() => {
    const g: Record<string, MetricDef[]> = {};
    for (const m of daily) (g[m.group] ??= []).push(m);
    return g;
  }, [daily]);
  const typesBySource = useMemo(() => {
    const g: Record<string, CatType[]> = {};
    for (const t of types) (g[t.source] ??= []).push(t);
    return g;
  }, [types]);

  const run = useCallback(() => {
    setLoading(true);
    setErr(null);
    const t0 = performance.now();
    const p: Record<string, string> = {
      kind: cfg.kind, cond: cfg.cond, start: cfg.start, end: cfg.end,
      pre: String(cfg.pre), post: String(cfg.post), k: String(cfg.k), thr: String(cfg.thr),
      cooldown: String(cfg.cooldown), sample: String(cfg.sample),
      price_min: String(cfg.price_min), price_max: String(cfg.price_max), dollar20_min: String(cfg.dollar20_min),
      exchanges: cfg.exchanges.join(","), funds: cfg.funds ? "1" : "0",
      metrics: cfg.metrics.join(","), wins: cfg.wins ? "1" : "0",
    };
    if (cfg.kind === "catalyst") Object.assign(p, { type: cfg.type, align: cfg.align });
    charterGet<StudyRes>("/event_study", p)
      .then((r) => {
        setRes(r);
        onApiError(null);
      })
      .catch((e: CharterApiError) => (e.status === 400 ? setErr(e.message) : onApiError(e.message)))
      .finally(() => {
        setLoading(false);
        setElapsed((performance.now() - t0) / 1000);
      });
  }, [cfg, onApiError]);

  const ran = useRef(false);
  useEffect(() => {
    if (!ran.current && catalog.length) {
      ran.current = true;
      run();
    }
  }, [run, catalog.length]);

  const charts = useMemo(() => {
    if (!res) return [];
    const x = res.offsets.map(String);
    return res.metrics.map((m) => {
      const unit = meta[m]?.unit;
      const series: NonNullable<EChartsOption["series"]> = [];
      const shown = GROUPS.filter(([g]) => g === "event" || cfg.show[g as keyof EventConfig["show"]]);
      for (const [g, name, color] of shown) {
        const s = res.groups[g]?.[m];
        if (!s) continue;
        const nAt0 = s.n[res.offsets.indexOf(0)] ?? 0;
        const label = `${name} (n=${nAt0.toLocaleString()})`;
        // band: 95% range of the mean (mean view) or the interquartile range (median view)
        const [lo, hi] = cfg.stat === "mean" ? [s.lo, s.hi] : [s.q25, s.q75];
        if (g === "event" || g === "control") {
          series.push(
            { type: "line", name: label, data: lo, stack: `band-${g}`, stackStrategy: "all", lineStyle: { opacity: 0 }, itemStyle: { color }, symbol: "none", silent: true, tooltip: { show: false } } as never,
            { type: "line", name: label, data: hi.map((h, i) => (h != null && lo[i] != null ? h - (lo[i] as number) : null)), stack: `band-${g}`, stackStrategy: "all",
              lineStyle: { opacity: 0 }, areaStyle: { color, opacity: 0.15 }, itemStyle: { color }, symbol: "none", silent: true, tooltip: { show: false } } as never,
          );
        }
        series.push({
          type: "line", name: label, data: cfg.stat === "mean" ? s.mean : s.median, symbol: "none",
          lineStyle: { color, width: g === "event" ? 2.5 : 1.5, type: g === "control" ? "dashed" : "solid" }, itemStyle: { color },
        } as never);
      }
      const option: EChartsOption = {
        backgroundColor: "transparent",
        animation: false,
        grid: { left: 80, right: 24, top: 36, bottom: 40 },
        legend: { top: 0, textStyle: { color: "#8b93a7" }, data: shown.map(([g, name]) => `${name} (n=${(res.groups[g]?.[m]?.n[res.offsets.indexOf(0)] ?? 0).toLocaleString()})`) },
        tooltip: {
          trigger: "axis",
          backgroundColor: "#131722", borderColor: "#2a3142", textStyle: { color: "#e6e9f0", fontSize: 12 },
          formatter: (p: unknown) => {
            const ps = (p as { dataIndex: number }[]);
            const i = ps[0]?.dataIndex ?? 0;
            const lines = shown.map(([g, name, color]) => {
              const s = res.groups[g]?.[m];
              if (!s) return "";
              const v = cfg.stat === "mean" ? s.mean[i] : s.median[i];
              const band = cfg.stat === "mean" ? `95% ${fmtValue(s.lo[i], unit)} to ${fmtValue(s.hi[i], unit)}` : `IQR ${fmtValue(s.q25[i], unit)} to ${fmtValue(s.q75[i], unit)}`;
              return `<span style="color:${color}">●</span> ${name}: <b>${fmtValue(v, unit)}</b> <span style="color:#8b93a7">${band} · n=${(s.n[i] ?? 0).toLocaleString()}</span>`;
            });
            return `<b>day ${res.offsets[i] > 0 ? "+" : ""}${res.offsets[i]}</b><br/>${lines.filter(Boolean).join("<br/>")}`;
          },
        },
        xAxis: { type: "category", data: x, name: "sessions from day 0", nameLocation: "middle", nameGap: 26, axisLabel: { color: "#8b93a7" } },
        yAxis: { type: "value", scale: true, name: `${cfg.stat} ${meta[m]?.label ?? m}`, nameLocation: "middle", nameGap: 62,
                 axisLabel: { formatter: (v: number) => fmtValue(v, unit), color: "#8b93a7" }, splitLine: { lineStyle: { color: "#1c2230" } } },
        series: [
          ...series,
          { type: "line", data: [], markLine: { symbol: "none", silent: true, data: [{ xAxis: String(0) }], lineStyle: { color: "#f5c542", type: "dashed" }, label: { formatter: "day 0", color: "#f5c542" } } } as never,
        ],
      };
      return { m, option };
    });
  }, [res, cfg.show, cfg.stat, meta]);

  const rows = useMemo(() => {
    if (!res) return [];
    const e = res.events;
    const idx = Array.from({ length: e.rows }, (_, i) => i);
    const col = e.data[sortCol] ?? e.data.date;
    idx.sort((a, b) => {
      const va = col[a], vb = col[b];
      if (va == null) return 1;
      if (vb == null) return -1;
      const c = va < vb ? -1 : va > vb ? 1 : 0;
      return sortDesc ? -c : c;
    });
    return idx;
  }, [res, sortCol, sortDesc]);

  function exportCsv() {
    if (!res) return;
    const e = res.events;
    const lines = [e.columns.join(",")];
    for (let i = 0; i < e.rows; i++) lines.push(e.columns.map((c) => e.data[c][i] ?? "").join(","));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `charter_events_${cfg.kind === "catalyst" ? cfg.type : "condition"}_${cfg.start}_${cfg.end}.csv`;
    a.click();
  }

  const n = (v: string, fallback: number) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : fallback);
  const sealed = cfg.end >= "2022-01-01";
  const s = res?.summary;
  const th = (c: string, label: string) => (
    <th className={c === "symbol" || c === "date" || c === "event_date" ? undefined : "col-num"}>
      <span className="charter-th" onClick={() => (sortCol === c ? setSortDesc(!sortDesc) : (setSortCol(c), setSortDesc(true)))}>
        {label}{sortCol === c ? (sortDesc ? " ▼" : " ▲") : ""}
      </span>
    </th>
  );

  return (
    <section>
      <div className="charter-controls">
        <span className="charter-presets">
          <button className={`research-tab${cfg.kind === "catalyst" ? " active" : ""}`} onClick={() => set({ kind: "catalyst" })}>Catalyst</button>
          <button className={`research-tab${cfg.kind === "condition" ? " active" : ""}`} onClick={() => set({ kind: "condition" })}>Condition (formula)</button>
        </span>
        {cfg.kind === "catalyst" && (
          <>
            <select value={cfg.type} onChange={(e) => set({ type: e.target.value })}>
              {Object.entries(typesBySource).map(([src, ts]) => (
                <optgroup key={src} label={SOURCE_LABELS[src] ?? src}>
                  {ts.map((t) => <option key={t.type} value={t.type} title={t.desc}>{t.label} ({t.n.toLocaleString()})</option>)}
                </optgroup>
              ))}
            </select>
            <label className="ops-dim">day 0
              <select value={cfg.align} onChange={(e) => set({ align: e.target.value as EventConfig["align"] })}>
                <option value="entry">first session after the event (as /research)</option>
                <option value="event">session of the event</option>
              </select>
            </label>
          </>
        )}
        <input className="charter-formula" value={cfg.cond} onChange={(e) => set({ cond: e.target.value })} onKeyDown={(e) => e.key === "Enter" && run()}
               placeholder={cfg.kind === "catalyst" ? "optional day-0 condition, e.g. gap > 0" : "e.g. (ret_1 >= 0.3) * (vol_ratio >= 5)   or   change(close, 3) > 0.5"} />
        <button className="link-button charter-run" onClick={run} disabled={loading}>{loading ? "Running…" : "Run"}</button>
        {err && <span className="neg">{err}</span>}
      </div>

      <div className="charter-controls charter-toggles">
        <span className="ops-dim">Events</span>
        <input type="date" value={cfg.start} min="2016-01-04" onChange={(e) => set({ start: e.target.value })} />
        <span className="ops-dim">→</span>
        <input type="date" value={cfg.end} onChange={(e) => set({ end: e.target.value })} />
        <label>window −<input className="charter-num" style={{ width: 50 }} value={cfg.pre} onChange={(e) => set({ pre: n(e.target.value, 20) })} /></label>
        <label>to +<input className="charter-num" style={{ width: 50 }} value={cfg.post} onChange={(e) => set({ post: n(e.target.value, 20) })} /> sessions</label>
        <label title="drop an event if the same stock had one within this many sessions before (keeps the first of each cluster)">
          cooldown <input className="charter-num" style={{ width: 50 }} value={cfg.cooldown} onChange={(e) => set({ cooldown: n(e.target.value, 20) })} />
        </label>
        <label>max events
          <select value={cfg.sample} onChange={(e) => set({ sample: Number(e.target.value) })}>
            {[1000, 5000, 10000, 20000].map((v) => <option key={v} value={v}>{v.toLocaleString()}</option>)}
          </select>
        </label>
        {sealed && <span className="neg">2022+ is the sealed test period — exploring it spends the out-of-sample data.</span>}
      </div>

      <div className="charter-controls charter-toggles">
        <span className="ops-dim">Universe on day 0</span>
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
      </div>

      <div className="charter-controls charter-toggles">
        <span className="ops-dim">Split</span>
        <label>winner = return to day +<input className="charter-num" style={{ width: 44 }} value={cfg.k} onChange={(e) => set({ k: n(e.target.value, 5) })} /></label>
        <label>≥ <input className="charter-num" style={{ width: 60 }} value={cfg.thr} onChange={(e) => set({ thr: n(e.target.value, 0) })} /> (0.05 = 5%)</label>
        <span className="charter-presets">
          {(["mean", "median"] as const).map((v) => (
            <button key={v} className={`research-tab${cfg.stat === v ? " active" : ""}`} onClick={() => set({ stat: v })}>{v}</button>
          ))}
        </span>
        {(["winners", "losers", "control"] as const).map((g) => (
          <label key={g}>
            <input type="checkbox" checked={cfg.show[g]} onChange={(e) => set({ show: { ...cfg.show, [g]: e.target.checked } })} />
            {g === "control" ? "random-date control" : g}
          </label>
        ))}
        <label title="clip each day's values to its 1st–99th percentile before averaging (the /research convention)">
          <input type="checkbox" checked={cfg.wins} onChange={(e) => set({ wins: e.target.checked })} /> winsorize 1/99
        </label>
      </div>

      <div className="charter-controls charter-toggles">
        <span className="ops-dim">Panels</span>
        <span className="charter-chip">{meta.cum_ret.label}</span>
        {cfg.metrics.map((m) => (
          <span key={m} className="charter-chip">
            {meta[m]?.label ?? m}
            <button onClick={() => set({ metrics: cfg.metrics.filter((x) => x !== m) })}>×</button>
          </span>
        ))}
        {cfg.metrics.length < 6 && (
          <select value="" onChange={(e) => e.target.value && !cfg.metrics.includes(e.target.value) && set({ metrics: [...cfg.metrics, e.target.value] })}>
            <option value="">+ add a metric panel…</option>
            {Object.entries(grouped).map(([g, ms]) => (
              <optgroup key={g} label={g}>
                {ms.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </optgroup>
            ))}
          </select>
        )}
        <span className="ops-dim">· settings apply on Run</span>
      </div>

      {res && (
        <div className="ops-panel charter-chart">
          <p className="research-note" style={{ margin: "4px 10px" }}>
            <b>{res.counts.used.toLocaleString()}</b> events
            {res.counts.sampled && ` (sampled from ${res.counts.events.toLocaleString()})`} · {res.counts.candidates.toLocaleString()} matches before the cooldown
            {res.counts.dropped_artifacts > 0 && ` · ${res.counts.dropped_artifacts} dropped (split/reorg artifacts)`}
            {" · "}{res.counts.control.toLocaleString()} control dates
            {elapsed != null && ` · ${elapsed.toFixed(1)}s`}
            <br />
            Day 0 = {res.day0}. Returns are from day 0's close (the entry), split-adjusted, before costs (~1% round trip in this band)
            {res.winsorized ? "; means winsorized 1/99 per day" : ""}.
          </p>
          {s && (
            <table className="ops-table research-table" style={{ margin: "6px 10px", width: "auto" }}>
              <thead>
                <tr><th>Return to day +{s.k}</th><th className="col-num">n</th><th className="col-num">mean</th><th className="col-num">median</th><th className="col-num">% up</th></tr>
              </thead>
              <tbody>
                {([["Events", s.event], ["Random dates, same names", s.control]] as [string, AtK][]).map(([name, a]) => (
                  <tr key={name} className="ops-row">
                    <td>{name}</td>
                    <td className="col-num">{a.n.toLocaleString()}</td>
                    <td className="col-num">{pct(a.mean)}</td>
                    <td className="col-num">{pct(a.median)}</td>
                    <td className="col-num">{a.hit == null ? "—" : `${(a.hit * 100).toFixed(1)}%`}</td>
                  </tr>
                ))}
                {s.diff != null && (
                  <tr className="ops-row">
                    <td><b>Difference (events − control)</b></td>
                    <td />
                    <td className="col-num" colSpan={3}>
                      <b className={s.diff_lo! > 0 ? "pos" : s.diff_hi! < 0 ? "neg" : undefined}>{pct(s.diff)}</b>
                      <span className="ops-dim"> 95% CI {pct(s.diff_lo)} to {pct(s.diff_hi)}</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
          <p className="research-note" style={{ margin: "4px 10px" }}>
            {res.counts.winners.toLocaleString()} winners / {res.counts.losers.toLocaleString()} losers (return to day +{s?.k} ≥ {pct(cfg.thr)}).
            Winners and losers are split on the outcome, so their paths after day 0 diverge by construction — the lead-up (days before 0) is the informative part.
          </p>
        </div>
      )}

      {loading && !res && <p className="empty-state">Running the event study…</p>}
      {charts.map(({ m, option }) => (
        <div key={m} className="ops-panel charter-chart">
          <EChart option={option} height={m === "cum_ret" ? 380 : 260} group="charter-events" />
        </div>
      ))}

      {res && (
        <div className="ops-panel charter-events">
          <div className="charter-subhead">
            <span className="ops-dim">Events ({res.events.rows.toLocaleString()}) — click a row to open it in the deep dive</span>
            <button className="link-button" onClick={exportCsv}>Export CSV</button>
          </div>
          <div className="charter-events-scroll" style={{ maxHeight: 520 }}>
            <table className="ops-table research-table">
              <thead>
                <tr>
                  {th("symbol", "Symbol")}
                  {th("date", "Day 0")}
                  {cfg.kind === "catalyst" && th("event_date", "Event date")}
                  {th("raw_close", "Close")}
                  {th("ret_1", "Day-0 return")}
                  {th("dollar20", "20d $vol")}
                  {th("outcome", `Return to +${s?.k}`)}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 500).map((i, j) => {
                  const d = res.events.data;
                  const out = d.outcome[i] as number | null;
                  return (
                    <tr key={i} className={`ops-row research-row${j % 2 ? " ops-row-alt" : ""}`} onClick={() => onOpenSymbol(d.symbol[i] as string, d.date[i] as string)}>
                      <td><b>{d.symbol[i]}</b></td>
                      <td className="catalyst-date">{d.date[i]}</td>
                      {cfg.kind === "catalyst" && <td className="catalyst-date">{d.event_date[i]}</td>}
                      <td className="col-num">{fmtValue(d.raw_close[i] as number, "price")}</td>
                      <td className="col-num">{pct(d.ret_1[i] as number)}</td>
                      <td className="col-num">{fmtValue(d.dollar20[i] as number, "usd")}</td>
                      <td className={`col-num ${out == null ? "" : out >= cfg.thr ? "pos" : "neg"}`}>{pct(out)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {res.events.rows > 500 && <p className="research-note">Showing 500 of {res.events.rows.toLocaleString()} — export for all.</p>}
          </div>
        </div>
      )}
    </section>
  );
}
