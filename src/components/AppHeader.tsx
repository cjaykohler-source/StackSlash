import { NavLink } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { BrandHomeLink } from "./BrandHomeLink";
import { SymbolSearch } from "./SymbolSearch";

const PAGES: [string, string][] = [
  ["/research", "Research"],
  ["/reports", "Reports"],
  ["/isolator", "Isolator"],
  ["/settings", "Settings"],
  ["/about", "About"],
  ["/ops", "Ops"],
];

/**
 * The one header every signed-in page renders: logo (home) on the left;
 * symbol search and the page buttons in one right-aligned row, always in
 * the same place. The current page's button is marked active (red, with a
 * soft glow).
 */
export function AppHeader() {
  return (
    <header className="page-header app-header">
      <BrandHomeLink />
      <nav className="header-actions app-header-nav" aria-label="Pages">
        <SymbolSearch />
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
