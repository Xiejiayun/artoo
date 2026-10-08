import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join } from "node:path";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const at = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const directory = "validation/managed-workspaces/postgres";
const phase = process.env.ARTOO_PG_VALIDATION_PHASE;
const files = { receipt: "receipt/run-event-receipt-concurrency.test.ts", admin: "admin/admin-concurrency.test.ts",
  assignment: "assignment/assignment-concurrency.test.ts" };
if (!phase || !Object.hasOwn(files, phase)) throw new Error("Select one owned PostgreSQL phase");
const receipt = process.env.ARTOO_PG_HARNESS_RECEIPT;
if (!receipt || !isAbsolute(receipt) || !existsSync(receipt) || !process.env.ARTOO_PG_RUN_TOKEN) {
  throw new Error("An owned fresh PostgreSQL receipt is required");
}
if (Object.keys(process.env).some((key) => key.startsWith("PG") || /(?:^|_)(?:DATABASE|DB)_URL$/.test(key))) {
  throw new Error("External PostgreSQL environment is forbidden");
}
const aliases = Object.fromEntries(["domain", "protocol", "db", "storage", "testkit", "node-supervisor", "client"]
  .map((name) => [`@artoo/${name}`, at(`packages/${name}/dist/index.js`)]));
aliases["@artoo/server"] = at("apps/server/dist/index.js");
aliases["@artoo/artood"] = at("apps/artood/dist/index.js");
aliases["pg"] = at(`${directory}/node_modules/pg/lib/index.js`);
for (const value of Object.values(aliases)) if (!existsSync(value)) throw new Error(`Required built module/dependency is absent: ${value}`);
export default defineConfig({
  root, cacheDir: at("artifacts/managed-workspaces/postgres/vite-cache"), resolve: { alias: aliases },
  test: {
    include: [`${directory}/${files[phase as keyof typeof files]}`], environment: "node", pool: "forks",
    maxWorkers: 1, fileParallelism: false, testTimeout: 45000, hookTimeout: 60000, bail: 1, retry: 0,
    server: { deps: { inline: [/\/apps\/(?:artood|server)\/dist\//, /\/packages\/[^/]+\/dist\//, /drizzle-orm\/node-postgres/] } },
    reporters: ["default", "json"], outputFile: { json: join(dirname(receipt), "vitest.json") },
  },
});
