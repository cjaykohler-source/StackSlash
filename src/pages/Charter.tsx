import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ECharts, EChartsOption } from "echarts";
import { AppHeader } from "../components/AppHeader";
import { EChart } from "../components/charter/EChart";
import { supabase } from "../lib/supabaseClient";
import {
  CHARTER_API_URL,
  CharterApiError,
  charterDownloadCsv,
  charterGet,
  fmtValue,
  type Columnar,
  type MetricDef,
} from "../lib/charterApi";
import { evaluateFormula, FormulaError } from "../lib/formula";
import { CrossView, DEFAULT_CROSS, type CrossConfig } from "../components/charter/CrossView";
import { DEFAULT_EVENTS, EventStudyView, type EventConfig } from "../components/charter/EventStudyView";
import { AggregatesView, DEFAULT_AGG, type AggConfig } from "../components/charter/AggregatesView";

/**
 * Charter: an interactive data visualizer over the whole research
 * warehouse (SIP daily + minute bars, catalysts, short data, SEC filings,
 * Reddit), served by the local Charter API: the symbol deep dive (phase 1),
 * the cross-section (phase 2), event studies (phase 3) and aggregates over
 * time (phase 4).
 */

type Tab = "symbol" | "cross" | "events" | "aggregates";
const TABS: [Tab, string, string | null][] = [
  ["symbol", "Symbol deep dive", null],
  ["cross", "Cross-section", null],
  ["events", "Event studies", null],
  ["aggregates", "Aggregates", null],
];

const PRESETS: [string, number | null][] = [
  ["1M", 31], ["3M", 92], ["6M", 183], ["1Y", 365], ["3Y", 1096], ["5Y", 1827], ["All", null],
];
const SMA_CHOICES = [5, 10, 20, 40, 50, 60, 200];
const SMA_COLORS: Record<number, string> = {
  5: "#f5c542", 10: "#f0a020", 20: "#4f8cff", 40: "#9b6bff", 50: "#c86bff", 60: "#ff6bd6", 200: "#e6e9f0",
};
const EVENT_SOURCES: [string, string, string][] = [
  ["edgar", "SEC filings", "#8b93a7"],
  ["news", "News", "#4f8cff"],
  ["earnings", "Earnings", "#2ecc71"],
  ["form4", "Insider (Form 4)", "#f5c542"],
  ["going_concern", "Going concern", "#e74c3c"],
  ["corporate_actions", "Corp. actions", "#c86bff"],
];

interface Formula {
  id: string;
  name: string;
  expr: string;
}
interface Config {
  symbol: string;
  preset: string;
  start: string;
  end: string;
  smas: number[];
  vwap: boolean;
  sources: string[];
  panels: string[];
  formulas: Formula[];
  live: boolean;
  cross: CrossConfig;
  events: EventConfig;
  agg: AggConfig;
}
const DEFAULT: Config = {
  symbol: "VALE",
  preset: "1Y",
  start: "",
  end: "",
  smas: [20, 50, 200],
  vwap: false,
  sources: ["edgar", "news", "earnings", "form4", "going_concern", "corporate_actions"],
  panels: ["volume", "vol_ratio", "short_float"],
  formulas: [],
  live: false,
  cross: DEFAULT_CROSS,
  events: DEFAULT_EVENTS,
  agg: DEFAULT_AGG,
};

interface ShortRes {
  short_interest: Columnar;
  short_volume: Columnar;
}
interface EventsRes extends Columnar {
  headlines: Columnar;
}
interface SymbolHit {
  symbol: string;
  name: string | null;
  first_date: string;
  last_date: string;
  last_close: number;
}
interface SavedView {
  id: number;
  name: string;
  tab: string;
  config: Config;
}

