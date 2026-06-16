/**
 * Google Auth wiring config (#34 slice 34-1c). Carried on {@link ServerContext}
 * alongside {@link DeviceAuthConfig}. Holds the OIDC provider coordinates, cookie
 * names, TTLs, the optional hosted-domain policy, and whether the protected-API
 * guard is enforced.
 *
 * Fail-closed: {@link loadAuthConfig} requires the Google client id / secret /
 * redirect uri (the `client_secret` only ever comes from env / a private channel,
 * never source or a public channel). Tests inject {@link testAuthConfig}, which
 * points at the in-process fake OIDC provider and never needs real credentials.
 */
export interface GoogleOidcConfig {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  clientId: string;
  clientSecret: string;
  /** The server callback URL registered with Google. */
  redirectUri: string;
}

export interface AuthConfig {
  google: GoogleOidcConfig;
  sessionCookieName: string;
  flowCookieName: string;
  sessionTtlMs: number;
  flowTtlMs: number;
  /** Restrict logins to a Google Workspace domain (`hd` claim) when set. */
  hostedDomain?: string | undefined;
  /** `Secure` cookie attribute — true in production / over https. */
  secureCookies: boolean;
  /** When true, the protected-API guard requires a valid session on /api/v1 REST
   *  routes (paired with the web `VITE_AUTH_ENABLED`). Default off so existing
   *  unauthenticated dev/test flows keep working. */
  enforceApiAuth: boolean;
}

export interface AuthConfigEnv {
  NODE_ENV?: string | undefined;
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
  GOOGLE_REDIRECT_URI?: string | undefined;
  GOOGLE_ISSUER?: string | undefined;
  GOOGLE_AUTHORIZATION_ENDPOINT?: string | undefined;
  GOOGLE_TOKEN_ENDPOINT?: string | undefined;
  GOOGLE_JWKS_URI?: string | undefined;
  GOOGLE_HOSTED_DOMAIN?: string | undefined;
  AUTH_SESSION_TTL_MS?: string | undefined;
  AUTH_FLOW_TTL_MS?: string | undefined;
  AUTH_SECURE_COOKIES?: string | undefined;
  AUTH_ENFORCE_API?: string | undefined;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TEN_MIN_MS = 10 * 60 * 1000;

function positiveIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Load Google-auth config from env, failing closed without client credentials. */
export function loadAuthConfig(env: AuthConfigEnv): AuthConfig {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = env.GOOGLE_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI are required for Google Auth",
    );
  }
  const isProd = env.NODE_ENV === "production";
  return {
    google: {
      issuer: env.GOOGLE_ISSUER?.trim() || "https://accounts.google.com",
      authorizationEndpoint:
        env.GOOGLE_AUTHORIZATION_ENDPOINT?.trim() || "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: env.GOOGLE_TOKEN_ENDPOINT?.trim() || "https://oauth2.googleapis.com/token",
      jwksUri: env.GOOGLE_JWKS_URI?.trim() || "https://www.googleapis.com/oauth2/v3/certs",
      clientId,
      clientSecret,
      redirectUri,
    },
    sessionCookieName: "artoo_session",
    flowCookieName: "artoo_auth_flow",
    sessionTtlMs: positiveIntOr(env.AUTH_SESSION_TTL_MS, WEEK_MS),
    flowTtlMs: positiveIntOr(env.AUTH_FLOW_TTL_MS, TEN_MIN_MS),
    hostedDomain: env.GOOGLE_HOSTED_DOMAIN?.trim() || undefined,
    secureCookies: isProd || env.AUTH_SECURE_COOKIES === "1",
    enforceApiAuth: env.AUTH_ENFORCE_API === "1",
  };
}

/** Fixed config for tests/fixtures, pointed at the in-process fake OIDC provider. */
export function testAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    google: {
      issuer: "https://fake-oidc.test",
      authorizationEndpoint: "https://fake-oidc.test/authorize",
      tokenEndpoint: "https://fake-oidc.test/token",
      jwksUri: "https://fake-oidc.test/jwks",
      clientId: "test-client",
      clientSecret: "test-secret",
      redirectUri: "http://127.0.0.1/auth/google/callback",
    },
    sessionCookieName: "artoo_session",
    flowCookieName: "artoo_auth_flow",
    sessionTtlMs: 3_600_000,
    flowTtlMs: 600_000,
    secureCookies: false,
    enforceApiAuth: false,
    ...overrides,
  };
}
