import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { BrandHomeLink } from "../components/BrandHomeLink";
import {
  DEFAULT_SPEC,
  OPERATORS,
  SNAPSHOT_FIELDS,
  WINDOW_CHOICES,
  WINDOW_FIELDS,
  fieldsFor,
  findField,
  formatMetric,
  toRpcSpec,
  type Condition,
  type ScreenSpec,
  type Scope,
} from "../lib/screenFields";

interface ScreenRow {
  id: string;
  name: string;
  description: string | null;
  is_preset: boolean;
  spec: ScreenSpec;
}

interface ResultRow {
  ticker: string;
  name: string | null;
  sector: string | null;
  last_close: number | null;
  dollar_vol_20d: number | null;
  coverage: number;
  metrics: Record<string, unknown> & { w?: Record<string, number | null> };
}

const emptyCondition = (scope: Scope = "window"): Condition => ({
  scope,
  field: (scope === "window" ? WINDOW_FIELDS : SNAPSHOT_FIELDS)[0].key,
  op: "gte",
  value: "",
  value2: "",
});

function metricValue(row: ResultRow, scope: Scope, field: string): number | null {
  const raw = scope === "window" ? row.metrics.w?.[field] : (row.metrics as Record<string, unknown>)[field];
  return raw == null ? null : Number(raw);
}

/**
 * Isolator — a screener over the whole tracked universe. Combine
 * current-snapshot factor filters with trailing-window aggregates
 * ("avg Bollinger width over 40 sessions ≤ 0.05", "volume high/low spread
 * ≥ 3", …) to isolate a setup, then save the query for re-running. Preset
 * queries cover the common trend archetypes.
 */
