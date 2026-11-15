import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";
import { htmlEvidence } from "./playwright.reporting.js";

const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer!];
export default defineConfig({
  ...base,
  ...htmlEvidence(
    "capacity",
    "Enabled real reservation capacity against local routes/browser and explicitly controlled mock execution; no external Provider acceptance",
  ),
  testDir: "./e2e-capacity",
  webServer: servers.map((server, index) =>
    index === 0
      ? {
          ...server,
          env: {
            ...server.env,
            ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
              version: 1,
              workspaces: { org_default: { flags: { capacity_admission: true } } },
            }),
          },
        }
      : server,
  ),
});
