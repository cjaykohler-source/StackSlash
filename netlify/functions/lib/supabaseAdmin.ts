import { createClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client using the service-role key, which bypasses
 * RLS. This must only ever be imported from Netlify Functions (server
 * code) — never from src/ (browser code). The env vars below are
 * deliberately NOT prefixed with VITE_ so Vite never bundles them into the
 * client.
 */
export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars (set in Netlify site settings).",
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
