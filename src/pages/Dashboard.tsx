import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { RegimeBanner } from "../components/RegimeBanner";
import { TrackingPanel } from "../components/TrackingPanel";
import { TriggerFeed } from "../components/TriggerFeed";
import { TopMovers } from "../components/TopMovers";
import { SymbolSearch } from "../components/SymbolSearch";
import logo from "../assets/SS_SingleLine_Logo.png";

export function Dashboard() {
  return (
    <div className="page">
      <header className="page-header">
        <img src={logo} alt="StackSlash" className="brand-logo" />
        <SymbolSearch />
        <div className="header-actions">
          <Link to="/isolator" className="link-button">
            Isolator
          </Link>
          <Link to="/reports" className="link-button">
            Reports
          </Link>
          <Link to="/settings" className="link-button">
            Settings
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
      <TrackingPanel />
      <div className="dashboard-body">
        <main className="dashboard-main">
          <TriggerFeed mode="today" />
        </main>
        <TopMovers />
      </div>
    </div>
  );
}
