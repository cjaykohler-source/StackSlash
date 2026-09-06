import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { RegimeBanner } from "../components/RegimeBanner";
import { TriggerFeed } from "../components/TriggerFeed";
import { SymbolSearch } from "../components/SymbolSearch";
import logo from "../assets/SS_SingleLine_Logo.png";

export function Dashboard() {
  return (
    <div className="page">
      <header className="page-header">
        <img src={logo} alt="StackSlash" className="brand-logo" />
        <SymbolSearch />
        <div className="header-actions">
          <Link to="/reports" className="link-button">
            Reports
          </Link>
          <Link to="/about" className="link-button">
            About
          </Link>
          <button className="link-button" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <RegimeBanner />
      <section>
        <h2>Trigger feed</h2>
        <TriggerFeed />
      </section>
    </div>
  );
}
