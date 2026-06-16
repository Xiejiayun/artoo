import { defineConfig, devices } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// #34 AUTHORITY smoke config — the merge-critical single-origin topology: the
// server serves the built web dist (ARTOO_WEB_DIST) AND /auth/* + /api/v1/* on
// the same origin, so session/flow cookies (SameSite=Lax) are first-party. No
// Vite proxy. Build the dist first with VITE_AUTH_ENABLED=true:
//   VITE_AUTH_ENABLED=true npm run build --workspace @artoo/web
// then: npx playwright test --config=playwright.authority.config.ts
const here = dirname(fileURLToPath(import.meta.url));
const SERVER_PORT = process.env.ARTOO_PORT ?? "4020";
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const WEB_DIST = process.env.ARTOO_WEB_DIST ?? resolve(here, "dist");

export default defineConfig({
  testDir: "./e2e-auth",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: SERVER_URL, trace: "off" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node ../server/dist/main.js",
    cwd: here,
    // No ARTOO_DB_DIR → in-memory PGlite, freshly seeded each boot (avoids the
    // "relation already exists" crash from re-migrating a reused data dir).
    env: {
      ARTOO_PORT: SERVER_PORT,
      ARTOO_HOST: "127.0.0.1",
      ARTOO_PAIRING_PEPPER: process.env.ARTOO_PAIRING_PEPPER ?? "authority-smoke-pepper",
      AUTH_ENFORCE_API: "1",
      ARTOO_WEB_DIST: WEB_DIST,
    },
    // Server-served SPA index responds 200 at the root once static hosting is on.
    url: `${SERVER_URL}/`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
