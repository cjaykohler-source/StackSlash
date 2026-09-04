import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabaseClient";

/**
 * Client-side route guard: redirects to /login when there's no Supabase
 * session. This is the UX gate, not the security boundary — the real
 * boundary is Postgres RLS (see the "authenticated read" policies in the
 * schema), which refuses every query without a valid JWT regardless of
 * what the UI does.
 *
 * TODO (hardening): move this to a Netlify Edge Function that checks a
 * Supabase SSR cookie session and redirects before the page ever loads,
 * so an unauthenticated visitor never even receives the app shell. That
 * needs @supabase/ssr for cookie-based sessions instead of the default
 * localStorage session. Not required for v1.
 */
export function AuthGuard({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const location = useLocation();

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) {
    return <div className="centered">Loading…</div>;
  }

  if (session === null) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}
