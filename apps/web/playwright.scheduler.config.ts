import { defineConfig } from "@playwright/test";
import base from "./playwright.config.js";
import { htmlEvidence } from "./playwright.reporting.js";

const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer!];
export default defineConfig({
  ...base,
  ...htmlEvidence(
    "scheduler",
    "Enabled task mirror, unified enqueue, explicit delegation and shadow observations against a real local server/browser and controlled mock execution; no external Provider acceptance",
  ),
  testDir: "./e2e-scheduler",
  webServer: servers.map((server, index) =>
    index === 0
      ? {
          ...server,
          env: {
            ...server.env,
            ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
              version: 1,
              workspaces: {
                org_default: {
                  flags: { task_mirror: true, unified_enqueue: true, claim_shadow: true, delegation_limits: true },
                },
              },
            }),
          },
        }
      : server,
  ),
});
