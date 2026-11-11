import { defineConfig } from "vitest/config";

// Explicit opt-in suite: it needs a freshly owned local PostgreSQL cluster.
// Ordinary npm test continues to run the PGlite and connection-admission tests.
export default defineConfig({
  test: {
    include: ["packages/storage/src/db/postgres-db-client.integration.ts"],
    environment: "node",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
