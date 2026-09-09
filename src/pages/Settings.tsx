import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import logo from "../assets/SS_SingleLine_Logo.png";

interface ScanConfig {
  price_min: number;
  price_max: number;
  min_dollar_vol_20d: number;
  max_rsi14: number;
  min_confluence: number;
  account_size: number;
  max_risk_pct: number;
  default_stop_pct: number;
  suppress_earnings_days: number;
}

const COLUMNS = [
  "price_min",
  "price_max",
  "min_dollar_vol_20d",
  "max_rsi14",
  "min_confluence",
  "account_size",
  "max_risk_pct",
  "default_stop_pct",
  "suppress_earnings_days",
] as const;

const FIELDS: { key: keyof ScanConfig; label: string; step: number; hint: string }[] = [
  { key: "price_min", label: "Price floor ($)", step: 0.05, hint: "Ignore anything cheaper than this." },
  { key: "price_max", label: "Price ceiling ($)", step: 0.25, hint: "Raise as the account grows past penny stocks." },
  {
    key: "min_dollar_vol_20d",
    label: "Min 20-day $ volume",
    step: 25000,
    hint: "Liquidity floor. Filters out un-tradeable micro-caps whose signals are noise.",
  },
  {
    key: "max_rsi14",
    label: "Max RSI(14) for longs",
    step: 1,
    hint: "Don't enter a long that's already this overbought — short-term returns tend to reverse.",
  },
  {
    key: "min_confluence",
    label: "Signals required to alert",
    step: 1,
    hint: "How many distinct triggers must agree before it promotes to a dossier + alert. Sub-$3 names rarely cluster, so 1 is the practical floor there.",
  },
  { key: "account_size", label: "Account size ($)", step: 5, hint: "Drives the risk-defined sizing shown on each dossier." },
  {
    key: "max_risk_pct",
    label: "Max risk per trade (fraction)",
    step: 0.05,
    hint: "Most the stop can lose as a fraction of the account. 0.20 = 20%.",
  },
  {
    key: "default_stop_pct",
    label: "Default stop distance (fraction)",
    step: 0.01,
    hint: "How far below entry the suggested stop sits. 0.12 = −12%.",
  },
  {
    key: "suppress_earnings_days",
    label: "Suppress alerts near earnings (days)",
    step: 1,
    hint: "Skip the Discord alert (dossier still written) when a report is within this many days. 0 = never suppress.",
  },
];

/**
 * Tunable targeting band for the confluence gate (the `scan_config`
 * singleton row). Starts tuned for a ~$40 account trading sub-$3 names;
 * widen the price band and lift the liquidity floor as the account grows.
 */
export function Settings() {
  const [cfg, setCfg] = useState<ScanConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("scan_config")
      .select(COLUMNS.join(", "))
      .eq("id", 1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else if (data) {
          const row = data as unknown as Record<string, unknown>;
          setCfg(Object.fromEntries(COLUMNS.map((k) => [k, Number(row[k])])) as unknown as ScanConfig);
        }
      });
  }, []);

  async function save() {
    if (!cfg) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const { error } = await supabase
      .from("scan_config")
      .update({ ...cfg, updated_at: new Date().toISOString() })
      .eq("id", 1);
    setSaving(false);
    if (error) setError(error.message);
    else {
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <Link to="/" className="brand-logo-link" aria-label="Home">
          <img src={logo} alt="StackSlash" className="brand-logo" />
        </Link>
        <div className="header-actions">
          <Link to="/" className="link-button">
            ← Dashboard
          </Link>
        </div>
      </header>

      <h2>Targeting band</h2>
      <p className="settings-intro">
        The confluence gate only promotes a signal to a dossier + Discord alert if the symbol sits inside this band.
        Changes apply to the next scan — no redeploy.
      </p>

      {error && <p className="tracking-error">{error}</p>}
      {!cfg ? (
        <p className="empty-state">Loading…</p>
      ) : (
        <div className="settings-form">
          {FIELDS.map((f) => (
            <label key={f.key} className="settings-field">
              <span className="settings-field-label">{f.label}</span>
              <input
                type="number"
                step={f.step}
                value={cfg[f.key]}
                onChange={(e) => setCfg({ ...cfg, [f.key]: Number(e.target.value) })}
              />
              <span className="settings-field-hint">{f.hint}</span>
            </label>
          ))}
          <div className="settings-actions">
            <button className="link-button" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            {saved && <span className="settings-saved">Saved ✓</span>}
          </div>
          <p className="settings-current">
            Current band: <strong>${cfg.price_min.toFixed(2)}–${cfg.price_max.toFixed(2)}</strong>, ≥ $
            {cfg.min_dollar_vol_20d.toLocaleString()}/day, RSI ≤ {cfg.max_rsi14}, ≥ {cfg.min_confluence} signals.
          </p>
        </div>
      )}

      <h2 className="settings-data-heading">Financials</h2>
      <p className="settings-intro">
        Balance sheet, cash flow, forward earnings dates and analyst ranks, pulled from the DoltHub
        <code> post-no-preference/earnings</code> dataset (updated weekly). A weekly job keeps this
        current; use the button for an on-demand refresh.
      </p>
      <FundamentalsRefresh />
    </div>
  );
}

interface JobRun {
  started_at: string;
  finished_at: string | null;
  status: string;
  rows_processed: number | null;
  error: string | null;
}

function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function FundamentalsRefresh() {
  const [last, setLast] = useState<JobRun | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLast = useCallback(async () => {
    const { data } = await supabase
      .from("job_runs")
      .select("started_at, finished_at, status, rows_processed, error")
      .eq("job_name", "refresh-fundamentals")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const row = (data as JobRun | null) ?? null;
    setLast(row);
    setRunning(row?.status === "running");
  }, []);

  useEffect(() => {
    loadLast();
  }, [loadLast]);

  // While a run is in flight, poll for completion.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(loadLast, 4000);
    return () => clearInterval(id);
  }, [running, loadLast]);

  async function refresh() {
    setError(null);
    setRunning(true);
    try {
      const res = await fetch("/.netlify/functions/refresh-fundamentals-background", { method: "POST" });
      // Background functions return 202 immediately; the poll picks up the result.
      if (res.status >= 400) throw new Error(`Trigger failed (${res.status})`);
      setTimeout(loadLast, 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
    }
  }

  return (
    <div className="settings-data">
      <div className="settings-actions">
        <button className="link-button" onClick={refresh} disabled={running}>
          {running ? "Pulling from DoltHub…" : "Refresh financials"}
        </button>
        {running && <span className="settings-field-hint">takes ~1–2 min</span>}
      </div>
      {error && <p className="tracking-error">{error}</p>}
      {last && !running && (
        <p className="settings-current">
          {last.status === "ok" ? (
            <>
              Last refreshed <strong>{ago(last.finished_at ?? last.started_at)}</strong>
              {last.rows_processed != null && <> · {last.rows_processed.toLocaleString()} symbols</>}
            </>
          ) : last.status === "error" ? (
            <>Last run failed{last.error ? `: ${last.error}` : ""} ({ago(last.started_at)})</>
          ) : (
            <>Last run: {last.status}</>
          )}
        </p>
      )}
      {!last && !running && <p className="settings-current">Never refreshed.</p>}
    </div>
  );
}
