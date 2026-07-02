import { agentInstances, agentRuntimes, agents, computers, devices, runs, skillInstalls } from "@artoo/db";
import {
  SkillManifestSchema,
  concurrencyLimitFromConfig,
  contributedCapabilities,
  hasSpareCapacity,
  isActiveRunStatus,
  isDeviceTrustEligible,
  isInstanceAdminAvailable,
  isRuntimeStale,
  matchCapabilities,
  type Capability,
  type SkillInstallState,
} from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, isNull, or } from "drizzle-orm";

import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";

/**
 * How long after its last heartbeat a runtime row is considered stale (and its
 * instance excluded). Default 30s = 3x the 10s heartbeat interval; an
 * `ARTOO_RUNTIME_STALE_MS` env override is honored only if it parses to a
 * positive finite number. Tests stay deterministic via the pure helper.
 */
const RUNTIME_STALE_AFTER_MS = ((): number => {
  const raw = process.env.ARTOO_RUNTIME_STALE_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 30_000;
})();

export interface SchedulerCandidate {
  agent_instance_id: string;
  agent_id: string;
  computer_id: string;
  runtime: string;
  model_profile_id: string | null;
  effort_profile_id: string | null;
  score: number;
}

export interface SchedulerOutcome {
  selected: SchedulerCandidate;
  candidates: SchedulerCandidate[];
  score: number;
  reason: string;
}

export interface ScheduleOptions {
  mode: "auto" | "manual";
  projectId: string;
  agentInstanceId?: string | null;
  /**
   * #115 P3b: the linked goal's budget `allowed_runtimes`. When provided (a goal
   * with an allowed_runtimes budget), only candidates whose runtime is in the list
   * survive — applied AFTER #113 DB-fact eligibility, before selection. Absent
   * (no goal / no budget) leaves scheduling behaviour unchanged.
   */
  allowedRuntimes?: string[] | null;
}

async function loadEnabledSkillInstallStates(
  tx: DrizzleDb,
  ctx: ServerContext,
  projectId: string,
): Promise<SkillInstallState[]> {
  const rows = await tx
    .select({
      manifest: skillInstalls.manifest,
      enabled: skillInstalls.enabled,
    })
    .from(skillInstalls)
    .where(
      and(
        eq(skillInstalls.organizationId, ctx.organizationId),
        eq(skillInstalls.enabled, true),
        or(isNull(skillInstalls.projectId), eq(skillInstalls.projectId, projectId)),
      ),
    );

  const installs: SkillInstallState[] = [];
  for (const row of rows) {
    const parsed = SkillManifestSchema.safeParse(row.manifest);
    if (parsed.success) {
      installs.push({ manifest: parsed.data, enabled: row.enabled });
    }
  }
  return installs;
}

/**
 * Rule-based core scheduler (codex Round 14). Hard filters: idle instance on an
 * online computer whose (agent ∪ computer ∪ runtime ∪ compatible enabled skill)
 * capabilities cover the task's required set; a manual override pins the
 * instance. Deterministic selection: highest score, then lowest instance id.
 * No eligible candidate maps to an
 * explainable `computer_offline` / `runtime_unavailable` error (task stays ready).
 */
