import { Link } from "react-router-dom";
// Web-sized copy (900px) of RiotLogo_r2.png (8110px, transparent).
import logo from "../assets/riot-logo-header.png";

/**
 * The StackSlash logo, linking home to the feed. Every signed-in page puts
 * this at the top of its header instead of a separate "back to feed"
 * button, so there is always one consistent way home (the browser's Back
 * goes to the previous page, which isn't always the feed).
 */
export function BrandHomeLink() {
  return (
    <Link to="/" className="brand-logo-link" aria-label="Home — back to feed">
      <img src={logo} alt="RIOT — Ranked Intraday Outlier Telemetry" className="brand-logo" />
    </Link>
  );
}
