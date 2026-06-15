import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@artoo/artood": new URL("./apps/artood/src/index.ts", import.meta.url).pathname,
      "@artoo/server": new URL("./apps/server/src/index.ts", import.meta.url).pathname,
      "@artoo/web": new URL("./apps/web/src/index.ts", import.meta.url).pathname,
      "@artoo/db": new URL("./packages/db/src/index.ts", import.meta.url).pathname,
      "@artoo/domain": new URL("./packages/domain/src/index.ts", import.meta.url).pathname,
      "@artoo/protocol": new URL("./packages/protocol/src/index.ts", import.meta.url).pathname,
      "@artoo/storage": new URL("./packages/storage/src/index.ts", import.meta.url).pathname,
      "@artoo/testkit": new URL("./packages/testkit/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    include: ["{apps,packages}/**/*.test.{ts,tsx}"],
    globals: false,
    environment: "node",
    // PGlite (embedded Postgres, WASM) integration tests are CPU-heavy; under
    // full-suite parallelism a fresh instance per test can exceed the 5s default
    // and flake. Generous timeouts keep the shared `npm test` gate reliable.
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
