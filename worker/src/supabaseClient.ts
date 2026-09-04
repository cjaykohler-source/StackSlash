import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

// Standalone copy of netlify/functions/lib/supabaseAdmin.ts's pattern —
// this worker is a separate deployable (own package.json/Docker image),
// not bundled with the Netlify functions, so it can't share that module
// directly. Same service-role usage: bypasses RLS, server-side only.
export const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