/** A stored config (localStorage or a saved view) may predate newer fields: fill them in. */
function withDefaults(c: Partial<Config>): Config {
  return {
    ...DEFAULT,
    ...c,
    cross: { ...DEFAULT_CROSS, ...(c.cross ?? {}) },
    events: { ...DEFAULT_EVENTS, ...(c.events ?? {}), show: { ...DEFAULT_EVENTS.show, ...(c.events?.show ?? {}) } },
    agg: { ...DEFAULT_AGG, ...(c.agg ?? {}) },
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function rangeOf(cfg: Config): { start: string; end: string } {
  if (cfg.preset === "custom") return { start: cfg.start, end: cfg.end };
  const end = new Date();
  const days = PRESETS.find(([p]) => p === cfg.preset)?.[1];
  const start = days == null ? new Date("2016-01-01") : new Date(end.getTime() - days * 86_400_000);
  return { start: iso(start), end: iso(end) };
}

/** Forward-fill a dated step series (e.g. twice-monthly short interest) onto daily dates. */
function alignStep(dates: string[], stepDates: (string | null)[], values: (number | null)[]): (number | null)[] {
  const out: (number | null)[] = [];
  let j = -1;
  for (const d of dates) {
    while (j + 1 < stepDates.length && (stepDates[j + 1] ?? "") <= d) j++;
    out.push(j >= 0 ? values[j] : null);
  }
  return out;
}

export function Charter() {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const t = localStorage.getItem("charter.tab") as Tab | null;
      return t && TABS.some(([x]) => x === t) ? t : "symbol";
    } catch {
      return "symbol";
    }
  });
  const [cfg, setCfg] = useState<Config>(() => {
    try {
      const s = localStorage.getItem("charter.last");
      const c = s ? JSON.parse(s) : {};
      return withDefaults(c);
    } catch {
      return DEFAULT;
    }
  });
  const [catalog, setCatalog] = useState<MetricDef[]>([]);
  const [apiError, setApiError] = useState<string | null>(null);

  // from the cross-section: open a stock in the deep dive, ~3 months before to 1 month after that day
  const openSymbol = useCallback(
    (symbol: string, date: string) => {
      const d = new Date(date);
      const start = new Date(d.getTime() - 92 * 86_400_000).toISOString().slice(0, 10);
      const end = new Date(Math.min(Date.now(), d.getTime() + 31 * 86_400_000)).toISOString().slice(0, 10);
      setCfg((c) => ({ ...c, symbol, preset: "custom", start, end }));
      setTab("symbol");
      window.scrollTo(0, 0);
    },
    [],
  );

  useEffect(() => {
    try {
      localStorage.setItem("charter.last", JSON.stringify(cfg));
      localStorage.setItem("charter.tab", tab);
    } catch {
      /* private mode: fine */
    }
  }, [cfg, tab]);

  useEffect(() => {
    charterGet<{ metrics: MetricDef[] }>("/catalog")
      .then((r) => {
        setCatalog(r.metrics);
        setApiError(null);
      })
      .catch((e: CharterApiError) => setApiError(e.message));
  }, []);

  return (
    <div className="page charter-page">
      <AppHeader />
      <nav className="research-tabs">
        {TABS.map(([t, label, phase]) => (
          <button
            key={t}
            className={`research-tab${tab === t ? " active" : ""}`}
            onClick={() => setTab(t)}
            title={phase ? `Coming in ${phase}` : undefined}
          >
            {label}
            {phase && <span className="charter-phase"> · {phase}</span>}
          </button>
        ))}
        <SavedViews
          cfg={cfg}
          tab={tab}
          onLoad={(c, t) => {
            setCfg(withDefaults(c));
            if (TABS.some(([x]) => x === t)) setTab(t as Tab);
          }}
        />
      </nav>
      {apiError && (
        <div className="ops-banner ops-banner-bad">
          {apiError}
        </div>
      )}
      {tab === "symbol" ? (
        <SymbolView cfg={cfg} setCfg={setCfg} catalog={catalog} onApiError={setApiError} />
      ) : tab === "cross" ? (
        <CrossView
          cfg={cfg.cross}
          set={(p) => setCfg({ ...cfg, cross: { ...cfg.cross, ...p } })}
          catalog={catalog}
          onApiError={setApiError}
          onOpenSymbol={openSymbol}
        />
      ) : tab === "events" ? (
        <EventStudyView
          cfg={cfg.events}
          set={(p) => setCfg((c) => ({ ...c, events: { ...c.events, ...p } }))}
          catalog={catalog}
          onApiError={setApiError}
          onOpenSymbol={openSymbol}
        />
      ) : (
        <AggregatesView
          cfg={cfg.agg}
          set={(p) => setCfg((c) => ({ ...c, agg: { ...c.agg, ...p } }))}
          onApiError={setApiError}
        />
      )}
      <p className="research-note">
        Data: local research warehouse via the Charter API ({CHARTER_API_URL}). SIP data updates nightly around 20:30 ET;
        the live panel is IEX and is never merged into the SIP series.
      </p>
    </div>
  );
}

function SavedViews({ cfg, tab, onLoad }: { cfg: Config; tab: Tab; onLoad: (c: Config, tab: string) => void }) {
  const [views, setViews] = useState<SavedView[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    supabase
      .from("charter_views")
      .select("id, name, tab, config")
      .order("name")
      .then(({ data, error }) => {
        if (error) setMsg(error.message);
        else setViews((data ?? []) as SavedView[]);
      });
  }, []);
  useEffect(load, [load]);

  async function save() {
    const name = window.prompt("Save this view as:");
    if (!name?.trim()) return;
    const existing = views.find((v) => v.name === name.trim());
    const row = { name: name.trim(), tab, config: cfg, updated_at: new Date().toISOString() };
    const { error } = existing
      ? await supabase.from("charter_views").update(row).eq("id", existing.id)
      : await supabase.from("charter_views").insert(row);
    setMsg(error ? error.message : `Saved "${name.trim()}"`);
    load();
  }
  async function remove(v: SavedView) {
    if (!window.confirm(`Delete saved view "${v.name}"?`)) return;
    await supabase.from("charter_views").delete().eq("id", v.id);
    load();
  }

  return (
    <div className="charter-views">
      <select
        value=""
        onChange={(e) => {
          const v = views.find((x) => String(x.id) === e.target.value);
          if (v) onLoad(v.config, v.tab);
        }}
      >
        <option value="">Saved views ({views.length})</option>
        {views.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
      <button className="link-button" onClick={save}>
        Save view
      </button>
      {views.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            const v = views.find((x) => String(x.id) === e.target.value);
            if (v) remove(v);
          }}
          title="Delete a saved view"
        >
          <option value="">Delete…</option>
          {views.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      )}
      {msg && <span className="charter-msg">{msg}</span>}
    </div>
  );
}

