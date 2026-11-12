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
import { unsettledStandaloneExecutions } from "./execution-state.js";
import { goalImportedDesignContinuations, goalImportedDesignReviews, goalImportedExecutions } from "@artoo/db";
import { goalImportedExecutionReviews, goalImportedExecutionRepairs } from "@artoo/db";
import { goalImportedValidations, goalImportedValidationReviews } from "@artoo/db";
import { goalRecoveryValidations, goalRecoveryValidationReviews } from "@artoo/db";
import { goalCleanValidations, goalCleanValidationReviews } from "@artoo/db";

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
  /** Internal H4 revalidation of its reserved author/reviewer only. */
  importedDesignReviewId?: string;
  /** Internal H3 revalidation of its own exact reservation; never populated from assignment requests. */
  importedDesignRunId?: string;
  importedExecutionRunId?: string;
  importedExecutionReviewId?: string;
  importedExecutionRepairRunId?: string;
  importedValidationRunId?: string;
  importedValidationReviewId?: string;
  recoveryValidationRunId?: string;
  recoveryValidationReviewId?: string;
  cleanValidationRunId?: string;
  cleanValidationReviewId?: string;
  mode: "auto" | "manual";
  projectId: string;
  /** Derived from the validated explicit/generated branch request. */
  branchBacked: boolean;
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
  if (opts.cleanValidationRunId) {
    const [owner] = await tx.select().from(goalCleanValidations).where(and(eq(goalCleanValidations.runId, opts.cleanValidationRunId), eq(goalCleanValidations.organizationId, ctx.organizationId)));
    if (!owner || owner.stopRequested || opts.mode !== "manual" || opts.agentInstanceId !== owner.writerInstanceId)
      throw AppError.conflict("Only clean validation can revalidate its exact reserved author");
  }
  if (opts.cleanValidationReviewId) {
    const [owner] = await tx.select().from(goalCleanValidationReviews).where(and(eq(goalCleanValidationReviews.id, opts.cleanValidationReviewId), eq(goalCleanValidationReviews.organizationId, ctx.organizationId)));
    if (!owner || owner.stopRequested || opts.mode !== "manual" || ![owner.authorInstanceId, owner.reviewerInstanceId].includes(opts.agentInstanceId ?? ""))
      throw AppError.conflict("Only clean review can revalidate its exact reserved participants");
  }
  if (opts.recoveryValidationRunId) {
    const [owner] = await tx.select().from(goalRecoveryValidations).where(and(eq(goalRecoveryValidations.runId, opts.recoveryValidationRunId), eq(goalRecoveryValidations.organizationId, ctx.organizationId)));
    if (!owner || owner.stopRequested || opts.mode !== "manual" || opts.agentInstanceId !== owner.writerInstanceId)
      throw AppError.conflict("Only recovery validation can revalidate its exact reserved author");
  }
  if (opts.recoveryValidationReviewId) {
    const [owner] = await tx.select().from(goalRecoveryValidationReviews).where(and(eq(goalRecoveryValidationReviews.id, opts.recoveryValidationReviewId), eq(goalRecoveryValidationReviews.organizationId, ctx.organizationId)));
    if (!owner || owner.stopRequested || opts.mode !== "manual" || ![owner.authorInstanceId, owner.reviewerInstanceId].includes(opts.agentInstanceId ?? ""))
      throw AppError.conflict("Only recovery review can revalidate its exact reserved participants");
  }
  if (opts.importedValidationRunId) {
    const [owner] = await tx.select().from(goalImportedValidations).where(and(eq(goalImportedValidations.runId, opts.importedValidationRunId), eq(goalImportedValidations.organizationId, ctx.organizationId)));
    if (!owner || owner.stopRequested || opts.mode !== "manual" || opts.agentInstanceId !== owner.writerInstanceId)
      throw AppError.conflict("Only H7 can revalidate its exact reserved validation author");
  }
  if (opts.importedValidationReviewId) {
    const [owner] = await tx.select().from(goalImportedValidationReviews).where(and(eq(goalImportedValidationReviews.id, opts.importedValidationReviewId), eq(goalImportedValidationReviews.organizationId, ctx.organizationId)));
    if (!owner || owner.stopRequested || opts.mode !== "manual" || ![owner.authorInstanceId, owner.reviewerInstanceId].includes(opts.agentInstanceId ?? ""))
      throw AppError.conflict("Only H7 can revalidate its exact final-product review participants");
  }
  if (opts.importedExecutionReviewId) {
    const [owner] = await tx.select().from(goalImportedExecutionReviews).where(and(eq(goalImportedExecutionReviews.id, opts.importedExecutionReviewId), eq(goalImportedExecutionReviews.organizationId, ctx.organizationId)));
    if (!owner || owner.stopRequested || opts.mode !== "manual" || ![owner.authorInstanceId, owner.reviewerInstanceId].includes(opts.agentInstanceId ?? ""))
      throw AppError.conflict("Only H6 can revalidate its exact reserved review participants");
  }
  if (opts.importedExecutionRepairRunId) {
    const [owner] = await tx.select().from(goalImportedExecutionRepairs).where(and(eq(goalImportedExecutionRepairs.runId, opts.importedExecutionRepairRunId), eq(goalImportedExecutionRepairs.organizationId, ctx.organizationId)));
    if (!owner || owner.stopRequested || opts.mode !== "manual" || opts.agentInstanceId !== owner.writerInstanceId)
      throw AppError.conflict("Only a repair can revalidate its exact reserved author");
  }
  if (opts.importedExecutionRunId) {
    const [owner] = await tx.select().from(goalImportedExecutions).where(and(eq(goalImportedExecutions.organizationId, ctx.organizationId), eq(goalImportedExecutions.runId, opts.importedExecutionRunId)));
    if (!owner || owner.stopRequested || owner.result !== null || opts.mode !== "manual" || opts.agentInstanceId !== owner.writerInstanceId)
      throw AppError.conflict("Only an unused H5 can revalidate its reserved implementation run");
  }
  if (opts.importedDesignReviewId) {
    const [owner] = await tx.select().from(goalImportedDesignReviews).where(and(eq(goalImportedDesignReviews.id, opts.importedDesignReviewId), eq(goalImportedDesignReviews.organizationId, ctx.organizationId)));
    if (!owner || owner.stopRequested || opts.mode !== "manual" || ![owner.authorInstanceId, owner.reviewerInstanceId].includes(opts.agentInstanceId ?? ""))
      throw AppError.conflict("Only H4 can revalidate its exact reserved participants");
  }
  if (opts.importedDesignRunId) {
    const [owner] = await tx.select().from(goalImportedDesignContinuations).where(and(eq(goalImportedDesignContinuations.organizationId, ctx.organizationId),
      eq(goalImportedDesignContinuations.runId, opts.importedDesignRunId)));
    if (!owner || owner.stopRequested || owner.result !== null || opts.mode !== "manual" || opts.agentInstanceId !== owner.writerInstanceId)
      throw AppError.conflict("Only an unused imported design can revalidate its exact reserved run");
  }
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
    .innerJoin(computers, and(eq(agentInstances.computerId, computers.id), eq(computers.organizationId, ctx.organizationId)))
    .innerJoin(agents, and(eq(agentInstances.agentId, agents.id), eq(agents.organizationId, ctx.organizationId)))
    .leftJoin(
      agentRuntimes,
      and(
        eq(agentRuntimes.organizationId, ctx.organizationId),
        eq(agentRuntimes.computerId, agentInstances.computerId),
        eq(agentRuntimes.runtime, agentInstances.runtime),
      ),
    )
    .where(and(eq(agentInstances.organizationId, ctx.organizationId), eq(agentInstances.projectId, opts.projectId)));

  const now = ctx.clock.nowIso();

  // #113 slice 5 — INTENTIONAL behavior change: busy/idle is now derived from
  // capacity (active non-terminal runs vs concurrency_limit), NOT from the
  // possibly-stale `agent_instances.status`; and a bound REVOKED device excludes
  // the candidate. `agent_instances.status` is kept only as an admin guard
  // (disabled/stopping/failed). The missing-runtime-row fallback is UNCHANGED.

  // Active (non-terminal) runs per instance, for capacity. One query; counted in JS.
  const activeRunRows = await tx
    .select({ id: runs.id, agentInstanceId: runs.agentInstanceId, status: runs.status })
    .from(runs)
    .where(eq(runs.organizationId, ctx.organizationId));
  const activeRunsByInstance = new Map<string, number>();
  for (const r of activeRunRows) {
    if (r.id !== opts.cleanValidationRunId && r.id !== opts.recoveryValidationRunId && r.id !== opts.importedValidationRunId && r.id !== opts.importedDesignRunId && r.id !== opts.importedExecutionRunId && r.id !== opts.importedExecutionRepairRunId && isActiveRunStatus(r.status)) {
      activeRunsByInstance.set(r.agentInstanceId, (activeRunsByInstance.get(r.agentInstanceId) ?? 0) + 1);
    }
  }
  for (const operation of await unsettledStandaloneExecutions(ctx, tx)) {
    if ("runId" in operation && (operation.runId === opts.cleanValidationRunId || operation.runId === opts.recoveryValidationRunId || operation.runId === opts.importedValidationRunId || operation.runId === opts.importedDesignRunId || operation.runId === opts.importedExecutionRunId || operation.runId === opts.importedExecutionRepairRunId || activeRunRows.some(run => run.id === operation.runId && isActiveRunStatus(run.status)))) continue;
    if (operation.kind === "clean_validation_review" && operation.id === opts.cleanValidationReviewId) continue;
    if (operation.kind === "recovery_validation_review" && operation.id === opts.recoveryValidationReviewId) continue;
    if (operation.kind === "validation_review" && operation.id === opts.importedValidationReviewId) continue;
    if (operation.kind === "execution_review" && operation.id === opts.importedExecutionReviewId) continue;
    if (operation.kind === "design_review" && operation.id === opts.importedDesignReviewId) continue;
    for (const instanceId of operation.participantInstanceIds) activeRunsByInstance.set(instanceId, (activeRunsByInstance.get(instanceId) ?? 0) + 1);
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
      // eligible with no runtime caps. A present-but-missing/disabled or stale/
      // timestamp-less row excludes the candidate (its runtime is known-bad). A fresh,
      // enabled row contributes its capabilities. `version` is non-gating.
      let runtimeCaps: Capability[] = [];
      if (r.runtimeStatus !== null) {
        if (r.runtimeStatus === "disabled" || r.runtimeStatus === "missing") {
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

  const supported = permitted.filter((r) => {
    const config = r.instanceConfig;
    const configured = config !== null && typeof config === "object" && !Array.isArray(config)
      && "worktree_workspace_base" in config && config.worktree_workspace_base !== undefined;
    return !opts.branchBacked || !configured
      || ctx.supportsExecutionFeature?.(r.computerId, "workspace-allocation.per-run-v1") === true;
  });

  const candidates: SchedulerCandidate[] = supported
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
    if (permitted.length > 0 && supported.length === 0) {
      throw AppError.conflict("No eligible current node session supports the configured per-run workspace allocation");
    }
    if (rows.length === 0) {
      throw new AppError("runtime_unavailable", "This project's squad is empty; assign an agent instance before starting work", 409);
    }
    const anyOnline = rows.some((r) => r.computerStatus === "online");
    if (!anyOnline) {
      throw new AppError("computer_offline", "no online computer is available", 409);
    }
    throw new AppError(
      "runtime_unavailable",
      "no eligible idle agent instance in this project's squad for the required capabilities",
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
