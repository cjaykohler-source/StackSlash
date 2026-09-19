import { useEffect, useState, type ReactNode } from "react";
import { supabase } from "../lib/supabaseClient";
import { InfoTooltip } from "./InfoTooltip";

/**
 * Balance sheet (SEC XBRL), short interest (FINRA) and borrow availability
 * (IBKR) for one symbol, above the news on the symbol page.
 * Context only: nothing here is a flag until it has been tested.
 */
type BalanceSheet = {
  period_end: string;
  form: string | null;
  filed: string | null;
  cash: number | null;
  short_term_debt: number | null;
  long_term_debt: number | null;
  current_assets: number | null;
  current_liabilities: number | null;
  stockholders_equity: number | null;
  shares_outstanding: number | null;
};
type ShortInterest = { settlement_date: string; short_shares: number; change_pct: number | null; days_to_cover: number | null };
type Broker = { as_of: string; float_shares: number | null; shares_outstanding: number | null; financial_status: string | null };
type Borrow = { captured_at: string; shortable_shares: number | null; shortable_tier: number | null };

export default function FinancialsPanel({ symbolId }: { symbolId: number }) {
  const [bs, setBs] = useState<BalanceSheet | null>(null);
  const [si, setSi] = useState<ShortInterest | null>(null);
  const [borrow, setBorrow] = useState<Borrow | null>(null);
  const [broker, setBroker] = useState<Broker | null>(null);
  const [sharesFallback, setSharesFallback] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      supabase.from("balance_sheet").select("*").eq("symbol_id", symbolId).order("period_end", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("short_interest").select("settlement_date,short_shares,change_pct,days_to_cover").eq("symbol_id", symbolId).order("settlement_date", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("short_availability").select("captured_at,shortable_shares,shortable_tier").eq("symbol_id", symbolId).order("captured_at", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("broker_snapshot").select("as_of,float_shares,shares_outstanding,financial_status").eq("symbol_id", symbolId).order("as_of", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("fundamentals").select("shares_outstanding").eq("symbol_id", symbolId).order("as_of", { ascending: false }).limit(1).maybeSingle(),
    ]).then(([b, s, a, r, f]) => {
      if (cancelled) return;
      setBs((b.data as BalanceSheet) ?? null);
      setSi((s.data as ShortInterest) ?? null);
      setBorrow((a.data as Borrow) ?? null);
      setBroker((r.data as Broker) ?? null);
      setSharesFallback((f.data?.shares_outstanding as number | null) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [symbolId]);

  if (!bs && !si && !borrow && !broker) return null;

  const shares = bs?.shares_outstanding ?? sharesFallback;
  const currentRatio =
    bs?.current_assets != null && bs.current_liabilities ? Number(bs.current_assets) / Number(bs.current_liabilities) : null;
  const debtParts = [
    bs?.short_term_debt != null ? `${money(bs.short_term_debt)} short-term` : null,
    bs?.long_term_debt != null ? `${money(bs.long_term_debt)} long-term` : null,
  ].filter(Boolean);

  return (
    <div className="financials-panel">
      <h3 className="profile-subheading">Financials</h3>

      {bs && (
        <Group title="Balance sheet" asOf={`${bs.form ?? "filing"} · ${shortDate(bs.period_end)}`}>
          <Metric label="Cash" value={money(bs.cash)} />
          <Metric label="Debt" value={debtParts.length ? debtParts.join(" · ") : "none reported"} />
          <Metric
            label="Current ratio"
            tip="Current assets ÷ current liabilities. Below 1, bills due within a year exceed what can be turned into cash within a year."
            value={currentRatio != null ? currentRatio.toFixed(2) : "—"}
          />
          <Metric label="Equity" value={money(bs.stockholders_equity)} />
        </Group>
      )}

      {si && (
        <Group title="Short interest" asOf={shortDate(si.settlement_date)}>
          <Metric
            label="% of shares out"
            value={shares ? `${((Number(si.short_shares) / Number(shares)) * 100).toFixed(1)}%` : "—"}
          />
          <Metric
            label="Days to cover"
            tip="Shares short ÷ average daily volume (FINRA)."
            value={si.days_to_cover != null ? Number(si.days_to_cover).toFixed(1) : "—"}
          />
          {si.change_pct != null && (
            <Metric label="vs prior report" value={`${Number(si.change_pct) > 0 ? "+" : ""}${Number(si.change_pct).toFixed(1)}%`} />
          )}
        </Group>
      )}

      {broker && (
        <Group title="Float & listing (Robinhood)" asOf={shortDate(broker.as_of)}>
          <Metric
            label="Float"
            tip="Shares available to trade publicly (excludes insiders and locked-up holders). One-off snapshot."
            value={
              broker.float_shares != null
                ? `${count(broker.float_shares)}${broker.shares_outstanding ? ` · ${((Number(broker.float_shares) / Number(broker.shares_outstanding)) * 100).toFixed(0)}% of shares out` : ""}`
                : "—"
            }
          />
          <Metric
            label="Listing status"
            tip="Noncompliant: the exchange has sent a listing-deficiency notice (e.g. under $1, late filing). Often precedes a reverse split."
            value={broker.financial_status === "Noncompliant" ? "Noncompliant" : "compliant"}
            className={broker.financial_status === "Noncompliant" ? "financials-amber" : undefined}
          />
        </Group>
      )}

      {borrow && (
        <Group title="Borrow (IBKR)" asOf={shortDate(borrow.captured_at)}>
          <Metric
            label="Shares to borrow"
            value={borrow.shortable_shares != null ? count(borrow.shortable_shares) : "—"}
          />
          <Metric label="Status" value={tierLabel(borrow.shortable_tier)} />
        </Group>
      )}
    </div>
  );
}

function Group({ title, asOf, children }: { title: string; asOf: string; children: ReactNode }) {
  return (
    <div className="factor-group">
      <h4 className="factor-group-title">
        {title} <span className="financials-asof">· {asOf}</span>
      </h4>
      <div className="dossier-metrics">{children}</div>
    </div>
  );
}

function Metric({ label, value, tip, className }: { label: string; value: string; tip?: string; className?: string }) {
  return (
    <div className="dossier-metric">
      <span className="dossier-metric-label">{tip ? <InfoTooltip text={tip}>{label}</InfoTooltip> : label}</span>
      <span className={`dossier-metric-value${className ? ` ${className}` : ""}`}>{value}</span>
    </div>
  );
}

function money(v: number | string | null | undefined): string {
  if (v == null) return "—";
  const n = Number(v);
  const a = Math.abs(n);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}K` : a.toFixed(0);
  return `${n < 0 ? "−" : ""}$${s}`;
}

function count(v: number | string): string {
  const n = Number(v);
  return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n));
}

function shortDate(iso: string): string {
  return new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** IB generic tick 46: >2.5 shares available, 1.5-2.5 locate needed, <=1.5 none. */
function tierLabel(t: number | null): string {
  if (t == null) return "—";
  return t > 2.5 ? "available" : t > 1.5 ? "locate needed" : "not available";
}
