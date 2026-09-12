import { useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { triggerLabel } from "../lib/triggerInfo";
import { TriggerFeed } from "../components/TriggerFeed";
import { BrandHomeLink } from "../components/BrandHomeLink";

interface RawEvent {
  symbol_id: number;
  trigger_id: number;
  priority: "normal" | "high" | null;
  snapshot: {
    confluence?: { count: number; direction: "long" | "short"; triggers: { name: string | null }[] } | null;
  } | null;
  symbols: { ticker: string } | null;
  triggers: { name: string } | null;
}

interface TriggerBreakdown {
  triggerId: number;
  name: string;
  count: number;
  winRate: number | null;
  avgReturn: number | null;
  sampleSize: number;
  meanExclTop1pct: number | null;
  top1pctProfitShare: number | null;
}

interface ConfluentSymbol {
  ticker: string;
  triggerNames: string[];
  highPriority: boolean;
}

interface ReportData {
  date: string;
  regimeText: string | null;
  riskOn: boolean | null;
  totalFires: number;
  distinctSymbols: number;
  distinctTriggers: number;
  confluent: ConfluentSymbol[];
  triggers: TriggerBreakdown[];
}

// Real theme colors from src/index.css — kept as plain hex here since
// canvas drawing can't read CSS custom properties directly.
const COLORS = {
  bg: "#010e1f",
  panel: "#131722",
  border: "#2a3142",
  text: "#e6e9f0",
  textDim: "#8b93a7",
  green: "#2ecc71",
  brandGreen: "#25e979",
  red: "#e74c3c",
};

const WIDTH = 1200;
const MARGIN = 48;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function pct(v: number, decimals = 0): string {
  return `${(v * 100).toFixed(decimals)}%`;
}

/**
 * Manual Canvas API drawing rather than a DOM-to-image library
 * (html2canvas/dom-to-image): the report is structured text/stats, no
 * charts, well within what fillText/fillRect can lay out directly —
 * avoids a new dependency and those libraries' known font/gradient
 * fidelity quirks, and gives exact control over matching the app's real
 * dark-theme colors instead of hoping a screenshot approximates them.
 *
 * Height is computed up front from the same row-by-row layout the draw
 * pass uses, so a quiet day and a busy day both render cleanly — no
 * wasted blank space, nothing clipped.
 */
function measureAndDraw(canvas: HTMLCanvasElement, data: ReportData) {
  const rowH = 28;
  const sectionGapH = 36;

  let height = MARGIN; // top margin
  height += 56; // title
  height += 34; // date
  height += 40; // regime line
  height += 56; // stats row
  height += sectionGapH;
  height += 32; // "Confluence" heading
  height += Math.max(1, data.confluent.length) * rowH;
  height += sectionGapH;
  height += 32; // "Triggers fired" heading
  height += Math.max(1, data.triggers.length) * (rowH * 2);
  height += sectionGapH;
  height += 24; // footer
  height += MARGIN;

  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  let y = MARGIN;

  // Background
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, WIDTH, height);

  // Title
  ctx.fillStyle = COLORS.brandGreen;
  ctx.font = "bold 32px -apple-system, Helvetica, Arial, sans-serif";
  ctx.fillText("STACKSLASH", MARGIN, y + 28);
  ctx.fillStyle = COLORS.text;
  ctx.font = "22px -apple-system, Helvetica, Arial, sans-serif";
  ctx.fillText("Daily Performance Report", MARGIN + 230, y + 24);
  y += 56;

  // Date
  ctx.fillStyle = COLORS.textDim;
  ctx.font = "16px -apple-system, Helvetica, Arial, sans-serif";
  ctx.fillText(data.date, MARGIN, y + 16);
  y += 34;

  // Regime
  ctx.font = "bold 16px -apple-system, Helvetica, Arial, sans-serif";
  ctx.fillStyle = data.riskOn === true ? COLORS.green : data.riskOn === false ? COLORS.red : COLORS.textDim;
  const regimeLabel = data.riskOn === true ? "RISK ON" : data.riskOn === false ? "RISK OFF" : "REGIME UNKNOWN";
  ctx.fillText(regimeLabel, MARGIN, y + 16);
  if (data.regimeText) {
    ctx.fillStyle = COLORS.textDim;
    ctx.font = "14px -apple-system, Helvetica, Arial, sans-serif";
    ctx.fillText(data.regimeText, MARGIN + 140, y + 16);
  }
  y += 40;

  // Stats row
  const stats: [string, string][] = [
    ["Total fires", String(data.totalFires)],
    ["Symbols", String(data.distinctSymbols)],
    ["Triggers", String(data.distinctTriggers)],
    ["Confluence", String(data.confluent.length)],
  ];
  const statW = (WIDTH - MARGIN * 2) / stats.length;
  stats.forEach(([label, value], i) => {
    const x = MARGIN + i * statW;
    ctx.fillStyle = COLORS.text;
    ctx.font = "bold 24px -apple-system, Helvetica, Arial, sans-serif";
    ctx.fillText(value, x, y + 24);
    ctx.fillStyle = COLORS.textDim;
    ctx.font = "13px -apple-system, Helvetica, Arial, sans-serif";
    ctx.fillText(label.toUpperCase(), x, y + 44);
  });
  y += 56 + sectionGapH;

  // Confluence section
  ctx.fillStyle = COLORS.brandGreen;
  ctx.font = "bold 17px -apple-system, Helvetica, Arial, sans-serif";
  ctx.fillText("Confluence", MARGIN, y + 16);
  y += 32;
  if (data.confluent.length === 0) {
    ctx.fillStyle = COLORS.textDim;
    ctx.font = "italic 14px -apple-system, Helvetica, Arial, sans-serif";
    ctx.fillText("No symbols with 2+ agreeing triggers today.", MARGIN, y + 14);
    y += rowH;
  } else {
    for (const c of data.confluent) {
      ctx.fillStyle = c.highPriority ? COLORS.red : COLORS.text;
      ctx.font = "bold 14px -apple-system, Helvetica, Arial, sans-serif";
      ctx.fillText(c.highPriority ? `${c.ticker}  ●` : c.ticker, MARGIN, y + 14);
      ctx.fillStyle = COLORS.textDim;
      ctx.font = "14px -apple-system, Helvetica, Arial, sans-serif";
      ctx.fillText(c.triggerNames.join(", "), MARGIN + 90, y + 14);
      y += rowH;
    }
  }
  y += sectionGapH;

  // Trigger breakdown section
  ctx.fillStyle = COLORS.brandGreen;
  ctx.font = "bold 17px -apple-system, Helvetica, Arial, sans-serif";
  ctx.fillText("Triggers fired", MARGIN, y + 16);
  y += 32;
  if (data.triggers.length === 0) {
    ctx.fillStyle = COLORS.textDim;
    ctx.font = "italic 14px -apple-system, Helvetica, Arial, sans-serif";
    ctx.fillText("No triggers fired today.", MARGIN, y + 14);
    y += rowH;
  } else {
    for (const t of data.triggers) {
      ctx.fillStyle = COLORS.text;
      ctx.font = "bold 14px -apple-system, Helvetica, Arial, sans-serif";
      ctx.fillText(`${t.name} — ${t.count} fire${t.count === 1 ? "" : "s"}`, MARGIN, y + 14);
      y += rowH;
      ctx.fillStyle = COLORS.textDim;
      ctx.font = "13px -apple-system, Helvetica, Arial, sans-serif";
      const statsLine =
        t.sampleSize > 0 && t.winRate !== null
          ? `5-day backtest: ${pct(t.winRate)} win rate, avg return ${pct(t.avgReturn ?? 0)} (${t.sampleSize} samples)`
          : "No backtested history yet.";
      ctx.fillText(statsLine, MARGIN + 12, y + 14);
      y += rowH;

      // An average carried by a handful of fires is not something a
      // 1-2 position account can expect to realize — call it out next to
      // the average rather than leaving the average to speak for itself.
      if (t.meanExclTop1pct !== null && (t.avgReturn ?? 0) > 0 && t.meanExclTop1pct < 0) {
        ctx.fillStyle = COLORS.red;
        ctx.fillText(
          `⚠ Tail-driven: ${pct(t.meanExclTop1pct)} excluding its best 1% of fires` +
            (t.top1pctProfitShare !== null ? ` — that 1% is ${pct(t.top1pctProfitShare)} of gross profit` : ""),
          MARGIN + 12,
          y + 14,
        );
        ctx.fillStyle = COLORS.textDim;
        y += rowH;
      }
    }
  }
  y += sectionGapH;

  // Footer
  ctx.fillStyle = COLORS.textDim;
  ctx.font = "12px -apple-system, Helvetica, Arial, sans-serif";
  ctx.fillText(`Generated ${new Date().toLocaleString()}`, MARGIN, y + 12);
}

