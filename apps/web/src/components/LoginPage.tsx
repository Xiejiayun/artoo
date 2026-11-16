/**
 * Same-origin relative app path only (#34, codex hard-req 1): reject absolute
 * URLs, protocol-relative (`//host`), and backslash / path-confusion variants;
 * fall back to the app root. The server validates again — this is defence in depth.
 */
import { t } from "../app/i18n.js";
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
      <div className="welcome-panel">
        <span className="login-brand">
          <span className="brand-mark" aria-hidden="true" />
          <strong>artoo OS</strong>
        </span>
        <span className="os-eyebrow">The control plane for your agents</span>
        <h2>
          One team.
          <br />
          Any machine.
          <br />
          <span>Ship together.</span>
        </h2>
        <p>
          Bring your coding agents into one workspace. Turn an idea into a plan, follow the execution, and review the
          evidence.
        </p>
        <div className="welcome-features">
          <span>
            <Bot size={18} aria-hidden="true" />
            <span>
              <strong>Agents work as a squad</strong>
              <small>One project, clear roles and shared context.</small>
            </span>
          </span>
          <span>
            <Monitor size={18} aria-hidden="true" />
            <span>
              <strong>Your machines, your workspaces</strong>
              <small>Connect a node and choose where work runs.</small>
            </span>
          </span>
          <span>
            <ShieldCheck size={18} aria-hidden="true" />
            <span>
              <strong>Every step stays visible</strong>
              <small>Real runs, human review and release evidence.</small>
            </span>
          </span>
        </div>
        <footer>ARTOO · AGENT WORKSPACE</footer>
      </div>
      <div className="login-card welcome-signin">
        <div className="os-login-theme">
          <ThemeControl />
        </div>
        <span className="os-eyebrow">{t("login.eyebrow")}</span>
        <h1 className="t-display">{t("login.title")}</h1>
        <p className="t-body t-muted login-lede">{t("login.lede")}</p>
        <Button variant="primary" size="md" className="login-submit" iconRight={ArrowRight} onClick={signIn}>
          {t("login.submit")}
        </Button>
        <p className="login-foot t-caption t-subtle">{t("login.foot")}</p>
      </div>
    </div>
  );
}
