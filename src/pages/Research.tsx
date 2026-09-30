import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { BrandHomeLink } from "../components/BrandHomeLink";
import { Markdown } from "../components/Markdown";
import {
  fetchCatalystTests,
  fetchCatalystTypes,
  pct,
  SOURCE_LABEL,
  VERDICT_LABEL,
  type CatalystEvent,
  type CatalystTest,
  type CatalystType,
  type Verdict,
} from "../lib/research";

type Tab = "leaderboard" | "feed" | "reddit" | "studies";
const TABS: [Tab, string][] = [
  ["leaderboard", "Catalyst leaderboard"],
  ["feed", "Live feed"],
  ["reddit", "Reddit attention"],
  ["studies", "Studies"],
];
const VERDICT_ORDER: Verdict[] = ["avoid", "positive", "watch", "none", "untested"];

/**
 * Research results published nightly from the local research warehouse
 * (research/publish_research.py): every catalyst type tested by
 * research/catalysts/harness.py, the past year of catalyst events, Reddit
 * mention counts, and the study write-ups from docs/.
 */
export function Research() {
  const [tab, setTab] = useState<Tab>(() => {
    const h = window.location.hash.slice(1) as Tab;
    return TABS.some(([t]) => t === h) ? h : "leaderboard";
  });
  const [types, setTypes] = useState<Map<string, CatalystType>>(new Map());

  useEffect(() => {
    fetchCatalystTypes().then(setTypes);
  }, []);
  useEffect(() => {
    window.history.replaceState(null, "", `#${tab}`);
  }, [tab]);

  return (
    <div className="page">
      <header className="page-header">
        <BrandHomeLink />
        <h1>Research</h1>
        <div className="header-actions">
          <Link to="/" className="link-button">
            Dashboard
          </Link>
        </div>
      </header>
      <nav className="research-tabs">
        {TABS.map(([t, label]) => (
          <button key={t} className={`research-tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === "leaderboard" && <Leaderboard types={types} />}
      {tab === "feed" && <Feed types={types} />}
      {tab === "reddit" && <Reddit />}
      {tab === "studies" && <Studies />}
    </div>
  );
}

function VerdictBadge({ t }: { t?: CatalystType }) {
  const v = t?.verdict ?? "untested";
  return (
    <span className={`verdict-badge verdict-${v}`} title={t?.verdict_note ?? undefined}>
      {VERDICT_LABEL[v]}
    </span>
  );
}

function Leaderboard({ types }: { types: Map<string, CatalystType> }) {
  const [tests, setTests] = useState<CatalystTest[] | null>(null);
  const [source, setSource] = useState("all");
  const [open, setOpen] = useState<string | null>(null);
  const [samples, setSamples] = useState<CatalystEvent[]>([]);

  useEffect(() => {
    fetchCatalystTests().then(setTests);
  }, []);
  useEffect(() => {
    if (!open) return;
    setSamples([]);
    supabase
      .from("research_catalyst_events")
      .select("*")
      .eq("type", open)
      .order("event_date", { ascending: false })
      .limit(25)
      .then(({ data }) => setSamples((data ?? []) as CatalystEvent[]));
  }, [open]);

  const rows = useMemo(() => {
    if (!tests) return [];
    const get = (type: string, period: string, h: number) =>
      tests.find((r) => r.type === type && r.period === period && r.horizon === h);
    return [...types.values()]
      .filter((t) => source === "all" || t.source === source)
      .map((t) => {
        const d20 = get(t.type, "2016-21", 20);
        const d5 = get(t.type, "2016-21", 5);
        const h20 = get(t.type, "2022+", 20);
        const gap = d20?.mean_x != null && d20.null_med != null ? d20.mean_x - d20.null_med : null;
        const hgap = h20?.mean_x != null && h20.null_med != null ? h20.mean_x - h20.null_med : null;
        return { t, d20, d5, gap, hgap };
      })
      .sort(
        (a, b) =>
          VERDICT_ORDER.indexOf(a.t.verdict) - VERDICT_ORDER.indexOf(b.t.verdict) ||
          Math.abs(b.gap ?? 0) - Math.abs(a.gap ?? 0),
      );
  }, [tests, types, source]);

  if (!tests) return <p className="empty-state">Loading…</p>;
  const sources = [...new Set([...types.values()].map((t) => t.source))].sort();

  return (
    <section>
      <p className="research-intro">
        Every catalyst type run through the same event study on $0.10–$15 stocks with $250k+ daily dollar volume:
        entry at the close of the first session after the event is public, 20-session return net of costs versus the
        same day's average. <strong>Gap</strong> is that excess minus the same stocks at random dates (the null), so it
        measures the catalyst, not the kind of stock. <strong>q</strong> corrects for how many types were tested. Discovery
        is 2016–21; 2022+ is held out until a rule is final. Click a row for recent examples.
      </p>
      <div className="research-filters">
        <label>
          Source{" "}
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">All</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s] ?? s}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="trigger-feed-scroll">
        <table className="isolator-table research-table">
          <thead>
            <tr>
              <th>Catalyst</th>
              <th>Verdict</th>
              <th>Source</th>
              <th className="col-num">Events</th>
              <th className="col-num">5d excess</th>
              <th className="col-num">20d excess</th>
              <th className="col-num">Null</th>
              <th className="col-num">Gap</th>
              <th className="col-num">90% CI</th>
              <th className="col-num">q</th>
              <th className="col-num">2022+ gap</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ t, d20, d5, gap, hgap }) => (
              <Fragment key={t.type}>
                <tr className="research-row" onClick={() => setOpen(open === t.type ? null : t.type)}>
                  <td>
                    {t.label}
                    {t.description && <div className="research-desc">{t.description}</div>}
                  </td>
                  <td>
                    <VerdictBadge t={t} />
                  </td>
                  <td>{SOURCE_LABEL[t.source] ?? t.source}</td>
                  <td className="col-num">{d20?.n?.toLocaleString() ?? "—"}</td>
                  <td className="col-num">{pct(d5?.mean_x)}</td>
                  <td className="col-num">{pct(d20?.mean_x)}</td>
                  <td className="col-num">{pct(d20?.null_med)}</td>
                  <td className={`col-num ${gap == null ? "" : gap < 0 ? "neg" : "pos"}`}>{pct(gap)}</td>
                  <td className="col-num">
                    {d20?.ci_lo != null ? `${pct(d20.ci_lo, 1)} … ${pct(d20.ci_hi, 1)}` : "—"}
                  </td>
                  <td className="col-num">{d20?.q != null ? d20.q.toFixed(3) : "—"}</td>
                  <td className="col-num">{hgap != null ? pct(hgap) : "sealed"}</td>
                </tr>
                {open === t.type && (
                  <tr className="research-expand">
                    <td colSpan={11}>
                      {t.verdict_note && <p className="research-note">{t.verdict_note}</p>}
                      {samples.length === 0 ? (
                        <p className="empty-state">No events of this type in the past year.</p>
                      ) : (
                        <ul className="catalyst-list">
                          {samples.map((e) => (
                            <li key={e.id}>
                              <span className="catalyst-date">{e.event_date}</span>
                              <Link to={`/symbol/${e.symbol}`}>{e.symbol}</Link>
                              {e.detail && <span className="catalyst-detail">{e.detail}</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const PAGE = 100;

function Feed({ types }: { types: Map<string, CatalystType> }) {
  const [events, setEvents] = useState<CatalystEvent[]>([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(true);
  const [verdict, setVerdict] = useState<"flagged" | "avoid" | "positive" | "all">("flagged");
  const [source, setSource] = useState("all");
  const [type, setType] = useState("all");
  const [symbol, setSymbol] = useState("");

  const typeFilter = useMemo(() => {
    if (type !== "all") return [type];
    const want: Verdict[] =
      verdict === "flagged" ? ["avoid", "positive", "watch"] : verdict === "all" ? [] : [verdict];
    if (!want.length) return null;
    return [...types.values()].filter((t) => want.includes(t.verdict)).map((t) => t.type);
  }, [types, verdict, type]);

  useEffect(() => {
    setPage(0);
    setEvents([]);
  }, [verdict, source, type, symbol, types]);

  useEffect(() => {
    if (!types.size) return;
    let cancelled = false;
    setLoading(true);
    let q = supabase
      .from("research_catalyst_events")
      .select("*")
      .order("event_date", { ascending: false })
      .order("id", { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (typeFilter) q = q.in("type", typeFilter);
    if (source !== "all") q = q.eq("source", source);
    if (symbol.trim()) q = q.eq("symbol", symbol.trim().toUpperCase());
    q.then(({ data }) => {
      if (cancelled) return;
      const rows = (data ?? []) as CatalystEvent[];
      setEvents((prev) => (page === 0 ? rows : [...prev, ...rows]));
      setMore(rows.length === PAGE);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [page, typeFilter, source, symbol, types]);

  const sources = [...new Set([...types.values()].map((t) => t.source))].sort();
  const typeOptions = [...types.values()]
    .filter((t) => source === "all" || t.source === source)
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <section>
      <div className="research-filters">
        <label>
          Show{" "}
          <select value={verdict} onChange={(e) => setVerdict(e.target.value as typeof verdict)}>
            <option value="flagged">Types with a verdict</option>
            <option value="avoid">Avoid only</option>
            <option value="positive">Positive only</option>
            <option value="all">Everything</option>
          </select>
        </label>
        <label>
          Source{" "}
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">All</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s] ?? s}
              </option>
            ))}
          </select>
        </label>
        <label>
          Type{" "}
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="all">All</option>
            {typeOptions.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Symbol{" "}
          <input
            className="research-symbol"
            value={symbol}
            placeholder="e.g. SNDL"
            onChange={(e) => setSymbol(e.target.value)}
          />
        </label>
      </div>
      {events.length === 0 && !loading ? (
        <p className="empty-state">No events match.</p>
      ) : (
        <div className="trigger-feed-scroll">
          <table className="isolator-table research-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Symbol</th>
                <th>Verdict</th>
                <th>Catalyst</th>
                <th>Source</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const t = types.get(e.type);
                return (
                  <tr key={e.id}>
                    <td className="catalyst-date">{e.event_date}</td>
                    <td>
                      <Link to={`/symbol/${e.symbol}`}>{e.symbol}</Link>
                    </td>
                    <td>
                      <VerdictBadge t={t} />
                    </td>
                    <td>{t?.label ?? e.type}</td>
                    <td>{SOURCE_LABEL[e.source] ?? e.source}</td>
                    <td className="catalyst-detail">{e.detail}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {more && (
        <button className="link-button research-more" disabled={loading} onClick={() => setPage((p) => p + 1)}>
          {loading ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}

interface RedditDay {
  symbol: string;
  day: string;
  mentions: number;
  posts: number;
  score_sum: number | null;
  comments_sum: number | null;
}

function Reddit() {
  const [rows, setRows] = useState<RedditDay[] | null>(null);

  useEffect(() => {
    const since = new Date(Date.now() - 31 * 86400_000).toISOString().slice(0, 10);
    supabase
      .from("research_reddit_daily")
      .select("*")
      .gte("day", since)
      .limit(20000)
      .then(({ data }) => setRows((data ?? []) as RedditDay[]));
  }, []);

  const table = useMemo(() => {
    if (!rows?.length) return [];
    const last = rows.reduce((m, r) => (r.day > m ? r.day : m), "");
    const weekAgo = new Date(Date.parse(last) - 7 * 86400_000).toISOString().slice(0, 10);
    const by = new Map<string, { today: number; week: number; month: number; score: number }>();
    for (const r of rows) {
      const s = by.get(r.symbol) ?? { today: 0, week: 0, month: 0, score: 0 };
      s.month += r.mentions;
      if (r.day > weekAgo) s.week += r.mentions;
      if (r.day === last) {
        s.today += r.mentions;
        s.score += r.score_sum ?? 0;
      }
      by.set(r.symbol, s);
    }
    return [...by.entries()]
      .map(([symbol, s]) => ({ symbol, ...s, spike: s.today / Math.max(s.month / 30, 0.5) }))
      .sort((a, b) => b.today - a.today || b.week - a.week)
      .slice(0, 100);
  }, [rows]);

  if (rows === null) return <p className="empty-state">Loading…</p>;
  if (!rows.length)
    return (
      <p className="empty-state">
        No Reddit data yet. The collector (research/catalysts/reddit_collect.py) is forward-only and starts once its
        Reddit API credentials are set; mention spikes become testable after a few months of history.
      </p>
    );
  return (
    <section>
      <p className="research-intro">
        Ticker mentions across tracked subreddits. Spike = the latest day's mentions vs the 30-day daily average. Not
        yet a tested catalyst — there's no history before the collector started.
      </p>
      <div className="trigger-feed-scroll">
        <table className="isolator-table research-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th className="col-num">Latest day</th>
              <th className="col-num">7 days</th>
              <th className="col-num">30 days</th>
              <th className="col-num">Spike</th>
              <th className="col-num">Score</th>
            </tr>
          </thead>
          <tbody>
            {table.map((r) => (
              <tr key={r.symbol}>
                <td>
                  <Link to={`/symbol/${r.symbol}`}>{r.symbol}</Link>
                </td>
                <td className="col-num">{r.today}</td>
                <td className="col-num">{r.week}</td>
                <td className="col-num">{r.month}</td>
                <td className="col-num">{r.spike.toFixed(1)}×</td>
                <td className="col-num">{r.score.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface Study {
  key: string;
  title: string;
  summary_md: string;
  updated_at: string;
}

function Studies() {
  const [studies, setStudies] = useState<Study[] | null>(null);
  const [key, setKey] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("research_studies")
      .select("*")
      .order("sort")
      .then(({ data }) => {
        const s = (data ?? []) as Study[];
        setStudies(s);
        setKey(s[0]?.key ?? null);
      });
  }, []);

  if (studies === null) return <p className="empty-state">Loading…</p>;
  const current = studies.find((s) => s.key === key);
  return (
    <section className="research-studies">
      <nav className="research-study-list">
        {studies.map((s) => (
          <button key={s.key} className={`research-tab${s.key === key ? " active" : ""}`} onClick={() => setKey(s.key)}>
            {s.title}
          </button>
        ))}
      </nav>
      {current && (
        <article className="research-study">
          <p className="research-note">Updated {new Date(current.updated_at).toLocaleString()}</p>
          <Markdown source={current.summary_md} />
        </article>
      )}
    </section>
  );
}
