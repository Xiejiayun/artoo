import { defineConfig, devices } from "@playwright/test";

// E2E config for the artoo web happy path. Playwright starts the real server
// (dev bootstrap: embedded PGlite + migrate + seed + listen) and the Vite dev
// server (which proxies /api + the client WS to the server).
const SERVER_PORT = process.env.ARTOO_PORT ?? "4010";
const WEB_PORT = process.env.WEB_PORT ?? "5179";
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: WEB_URL,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node ../server/dist/main.js",
      env: { ARTOO_PORT: SERVER_PORT, ARTOO_HOST: "127.0.0.1" },
      url: `${SERVER_URL}/api/v1/bootstrap`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `npm run dev -- --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      env: { ARTOO_SERVER_URL: SERVER_URL },
      url: WEB_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
