import { Link } from "react-router-dom";
import logo from "../assets/SS_SingleLine_Logo.png";

/**
 * The StackSlash logo, linking home to the feed. Every signed-in page puts
 * this at the top of its header instead of a separate "back to feed"
 * button, so there is always one consistent way home (the browser's Back
 * goes to the previous page, which isn't always the feed).
 */
export function BrandHomeLink() {
  return (
    <Link to="/" className="brand-logo-link" aria-label="Home — back to feed">
      <img src={logo} alt="StackSlash" className="brand-logo" />
    </Link>
  );
}
