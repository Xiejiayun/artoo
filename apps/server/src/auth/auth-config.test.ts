import { describe, expect, it } from "vitest";

import { loadAuthConfig, testAuthConfig } from "./auth-config.js";

const CREDS = {
  GOOGLE_CLIENT_ID: "id-123",
  GOOGLE_CLIENT_SECRET: "secret-xyz",
  GOOGLE_REDIRECT_URI: "https://app.example/auth/google/callback",
};

describe("loadAuthConfig", () => {
  it("fails closed without google client credentials", () => {
    expect(() => loadAuthConfig({})).toThrow(/GOOGLE_CLIENT_ID/);
    expect(() => loadAuthConfig({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" })).toThrow(); // no redirect
    expect(() => loadAuthConfig({ ...CREDS, GOOGLE_CLIENT_SECRET: "   " })).toThrow(); // blank secret
  });

  it("loads with credentials and sensible Google defaults", () => {
    const c = loadAuthConfig(CREDS);
    expect(c.google.clientId).toBe("id-123");
    expect(c.google.issuer).toBe("https://accounts.google.com");
    expect(c.google.tokenEndpoint).toBe("https://oauth2.googleapis.com/token");
    expect(c.enforceApiAuth).toBe(false);
    expect(c.secureCookies).toBe(false);
    expect(c.hostedDomain).toBeUndefined();
  });

  it("enables enforceApiAuth + secure cookies + hosted-domain via flags / prod", () => {
    expect(loadAuthConfig({ ...CREDS, AUTH_ENFORCE_API: "1" }).enforceApiAuth).toBe(true);
    expect(loadAuthConfig({ ...CREDS, NODE_ENV: "production" }).secureCookies).toBe(true);
    expect(loadAuthConfig({ ...CREDS, AUTH_SECURE_COOKIES: "1" }).secureCookies).toBe(true);
    expect(loadAuthConfig({ ...CREDS, GOOGLE_HOSTED_DOMAIN: "example.com" }).hostedDomain).toBe("example.com");
  });
});

describe("testAuthConfig", () => {
  it("points at the in-process fake provider and applies overrides", () => {
    expect(testAuthConfig().google.issuer).toBe("https://fake-oidc.test");
    expect(testAuthConfig().enforceApiAuth).toBe(false);
    expect(testAuthConfig({ enforceApiAuth: true }).enforceApiAuth).toBe(true);
  });
});
