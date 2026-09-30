import { NavLink } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { BrandHomeLink } from "./BrandHomeLink";
import { SymbolSearch } from "./SymbolSearch";

const PAGES: [string, string][] = [
  ["/isolator", "Isolator"],
  ["/reports", "Reports"],
  ["/research", "Research"],
  ["/ops", "Ops"],
  ["/settings", "Settings"],
  ["/about", "About"],
];

/**
 * The one header every signed-in page renders: logo (home), symbol search
 * and the page buttons, always in the same place. The current page's
 * button is marked active (red, with a soft glow).
 */
export function AppHeader() {
  return (
    <header className="page-header app-header">
      <BrandHomeLink />
      <SymbolSearch />
      <nav className="header-actions" aria-label="Pages">
        {PAGES.map(([to, label]) => (
          <NavLink key={to} to={to} className={({ isActive }) => `link-button${isActive ? " active" : ""}`}>
            {label}
          </NavLink>
        ))}
        <button className="link-button" onClick={() => supabase.auth.signOut()}>
          Sign out
        </button>
      </nav>
    </header>
  );
}
