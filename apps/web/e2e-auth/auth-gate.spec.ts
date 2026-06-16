import { expect, test } from "@playwright/test";

/**
 * #34 web/server login regression (auth flag ON). Designed for the
 * merge-critical **single-origin** topology — the server serves the built web
 * dist and `/auth/*` + `/api/v1/*` share that origin — but the browser
 * assertions also pass through the Vite dev proxy (dev-proxy coverage).
 *
 * Run with the server started AUTH_ENFORCE_API=1 and the web reachable at
 * SMOKE_WEB_URL (single origin: the server's own URL; dev-proxy: the Vite URL).
 *
 * The logged-in round-trip needs real Google OAuth credentials (or the
 * test-only fake OIDC provider, covered by the server e2e), so this asserts the
 * unauthenticated gate + start-of-flow redirect + that API failures stay JSON.
 */
test.describe("auth gate + static-host boundary (VITE_AUTH_ENABLED=true)", () => {
  test("unauthenticated root renders the Google login gate, not the app", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
  });

  test("unauthenticated deep-link (SPA fallback) also renders the login gate", async ({ page }) => {
    // A deep client route must serve index (SPA fallback) → app boots → AuthGate
    // → login gate, NOT a 404 and NOT the protected app chrome.
    await page.goto("/board");
    await expect(page.getByRole("button", { name: "Sign in with Google" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
  });

  test("Sign in → /auth/google/start 302 to Google with PKCE + flow cookie", async ({ page, context }) => {
    await page.route("**/accounts.google.com/**", (route) => route.abort());
    await page.goto("/");
    const button = page.getByRole("button", { name: "Sign in with Google" });
    await expect(button).toBeVisible();
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/auth/google/start")),
      button.click(),
    ]);
    expect(response.status()).toBe(302);
    const location = response.headers()["location"] ?? "";
    expect(location).toContain("accounts.google.com");
    expect(location).toContain("code_challenge_method=S256");
    // Flow-binding cookie is set by the 302; HttpOnly hides it from
    // response.headers(), so assert it (and its attributes) via the context.
    const flowCookie = (await context.cookies()).find((c) => c.name === "artoo_auth_flow");
    expect(flowCookie?.httpOnly).toBe(true);
    expect(flowCookie?.sameSite).toBe("Lax");
  });

  test("protected /api/v1/* failures stay JSON 401/404, not SPA-fallback HTML", async ({ request }) => {
    // The static/SPA-fallback layer must not swallow API routes into index.html.
    const unauth = await request.get("/api/v1/bootstrap");
    expect(unauth.status()).toBe(401);
    expect(unauth.headers()["content-type"]).toContain("application/json");
    expect(JSON.parse(await unauth.text()).error.code).toBe("unauthorized");

    const unknown = await request.get("/api/v1/does-not-exist");
    expect([401, 404]).toContain(unknown.status());
    expect(unknown.headers()["content-type"]).toContain("application/json");
  });

  test("/auth/session stays JSON 401 (not swallowed by SPA fallback)", async ({ request }) => {
    const session = await request.get("/auth/session");
    expect(session.status()).toBe(401);
    expect(session.headers()["content-type"]).toContain("application/json");
  });

  test("exact /api and /auth roots (HTML Accept) stay JSON, not the SPA index", async ({ request }) => {
    // Regression for the SPA-fallback edge where exact namespace roots (no
    // trailing slash) with a navigation Accept could be served index.html.
    for (const path of ["/api", "/auth"]) {
      const res = await request.get(path, { headers: { Accept: "text/html,application/xhtml+xml" } });
      expect(res.headers()["content-type"] ?? "").not.toContain("text/html");
      expect([401, 404]).toContain(res.status());
    }
  });
});
