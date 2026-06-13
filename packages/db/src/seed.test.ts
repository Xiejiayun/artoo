import { PgliteDbClient } from "@artoo/storage";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { loadMigrationStatements } from "./migrations.js";
import { agentInstances, computers, effortProfiles, modelProfiles, projects } from "./schema.js";
import { seed } from "./seed.js";

const NOW = "2026-06-13T00:00:00.000Z";

describe("seed", () => {
  let client: PgliteDbClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("creates a complete runnable graph", async () => {
    client = await PgliteDbClient.create();
    await client.migrate(await loadMigrationStatements());
    const ids = await seed(client, NOW);

    const models = await client.db.select().from(modelProfiles);
    const efforts = await client.db.select().from(effortProfiles);
    expect(models.length).toBe(3);
    expect(efforts.length).toBe(3);
    expect(ids.agentInstanceId).toBe("instance_mock_coder");
  });

  it("seeds an idle instance on an online computer with model+effort profiles", async () => {
    client = await PgliteDbClient.create();
    await client.migrate(await loadMigrationStatements());
    await seed(client, NOW);

    // The scheduler's core filter: an idle instance on an online computer.
    const schedulable = await client.db
      .select({
        instanceId: agentInstances.id,
        instanceStatus: agentInstances.status,
        computerStatus: computers.status,
        modelProfileId: agentInstances.modelProfileId,
        effortProfileId: agentInstances.effortProfileId,
        workspaceRoot: agentInstances.workspaceRoot,
      })
      .from(agentInstances)
      .innerJoin(computers, eq(agentInstances.computerId, computers.id))
      .where(and(eq(agentInstances.status, "idle"), eq(computers.status, "online")));

    expect(schedulable).toHaveLength(1);
    expect(schedulable[0]?.modelProfileId).toBe("model_standard_coding");
    expect(schedulable[0]?.effortProfileId).toBe("effort_standard_coding");
    expect(schedulable[0]?.workspaceRoot).toBe("C:/workspace/artoo");
  });

  it("supports workspace override", async () => {
    client = await PgliteDbClient.create();
    await client.migrate(await loadMigrationStatements());
    const workspaceRoot = "C:/workspace/artoo-runs/test-run";
    await seed(client, NOW, { workspaceRoot });

    const instance = (await client.db.select().from(agentInstances))[0];
    const project = (await client.db.select().from(projects))[0];
    expect(instance?.workspaceRoot).toBe(workspaceRoot);
    expect(project?.defaultWorkspace).toBe(workspaceRoot);
  });
});
