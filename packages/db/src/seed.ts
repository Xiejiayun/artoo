import type { DbClient } from "@artoo/storage";

import {
  agentInstances,
  agentRuntimes,
  agents,
  computers,
  effortProfiles,
  modelProfiles,
  organizations,
  projects,
  users,
} from "./schema.js";

export interface SeedIds {
  organizationId: string;
  userId: string;
  projectId: string;
  computerId: string;
  agentId: string;
  agentInstanceId: string;
}

export interface SeedOptions {
  /**
   * Workspace root for the seeded project/agent-instance. Defaults to the repo
   * path for tests, but the dev server overrides it with an ISOLATED directory
   * so a real ProcessAdapter (#7) never writes context_pack.md / artifacts into
   * the live working tree.
   */
  workspaceRoot?: string;
}

/**
 * Seed the minimal runnable graph for v0.1-core (design / Round 16): one org,
 * owner, project, an online mock computer with an idle mock agent instance, and
 * three model+effort profiles (fast_fix / standard_coding / deep_architect).
 * This is exactly enough for the scheduler to pick an idle instance and run the
 * mock loop end to end.
 */
export async function seed(
  client: DbClient,
  now: string,
  options: SeedOptions = {},
): Promise<SeedIds> {
  const workspaceRoot = options.workspaceRoot ?? "C:/workspace/artoo";
  const ids: SeedIds = {
    organizationId: "org_default",
    userId: "user_owner",
    projectId: "proj_artoo",
    computerId: "computer_local_mock",
    agentId: "agent_mock_coder",
    agentInstanceId: "instance_mock_coder",
  };

  await client.transaction(async (tx) => {
    await tx.insert(organizations).values({ id: ids.organizationId, name: "Default Org", createdAt: now });

    await tx.insert(users).values({
      id: ids.userId,
      organizationId: ids.organizationId,
      email: "owner@artoo.dev",
      displayName: "Owner",
      role: "owner",
      createdAt: now,
    });

    await tx.insert(projects).values({
      id: ids.projectId,
      organizationId: ids.organizationId,
      name: "artoo",
      defaultWorkspace: workspaceRoot,
      createdAt: now,
    });

    await tx.insert(computers).values({
      id: ids.computerId,
      organizationId: ids.organizationId,
      displayName: "Local Mock",
      hostname: "localhost",
      os: "windows",
      arch: "x64",
      status: "online",
      lastHeartbeatAt: now,
      resources: {},
      capabilities: ["code.modify", "test.run"],
      createdAt: now,
    });

    await tx.insert(modelProfiles).values([
      profile("model_fast_fix", "fast_fix", "low", "fast", ["code.modify"], now),
      profile("model_standard_coding", "standard_coding", "medium", "normal", ["code.modify", "test.run"], now),
      profile("model_deep_architect", "deep_architect", "premium", "slow", ["code.modify", "code.review"], now),
    ]);

    await tx.insert(effortProfiles).values([
      effort("effort_fast_fix", "fast_fix", "low", 15, now),
      effort("effort_standard_coding", "standard_coding", "medium", 60, now),
      effort("effort_deep_architect", "deep_architect", "high", 120, now),
    ]);

    await tx.insert(agents).values({
      id: ids.agentId,
      organizationId: ids.organizationId,
      displayName: "Mock Coder",
      kind: "mock",
      status: "idle",
      capabilities: ["code.modify", "test.run"],
      createdAt: now,
    });

    await tx.insert(agentRuntimes).values({
      id: "runtime_mock",
      organizationId: ids.organizationId,
      computerId: ids.computerId,
      runtime: "mock",
      version: "0.1.0",
      status: "available",
      metadata: {},
    });

    await tx.insert(agentInstances).values({
      id: ids.agentInstanceId,
      organizationId: ids.organizationId,
      computerId: ids.computerId,
      agentId: ids.agentId,
      runtime: "mock",
      modelProfileId: "model_standard_coding",
      effortProfileId: "effort_standard_coding",
      status: "idle",
      workspaceRoot,
      config: {},
      createdAt: now,
    });
  });

  return ids;
}

function profile(
  id: string,
  name: string,
  costTier: string,
  latencyTier: string,
  capabilityTags: string[],
  now: string,
) {
  return {
    id,
    organizationId: "org_default",
    name,
    provider: "mock",
    model: `mock-${name}`,
    costTier,
    latencyTier,
    capabilityTags,
    config: {},
    enabled: true,
    createdAt: now,
  };
}

function effort(id: string, name: string, level: string, maxRuntimeMinutes: number, now: string) {
  return {
    id,
    organizationId: "org_default",
    name,
    effort: level,
    maxRuntimeMinutes,
    retryBudget: 1,
    description: `${name} effort profile`,
    config: {},
    enabled: true,
    createdAt: now,
  };
}
