import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Cross-package `@artoo/*` imports must resolve to live `src` (not stale `dist`)
// so cross-package TDD works without a build step. Shared skeleton config —
// added on feature/task-4 to unblock db->storage tests; reconcile on main.
const pkgSrc = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@artoo/domain": pkgSrc("domain"),
      "@artoo/storage": pkgSrc("storage"),
      "@artoo/db": pkgSrc("db"),
      "@artoo/protocol": pkgSrc("protocol"),
      "@artoo/testkit": pkgSrc("testkit"),
    },
  },
  test: {
    include: ["{apps,packages}/**/*.test.ts"],
    globals: false,
    environment: "node",
  },
});
