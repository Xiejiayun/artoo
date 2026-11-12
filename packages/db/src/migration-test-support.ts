import type { DbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { agentRuntimes, agents, computers, modelProfiles } from "./schema.js";
import { seed, type SeedOptions } from "./seed.js";

/** Old migration boundaries must seed the pre-0058 instance columns, even when
 * the current Drizzle table has acquired new columns. Do not migrate ahead:
 * these tests need the real historical schema and its original constraints. */
export async function seedPreProjectSquads(client: DbClient, now: string, options: SeedOptions = {}) {
  const ids = await seed(client, now, { ...options, demoResources: false });
  if (options.demoResources === false) return ids;
  const workspaceRoot = options.workspaceRoot?.trim() ? options.workspaceRoot : "C:/workspace/artoo";
  await client.transaction(async tx => {
    await tx.insert(computers).values({ id: ids.computerId, organizationId: ids.organizationId,
      displayName: "Local Mock", hostname: "localhost", os: "windows", arch: "x64", status: "online",
      lastHeartbeatAt: now, resources: {}, capabilities: ["code.modify", "test.run"], createdAt: now });
    await tx.insert(modelProfiles).values([
      { id: "model_fast_fix", name: "fast_fix", costTier: "low", latencyTier: "fast", capabilityTags: ["code.modify"] },
      { id: "model_standard_coding", name: "standard_coding", costTier: "medium", latencyTier: "normal", capabilityTags: ["code.modify", "test.run"] },
      { id: "model_deep_architect", name: "deep_architect", costTier: "premium", latencyTier: "slow", capabilityTags: ["code.modify", "code.review"] },
    ].map(profile => ({ ...profile, organizationId: ids.organizationId, provider: "mock", model: `mock-${profile.name}`,
      config: {}, enabled: true, createdAt: now })));
    await tx.insert(agents).values({ id: ids.agentId, organizationId: ids.organizationId, displayName: "Mock Coder",
      kind: "mock", status: "idle", capabilities: ["code.modify", "test.run"], createdAt: now });
    await tx.insert(agentRuntimes).values({ id: "runtime_mock", organizationId: ids.organizationId,
      computerId: ids.computerId, runtime: "mock", version: "0.1.0", status: "available", lastSeenAt: now, metadata: {} });
    await tx.execute(sql`INSERT INTO agent_instances
      (id, organization_id, computer_id, agent_id, runtime, model_profile_id, effort_profile_id, status, workspace_root, config, created_at)
      VALUES (${ids.agentInstanceId}, ${ids.organizationId}, ${ids.computerId}, ${ids.agentId}, 'mock',
        'model_standard_coding', 'effort_standard_coding', 'idle', ${workspaceRoot}, '{}'::jsonb, ${now})`);
  });
  return ids;
}
