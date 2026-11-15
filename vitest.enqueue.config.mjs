import base from "./vitest.config.ts";

// Re-run the actual original business workflows against migrated/seeded DBs.
// No product service or original assertion is mocked or replaced.
export default {
  ...base,
  test: {
    ...base.test,
    include: [
      "apps/server/src/services/assistant-service.test.ts",
      "apps/server/src/services/discussion-service.test.ts",
      "apps/server/src/services/plan-service.test.ts",
      "apps/server/src/agent-team.test.ts",
      "apps/server/src/imported-product-review.test.ts",
    ],
    env: {
      ARTOO_TEST_SCHEDULER_ROLLOUT: JSON.stringify({
        version: 1,
        workspaces: {
          org_default: {
            flags: { unified_enqueue: true, task_mirror: true },
          },
        },
      }),
    },
  },
};
