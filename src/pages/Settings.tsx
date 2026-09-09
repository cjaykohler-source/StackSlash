import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import logo from "../assets/SS_SingleLine_Logo.png";

interface ScanConfig {
  price_min: number;
  price_max: number;
  min_dollar_vol_20d: number;
  max_rsi14: number;
  min_confluence: number;
}

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
    hint: "How many distinct triggers must agree (same direction, same symbol) before it promotes to a dossier + alert.",
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
      .select("price_min, price_max, min_dollar_vol_20d, max_rsi14, min_confluence")
      .eq("id", 1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) setError(error.message);
        else if (data)
          setCfg({
            price_min: Number(data.price_min),
            price_max: Number(data.price_max),
            min_dollar_vol_20d: Number(data.min_dollar_vol_20d),
            max_rsi14: Number(data.max_rsi14),
            min_confluence: Number(data.min_confluence),
          });
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
        <img src={logo} alt="StackSlash" className="brand-logo" />
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
    </div>
  );
}
