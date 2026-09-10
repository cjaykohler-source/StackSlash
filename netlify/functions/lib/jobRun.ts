import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Wraps a job's work in a job_runs row so a silently-dead scheduled
 * function is visible in the DB instead of invisible. Every job (eod-scan,
 * intraday-scan, deep-dive) should call this rather than running bare.
 */

/**
 * Turn anything a job might throw into a legible string for job_runs.error.
 * `String(err)` on a plain object (e.g. a Supabase PostgrestError, which is
 * not an Error instance) yields the useless "[object Object]" — this keeps
 * the message, code, details and hint instead.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    const parts = [o.message, o.code, o.details, o.hint].filter(Boolean).map(String);
    if (parts.length) return parts.join(" | ");
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  return String(err);
}
export async function withJobRun<T>(
  db: SupabaseClient,
  jobName: string,
  fn: () => Promise<{ rowsProcessed: number; result: T }>,
): Promise<T> {
  const { data: run, error: insertError } = await db
    .from("job_runs")
    .insert({ job_name: jobName, status: "running" })
    .select("id")
    .single();

  if (insertError || !run) {
    // Don't let logging failures block the actual job.
    // eslint-disable-next-line no-console
    console.error("Failed to write job_runs start row", insertError);
  }

  try {
    const { rowsProcessed, result } = await fn();
    if (run) {
      await db
        .from("job_runs")
        .update({ finished_at: new Date().toISOString(), status: "ok", rows_processed: rowsProcessed })
        .eq("id", run.id);
    }
    return result;
  } catch (err) {
    if (run) {
      await db
        .from("job_runs")
        .update({
          finished_at: new Date().toISOString(),
          status: "error",
          error: describeError(err).slice(0, 2000),
        })
        .eq("id", run.id);
    }
    throw err;
  }
}
