import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { lookupAsset } from "./lib/alpaca";
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
 * Before checking, it reconciles delisted symbols: `stale_active_symbol`
 * counts active symbols with no bar in 10 days, and nothing else in this
 * project ever marks a delisted ticker inactive, so that count could only
 * grow (GLMD and RAY pushed it 13 -> 15 on 2026-09-19 after delisting).
 * Alpaca's asset record is the authority: status "inactive" means the
 * listing is gone and bars will never arrive again, so the symbol is
 * deactivated. A symbol that is still listed but merely halted stays
 * active and keeps being reported, which is the signal worth seeing.
 *
 * Alerting is on *deltas*, not absolute counts. This universe has ~736
 * legitimately gappy symbols (halts, delistings, recent listings); that
 * number being 736 is not news, it being 900 tomorrow is. A check that
 * pages every night is a check that gets muted.
 *
 * That last line was true and the check was violating it. Until
 * 2026-09-21 the two noisy critical classes counted ALL of bars_daily --
 * 5.4M rows, five years -- so they were cumulative and monotonically
 * increasing, gaining roughly a row per session as new bars landed. A
 * critical class alerts on any increase, so the check paged on +1 against
 * a 46,000-row baseline. Two fixes, both in check_data_integrity():
 *
 *   - The critical classes are now `split_scale_break_30d` and
 *     `implausible_price_30d`, scoped to the last 30 days. A five-year-old
 *     artifact is a permanent fact about the archive; a new one on this
 *     week's bars is news. Full-history counts stay as `info` for context.
 *   - `implausible_price` no longer flags BRK.A. A raw threshold cannot
 *     separate it from the 132 micro-caps whose split-adjusted history was
 *     back-adjusted through large reverse splits (SXTC and friends reach
 *     $100M/share) -- both land in the same price buckets. What separates
 *     them is whether the symbol is expensive TODAY, so a high historical
 *     close only counts when the latest close is itself ordinary.
 *
 * Result: the critical surface went from 46,364 rows to 4 -- the reverse
 * splits of UZX, EPOW, JAGX and NCT on 09-08/09, which are exactly the
 * interleaved-split-scale class this check exists to catch.
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
    const deactivated = await deactivateDelisted(db);

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
      const note = deactivated.length
        ? `\n_(deactivated as delisted this run: ${deactivated.join(", ")})_`
        : "";
      await sendOperationalAlert(`⚠️ **Data integrity regression**\n${regressions.join("\n")}${note}`);
      alerted = true;
    }

    return {
      rowsProcessed: issues.length,
      result: {
        deactivated,
        issues: Object.fromEntries(issues.map((i) => [i.issue_type, i.affected_count])),
        regressions,
        alerted,
      },
    };
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};

/**
 * Set `active = false` on stale symbols Alpaca reports as delisted.
 * Deliberately conservative: only "inactive" or a 404 (the asset record is
 * gone entirely) deactivates. Tradable-but-silent symbols — long halts like
 * SVA or HCHL — are left alone, because they can resume. One asset lookup
 * per stale symbol, and there are ~15 of them.
 */
async function deactivateDelisted(db: ReturnType<typeof getSupabaseAdmin>): Promise<string[]> {
  const { data, error } = await db.rpc("stale_active_symbols");
  if (error) throw error;
  const stale = (data as { id: number; ticker: string }[]) ?? [];

  const delisted: { id: number; ticker: string }[] = [];
  for (const s of stale) {
    try {
      const asset = await lookupAsset(s.ticker);
      if (!asset.found || asset.status === "inactive") delisted.push(s);
    } catch (err) {
      // A lookup failure is not evidence of a delisting — skip and retry
      // tomorrow rather than deactivating a live symbol on an API blip.
      console.warn(`asset lookup failed for ${s.ticker}:`, err);
    }
  }

  if (delisted.length) {
    const { error: updateErr } = await db
      .from("symbols")
      .update({ active: false })
      .in("id", delisted.map((s) => s.id));
    if (updateErr) throw updateErr;
  }
  return delisted.map((s) => s.ticker);
}
