import { describe, expect, it } from "vitest";
import { loadSchedulerRollout, schedulerRolloutEnabled, SCHEDULER_ROLLOUT_FLAGS } from "./scheduler-rollout.js";

describe("scheduler rollout startup configuration", () => {
  const scope = { organizationId: "org_a", projectId: "project_a" };
  it("defaults every migration off", () => {
    expect(loadSchedulerRollout({})).toBeUndefined();
    for (const flag of SCHEDULER_ROLLOUT_FLAGS) expect(schedulerRolloutEnabled(undefined, flag, scope)).toBe(false);
  });
  it("supports workspace defaults and explicit project opt-out without crossing tenants", () => {
    const config = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
        version: 1,
        workspaces: {
          org_a: { flags: { task_mirror: true }, projects: { project_a: { task_mirror: false, claim_shadow: true } } },
        },
      }),
    });
    expect(schedulerRolloutEnabled(config, "task_mirror", scope)).toBe(false);
    expect(schedulerRolloutEnabled(config, "claim_shadow", scope)).toBe(true);
    expect(schedulerRolloutEnabled(config, "task_mirror", { ...scope, projectId: "other" })).toBe(true);
    expect(schedulerRolloutEnabled(config, "claim_shadow", { ...scope, organizationId: "org_b" })).toBe(false);
    expect(Object.isFrozen(config?.workspaces.org_a?.projects?.project_a)).toBe(true);
  });
  it.each([
    "{",
    "null",
    '{"version":2,"workspaces":{}}',
    '{"version":1,"workspaces":{"org_a":{"flags":{"task_mirror":"false"}}}}',
    '{"version":1,"workspaces":{"org_a":{"flags":{"typo":true}}}}',
    '{"version":1,"workspaces":{},"enabled":true}',
    " ".repeat(65537),
  ])("rejects invalid operator configuration case %#", (raw) => {
    expect(() => loadSchedulerRollout({ ARTOO_SCHEDULER_ROLLOUT: raw })).toThrow(/ARTOO_SCHEDULER_ROLLOUT/);
  });
});
