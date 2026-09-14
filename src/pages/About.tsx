import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { TRIGGER_INFO, TIMING_LABEL, triggerLabel, triggerSide, type TriggerTiming } from "../lib/triggerInfo";
import { BrandHomeLink } from "../components/BrandHomeLink";

interface TriggerRow {
  id: number;
  name: string;
  enabled: boolean;
  cooldown_minutes: number;
}

interface StatRow {
  trigger_id: number;
  sample_size: number;
  win_rate: number | null;
  avg_return: number | null;
  mean_excl_top1pct: number | null;
}

// The backtest horizon shown on each card (trigger_stats also has 1/2/5/10/20).
const RECORD_HORIZON = 3;
const FIRES_WINDOW_DAYS = 30;
const TIMING_ORDER: TriggerTiming[] = ["realtime", "daily", "exit", "intraday"];

/**
 * Plain-English breakdown of every trigger: when it runs, exactly what has
 * to be true for it to fire, its backtest record, and how often it has
 * actually fired lately. Wording and conditions live in lib/triggerInfo.ts;
 * enabled state, cooldowns, backtest stats (trigger_stats) and recent fire
 * counts (trigger_events) are read live, so the page stays current as
 * triggers are switched on/off or backtests are re-run.
 */
export function About() {
  const [rows, setRows] = useState<Record<string, TriggerRow>>({});
  const [stats, setStats] = useState<Record<number, StatRow>>({});
  const [fires, setFires] = useState<Record<number, number>>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data } = await supabase.from("triggers").select("id, name, enabled, cooldown_minutes");
      if (cancelled || !data) return;
      const triggers = data as TriggerRow[];
      setRows(Object.fromEntries(triggers.map((t) => [t.name, t])));

      const since = new Date(Date.now() - FIRES_WINDOW_DAYS * 86_400_000).toISOString();
      const [statsRes, ...counts] = await Promise.all([
        supabase
          .from("trigger_stats")
          .select("trigger_id, sample_size, win_rate, avg_return, mean_excl_top1pct")
          .eq("horizon_days", RECORD_HORIZON),
        ...triggers.map((t) =>
          supabase.from("trigger_events").select("id", { count: "exact", head: true }).eq("trigger_id", t.id).gte("ts", since),
        ),
      ]);
      if (cancelled) return;
      setStats(Object.fromEntries(((statsRes.data as StatRow[] | null) ?? []).map((s) => [s.trigger_id, s])));
      setFires(Object.fromEntries(triggers.map((t, i) => [t.id, counts[i].count ?? 0])));
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const names = Object.keys(TRIGGER_INFO).sort((a, b) => {
    const ta = TIMING_ORDER.indexOf(TRIGGER_INFO[a].timing);
    const tb = TIMING_ORDER.indexOf(TRIGGER_INFO[b].timing);
    return ta !== tb ? ta - tb : triggerLabel(a).localeCompare(triggerLabel(b));
  });
  const loaded = Object.keys(rows).length > 0;
  const active = names.filter((n) => rows[n]?.enabled);
  const off = names.filter((n) => loaded && !rows[n]?.enabled);

  const card = (name: string) => (
    <TriggerCard
      key={name}
      name={name}
      row={rows[name]}
      stat={rows[name] ? stats[rows[name].id] : undefined}
      fires={rows[name] ? fires[rows[name].id] : undefined}
    />
  );

  return (
    <div className="page about-page">
      <header className="page-header">
        <BrandHomeLink />
      </header>

      <h2>How the triggers work</h2>
      <p className="about-intro">
        Every alert on the dashboard comes from one of the triggers below. A trigger is a fixed set of conditions; when a
        stock meets all of them, the trigger "fires" and the stock lands in the feed. Nothing here is a recommendation:
        the backtest numbers on each card show how every one of these has actually performed.
      </p>

      <div className="about-basics">
        <div className="about-basic">
          <h3>When they run</h3>
          <p>
            <b>Real-time</b> triggers watch every trade on the live feed. <b>Daily</b> triggers run once after the close on
            that day's finished bars. <b>Intraday</b> triggers run every few minutes during market hours.
          </p>
        </div>
        <div className="about-basic">
          <h3>Market filter</h3>
          <p>
            Most buy-side triggers only fire when the market is <b>risk-on</b>, meaning SPY is above its 200-day average.
            The banner at the top of the dashboard shows which regime we're in today.
          </p>
        </div>
        <div className="about-basic">
          <h3>Reading the track record</h3>
          <p>
            Each card shows a {RECORD_HORIZON}-day backtest: every past fire, bought and held {RECORD_HORIZON} trading days,
            before costs. On sub-$5 stocks a round trip costs about 1%. <b>Avg without top 1%</b> drops the biggest winners;
            if it turns negative, the average depends on a few lucky outliers.
          </p>
        </div>
      </div>

      <h3 className="about-section-title">
        Active <span className="about-section-count">{active.length}</span>
      </h3>
      <div className="trigger-card-grid">{loaded ? active.map(card) : <p className="empty-state">Loading…</p>}</div>

      {off.length > 0 && (
        <>
          <h3 className="about-section-title">
            Switched off <span className="about-section-count">{off.length}</span>
          </h3>
          <p className="about-section-note">Kept for reference and re-testing. None of these fire.</p>
          <div className="trigger-card-grid">{off.map(card)}</div>
        </>
      )}
    </div>
  );
}

