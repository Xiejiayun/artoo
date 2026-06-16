/**
 * Same-origin relative app path only (#34, codex hard-req 1): reject absolute
 * URLs, protocol-relative (`//host`), and backslash / path-confusion variants;
 * fall back to the app root. The server validates again — this is defence in depth.
 */
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
    <div className="login-page">
      <h1>artoo</h1>
      <p>Sign in to access your team workspace.</p>
      <button type="button" className="login-google" onClick={signIn}>
        Sign in with Google
      </button>
    </div>
  );
}
