import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const at = (relative: string) => fileURLToPath(new URL(`../../../${relative}`, import.meta.url));
const directory = "validation/managed-workspaces/managed";
const phase = process.env.ARTOO_MANAGED_VALIDATION_PHASE;
if (phase !== "live" && phase !== "ws") throw new Error("Select one reviewed managed phase: ARTOO_MANAGED_VALIDATION_PHASE=live|ws");
const temporaryPrefix = phase === "live" ? "/private/tmp/artoo-live-journal-validation-" : "/private/tmp/artoo-ws-journal-validation-";
if (!tmpdir().startsWith(temporaryPrefix) || !existsSync(join(tmpdir(), ".validation-owner"))) {
  throw new Error("Managed validation requires the matching outer-owned temporary parent and marker");
}
const reportDirectory = process.env.ARTOO_NODE_PHYSICAL_REPORT_DIR;
if (!reportDirectory || !isAbsolute(reportDirectory) || !existsSync(reportDirectory) || !statSync(reportDirectory).isDirectory()) {
  throw new Error("Managed validation requires an existing outer-owned absolute report directory");
}

// All workspace imports, including those inside the compiled server, enter
// the same compiled graph. Never merge the root config's source aliases here.
const aliases = Object.fromEntries(["domain", "protocol", "db", "storage", "testkit", "node-supervisor", "client"]
  .map((name) => [`@artoo/${name}`, at(`packages/${name}/dist/index.js`)]));
aliases["@artoo/artood"] = at("apps/artood/dist/index.js");
aliases["@artoo/server"] = at("apps/server/dist/index.js");
const requiredProducts = [
  ...Object.values(aliases),
  at("apps/artood/dist/node-client.js"),
  at("apps/artood/dist/artifact-upload.js"),
  at("apps/artood/dist/process-adapter.js"),
  at("apps/artood/dist/process-adapter-owned-receipts.js"),
  at("apps/artood/dist/node-allocation-identity.js"),
  at("apps/artood/dist/workspace-binding.js"),
  ...["git-operations", "owned-context", "owned-git", "workspace-namespace", "worktree-preflight", "worktree-reservation"]
    .map((name) => at(`apps/artood/dist/owned/${name}.js`)),
  ...["journal", "journal-worker", "journal-boundary", "journal-clock", "managed-delivery", "managed-node-runner", "managed-ws-transport"]
    .map((name) => at(`apps/artood/dist/managed/${name}.js`)),
  at("apps/server/dist/test-support.js"),
  at("apps/server/dist/config/device-auth.js"),
  at("apps/server/dist/services/run-event-receipt.js"),
];
const missing = requiredProducts.filter((path) => !existsSync(path) || !statSync(path).isFile());
if (missing.length) throw new Error(`Build the repository graph before managed validation; missing compiled inputs:\n${missing.join("\n")}`);

export default defineConfig({
  root,
  cacheDir: at("artifacts/managed-workspaces/vite-cache"),
  resolve: { alias: aliases },
  test: {
    include: (phase === "live" ? ["live.git.test.ts"] : ["managed-transport.test.ts", "managed-writer.test.ts"])
      .map((name) => `${directory}/${name}`),
    // Inlining keeps the actual spawn observer and producer WeakMaps together;
    // externalizing one workspace package would create a second module graph.
    server: { deps: { inline: [/\/apps\/(?:artood|server)\/dist\//, /\/packages\/[^/]+\/dist\//] } },
    pool: "forks", maxWorkers: 1, fileParallelism: false,
    environment: "node", testTimeout: 90000, hookTimeout: 20000,
    bail: 1, retry: 0, reporters: ["default", "json"],
    outputFile: { json: join(reportDirectory, "vitest.json") },
  },
});