function TriggerCard({ name, row, stat, fires }: { name: string; row?: TriggerRow; stat?: StatRow; fires?: number }) {
  const info = TRIGGER_INFO[name];
  const side = triggerSide(name);
  const pct = (v: number | null | undefined, digits = 2) =>
    v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
  const tone = (v: number | null | undefined) => (v == null || v === 0 ? "" : v > 0 ? "up" : "down");

  return (
    <article className={`trigger-card${row && !row.enabled ? " trigger-card-off" : ""}`}>
      <header className="trigger-card-head">
        <h4>{info.label}</h4>
        {row && (
          <span className={`status ${row.enabled ? "status-alerted" : "status-dismissed"}`}>
            {row.enabled ? "Active" : "Off"}
          </span>
        )}
      </header>
      <div className="trigger-chips">
        <span className="trigger-chip">{TIMING_LABEL[info.timing]}</span>
        <span className={`trigger-chip trigger-chip-${side}`}>{side === "buy" ? "Buy side" : "Sell side"}</span>
        <span className="trigger-chip">{info.categoryLabel}</span>
      </div>

      <p className="trigger-summary">{info.summary}</p>

      <div className="trigger-block-label">Fires when</div>
      <ul className="trigger-conditions">
        {info.conditions.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      {info.detail && <p className="trigger-detail">{info.detail}</p>}

      {row && !row.enabled && info.offReason && (
        <p className="trigger-off-reason">
          <b>Why it's off:</b> {info.offReason}
        </p>
      )}

      {stat && stat.sample_size > 0 && (
        <div className="trigger-record">
          <div className="trigger-block-label">Backtest, {RECORD_HORIZON}-day hold, before costs</div>
          <dl>
            <div>
              <dt>Trades</dt>
              <dd>{stat.sample_size.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Win rate</dt>
              <dd>{stat.win_rate == null ? "—" : `${(stat.win_rate * 100).toFixed(0)}%`}</dd>
            </div>
            <div>
              <dt>Avg return</dt>
              <dd className={tone(stat.avg_return)}>{pct(stat.avg_return)}</dd>
            </div>
            <div>
              <dt>Avg without top 1%</dt>
              <dd className={tone(stat.mean_excl_top1pct)}>{pct(stat.mean_excl_top1pct)}</dd>
            </div>
          </dl>
        </div>
      )}

      {row && (row.enabled || (fires ?? 0) > 0) && (
        <footer className="trigger-card-foot">
          {fires != null && (row.enabled || fires > 0) && (
            <span>
              {fires.toLocaleString()} fire{fires === 1 ? "" : "s"} in the last {FIRES_WINDOW_DAYS} days
              {row.enabled ? "" : ", before it was switched off"}
            </span>
          )}
          {row.enabled && <span>Re-alerts a stock at most every {formatCooldown(row.cooldown_minutes)}</span>}
        </footer>
      )}
    </article>
  );
}

function formatCooldown(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "day" : `${days} days`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "hour" : `${hours} hours`;
  }
  return `${minutes} minutes`;
}
