import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { sendOperationalAlert } from "./lib/notify";

/**
 * Nightly data-integrity sweep.
 *
 * Every silent-corruption bug this project has hit shared one shape: no
 * error raised, just quietly wrong numbers that were believed and acted
 * on — sometimes for months, twice all the way into a reported finding.
 * The 1,000-row PostgREST cap (five separate instances), the
 * forward-return misalignment across delisting gaps, close-only
 * bars_daily rows breaking every intrabar sim, interleaved split scales
 * producing +40,000% three-day returns. All of them were detectable by
 * a query somebody simply never ran on a schedule.
 *
 * So: run them on a schedule. The heavy lifting is one Postgres function
 * (`check_data_integrity()`), which does a single windowed pass over
 * bars_daily and returns a count per issue class.
 *
 * Alerting is on *deltas*, not absolute counts. This universe has ~736
 * legitimately gappy symbols (halts, delistings, recent listings); that
 * number being 736 is not news, it being 900 tomorrow is. A check that
 * pages every night is a check that gets muted.
 */

// Issue classes that corrupt math rather than merely describing a messy
// universe — these alert on any increase at all.
const CRITICAL_SEVERITIES = new Set(["critical"]);

// A warn-level class has to move by more than this to be worth a ping.
const WARN_DELTA_THRESHOLD = 0.05;

type IssueRow = {
  issue_type: string;
  severity: string;
  affected_count: number;
  distinct_symbols: number;
};

export default async (_req?: Request) => {
  const db = getSupabaseAdmin();

  const result = await withJobRun(db, "data-integrity-check", async () => {
    const { data, error } = await db.rpc("check_data_integrity");
    if (error) throw error;
    const issues = (data as IssueRow[]) ?? [];

    // Previous run, for delta comparison — one row per issue_type.
    const { data: priorRows, error: priorErr } = await db
      .from("data_quality_issues")
      .select("issue_type, affected_count, checked_at")
      .order("checked_at", { ascending: false })
      .limit(200);
    if (priorErr) throw priorErr;

    const prior = new Map<string, number>();
    for (const row of (priorRows as { issue_type: string; affected_count: number }[]) ?? []) {
      if (!prior.has(row.issue_type)) prior.set(row.issue_type, row.affected_count);
    }

    const checkedAt = new Date().toISOString();
    const { error: insertErr } = await db.from("data_quality_issues").insert(
      issues.map((i) => ({
        checked_at: checkedAt,
        issue_type: i.issue_type,
        severity: i.severity,
        affected_count: i.affected_count,
        distinct_symbols: i.distinct_symbols,
        details: { previous_count: prior.get(i.issue_type) ?? null },
      })),
    );
    if (insertErr) throw insertErr;

    const regressions: string[] = [];
    for (const i of issues) {
      if (i.affected_count === 0) continue;
      const before = prior.get(i.issue_type);

      // First sighting of a critical class is itself the alert — there is
      // no baseline to compare against and zero is the only correct value.
      if (before === undefined) {
        if (CRITICAL_SEVERITIES.has(i.severity)) {
          regressions.push(`NEW ${i.issue_type}: ${i.affected_count} rows across ${i.distinct_symbols} symbols`);
        }
        continue;
      }

      const grew = CRITICAL_SEVERITIES.has(i.severity)
        ? i.affected_count > before
        : i.affected_count > before * (1 + WARN_DELTA_THRESHOLD);

      if (grew) {
        regressions.push(
          `${i.issue_type}: ${before} → ${i.affected_count} rows (${i.distinct_symbols} symbols)`,
        );
      }
    }

    let alerted = false;
    if (regressions.length) {
      await sendOperationalAlert(`⚠️ **Data integrity regression**\n${regressions.join("\n")}`);
      alerted = true;
    }

    return {
      rowsProcessed: issues.length,
      result: {
        issues: Object.fromEntries(issues.map((i) => [i.issue_type, i.affected_count])),
        regressions,
        alerted,
      },
    };
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};