export async function scheduleTask(
  tx: DrizzleDb,
  ctx: ServerContext,
  required: readonly Capability[],
  opts: ScheduleOptions,
): Promise<SchedulerOutcome> {
  const enabledSkillInstalls = await loadEnabledSkillInstallStates(tx, ctx, opts.projectId);
  const rows = await tx
    .select({
      instanceId: agentInstances.id,
      agentId: agentInstances.agentId,
      computerId: agentInstances.computerId,
      runtime: agentInstances.runtime,
      modelProfileId: agentInstances.modelProfileId,
      effortProfileId: agentInstances.effortProfileId,
      instanceStatus: agentInstances.status,
      instanceConfig: agentInstances.config,
      computerStatus: computers.status,
      agentCaps: agents.capabilities,
      computerCaps: computers.capabilities,
      // Runtime row for this instance's runtime (LEFT JOIN: null when absent).
      runtimeStatus: agentRuntimes.status,
      runtimeCaps: agentRuntimes.capabilities,
      runtimeLastSeen: agentRuntimes.lastSeenAt,
    })
    .from(agentInstances)
    .innerJoin(computers, eq(agentInstances.computerId, computers.id))
    .innerJoin(agents, eq(agentInstances.agentId, agents.id))
    .leftJoin(
      agentRuntimes,
      and(
        eq(agentRuntimes.organizationId, ctx.organizationId),
        eq(agentRuntimes.computerId, agentInstances.computerId),
        eq(agentRuntimes.runtime, agentInstances.runtime),
      ),
    )
    .where(eq(agentInstances.organizationId, ctx.organizationId));

  const now = ctx.clock.nowIso();

  // #113 slice 5 — INTENTIONAL behavior change: busy/idle is now derived from
  // capacity (active non-terminal runs vs concurrency_limit), NOT from the
  // possibly-stale `agent_instances.status`; and a bound REVOKED device excludes
  // the candidate. `agent_instances.status` is kept only as an admin guard
  // (disabled/stopping/failed). The missing-runtime-row fallback is UNCHANGED.

  // Active (non-terminal) runs per instance, for capacity. One query; counted in JS.
  const activeRunRows = await tx
    .select({ agentInstanceId: runs.agentInstanceId, status: runs.status })
    .from(runs)
    .where(eq(runs.organizationId, ctx.organizationId));
  const activeRunsByInstance = new Map<string, number>();
  for (const r of activeRunRows) {
    if (isActiveRunStatus(r.status)) {
      activeRunsByInstance.set(r.agentInstanceId, (activeRunsByInstance.get(r.agentInstanceId) ?? 0) + 1);
    }
  }

  // Computers with a bound REVOKED device (exists/aggregate, so multiple device
  // rows for one computer never duplicate or split a candidate). No device row
  // or an active device leaves the computer eligible.
  const revokedRows = await tx
    .select({ computerId: devices.computerId })
    .from(devices)
    .where(and(eq(devices.organizationId, ctx.organizationId), eq(devices.trust, "revoked")));
  const revokedComputerIds = new Set<string>();
  for (const d of revokedRows) {
    if (d.computerId !== null) revokedComputerIds.add(d.computerId);
  }

  const eligible = rows
    .filter(
      (r) =>
        isInstanceAdminAvailable(r.instanceStatus) &&
        r.computerStatus === "online" &&
        hasSpareCapacity(
          activeRunsByInstance.get(r.instanceId) ?? 0,
          concurrencyLimitFromConfig(r.instanceConfig as Record<string, unknown> | null),
        ) &&
        isDeviceTrustEligible(revokedComputerIds.has(r.computerId)),
    )
    .filter(
      (r) =>
        opts.mode !== "manual" ||
        opts.agentInstanceId == null ||
        r.instanceId === opts.agentInstanceId,
    )
    .filter((r) => {
      // Runtime eligibility (#15 Part 3). A missing agent_runtimes row is a
      // deliberate fallback (seeded/dev/pre-heartbeat): the candidate stays
      // eligible with no runtime caps. A present-but-disabled or stale/timestamp-
      // less row excludes the candidate (its runtime is known-bad). A fresh,
      // enabled row contributes its capabilities. `version` is non-gating.
      let runtimeCaps: Capability[] = [];
      if (r.runtimeStatus !== null) {
        if (r.runtimeStatus === "disabled") {
          return false;
        }
        if (isRuntimeStale(r.runtimeLastSeen, now, RUNTIME_STALE_AFTER_MS)) {
          return false;
        }
        runtimeCaps = (r.runtimeCaps as Capability[] | null) ?? [];
      }
      const skillCaps = contributedCapabilities(enabledSkillInstalls, r.runtime);
      return matchCapabilities(required, [
        ...(r.agentCaps as Capability[]),
        ...(r.computerCaps as Capability[]),
        ...runtimeCaps,
        ...skillCaps,
      ]);
    });

  // #115 P3b-1: goal budget `allowed_runtimes` filter — applied AFTER the #113
  // DB-fact eligibility above and BEFORE selection. A null list (no goal / no
  // budget) leaves the eligible set (and the decision reason) unchanged.
  const allowedRuntimes = opts.allowedRuntimes ?? null;
  const permitted =
    allowedRuntimes === null ? eligible : eligible.filter((r) => allowedRuntimes.includes(r.runtime));
  // Distinguish "the goal budget emptied the candidates" from ordinary
  // no-eligible-instance, so the failure is explainable rather than generic.
  const emptiedByGoalBudget = allowedRuntimes !== null && eligible.length > 0 && permitted.length === 0;

  const candidates: SchedulerCandidate[] = permitted
    .map((r) => ({
      agent_instance_id: r.instanceId,
      agent_id: r.agentId,
      computer_id: r.computerId,
      runtime: r.runtime,
      model_profile_id: r.modelProfileId,
      effort_profile_id: r.effortProfileId,
      // capability match (100) + exact-capability bonus + idle bonus (15).
      score: 100 + (required.length > 0 ? 20 : 0) + 15,
    }))
    .sort((a, b) => b.score - a.score || a.agent_instance_id.localeCompare(b.agent_instance_id));

  const selected = candidates[0];
  if (selected === undefined) {
    if (emptiedByGoalBudget) {
      throw new AppError(
        "runtime_unavailable",
        "no eligible agent instance is permitted by the goal's allowed_runtimes budget",
        409,
        { reason: "goal_allowed_runtimes", allowed_runtimes: opts.allowedRuntimes },
      );
    }
    const anyOnline = rows.some((r) => r.computerStatus === "online");
    if (!anyOnline) {
      throw new AppError("computer_offline", "no online computer is available", 409);
    }
    throw new AppError(
      "runtime_unavailable",
      "no eligible idle agent instance for the required capabilities",
      409,
      { required_capabilities: required },
    );
  }

  return {
    selected,
    candidates,
    score: selected.score,
    reason:
      opts.mode === "manual" && opts.agentInstanceId != null
        ? "manual_override"
        : "capability_match_and_idle",
  };
}
