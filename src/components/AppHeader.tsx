import { useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { BrandHomeLink } from "./BrandHomeLink";
import { SymbolSearch } from "./SymbolSearch";

const PAGES: [string, string][] = [
  ["/charter", "Charter"],
  ["/research", "Research"],
  ["/reports", "Reports"],
  ["/isolator", "Isolator"],
  ["/settings", "Settings"],
  ["/about", "About"],
  ["/ops", "Ops"],
];

// Pages built for a wide screen; on a phone they get a note pointing at desktop.
const DESKTOP_PAGES = new Set(["/research", "/isolator", "/ops"]);

/**
 * The one header every signed-in page renders: logo (home) on the left;
 * symbol search and the page buttons in one right-aligned row, always in
 * the same place. The current page's button is marked active (red, with a
 * soft glow). On a phone the page buttons fold into a Menu dropdown and the
 * search takes its own full-width row.
 */
export function AppHeader() {
  const { pathname } = useLocation();
  const menu = useRef<HTMLDetailsElement>(null);

  // Close the phone menu after navigating.
  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [pathname]);

  const links = (
    <>
      {PAGES.map(([to, label]) => (
        <NavLink key={to} to={to} className={({ isActive }) => `link-button${isActive ? " active" : ""}`}>
          {label}
        </NavLink>
      ))}
      <button className="link-button" onClick={() => supabase.auth.signOut()}>
        Sign out
      </button>
    </>
  );

  return (
    <>
      <header className="page-header app-header">
        <BrandHomeLink />
        <details className="app-menu" ref={menu}>
          <summary className="link-button">Menu</summary>
          <nav className="app-menu-list" aria-label="Pages">
            <NavLink to="/" end className={({ isActive }) => `link-button${isActive ? " active" : ""}`}>
              Feed
            </NavLink>
            {links}
          </nav>
        </details>
        <nav className="header-actions app-header-nav" aria-label="Pages">
          <SymbolSearch />
          <span className="app-header-links">{links}</span>
        </nav>
      </header>
      {DESKTOP_PAGES.has(pathname) && (
        <p className="desktop-only-note">This page is built for a wide screen. It works on a phone, but it's easier on desktop.</p>
      )}
    </>
  );
}