function SymbolSearchBox({ value, onPick }: { value: string; onPick: (s: string) => void }) {
  const [q, setQ] = useState(value);
  const [hits, setHits] = useState<SymbolHit[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => setQ(value), [value]);
  useEffect(() => {
    if (!open || q.trim().length < 1) return;
    const t = setTimeout(() => {
      charterGet<{ symbols: SymbolHit[] }>("/symbols", { q: q.trim(), limit: "12" })
        .then((r) => setHits(r.symbols))
        .catch(() => setHits([]));
    }, 150);
    return () => clearTimeout(t);
  }, [q, open]);
  return (
    <div className="charter-search">
      <input
        value={q}
        placeholder="Symbol or company"
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => setQ(e.target.value.toUpperCase())}
        onKeyDown={(e) => {
          if (e.key === "Enter" && q.trim()) {
            onPick((hits[0]?.symbol ?? q).trim());
            setOpen(false);
          }
        }}
      />
      {open && hits.length > 0 && (
        <ul className="charter-search-hits">
          {hits.map((h) => (
            <li key={h.symbol} onMouseDown={() => onPick(h.symbol)}>
              <b>{h.symbol}</b> <span className="ops-dim">{h.name ?? ""}</span>
              <span className="ops-dim charter-hit-range">
                {h.first_date.slice(0, 4)}–{h.last_date.slice(0, 7)} · ${h.last_close?.toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ symbol view

interface Loaded {
  daily: Columnar;
  events: EventsRes;
  short: ShortRes;
  fundamentals: Columnar;
  reddit: Columnar;
}

/** Extra panel metrics that come from non-daily endpoints, aligned onto daily dates. */
const SERIES_PANELS: Record<string, string> = {
  short_interest: "Short interest",
  short_float: "Short float",
  days_to_cover: "Days to cover",
  short_volume_ratio: "Short volume ratio",
  shares_outstanding: "Shares outstanding",
  public_float: "Public float ($)",
  cash: "Cash",
  operating_cash_flow: "Operating cash flow",
  reddit_mentions: "Reddit mentions (24h)",
  reddit_upvotes: "Reddit upvotes (24h)",
};

function SymbolView({
  cfg,
  setCfg,
  catalog,
  onApiError,
}: {
  cfg: Config;
  setCfg: (c: Config) => void;
  catalog: MetricDef[];
  onApiError: (m: string | null) => void;
}) {
  const [data, setData] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [minuteDate, setMinuteDate] = useState<string | null>(null);
  const [addPanel, setAddPanel] = useState("");
  const [formulaDraft, setFormulaDraft] = useState({ name: "", expr: "" });
  const [formulaErr, setFormulaErr] = useState<string | null>(null);
  const { start, end } = rangeOf(cfg);
  const set = (p: Partial<Config>) => setCfg({ ...cfg, ...p });
  const byId = useMemo(() => Object.fromEntries(catalog.map((m) => [m.id, m])), [catalog]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const p = { symbol: cfg.symbol, start, end };
    Promise.all([
      charterGet<Columnar>("/daily", p),
      charterGet<EventsRes>("/events", p),
      charterGet<ShortRes>("/short", p),
      charterGet<Columnar>("/fundamentals", { symbol: cfg.symbol }),
      charterGet<Columnar>("/reddit", p),
    ])
      .then(([daily, events, short, fundamentals, reddit]) => {
        if (cancelled) return;
        setData({ daily, events, short, fundamentals, reddit });
        onApiError(null);
      })
      .catch((e: CharterApiError) => !cancelled && onApiError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [cfg.symbol, start, end, onApiError]);

  // every panel-able series aligned onto the daily dates
  const cols = useMemo(() => {
    if (!data) return null;
    const d = data.daily.data;
    const dates = d.date as string[];
    const c: Record<string, (number | null)[]> = {};
    for (const k of data.daily.columns) if (k !== "date") c[k] = d[k] as (number | null)[];
    const si = data.short.short_interest.data;
    if (data.short.short_interest.rows) {
      // FINRA publishes ~8 business days after settlement: align on the approximate publication date
      const pub = si.published_approx as string[];
      for (const k of ["short_interest", "short_float", "days_to_cover"]) c[k] = alignStep(dates, pub, si[k] as (number | null)[]);
    } else for (const k of ["short_interest", "short_float", "days_to_cover"]) c[k] = dates.map(() => null);
    const sv = data.short.short_volume.data;
    c.short_volume_ratio = data.short.short_volume.rows
      ? alignStep(dates, sv.date as string[], sv.short_volume_ratio as (number | null)[])
      : dates.map(() => null);
    const f = data.fundamentals.data;
    for (const k of ["shares_outstanding", "public_float", "cash", "operating_cash_flow"]) {
      const idx = (f.metric ?? []).map((m, i) => (m === k ? i : -1)).filter((i) => i >= 0);
      c[k] = alignStep(dates, idx.map((i) => f.filed[i] as string), idx.map((i) => f.value[i] as number));
    }
    const r = data.reddit.data;
    const mentions: Record<string, number> = {};
    const upv: Record<string, number> = {};
    for (let i = 0; i < data.reddit.rows; i++) {
      const dd = r.date[i] as string;
      mentions[dd] = (mentions[dd] ?? 0) + ((r.mentions[i] as number) ?? 0);
      upv[dd] = (upv[dd] ?? 0) + ((r.upvotes[i] as number) ?? 0);
    }
    c.reddit_mentions = dates.map((dd) => mentions[dd] ?? null);
    c.reddit_upvotes = dates.map((dd) => upv[dd] ?? null);
    for (const fm of cfg.formulas) {
      try {
        c[fm.id] = evaluateFormula(fm.expr, c);
      } catch {
        c[fm.id] = dates.map(() => null);
      }
    }
    return { dates, c };
  }, [data, cfg.formulas]);

  const panelLabel = (id: string) =>
    cfg.formulas.find((f) => f.id === id)?.name ?? byId[id]?.label ?? SERIES_PANELS[id] ?? id;
  const panelUnit = (id: string): MetricDef["unit"] | undefined =>
    byId[id]?.unit ?? (["short_float", "short_volume_ratio"].includes(id) ? "pct" : ["short_interest", "shares_outstanding"].includes(id) ? "shares" : ["public_float", "cash", "operating_cash_flow"].includes(id) ? "usd" : ["reddit_mentions", "reddit_upvotes"].includes(id) ? "count" : undefined);

  const option = useMemo<EChartsOption | null>(() => {
    if (!cols || !data) return null;
    const { dates, c } = cols;
    const panels = cfg.panels.filter((p) => p in c);
    const PRICE_H = 360, PANEL_H = 110, GAP = 28, TOP = 36;
    const grids = [{ left: 64, right: 24, top: TOP, height: PRICE_H }];
    panels.forEach((_, i) => grids.push({ left: 64, right: 24, top: TOP + PRICE_H + GAP + i * (PANEL_H + GAP), height: PANEL_H }));
    const xAxis = grids.map((_, i) => ({
      type: "category" as const,
      data: dates,
      gridIndex: i,
      boundaryGap: true,
      axisLabel: { show: i === grids.length - 1, color: "#8b93a7" },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: "#2a3142" } },
      axisPointer: { label: { show: i === grids.length - 1 } },
    }));
    const yAxis = grids.map((_, i) => ({
      type: "value" as const,
      gridIndex: i,
      scale: true,
      splitNumber: i === 0 ? 5 : 2,
      axisLabel: {
        color: "#8b93a7",
        formatter: (v: number) => (i === 0 ? fmtValue(v, "price") : fmtValue(v, panelUnit(panels[i - 1]))),
      },
      splitLine: { lineStyle: { color: "#1c2230" } },
      name: i === 0 ? cfg.symbol : panelLabel(panels[i - 1]),
      nameLocation: "end" as const,
      nameTextStyle: { color: "#8b93a7", align: "left" as const, padding: [0, 0, 0, -56] },
    }));
    const series: EChartsOption["series"] = [
      {
        type: "candlestick",
        name: cfg.symbol,
        data: dates.map((_, i) => [c.open[i], c.close[i], c.low[i], c.high[i]]),
        itemStyle: { color: "#2ecc71", color0: "#e74c3c", borderColor: "#2ecc71", borderColor0: "#e74c3c" },
      },
      ...cfg.smas.map((k) => ({
        type: "line" as const,
        name: `SMA ${k}`,
        data: c[`sma${k}`],
        showSymbol: false,
        lineStyle: { width: 1.2, color: SMA_COLORS[k] },
        itemStyle: { color: SMA_COLORS[k] },
      })),
    ];
    if (cfg.vwap)
      series.push({ type: "line", name: "VWAP", data: c.vwap, showSymbol: false, lineStyle: { width: 1, type: "dotted", color: "#f0a020" } });
    // event markers: one dot per source per day, above the high
    const ev = data.events.data;
    for (const [src, label, color] of EVENT_SOURCES) {
      if (!cfg.sources.includes(src)) continue;
      const byDay: Record<string, string[]> = {};
      for (let i = 0; i < data.events.rows; i++)
        if (ev.source[i] === src) (byDay[ev.date[i] as string] ??= []).push(`${ev.label[i]}${ev.detail[i] ? " — " + String(ev.detail[i]).slice(0, 90) : ""}`);
      const pts = dates
        .map((d, i) => (byDay[d] ? { value: [i, (c.high[i] as number) * 1.04], names: byDay[d] } : null))
        .filter(Boolean);
      if (pts.length)
        series.push({
          type: "scatter",
          name: label,
          data: pts as never,
          symbolSize: 7,
          itemStyle: { color },
          tooltip: {
            trigger: "item",
            formatter: (p: unknown) => {
              const pp = p as { data: { value: number[]; names: string[] } };
              return `<b>${label}</b> · ${dates[pp.data.value[0]]}<br/>${pp.data.names.join("<br/>")}`;
            },
          },
        });
    }
    panels.forEach((pid, i) => {
      const gi = i + 1;
      if (pid === "volume") {
        series.push({
          type: "bar",
          name: "Volume",
          xAxisIndex: gi,
          yAxisIndex: gi,
          data: dates.map((_, j) => ({ value: c.volume[j], itemStyle: { color: (c.close[j] ?? 0) >= (c.open[j] ?? 0) ? "#2ecc7199" : "#e74c3c99" } })),
        });
      } else {
        series.push({
          type: "line",
          name: panelLabel(pid),
          xAxisIndex: gi,
          yAxisIndex: gi,
          data: c[pid],
          showSymbol: false,
          step: ["short_interest", "short_float", "days_to_cover", "shares_outstanding", "public_float", "cash", "operating_cash_flow"].includes(pid) ? "end" : undefined,
          lineStyle: { width: 1.3, color: "#4f8cff" },
          areaStyle: { color: "rgba(79,140,255,0.08)" },
          connectNulls: false,
        });
      }
    });
    const allX = grids.map((_, i) => i);
    return {
      backgroundColor: "transparent",
      animation: false,
      legend: { top: 0, left: 64, textStyle: { color: "#8b93a7" }, data: series.filter((s) => s && (s as { xAxisIndex?: number }).xAxisIndex === undefined).map((s) => (s as { name: string }).name) },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross", link: [{ xAxisIndex: "all" }] },
        backgroundColor: "#131722",
        borderColor: "#2a3142",
        textStyle: { color: "#e6e9f0", fontSize: 12 },
        formatter: (ps: unknown) => {
          const arr = ps as { dataIndex: number }[];
          const i = arr[0]?.dataIndex ?? 0;
          const lines = [
            `<b>${cfg.symbol}</b> ${dates[i]} · <span style="color:#8b93a7">click for this day's minute chart</span>`,
            `O ${fmtValue(c.open[i], "price")} H ${fmtValue(c.high[i], "price")} L ${fmtValue(c.low[i], "price")} C ${fmtValue(c.close[i], "price")} · VWAP ${fmtValue(c.vwap[i], "price")}`,
            `Vol ${fmtValue(c.volume[i], "shares")} (${fmtValue(c.vol_ratio[i], "ratio")}x avg) · day ${fmtValue(c.ret_1[i], "pct")} · gap ${fmtValue(c.gap[i], "pct")} · body ${fmtValue(c.body[i], "pct")}`,
            ...panels.filter((p) => p !== "volume").map((p) => `${panelLabel(p)}: ${fmtValue(c[p][i], panelUnit(p))}`),
          ];
          return lines.join("<br/>");
        },
      },
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      grid: grids,
      xAxis,
      yAxis,
      dataZoom: [
        { type: "inside", xAxisIndex: allX, start: 0, end: 100 },
        { type: "slider", xAxisIndex: allX, bottom: 4, height: 18, borderColor: "#2a3142", textStyle: { color: "#8b93a7" } },
      ],
      series,
    };
  }, [cols, data, cfg.panels, cfg.smas, cfg.vwap, cfg.sources, cfg.symbol, cfg.formulas, byId]);

  const chartHeight = 36 + 360 + cfg.panels.length * (110 + 28) + 60;
  // click anywhere in the price chart -> the minute chart for the day under the cursor
  const datesRef = useRef<string[]>([]);
  datesRef.current = cols?.dates ?? [];
  const onReady = useCallback((chart: ECharts) => {
    chart.getZr().on("click", (e: { offsetX: number; offsetY: number }) => {
      const pt = [e.offsetX, e.offsetY];
      if (!chart.containPixel({ gridIndex: 0 }, pt)) return;
      // convert against the price grid: returns [x value (category index), y value]
      const conv = chart.convertFromPixel({ gridIndex: 0 }, pt) as unknown as number[];
      const idx = Math.round(conv?.[0]);
      const d = datesRef.current[idx];
      if (d) setMinuteDate(d);
    });
  }, []);

  function addFormula() {
    setFormulaErr(null);
    if (!formulaDraft.expr.trim() || !cols) return;
    try {
      evaluateFormula(formulaDraft.expr, cols.c);
    } catch (e) {
      setFormulaErr(e instanceof FormulaError ? e.message : String(e));
      return;
    }
    const id = `f_${Date.now().toString(36)}`;
    const name = formulaDraft.name.trim() || formulaDraft.expr.trim();
    set({ formulas: [...cfg.formulas, { id, name, expr: formulaDraft.expr.trim() }], panels: [...cfg.panels, id] });
    setFormulaDraft({ name: "", expr: "" });
  }

  const groups = useMemo(() => {
    const g: Record<string, { id: string; label: string }[]> = {};
    for (const m of catalog) if (m.kind === "daily" && !["open", "high", "low", "close"].includes(m.id)) (g[m.group] ??= []).push({ id: m.id, label: m.label });
    g["Short / fundamentals / attention"] = Object.entries(SERIES_PANELS).map(([id, label]) => ({ id, label }));
    if (cfg.formulas.length) g["My formulas"] = cfg.formulas.map((f) => ({ id: f.id, label: f.name }));
    return g;
  }, [catalog, cfg.formulas]);

  function exportChartCsv() {
    if (!cols) return;
    const keys = ["date", ...Object.keys(cols.c)];
    const lines = [keys.join(",")];
    cols.dates.forEach((d, i) => lines.push([d, ...Object.keys(cols.c).map((k) => cols.c[k][i] ?? "")].join(",")));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    a.download = `charter_${cfg.symbol}_${start}_${end}.csv`;
    a.click();
  }

  return (
    <section>
      <div className="charter-controls">
        <SymbolSearchBox value={cfg.symbol} onPick={(s) => { set({ symbol: s }); setMinuteDate(null); }} />
        <div className="charter-presets">
          {PRESETS.map(([p]) => (
            <button key={p} className={`research-tab${cfg.preset === p ? " active" : ""}`} onClick={() => set({ preset: p })}>
              {p}
            </button>
          ))}
          <input type="date" value={cfg.preset === "custom" ? cfg.start : start} min="2016-01-01"
                 onChange={(e) => set({ preset: "custom", start: e.target.value, end: cfg.preset === "custom" ? cfg.end : end })} />
          <span className="ops-dim">→</span>
          <input type="date" value={cfg.preset === "custom" ? cfg.end : end}
                 onChange={(e) => set({ preset: "custom", end: e.target.value, start: cfg.preset === "custom" ? cfg.start : start })} />
        </div>
      </div>

      <div className="charter-controls charter-toggles">
        <span className="ops-dim">SMA</span>
        {SMA_CHOICES.map((k) => (
          <label key={k} style={{ color: SMA_COLORS[k] }}>
            <input type="checkbox" checked={cfg.smas.includes(k)}
                   onChange={(e) => set({ smas: e.target.checked ? [...cfg.smas, k].sort((a, b) => a - b) : cfg.smas.filter((x) => x !== k) })} />
            {k}
          </label>
        ))}
        <label>
          <input type="checkbox" checked={cfg.vwap} onChange={(e) => set({ vwap: e.target.checked })} /> VWAP
        </label>
        <span className="ops-dim">· Markers</span>
        {EVENT_SOURCES.map(([src, label, color]) => (
          <label key={src} style={{ color }}>
            <input type="checkbox" checked={cfg.sources.includes(src)}
                   onChange={(e) => set({ sources: e.target.checked ? [...cfg.sources, src] : cfg.sources.filter((x) => x !== src) })} />
            {label}
          </label>
        ))}
      </div>

      <div className="charter-controls charter-toggles">
        <span className="ops-dim">Panels</span>
        {cfg.panels.map((p) => (
          <span key={p} className="charter-chip">
            {panelLabel(p)}
            <button onClick={() => set({ panels: cfg.panels.filter((x) => x !== p) })} title="Remove panel">×</button>
          </span>
        ))}
        <select value={addPanel} onChange={(e) => { if (e.target.value) set({ panels: [...cfg.panels, e.target.value] }); setAddPanel(""); }}>
          <option value="">+ Add panel…</option>
          <option value="volume">Volume (bars)</option>
          {Object.entries(groups).map(([g, items]) => (
            <optgroup key={g} label={g}>
              {items.filter((it) => !cfg.panels.includes(it.id)).map((it) => (
                <option key={it.id} value={it.id}>{it.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="charter-controls charter-toggles">
        <span className="ops-dim">Formula</span>
        <input className="charter-formula-name" placeholder="name (optional)" value={formulaDraft.name}
               onChange={(e) => setFormulaDraft({ ...formulaDraft, name: e.target.value })} />
        <input className="charter-formula" placeholder="e.g. vol_ratio * (close > sma20)   or   change(short_float, 10)"
               value={formulaDraft.expr} onChange={(e) => setFormulaDraft({ ...formulaDraft, expr: e.target.value })}
               onKeyDown={(e) => e.key === "Enter" && addFormula()} />
        <button className="link-button" onClick={addFormula}>Add as panel</button>
        {formulaErr && <span className="neg">{formulaErr}</span>}
        {cfg.formulas.length > 0 && (
          <span className="ops-dim">
            {cfg.formulas.map((f) => (
              <span key={f.id} className="charter-chip" title={f.expr}>
                ƒ {f.name}
                <button onClick={() => set({ formulas: cfg.formulas.filter((x) => x.id !== f.id), panels: cfg.panels.filter((x) => x !== f.id) })}>×</button>
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="ops-panel charter-chart">
        {loading && !option && <p className="empty-state">Loading {cfg.symbol}…</p>}
        {option && cols && cols.dates.length > 0 && <EChart option={option} height={chartHeight} onReady={onReady} />}
        {cols && cols.dates.length === 0 && !loading && <p className="empty-state">No SIP bars for {cfg.symbol} in this range.</p>}
      </div>

      <div className="charter-controls charter-toggles">
        <span className="ops-dim">Export</span>
        <button className="link-button" onClick={exportChartCsv} disabled={!cols}>Chart data (incl. formulas) CSV</button>
        <button className="link-button" onClick={() => charterDownloadCsv("/daily", { symbol: cfg.symbol, start, end }, `daily_${cfg.symbol}.csv`)}>Daily CSV</button>
        <button className="link-button" onClick={() => charterDownloadCsv("/events", { symbol: cfg.symbol, start, end }, `events_${cfg.symbol}.csv`)}>Events CSV</button>
        <button className="link-button" onClick={() => charterDownloadCsv("/fundamentals", { symbol: cfg.symbol }, `fundamentals_${cfg.symbol}.csv`)}>Filings CSV</button>
        <label>
          <input type="checkbox" checked={cfg.live} onChange={(e) => set({ live: e.target.checked })} /> Show today's live IEX panel
        </label>
      </div>

      {minuteDate && <MinutePanel symbol={cfg.symbol} date={minuteDate} onClose={() => setMinuteDate(null)} />}
      {cfg.live && <LivePanel symbol={cfg.symbol} />}
      {data && <EventsTable events={data.events} sources={cfg.sources} />}
    </section>
  );
}

function intradayOption(title: string, ts: string[], o: number[], h: number[], l: number[], c: number[], v: number[], vw: (number | null)[]): EChartsOption {
  // session VWAP from the regular session (09:30-16:00 ET) minutes: cumulative typical price x volume
  let pv = 0, vv = 0;
  const sessVwap = ts.map((t, i) => {
    const hm = t.slice(11, 16);
    if (hm < "09:30" || hm >= "16:00") return null;
    pv += ((h[i] + l[i] + c[i]) / 3) * v[i];
    vv += v[i];
    return vv ? pv / vv : null;
  });
  const labels = ts.map((t) => t.slice(11, 16));
  const pre = labels.findIndex((x) => x >= "09:30");
  const post = labels.findIndex((x) => x >= "16:00");
  void vw;
  return {
    backgroundColor: "transparent",
    animation: false,
    title: { text: title, left: 64, textStyle: { color: "#e6e9f0", fontSize: 13 } },
    tooltip: { trigger: "axis", axisPointer: { type: "cross" }, backgroundColor: "#131722", borderColor: "#2a3142", textStyle: { color: "#e6e9f0" } },
    axisPointer: { link: [{ xAxisIndex: "all" }] },
    grid: [{ left: 64, right: 24, top: 36, height: 240 }, { left: 64, right: 24, top: 300, height: 80 }],
    xAxis: [0, 1].map((i) => ({ type: "category" as const, data: labels, gridIndex: i, axisLabel: { show: i === 1, color: "#8b93a7" }, axisLine: { lineStyle: { color: "#2a3142" } } })),
    yAxis: [0, 1].map((i) => ({ type: "value" as const, gridIndex: i, scale: true, splitNumber: i ? 2 : 5, axisLabel: { color: "#8b93a7" }, splitLine: { lineStyle: { color: "#1c2230" } } })),
    dataZoom: [{ type: "inside", xAxisIndex: [0, 1] }, { type: "slider", xAxisIndex: [0, 1], bottom: 4, height: 16 }],
    series: [
      {
        type: "candlestick",
        name: "1-min",
        data: ts.map((_, i) => [o[i], c[i], l[i], h[i]]),
        itemStyle: { color: "#2ecc71", color0: "#e74c3c", borderColor: "#2ecc71", borderColor0: "#e74c3c" },
        markArea: pre > 0 || post > 0 ? {
          itemStyle: { color: "rgba(255,255,255,0.035)" },
          data: [
            ...(pre > 0 ? [[{ xAxis: labels[0] }, { xAxis: labels[pre - 1] }]] : []),
            ...(post > 0 ? [[{ xAxis: labels[post] }, { xAxis: labels[labels.length - 1] }]] : []),
          ] as never,
        } : undefined,
      },
      { type: "line", name: "Session VWAP", data: sessVwap, showSymbol: false, lineStyle: { color: "#f0a020", width: 1.3 } },
      { type: "bar", name: "Volume", xAxisIndex: 1, yAxisIndex: 1, data: v.map((x, i) => ({ value: x, itemStyle: { color: c[i] >= o[i] ? "#2ecc7199" : "#e74c3c99" } })) },
    ],
  };
}

function MinutePanel({ symbol, date, onClose }: { symbol: string; date: string; onClose: () => void }) {
  const [res, setRes] = useState<(Columnar & { note?: string }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setRes(null);
    setErr(null);
    charterGet<Columnar & { note?: string }>("/minute", { symbol, date }).then(setRes).catch((e: CharterApiError) => setErr(e.message));
  }, [symbol, date]);
  const option = useMemo(() => {
    if (!res || !res.rows) return null;
    const d = res.data;
    return intradayOption(`${symbol} · ${date} · SIP 1-minute (pre/post market shaded)`, d.ts_et as string[], d.open as number[], d.high as number[], d.low as number[], d.close as number[], d.volume as number[], d.vwap as number[]);
  }, [res, symbol, date]);
  return (
    <div className="ops-panel charter-chart">
      <div className="charter-subhead">
        <b>Minute bars · {date}</b>
        <span>
          <button className="link-button" onClick={() => charterDownloadCsv("/minute", { symbol, date }, `minute_${symbol}_${date}.csv`)}>CSV</button>{" "}
          <button className="link-button" onClick={onClose}>Close</button>
        </span>
      </div>
      {err && <p className="neg">{err}</p>}
      {!res && !err && <p className="empty-state">Loading minute bars…</p>}
      {res && !res.rows && <p className="empty-state">{res.note ?? "No minute bars for this day."}</p>}
      {option && <EChart option={option} height={410} />}
    </div>
  );
}

function LivePanel({ symbol }: { symbol: string }) {
  const [res, setRes] = useState<(Columnar & { feed: string }) | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      charterGet<Columnar & { feed: string }>("/live", { symbol })
        .then((r) => alive && setRes(r))
        .catch((e: CharterApiError) => alive && setErr(e.message));
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [symbol]);
  const option = useMemo(() => {
    if (!res || !res.rows) return null;
    const d = res.data;
    const ts = (d.ts as string[]).map((t) => new Date(t).toLocaleString("sv-SE", { timeZone: "America/New_York" }).replace(" ", "T"));
    return intradayOption(`${symbol} · TODAY · IEX live (partial volume — separate from SIP)`, ts, d.open as number[], d.high as number[], d.low as number[], d.close as number[], d.volume as number[], d.vwap as number[]);
  }, [res, symbol]);
  return (
    <div className="ops-panel charter-chart charter-live">
      <div className="charter-subhead">
        <b>Live today · IEX</b>
        <span className="ops-dim">refreshes every minute · {res?.feed}</span>
      </div>
      {err && <p className="neg">{err}</p>}
      {res && !res.rows && <p className="empty-state">No IEX trades yet today.</p>}
      {option && <EChart option={option} height={410} />}
    </div>
  );
}

function EventsTable({ events, sources }: { events: EventsRes; sources: string[] }) {
  const [show, setShow] = useState<"events" | "headlines">("events");
  const d = events.data;
  const rows = [...Array(events.rows).keys()].filter((i) => sources.includes(d.source[i] as string)).reverse();
  const h = events.headlines;
  return (
    <div className="ops-panel charter-events">
      <div className="charter-subhead">
        <span>
          <button className={`research-tab${show === "events" ? " active" : ""}`} onClick={() => setShow("events")}>
            Catalysts & filings ({rows.length})
          </button>{" "}
          <button className={`research-tab${show === "headlines" ? " active" : ""}`} onClick={() => setShow("headlines")}>
            All headlines ({h.rows})
          </button>
        </span>
      </div>
      <div className="charter-events-scroll">
        <table className="ops-table research-table">
          <tbody>
            {show === "events"
              ? rows.map((i, k) => (
                  <tr key={i} className={`ops-row${k % 2 ? " ops-row-alt" : ""}`}>
                    <td className="catalyst-date">{d.date[i]}</td>
                    <td>{d.label[i]}</td>
                    <td className="ops-dim">{d.source[i]}</td>
                    <td className="catalyst-detail">{d.detail[i]}</td>
                  </tr>
                ))
              : [...Array(h.rows).keys()].reverse().map((i, k) => (
                  <tr key={i} className={`ops-row${k % 2 ? " ops-row-alt" : ""}`}>
                    <td className="catalyst-date">{h.data.date[i]}</td>
                    <td>{h.data.headline[i]}</td>
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
