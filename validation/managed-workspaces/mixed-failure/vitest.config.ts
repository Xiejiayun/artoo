import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (relative: string) => fileURLToPath(new URL(`../../../${relative}`, import.meta.url));
if (process.env.ARTOO_MANAGED_VALIDATION_PHASE !== "mixed-failure") throw new Error("Select the reviewed mixed-failure phase");
// Retain the shared physical fixture family's outer ownership boundary.
if (!tmpdir().startsWith("/private/tmp/artoo-ws-journal-validation-") || !existsSync(join(tmpdir(), ".validation-owner"))) throw new Error("Mixed-failure validation requires its owned WS fixture parent");
const report = process.env.ARTOO_NODE_PHYSICAL_REPORT_DIR;
if (!report || !isAbsolute(report) || !existsSync(report) || !statSync(report).isDirectory()) throw new Error("Mixed-failure validation requires an existing owned report directory");
const aliases = Object.fromEntries(["domain", "protocol", "db", "storage", "testkit", "node-supervisor", "client"].map((name) => [`@artoo/${name}`, at(`packages/${name}/dist/index.js`)]));
aliases["@artoo/artood"] = at("apps/artood/dist/index.js"); aliases["@artoo/server"] = at("apps/server/dist/index.js");
const required = [...Object.values(aliases),
  ...["node-client", "process-adapter", "process-adapter-owned-receipts", "node-allocation-identity"].map((name) => at(`apps/artood/dist/${name}.js`)),
  ...["journal", "journal-worker", "managed-bootstrap", "managed-delivery", "managed-node-runner", "managed-ws-transport"].map((name) => at(`apps/artood/dist/managed/${name}.js`)),
  at("apps/server/dist/test-support.js"),
  ...["assistant-service", "discussion-service", "run-event-receipt"].map((name) => at(`apps/server/dist/services/${name}.js`)),
];
const missing = required.filter((path) => !existsSync(path) || !statSync(path).isFile());
if (missing.length) throw new Error(`Build the complete repository graph before mixed-failure validation: ${missing.join(", ")}`);
export default defineConfig({
  root: at(""), cacheDir: at("artifacts/managed-workspaces/mixed-failure-vite-cache"), resolve: { alias: aliases },
  test: {
    include: ["validation/managed-workspaces/mixed-failure/mixed-failure.test.ts"],
    server: { deps: { inline: [/\/apps\/(?:artood|server)\/dist\//, /\/packages\/[^/]+\/dist\//] } },
    pool: "forks", maxWorkers: 1, fileParallelism: false, environment: "node",
    testTimeout: 90000, hookTimeout: 20000, bail: 1, retry: 0,
    reporters: ["default", "json"], outputFile: { json: join(report, "vitest.json") },
  },
});
