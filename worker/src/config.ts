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
  // The confluence gate promotes a fire to a real trigger_event only when
  // >= 2 distinct same-direction triggers agree on a symbol within the
  // window. The worker can't import the Netlify lib, so it POSTs its fire
  // here and lets the deployed function run the gate.
  confluenceGateUrl:
    process.env.CONFLUENCE_GATE_URL ?? "https://stackslash.netlify.app/.netlify/functions/confluence-gate",
  ewmaAlpha: Number(process.env.EWMA_ALPHA ?? "0.05"),
  zScoreThreshold: Number(process.env.Z_SCORE_THRESHOLD ?? "3.0"),
  minTicksBeforeEval: Number(process.env.MIN_TICKS_BEFORE_EVAL ?? "30"),
  heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS ?? "60000"),
};
