import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
const evidence = process.env.ARTOO_STORAGE_HARNESS_EVIDENCE;
if (!evidence) throw new Error("Harness evidence directory is required");
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["preview-storage-timeout-child.ts"],
    environment: "node", maxWorkers: 1, fileParallelism: false,
    testTimeout: 30_000, hookTimeout: 30_000,
    reporters: ["json", fileURLToPath(new URL("./preview-storage-timeout-reporter.mjs", import.meta.url))],
    outputFile: join(evidence, "vitest-report.json"),
  },
});
