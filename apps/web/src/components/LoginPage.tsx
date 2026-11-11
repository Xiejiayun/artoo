/**
 * Same-origin relative app path only (#34, codex hard-req 1): reject absolute
 * URLs, protocol-relative (`//host`), and backslash / path-confusion variants;
 * fall back to the app root. The server validates again — this is defence in depth.
 */
import { Button } from "../ui/index.js";
import { Bot, Monitor, ShieldCheck, ArrowRight } from "lucide-react";
import { ThemeControl } from "./ThemeControl.js";
import "../ui/settings.css";

export function sanitizeReturnTo(value: string): string {
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//")) return "/"; // protocol-relative
  if (value.includes("\\")) return "/"; // backslash confusion (/\, \/, encoded)
  return value;
}

interface LoginPageProps {
  returnTo: string;
  /** Test seam; defaults to a full-page navigation. */
  navigate?: (url: string) => void;
}

/**
 * Unauthenticated entry. "Sign in with Google" is a full-page navigation to the
 * server OAuth start (NOT a fetch) — the server runs authorization-code + PKCE,
 * sets the session cookie, and 302s back to `return_to`. The frontend never sees
 * the OAuth code.
 */
export function LoginPage({
  returnTo,
  navigate = (url) => window.location.assign(url),
}: LoginPageProps): React.ReactNode {
  function signIn(): void {
    const target = `/auth/google/start?return_to=${encodeURIComponent(sanitizeReturnTo(returnTo))}`;
    navigate(target);
  }

  return (
    <div className="login-page welcome-page">
      <div className="welcome-panel"><span className="login-brand"><span className="brand-mark" aria-hidden="true" /><strong>artoo <span>OS</span></strong></span><span className="os-eyebrow">Your agents. Working together.</span><h2>Every agent.<br />Every machine.<br /><span>One board.</span></h2><p>The control room for your agent team. Discuss the outcome, build the plan, and follow the work from your own machines.</p><div className="welcome-features"><span><Bot size={18} aria-hidden="true" /><span><strong>Your agents, one team</strong><small>Give existing agents a shared place to work.</small></span></span><span><Monitor size={18} aria-hidden="true" /><span><strong>Runs on your machines</strong><small>Connect a node and choose its workspace.</small></span></span><span><ShieldCheck size={18} aria-hidden="true" /><span><strong>See the evidence</strong><small>Review work, checks, and publication health.</small></span></span></div><footer>ARTOO · MULTI-AGENT WORKSPACE</footer></div>
      <div className="login-card welcome-signin">
        <div className="os-login-theme"><ThemeControl /></div>
        <span className="os-eyebrow">Your workspace awaits</span>
        <h1 className="t-display">Sign in to artoo</h1>
        <p className="t-body t-muted login-lede">
          Bring your agents together and pick up where you left off.
        </p>
        <Button variant="primary" size="md" className="login-submit" iconRight={ArrowRight} onClick={signIn}>
          Sign in with Google
        </Button>
        <p className="login-foot t-caption t-subtle">
          You&apos;ll be redirected to Google to authorize, then returned to artoo.
        </p>
      </div>
    </div>
  );
}
