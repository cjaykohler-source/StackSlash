import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { BrandHomeLink } from "../components/BrandHomeLink";

/**
 * One place to see every recurring process: launchd jobs on the worker
 * host, Netlify scheduled functions and Supabase pg_cron. Built from
 *   ops_jobs         the registry (schedule, group, overdue threshold)
 *   ops_job_summary  latest job_runs row + 7-day counts per job
 *   job_runs         the last day of runs, for the per-job strip
 *   ops_host_status  launchd state pushed every 5 min by scripts/ops_heartbeat.py
 * Jobs that don't write job_runs (local scripts) are judged from the
 * heartbeat alone: last exit status and newest log time.
 */

interface OpsJob {
  name: string;
  host: "launchd" | "netlify" | "pg_cron";
  grp: string;
  schedule_text: string;
  description: string | null;
  stale_after: string;
  weekdays_only: boolean;
  market_hours: boolean;
  records_runs: boolean;
  sort: number;
}
interface Summary {
  job_name: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  rows_processed: number | null;
  error: string | null;
  runs_7d: number;
  fails_7d: number;
  avg_secs: number | null;
}
interface HostStatus {
  label: string;
  loaded: boolean | null;
  pid: number | null;
  last_exit: number | null;
  last_log_at: string | null;
  updated_at: string;
}
interface Run {
  job_name: string;
  started_at: string;
  status: string;
}

type State = "ok" | "running" | "failed" | "stuck" | "overdue" | "idle" | "never" | "not-loaded";
const STATE_LABEL: Record<State, string> = {
  ok: "OK",
  running: "Running",
  failed: "Failed",
  stuck: "Stuck",
  overdue: "Overdue",
  idle: "Idle (off-hours)",
  never: "No runs",
  "not-loaded": "Not loaded",
};
const GROUPS = ["Market hours", "Always on", "Daily", "End of day", "Weekly"];

/** Postgres interval text ("20:00:00", "1 day 02:00:00", "8 days") -> ms. */
function intervalMs(v: string): number {
  let ms = 0;
  const d = /(\d+)\s+days?/.exec(v);
  if (d) ms += +d[1] * 86_400_000;
  const t = /(\d+):(\d+):(\d+)/.exec(v);
  if (t) ms += (+t[1] * 3600 + +t[2] * 60 + +t[3]) * 1000;
  return ms;
}

function etParts(now: Date) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return { day: get("weekday"), hhmm: +get("hour") * 100 + +get("minute") };
}

