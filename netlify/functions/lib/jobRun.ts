import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Wraps a job's work in a job_runs row so a silently-dead scheduled
 * function is visible in the DB instead of invisible. Every job (eod-scan,
 * intraday-scan, deep-dive) should call this rather than running bare.
 */
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
          error: err instanceof Error ? err.message : String(err),
        })
        .eq("id", run.id);
    }
    throw err;
  }
}
