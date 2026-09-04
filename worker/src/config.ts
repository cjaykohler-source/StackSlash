function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const config = {
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  alpacaKeyId: required("ALPACA_API_KEY_ID"),
  alpacaSecretKey: required("ALPACA_API_SECRET_KEY"),
  alpacaStreamUrl: process.env.ALPACA_STREAM_URL ?? "wss://stream.data.alpaca.markets/v2/iex",
  outlierTriggerName: process.env.OUTLIER_TRIGGER_NAME ?? "realtime_outlier_zscore",
  ewmaAlpha: Number(process.env.EWMA_ALPHA ?? "0.05"),
  zScoreThreshold: Number(process.env.Z_SCORE_THRESHOLD ?? "3.0"),
  minTicksBeforeEval: Number(process.env.MIN_TICKS_BEFORE_EVAL ?? "30"),
  heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS ?? "60000"),
};
