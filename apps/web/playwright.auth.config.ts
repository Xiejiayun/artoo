import { defineConfig, devices } from "@playwright/test";
import { htmlEvidence } from "./playwright.reporting";

// #34 authority/dev-proxy smoke config. Unlike playwright.config.ts this does NOT
// manage the servers — they are started externally with auth enabled
// (server AUTH_ENFORCE_API=1, web VITE_AUTH_ENABLED=true) so the gate is live.
const WEB_URL = process.env.SMOKE_WEB_URL ?? "http://127.0.0.1:5179";

export default defineConfig({
  testDir: "./e2e-auth",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  ...htmlEvidence("auth-proxy", "Unauthenticated browser gate and OAuth redirect initiation via a development proxy; no completed Google login claim"),
  use: { baseURL: WEB_URL, trace: "off", screenshot: "on", channel: process.env.ARTOO_CHROMIUM_CHANNEL?.trim() || undefined },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
