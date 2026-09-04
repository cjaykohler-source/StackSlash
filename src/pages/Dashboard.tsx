import { supabase } from "../lib/supabaseClient";
import { RegimeBanner } from "../components/RegimeBanner";
import { TriggerFeed } from "../components/TriggerFeed";

export function Dashboard() {
  return (
    <div className="page">
      <header className="page-header">
        <h1>StackSlash Scanner</h1>
        <button className="link-button" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </header>
      <RegimeBanner />
      <section>
        <h2>Trigger feed</h2>
        <TriggerFeed />
      </section>
    </div>
  );
}
