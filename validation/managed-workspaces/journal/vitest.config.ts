import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const at = (relative: string) => fileURLToPath(new URL(`../../../${relative}`, import.meta.url));
if (!tmpdir().startsWith("/private/tmp/artoo-journal-validation-") || !existsSync(join(tmpdir(), ".validation-owner"))) {
  throw new Error("journal validation requires its outer-owned temporary parent and marker");
}
const reportDirectory = process.env.ARTOO_JOURNAL_REPORT_DIR;
if (!reportDirectory || !isAbsolute(reportDirectory) || !existsSync(reportDirectory) || !statSync(reportDirectory).isDirectory()) {
  throw new Error("journal validation requires an existing outer-owned absolute report directory");
}
const aliases = Object.fromEntries(["domain", "protocol"].map((name) => [`@artoo/${name}`, at(`packages/${name}/dist/index.js`)]));
const requiredProducts = [
  ...Object.values(aliases),
  at("apps/artood/dist/process-adapter.js"),
  at("apps/artood/dist/process-adapter-owned-receipts.js"),
  at("apps/artood/dist/node-allocation-identity.js"),
  ...["owned-git", "workspace-namespace", "worktree-reservation", "owned-context", "git-operations", "worktree-preflight"]
    .map((name) => at(`apps/artood/dist/owned/${name}.js`)),
  ...["journal", "journal-worker", "journal-boundary", "journal-clock"]
    .map((name) => at(`apps/artood/dist/managed/${name}.js`)),
  fileURLToPath(new URL("./dist/journal-child.mjs", import.meta.url)),
];
const missing = requiredProducts.filter((path) => !existsSync(path) || !statSync(path).isFile());
if (missing.length) throw new Error(`Build the canonical repository graph and this family child before validation:\n${missing.join("\n")}`);

// This config is independent of root Vitest's source aliases. The parent and
// child both use canonical compiled modules; no product is bundled into a fixture.
export default defineConfig({
  root,
  cacheDir: join(reportDirectory, "vite-cache"),
  resolve: { alias: aliases },
  test: {
    include: ["validation/managed-workspaces/journal/journal.git.test.ts"],
    server: { deps: { inline: [/\/apps\/artood\/dist\//, /\/packages\/[^/]+\/dist\//] } },
    pool: "forks", maxWorkers: 1, fileParallelism: false,
    environment: "node", testTimeout: 90000, hookTimeout: 20000,
    bail: 1, retry: 0, reporters: ["default", "json"],
    outputFile: { json: join(reportDirectory, "vitest.json") },
  },
});