export function Reports() {
  const [date, setDate] = useState(todayIso());
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasReport, setHasReport] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const dayStart = `${date}T00:00:00Z`;
      const dayEnd = new Date(new Date(dayStart).getTime() + 24 * 60 * 60 * 1000).toISOString();

      const [eventsRes, regimeRes] = await Promise.all([
        supabase
          .from("trigger_events")
          .select("symbol_id, trigger_id, priority, snapshot, symbols(ticker), triggers(name)")
          .gte("ts", dayStart)
          .lt("ts", dayEnd),
        supabase
          .from("regime_state")
          .select("*")
          .lte("as_of", date)
          .order("as_of", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (eventsRes.error) throw eventsRes.error;

      const rawEvents = (eventsRes.data as unknown as RawEvent[]) ?? [];

      const tickerBySymbol = new Map<number, string>();
      const triggerNameById = new Map<number, string>();
      for (const e of rawEvents) {
        if (e.symbols?.ticker) tickerBySymbol.set(e.symbol_id, e.symbols.ticker);
        if (e.triggers?.name) triggerNameById.set(e.trigger_id, e.triggers.name);
      }

      // Every promoted trigger_event already carries its confluence
      // cluster (the gate only promotes clusters of >= 2) — read that
      // rather than re-deriving it from multiple rows.
      const confluent: ConfluentSymbol[] = rawEvents
        .filter((e) => (e.snapshot?.confluence?.count ?? 0) >= 2)
        .map((e) => ({
          ticker: e.symbols?.ticker ?? tickerBySymbol.get(e.symbol_id) ?? String(e.symbol_id),
          triggerNames: (e.snapshot!.confluence!.triggers ?? [])
            .map((t) => t.name)
            .filter((n): n is string => !!n)
            .map((n) => triggerLabel(n)),
          highPriority: e.priority === "high",
        }));

      const triggerCounts = new Map<number, number>();
      for (const e of rawEvents) triggerCounts.set(e.trigger_id, (triggerCounts.get(e.trigger_id) ?? 0) + 1);
      const triggerIds = [...triggerCounts.keys()];

      type StatRow = {
        trigger_id: number;
        win_rate: number | null;
        avg_return: number | null;
        sample_size: number;
        mean_excl_top1pct: number | null;
        top1pct_profit_share: number | null;
      };
      let statsByTrigger = new Map<number, StatRow>();
      if (triggerIds.length) {
        const { data: statsData, error: statsErr } = await supabase
          .from("trigger_stats")
          .select("trigger_id, win_rate, avg_return, sample_size, mean_excl_top1pct, top1pct_profit_share")
          .in("trigger_id", triggerIds)
          .eq("horizon_days", 5);
        if (statsErr) throw statsErr;
        statsByTrigger = new Map(((statsData as StatRow[]) ?? []).map((s) => [s.trigger_id, s]));
      }

      const triggers: TriggerBreakdown[] = triggerIds.map((id) => {
        const stat = statsByTrigger.get(id);
        return {
          triggerId: id,
          name: triggerNameById.get(id) ? triggerLabel(triggerNameById.get(id)!) : `Trigger #${id}`,
          count: triggerCounts.get(id) ?? 0,
          winRate: stat?.win_rate ?? null,
          avgReturn: stat?.avg_return ?? null,
          sampleSize: stat?.sample_size ?? 0,
          meanExclTop1pct: stat?.mean_excl_top1pct ?? null,
          top1pctProfitShare: stat?.top1pct_profit_share ?? null,
        };
      });

      const regime = regimeRes.data as {
        risk_on: boolean | null;
        index_symbol: string;
        above_200dma: boolean | null;
        vol_regime: string | null;
        as_of: string;
      } | null;

      const reportData: ReportData = {
        date,
        regimeText: regime
          ? `${regime.index_symbol} ${regime.above_200dma ? "above" : "below"} 200DMA · vol regime: ${regime.vol_regime ?? "unknown"} (as of ${regime.as_of})`
          : null,
        riskOn: regime?.risk_on ?? null,
        totalFires: rawEvents.length,
        distinctSymbols: tickerBySymbol.size,
        distinctTriggers: triggerIds.length,
        confluent,
        triggers,
      };

      if (canvasRef.current) {
        measureAndDraw(canvasRef.current, reportData);
        setHasReport(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  function download() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `stackslash-report-${date}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  return (
    <div className="page">
      <header className="page-header">
        <BrandHomeLink />
      </header>
      <h2>Reports</h2>

      <div className="report-controls">
        <input
          type="date"
          value={date}
          max={todayIso()}
          onChange={(e) => setDate(e.target.value)}
        />
        <button className="link-button" onClick={generate} disabled={generating}>
          {generating ? "Generating…" : "Generate Report"}
        </button>
        {hasReport && (
          <button className="link-button" onClick={download}>
            Download PNG
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      <canvas ref={canvasRef} className={`report-canvas ${hasReport ? "" : "report-canvas-empty"}`} />

      <section className="reports-feed-history">
        <h2>Trigger feed — earlier days</h2>
        <TriggerFeed mode="history" />
      </section>
    </div>
  );
}
