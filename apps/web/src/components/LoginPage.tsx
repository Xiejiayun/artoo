/**
 * Same-origin relative app path only (#34, codex hard-req 1): reject absolute
 * URLs, protocol-relative (`//host`), and backslash / path-confusion variants;
 * fall back to the app root. The server validates again — this is defence in depth.
 */
import { Button } from "../ui/index.js";
import { CheckCircle2, Hash, MessageSquare, ArrowRight } from "lucide-react";
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
      <div className="welcome-panel"><span className="login-brand"><span className="brand-mark" aria-hidden="true">a</span>artoo</span><h2>A shared place<br />to move work forward.</h2><p>Talk with your team, bring agents into the conversation, and turn decisions into finished work.</p><div className="welcome-features"><span><Hash size={20} aria-hidden="true" />Channels for every conversation</span><span><MessageSquare size={20} aria-hidden="true" />Focused replies, shared context</span><span><CheckCircle2 size={20} aria-hidden="true" />Clear assignments and review</span></div></div>
      <div className="login-card welcome-signin">
        <h1 className="t-display">Sign in to artoo</h1>
        <p className="t-body t-muted login-lede">
          Pick up the conversation with your team.
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
