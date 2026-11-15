import { agentRuntimes, agents } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSchedulerRollout } from "./config/scheduler-rollout.js";
import * as fence from "./services/scheduler-configuration-fence.js";
import { schedulerConfigurationMutations } from "./test-fixtures/scheduler-configuration.js";
import { buildTestServer, type TestServer } from "./test-support.js";

describe("scheduler configuration writer fence", () => {
  let server: TestServer;
  afterEach(async () => {
    vi.restoreAllMocks();
    await server?.close();
  });
  function enable() {
    server.ctx.schedulerRollout = loadSchedulerRollout({
      ARTOO_SCHEDULER_ROLLOUT: JSON.stringify({
        version: 1,
        workspaces: {
          org_default: { projects: { proj_artoo: { daemon_claim: true }, other: { daemon_claim: false } } },
        },
      }),
    });
  }

  it("keeps the default-off path query-free and shares project opt-in across only its organization", async () => {
    server = await buildTestServer();
    const execute = vi.spyOn(server.db.db, "execute");
    expect(await fence.lockSchedulerConfiguration(server.ctx, server.db.db)).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    enable();
    expect(fence.schedulerConfigurationFenceEnabled(server.ctx)).toBe(true);
    expect(fence.schedulerConfigurationFenceEnabled({ ...server.ctx, organizationId: "another" })).toBe(false);
    await expect(fence.lockSchedulerConfiguration(server.ctx, server.db.db)).rejects.toMatchObject({
      details: { reason: "scheduler_configuration_transaction" },
    });
    await expect(
      server.db.db.transaction((tx) => fence.lockSchedulerConfiguration(server.ctx, tx), {
        isolationLevel: "repeatable read",
      }),
    ).rejects.toMatchObject({ details: { reason: "scheduler_configuration_transaction" } });
    expect(await server.db.transaction((tx) => fence.lockSchedulerConfiguration(server.ctx, tx))).toBe(true);
  });

  it.each([false, true])("preserves every real writer with daemon_claim=%s", async (enabled) => {
    server = await buildTestServer();
    // Explicit fixture inventory must support the seeded logical Agent's declarations.
    const [agent] = await server.db.db.select().from(agents).where(eq(agents.id, "agent_mock_coder"));
    await server.db.db
      .update(agentRuntimes)
      .set({ capabilities: agent!.capabilities })
      .where(eq(agentRuntimes.id, "runtime_mock"));
    if (enabled) enable();
    // Controlled session capability only. This suite never launches a process.
    server.ctx.supportsExecutionFeature = () => true;
    const lock = vi.spyOn(fence, "lockSchedulerConfiguration");
    for (const mutation of schedulerConfigurationMutations) {
      lock.mockClear();
      const response = await server.app.inject(mutation.request);
      expect(response.statusCode, `${mutation.name}: ${response.body}`).toBe(mutation.status);
      expect(lock, mutation.name).toHaveBeenCalledTimes(1);
      expect(await lock.mock.results[0]!.value, mutation.name).toBe(enabled);
    }
  });
});