export function Isolator() {
  const [screens, setScreens] = useState<ScreenRow[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [spec, setSpec] = useState<ScreenSpec>(DEFAULT_SPEC);
  const [results, setResults] = useState<ResultRow[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ranAt, setRanAt] = useState<string | null>(null);
  const [ranSpec, setRanSpec] = useState<ScreenSpec | null>(null);
  const [saveName, setSaveName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadScreens = useCallback(async () => {
    const { data } = await supabase
      .from("screens")
      .select("id, name, description, is_preset, spec")
      .order("is_preset", { ascending: false })
      .order("name", { ascending: true });
    setScreens((data as ScreenRow[]) ?? []);
  }, []);

  useEffect(() => {
    loadScreens();
  }, [loadScreens]);

  const selected = screens.find((s) => s.id === selectedId) ?? null;

  function applyScreen(id: string) {
    setSelectedId(id);
    if (!id) {
      setSpec({ ...DEFAULT_SPEC, conditions: [emptyCondition()] });
      return;
    }
    const s = screens.find((x) => x.id === id);
    if (s) setSpec({ ...DEFAULT_SPEC, ...s.spec, conditions: normalizeConds(s.spec.conditions) });
  }

  function normalizeConds(conds: Condition[] | undefined): Condition[] {
    return (conds ?? []).map((c) => ({
      scope: c.scope,
      field: c.field,
      op: c.op,
      value: c.value != null ? String((c as unknown as { value: unknown }).value) : "",
      value2: c.value2 != null ? String((c as unknown as { value2: unknown }).value2) : "",
    }));
  }

  const patch = (p: Partial<ScreenSpec>) => setSpec((s) => ({ ...s, ...p }));
  const patchCond = (i: number, p: Partial<Condition>) =>
    setSpec((s) => ({ ...s, conditions: s.conditions.map((c, j) => (j === i ? { ...c, ...p } : c)) }));

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const rpcSpec = toRpcSpec(spec);
      const { data, error } = await supabase.rpc("screen_symbols", { spec: rpcSpec });
      if (error) throw error;
      setResults((data as ResultRow[]) ?? []);
      setRanAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      setRanSpec(spec);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResults(null);
    } finally {
      setRunning(false);
    }
  }

  async function saveNew() {
    const name = (saveName ?? "").trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    const { data, error } = await supabase
      .from("screens")
      .insert({ name, spec: specForStorage(spec), is_preset: false })
      .select("id")
      .single();
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    setSaveName(null);
    await loadScreens();
    if (data) setSelectedId((data as { id: string }).id);
  }

  async function updateSaved() {
    if (!selected || selected.is_preset || busy) return;
    setBusy(true);
    setError(null);
    const { error } = await supabase
      .from("screens")
      .update({ spec: specForStorage(spec), updated_at: new Date().toISOString() })
      .eq("id", selected.id);
    setBusy(false);
    if (error) setError(error.message);
    else await loadScreens();
  }

  async function deleteSaved() {
    if (!selected || selected.is_preset || busy) return;
    if (!window.confirm(`Delete saved search "${selected.name}"?`)) return;
    setBusy(true);
    const { error } = await supabase.from("screens").delete().eq("id", selected.id);
    setBusy(false);
    if (error) setError(error.message);
    else {
      setSelectedId("");
      await loadScreens();
    }
  }

  const presets = screens.filter((s) => s.is_preset);
  const mine = screens.filter((s) => !s.is_preset);

  // Result columns: one per condition that actually ran, plus the sort key.
  const resultCols = useMemo(() => {
    if (!ranSpec) return [];
    const seen = new Set<string>();
    const cols: { scope: Scope; field: string; label: string; unit: ReturnType<typeof colUnit> }[] = [];
    const add = (scope: Scope, field: string) => {
      const k = `${scope}:${field}`;
      if (seen.has(k)) return;
      const meta = findField(scope, field);
      if (!meta) return;
      seen.add(k);
      cols.push({ scope, field, label: meta.label, unit: meta.unit });
    };
    for (const c of ranSpec.conditions) if (c.value !== "") add(c.scope, c.field);
    const sortMeta = findField("window", ranSpec.sort) ? "window" : findField("snapshot", ranSpec.sort) ? "snapshot" : null;
    if (sortMeta) add(sortMeta as Scope, ranSpec.sort);
    return cols;
  }, [ranSpec]);

  function downloadCsv() {
    if (!results || !ranSpec) return;
    const head = ["ticker", "name", "sector", "price", "dollar_vol_20d", "sessions", ...resultCols.map((c) => `${c.scope}:${c.field}`)];
    const lines = [head.join(",")];
    for (const r of results) {
      const cells = [
        r.ticker,
        csvCell(r.name ?? ""),
        csvCell(r.sector ?? ""),
        r.last_close ?? "",
        r.dollar_vol_20d ?? "",
        r.coverage,
        ...resultCols.map((c) => metricValue(r, c.scope, c.field) ?? ""),
      ];
      lines.push(cells.join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `isolator-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const thinCoverage = ranSpec && ranSpec.conditions.some((c) => c.scope === "window") &&
    (results ?? []).some((r) => r.coverage > 0 && r.coverage < ranSpec.window);

  return (
    <div className="page">
      <header className="page-header">
        <BrandHomeLink />
      </header>

      <h2>Isolator</h2>
      <p className="settings-intro">
        Screen the whole tracked universe. Mix current-snapshot factors with trailing-window aggregates
        to isolate a setup — then save the query. Window metrics are recomputed nightly from daily bars
        (~18 months deep); snapshot factors are the latest scan.
      </p>

      {error && <p className="tracking-error">{error}</p>}

      <div className="isolator-bar">
        <label className="isolator-field">
          <span>Load</span>
          <select value={selectedId} onChange={(e) => applyScreen(e.target.value)}>
            <option value="">— new screen —</option>
            {presets.length > 0 && (
              <optgroup label="Presets">
                {presets.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </optgroup>
            )}
            {mine.length > 0 && (
              <optgroup label="My searches">
                {mine.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label className="isolator-field">
          <span>Lookback</span>
          <select
            value={spec.window}
            onChange={(e) => patch({ window: Number(e.target.value) as ScreenSpec["window"] })}
          >
            {WINDOW_CHOICES.map((w) => (
              <option key={w} value={w}>{w} sessions</option>
            ))}
          </select>
        </label>
        <label className="isolator-field">
          <span>Limit</span>
          <input
            type="number"
            min={1}
            max={1000}
            step={50}
            value={spec.limit}
            onChange={(e) => patch({ limit: Number(e.target.value) })}
          />
        </label>
        <label className="isolator-check">
          <input
            type="checkbox"
            checked={spec.restrict_band}
            onChange={(e) => patch({ restrict_band: e.target.checked })}
          />
          <span>Targeting band only</span>
        </label>
        <label className="isolator-check">
          <input
            type="checkbox"
            checked={spec.exclude_alert_excluded}
            onChange={(e) => patch({ exclude_alert_excluded: e.target.checked })}
          />
          <span>Exclude mega-caps</span>
        </label>
      </div>

      {selected?.description && <p className="isolator-preset-note">{selected.description}</p>}

      <div className="isolator-conditions">
        {spec.conditions.map((c, i) => {
          const meta = findField(c.scope, c.field);
          const op = OPERATORS.find((o) => o.key === c.op);
          return (
            <div className="isolator-cond" key={i}>
              <select
                value={c.scope}
                onChange={(e) => {
                  const scope = e.target.value as Scope;
                  patchCond(i, { scope, field: fieldsFor(scope)[0].key });
                }}
              >
                <option value="window">over window</option>
                <option value="snapshot">right now</option>
              </select>

              <select value={c.field} onChange={(e) => patchCond(i, { field: e.target.value })}>
                {groupFields(c.scope).map(([group, fields]) => (
                  <optgroup key={group} label={group}>
                    {fields.map((f) => (
                      <option key={f.key} value={f.key}>{f.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>

              <select value={c.op} onChange={(e) => patchCond(i, { op: e.target.value })}>
                {OPERATORS.map((o) => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </select>

              <input
                type="number"
                step="any"
                value={c.value}
                placeholder="value"
                onChange={(e) => patchCond(i, { value: e.target.value })}
              />
              {op?.args === 2 && (
                <input
                  type="number"
                  step="any"
                  value={c.value2}
                  placeholder="and"
                  onChange={(e) => patchCond(i, { value2: e.target.value })}
                />
              )}

              <button
                className="isolator-cond-remove"
                onClick={() => patch({ conditions: spec.conditions.filter((_, j) => j !== i) })}
                aria-label="Remove condition"
              >
                ×
              </button>
              {meta && <span className="isolator-cond-help">{meta.help}</span>}
            </div>
          );
        })}
        <button
          className="link-button"
          onClick={() => patch({ conditions: [...spec.conditions, emptyCondition()] })}
        >
          + Add condition
        </button>
      </div>

      <div className="isolator-actions">
        <button className="isolator-run" onClick={run} disabled={running}>
          {running ? "Running…" : "Run screen"}
        </button>
        <label className="isolator-field isolator-sort">
          <span>Sort by</span>
          <select value={spec.sort} onChange={(e) => patch({ sort: e.target.value })}>
            <option value="dollar_vol_20d">$ volume</option>
            <option value="last_close">Price</option>
            <option value="coverage">Sessions covered</option>
            {sortOptions(spec).map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
          <select value={spec.sort_dir} onChange={(e) => patch({ sort_dir: e.target.value as "asc" | "desc" })}>
            <option value="desc">high → low</option>
            <option value="asc">low → high</option>
          </select>
        </label>

        <span className="isolator-spacer" />

        {selected && !selected.is_preset && (
          <>
            <button className="link-button" onClick={updateSaved} disabled={busy}>Update "{selected.name}"</button>
            <button className="link-button" onClick={deleteSaved} disabled={busy}>Delete</button>
          </>
        )}
        {saveName === null ? (
          <button className="link-button" onClick={() => setSaveName("")}>Save as…</button>
        ) : (
          <span className="isolator-save">
            <input
              autoFocus
              value={saveName}
              placeholder="Search name"
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveNew()}
            />
            <button className="link-button" onClick={saveNew} disabled={busy || !saveName.trim()}>Save</button>
            <button className="link-button" onClick={() => setSaveName(null)}>Cancel</button>
          </span>
        )}
      </div>

      {results && ranSpec && (
        <section className="isolator-results">
          <div className="isolator-results-head">
            <strong>{results.length}</strong> match{results.length === 1 ? "" : "es"}
            {ranAt && <span className="isolator-results-meta"> · ran {ranAt} · {ranSpec.window}-session window</span>}
            {results.length > 0 && (
              <button className="link-button" onClick={downloadCsv}>Download CSV</button>
            )}
          </div>
          {thinCoverage && (
            <p className="isolator-thin">
              Some rows have fewer sessions than the window — window metrics fill in as the daily-bar
              history deepens (or the symbol is newly listed).
            </p>
          )}
          {results.length === 0 ? (
            <p className="empty-state">Nothing matched. Loosen a condition or widen the universe.</p>
          ) : (
            <div className="trigger-feed-scroll">
              <table className="trigger-feed isolator-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th className="col-num">Price</th>
                    <th className="col-num">$ Vol</th>
                    <th className="col-num">Sess.</th>
                    {resultCols.map((c) => (
                      <th key={`${c.scope}:${c.field}`} className="col-num">
                        {c.label}
                        <span className="isolator-col-scope">{c.scope === "window" ? " · window" : " · now"}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.ticker}>
                      <td>
                        <Link to={`/symbol/${r.ticker}`}>{r.ticker}</Link>
                        {r.name && <span className="isolator-name"> {r.name}</span>}
                      </td>
                      <td className="col-num">{r.last_close != null ? `$${r.last_close.toFixed(2)}` : "—"}</td>
                      <td className="col-num">{formatMetric("usd", r.dollar_vol_20d)}</td>
                      <td className="col-num">{r.coverage || "—"}</td>
                      {resultCols.map((c) => (
                        <td key={`${c.scope}:${c.field}`} className="col-num">
                          {formatMetric(c.unit, metricValue(r, c.scope, c.field))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/** Window-metric sort choices: every window condition, plus the current
 *  sort key if it isn't already covered (so a preset's sort stays valid). */
function sortOptions(spec: ScreenSpec): { key: string; label: string }[] {
  const keys = new Set(spec.conditions.filter((c) => c.scope === "window").map((c) => c.field));
  if (spec.sort && findField("window", spec.sort)) keys.add(spec.sort);
  return [...keys].map((k) => ({ key: k, label: findField("window", k)?.label ?? k }));
}

function groupFields(scope: Scope): [string, ReturnType<typeof fieldsFor>][] {
  const groups = new Map<string, ReturnType<typeof fieldsFor>>();
  for (const f of fieldsFor(scope)) {
    const arr = groups.get(f.group) ?? [];
    arr.push(f);
    groups.set(f.group, arr);
  }
  return [...groups.entries()];
}

function colUnit(scope: Scope, field: string) {
  return findField(scope, field)?.unit ?? "num";
}

/** Store conditions with numeric values (not the form's strings). */
function specForStorage(spec: ScreenSpec): Record<string, unknown> {
  return {
    ...toRpcSpec(spec),
    // keep the raw window/sort even if no conditions
    window: spec.window,
    sort: spec.sort,
    sort_dir: spec.sort_dir,
    restrict_band: spec.restrict_band,
    exclude_alert_excluded: spec.exclude_alert_excluded,
    limit: spec.limit,
  };
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