function ago(ts: string | null | undefined, now: number): string {
  if (!ts) return "—";
  const s = Math.max(0, (now - Date.parse(ts)) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172_800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function judge(job: OpsJob, sum: Summary | undefined, hs: HostStatus | undefined, now: Date): { state: State; last: string | null } {
  const last = job.records_runs ? sum?.started_at ?? null : hs?.last_log_at ?? null;
  if (job.host === "launchd" && hs && hs.loaded === false) return { state: "not-loaded", last };
  // always-on services (KeepAlive) are healthy while their process is alive,
  // whatever their start-of-life job_runs row says
  if (job.grp === "Always on" && hs?.pid) return { state: "running", last: hs.updated_at };
  if (job.grp === "Always on" && hs && !hs.pid && job.stale_after.startsWith("3650")) return { state: "failed", last };
  if (job.records_runs && sum?.status === "running") {
    return { state: now.getTime() - Date.parse(sum.started_at) > 2 * 3600_000 ? "stuck" : "running", last };
  }
  if (job.records_runs ? sum && (sum.status === "failed" || sum.status === "error") : hs?.last_exit != null && hs.last_exit !== 0) {
    return { state: "failed", last };
  }
  if (!last) return { state: "never", last };
  const { day, hhmm } = etParts(now);
  const weekend = day === "Sat" || day === "Sun";
  if (job.market_hours && (weekend || hhmm < 930 || hhmm > 1600)) return { state: "idle", last };
  let window = intervalMs(job.stale_after);
  if (job.weekdays_only && (weekend || day === "Mon")) window += 2 * 86_400_000;
  return { state: now.getTime() - Date.parse(last) > window ? "overdue" : "ok", last };
}

export function Ops() {
  const [jobs, setJobs] = useState<OpsJob[]>([]);
  const [sums, setSums] = useState<Map<string, Summary>>(new Map());
  const [host, setHost] = useState<Map<string, HostStatus>>(new Map());
  const [runs, setRuns] = useState<Map<string, Run[]>>(new Map());
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 26 * 3600_000).toISOString();
    const [j, s, h, r] = await Promise.all([
      supabase.from("ops_jobs").select("*").order("sort"),
      supabase.from("ops_job_summary").select("*"),
      supabase.from("ops_host_status").select("*"),
      supabase
        .from("job_runs")
        .select("job_name, started_at, status")
        .gte("started_at", since)
        .order("started_at", { ascending: false })
        .limit(1000),
    ]);
    setJobs((j.data ?? []) as OpsJob[]);
    setSums(new Map(((s.data ?? []) as Summary[]).map((x) => [x.job_name, x])));
    setHost(new Map(((h.data ?? []) as HostStatus[]).map((x) => [x.label, x])));
    const byJob = new Map<string, Run[]>();
    for (const run of (r.data ?? []) as Run[]) {
      const list = byJob.get(run.job_name) ?? [];
      if (list.length < 24) list.push(run);
      byJob.set(run.job_name, list);
    }
    setRuns(byJob);
    setLoadedAt(new Date());
  }, []);

  useEffect(() => {
    load();
    const a = setInterval(load, 60_000);
    const b = setInterval(() => setNow(new Date()), 15_000);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [load]);

  const rows = useMemo(
    () => jobs.map((job) => ({ job, sum: sums.get(job.name), hs: host.get(job.name), ...judge(job, sums.get(job.name), host.get(job.name), now) })),
    [jobs, sums, host, now],
  );
  const counts = useMemo(() => {
    const c: Partial<Record<State, number>> = {};
    for (const r of rows) c[r.state] = (c[r.state] ?? 0) + 1;
    return c;
  }, [rows]);

  const hostRow = host.get("_host");
  const hostAge = hostRow ? now.getTime() - Date.parse(hostRow.updated_at) : Infinity;
  const nowMs = now.getTime();

  return (
    <div className="page">
      <header className="page-header">
        <BrandHomeLink />
        <h1>Ops</h1>
        <div className="header-actions">
          <button className="link-button" onClick={load}>
            Refresh
          </button>
          <Link to="/" className="link-button">
            Dashboard
          </Link>
        </div>
      </header>

      <div className={`ops-banner ${hostAge < 15 * 60_000 ? "ops-banner-ok" : "ops-banner-bad"}`}>
        {hostRow
          ? hostAge < 15 * 60_000
            ? `Worker host up — heartbeat ${ago(hostRow.updated_at, nowMs)}`
            : `Worker host silent since ${new Date(hostRow.updated_at).toLocaleString()} — every launchd job is down (machine off, asleep, or heartbeat stopped)`
          : "No heartbeat from the worker host yet (com.stackslash.ops-heartbeat)"}
        <span className="ops-counts">
          {(Object.keys(STATE_LABEL) as State[])
            .filter((s) => counts[s])
            .map((s) => (
              <span key={s} className={`ops-pill ops-${s}`}>
                {counts[s]} {STATE_LABEL[s]}
              </span>
            ))}
        </span>
      </div>

      <div className="trigger-feed-scroll ops-panel">
        <table className="ops-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Job</th>
              <th>Where</th>
              <th>Schedule (ET)</th>
              <th>Last run</th>
              <th className="col-num">Took</th>
              <th className="col-num">Rows</th>
              <th className="col-num">7d runs / fails</th>
              <th>Recent</th>
            </tr>
          </thead>
          <tbody>
            {GROUPS.map((g) => {
              const inGroup = rows.filter((r) => r.job.grp === g);
              if (!inGroup.length) return null;
              return (
                <Fragment key={g}>
                  <tr className="ops-group">
                    <td colSpan={9}>{g}</td>
                  </tr>
                  {inGroup.map(({ job, sum, hs, state, last }, idx) => {
                    const took =
                      job.records_runs && sum?.finished_at
                        ? Math.round((Date.parse(sum.finished_at) - Date.parse(sum.started_at)) / 1000)
                        : null;
                    const detail =
                      (job.records_runs ? sum?.error : null) ??
                      (hs && !job.records_runs && hs.last_exit ? `launchd last exit status ${hs.last_exit}` : null);
                    return (
                      <Fragment key={job.name}>
                        <tr
                          className={`ops-row ops-row-${state}${idx % 2 ? " ops-row-alt" : ""}${open === job.name ? " ops-row-open" : ""}`}
                          onClick={() => setOpen(open === job.name ? null : job.name)}
                        >
                          <td>
                            <span className={`ops-pill ops-${state}`}>{STATE_LABEL[state]}</span>
                          </td>
                          <td>
                            {job.name}
                            {job.description && <div className="research-desc">{job.description}</div>}
                          </td>
                          <td className="ops-dim">{job.host}</td>
                          <td className="ops-dim">{job.schedule_text}</td>
                          <td title={last ?? undefined}>{ago(last, nowMs)}</td>
                          <td className="col-num">{took != null ? `${took}s` : "—"}</td>
                          <td className="col-num">{sum?.rows_processed?.toLocaleString() ?? "—"}</td>
                          <td className="col-num">
                            {job.records_runs ? (
                              <>
                                {sum?.runs_7d ?? 0} / <span className={sum?.fails_7d ? "neg" : ""}>{sum?.fails_7d ?? 0}</span>
                              </>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td>
                            <span className="ops-strip">
                              {(runs.get(job.name) ?? [])
                                .slice()
                                .reverse()
                                .map((r, i) => (
                                  <span key={i} className={`ops-tick ops-tick-${r.status}`} title={`${r.started_at} ${r.status}`} />
                                ))}
                            </span>
                          </td>
                        </tr>
                        {open === job.name && (
                          <tr className="ops-expand">
                            <td colSpan={9}>
                              <div className="ops-detail">
                                {detail && <pre className="ops-error">{detail}</pre>}
                                <div>
                                  Overdue after {job.stale_after}
                                  {job.weekdays_only ? " (weekdays)" : ""}
                                  {job.market_hours ? ", market hours only" : ""}.{" "}
                                  {job.records_runs ? "Judged from job_runs." : "Judged from the host heartbeat (no job_runs rows)."}
                                </div>
                                {hs && (
                                  <div>
                                    launchd: {hs.loaded ? "loaded" : "not loaded"}
                                    {hs.pid ? `, running (pid ${hs.pid})` : ""}, last exit {hs.last_exit ?? "—"}, newest log{" "}
                                    {ago(hs.last_log_at, nowMs)}
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="research-note">
        Refreshes every minute{loadedAt ? ` · loaded ${loadedAt.toLocaleTimeString()}` : ""}. Click a row for details.
      </p>
    </div>
  );
}
