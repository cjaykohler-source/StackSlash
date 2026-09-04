import { supabase } from "./supabaseClient.js";
import { config } from "./config.js";

/**
 * Long-running analog of netlify/functions/lib/jobRun.ts. That helper
 * assumes a short start->finish job; this worker runs indefinitely, so
 * instead of one row per run, it holds one row open for the life of the
 * process and periodically bumps finished_at + rows_processed (tick
 * count) so the ops view (job_runs) can show "still alive, last seen X"
 * for the streaming worker the same way it shows scheduled-function health.
 */
export class Heartbeat {
  private jobRunId: number | null = null;
  private tickCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  async start() {
    const { data, error } = await supabase
      .from("job_runs")
      .insert({ job_name: "realtime-outlier-worker", status: "running" })
      .select("id")
      .single();
    if (error) {
      // eslint-disable-next-line no-console
      console.error("Failed to write initial heartbeat row", error);
      return;
    }
    this.jobRunId = data.id;

    this.timer = setInterval(() => {
      void this.beat();
    }, config.heartbeatIntervalMs);
  }

  recordTick() {
    this.tickCount += 1;
  }

  private async beat() {
    if (this.jobRunId === null) return;
    await supabase
      .from("job_runs")
      .update({ finished_at: new Date().toISOString(), rows_processed: this.tickCount })
      .eq("id", this.jobRunId);
  }

  async stop(status: "ok" | "error", errorMessage?: string) {
    if (this.timer) clearInterval(this.timer);
    if (this.jobRunId === null) return;
    await supabase
      .from("job_runs")
      .update({
        finished_at: new Date().toISOString(),
        status,
        rows_processed: this.tickCount,
        error: errorMessage ?? null,
      })
      .eq("id", this.jobRunId);
  }
}
