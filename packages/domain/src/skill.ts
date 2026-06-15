/**
 * Skill manifest contract (skill.yaml v1alpha1) — design.md §6 (Skills),
 * v0.1-complete Phase A.
 *
 * Pure domain: zod schema/types, deterministic validation, a stable permission
 * summary for UI/policy, and runtime-aware capability contribution. Storage,
 * install/enable APIs, scheduler consumption, and approval-policy integration
 * are Phase B and intentionally NOT here.
 *
 * Conventions: manifest keys are snake_case (as authored in skill.yaml). The
 * manifest is `.passthrough()` so unknown top-level fields survive for
 * forward-compat; `permissions` is `.strict()` because the permission category
 * vocabulary is closed.
 */
import { z } from "zod";

import { CAPABILITIES, CapabilitySchema, type Capability } from "./capabilities.js";
import { RiskSchema } from "./schemas.js";

type Risk = z.infer<typeof RiskSchema>;

/** The only manifest version this module understands. */
export const SKILL_API_VERSION = "v1alpha1" as const;

// Official-ish semver (no build/though prerelease allowed). Rejects "1.0", "v1".
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const SemverSchema = z.string().regex(SEMVER_RE, "must be a semantic version (x.y.z)");

/** Closed vocabulary surfaced by the permission summary for UI/policy. */
export const PermissionCategorySchema = z.enum([
  "filesystem",
  "network",
  "secrets",
  "external_service",
  "high_risk_action",
]);
export const PERMISSION_CATEGORIES = PermissionCategorySchema.options;
export type PermissionCategory = z.infer<typeof PermissionCategorySchema>;

/** A declared high-risk action carries an approval risk (reuses RiskSchema). */
export const HighRiskActionSchema = z
  .object({
    action: z.string().min(1),
    risk: RiskSchema.default("high"),
  })
  .strict();
export type HighRiskAction = z.infer<typeof HighRiskActionSchema>;

/** Structured, closed permission declarations. */
export const SkillPermissionsSchema = z
  .object({
    filesystem: z
      .object({
        read: z.array(z.string()).default([]),
        write: z.array(z.string()).default([]),
      })
      .strict()
      .optional(),
    network: z
      .object({
        outbound: z.array(z.string()).default([]),
      })
      .strict()
      .optional(),
    secrets: z.array(z.string()).optional(),
    external_services: z.array(z.string()).optional(),
    high_risk_actions: z.array(HighRiskActionSchema).optional(),
  })
  .strict();
export type SkillPermissions = z.infer<typeof SkillPermissionsSchema>;

/**
 * Optional MCP tool binding. This is an execution/tool binding only and is
 * independent of `compatible_runtimes` (the scheduler-facing contract). The
 * refine applies to the binding itself: stdio needs a command, http/sse a url.
 * Shape only — never used to reach a live MCP server in this layer.
 */
export const McpBindingSchema = z
  .object({
    server: z.string().min(1),
    transport: z.enum(["stdio", "http", "sse"]),
    command: z.string().min(1).nullish(),
    args: z.array(z.string()).default([]),
    url: z.string().min(1).nullish(),
  })
  .passthrough()
  .superRefine((binding, ctx) => {
    if (binding.transport === "stdio" && (binding.command === undefined || binding.command === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "stdio transport requires a command",
      });
    }
    if (
      (binding.transport === "http" || binding.transport === "sse") &&
      (binding.url === undefined || binding.url === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: `${binding.transport} transport requires a url`,
      });
    }
  });
export type McpBinding = z.infer<typeof McpBindingSchema>;

const SchemaRefSchema = z.union([z.string().min(1), z.record(z.string(), z.unknown())]);

export const ApprovalRiskSchema = z
  .object({
    action: z.string().min(1),
    risk: RiskSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();
export type ApprovalRisk = z.infer<typeof ApprovalRiskSchema>;

/** skill.yaml v1alpha1. */
export const SkillManifestSchema = z
  .object({
    api_version: z.literal(SKILL_API_VERSION),
    id: z.string().min(1),
    name: z.string().min(1),
    version: SemverSchema,
    description: z.string().default(""),
    capabilities: z.array(CapabilitySchema),
    // Scheduler-facing runtime compatibility. Kept as free strings until #15
    // freezes a runtime enum; at least one runtime is required.
    compatible_runtimes: z.array(z.string().min(1)).min(1),
    permissions: SkillPermissionsSchema.optional(),
    approval_risks: z.array(ApprovalRiskSchema).default([]),
    input_schema: SchemaRefSchema.optional(),
    output_schema: SchemaRefSchema.optional(),
    mcp: McpBindingSchema.optional(),
    evals: z.array(z.string().min(1)).default([]),
  })
  .passthrough();
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface SkillValidationIssue {
  /** Dotted path into the manifest, e.g. "permissions.filesystem". */
  path: string;
  message: string;
}

export interface SkillValidationResult {
  ok: boolean;
  /** Present iff ok. */
  manifest?: SkillManifest;
  /** Empty iff ok; otherwise sorted (path, then message) for determinism. */
  errors: SkillValidationIssue[];
}

/** Deterministic manifest validation: same input always yields the same result. */
export function validateSkillManifest(input: unknown): SkillValidationResult {
  const parsed = SkillManifestSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, manifest: parsed.data, errors: [] };
  }
  const errors = parsed.error.issues
    .map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    .sort((a, b) =>
      a.path === b.path ? a.message.localeCompare(b.message) : a.path.localeCompare(b.path),
    );
  return { ok: false, errors };
}

// ---------------------------------------------------------------------------
// Permission summary
// ---------------------------------------------------------------------------

export interface PermissionSummary {
  filesystem: { read: string[]; write: string[] };
  network: { outbound: string[] };
  secrets: string[];
  external_services: string[];
  high_risk_actions: { action: string; risk: Risk }[];
  approval_risks: ApprovalRisk[];
  /** Non-empty categories, in canonical PERMISSION_CATEGORIES order. */
  categories: PermissionCategory[];
  /** Deterministic overall risk (see rules below). */
  risk: Risk;
}

const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

function maxRisk(a: Risk, b: Risk): Risk {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/**
 * Stable summary for UI/policy. All lists are sorted; risk is deterministic:
 *  - filesystem write or any network egress -> at least `medium`
 *  - secrets, external services, or any high-risk action -> `high`
 *  - and never below any explicitly declared high-risk-action risk.
 * Read-only filesystem alone stays `low`.
 */
export function summarizeSkillPermissions(manifest: SkillManifest): PermissionSummary {
  const permissions = manifest.permissions;
  const sortedCopy = (values: readonly string[] | undefined): string[] => [...(values ?? [])].sort();

  const fsRead = sortedCopy(permissions?.filesystem?.read);
  const fsWrite = sortedCopy(permissions?.filesystem?.write);
  const netOut = sortedCopy(permissions?.network?.outbound);
  const secrets = sortedCopy(permissions?.secrets);
  const externalServices = sortedCopy(permissions?.external_services);
  const highRiskActions = [...(permissions?.high_risk_actions ?? [])]
    .map((entry) => ({ action: entry.action, risk: entry.risk }))
    .sort((a, b) => a.action.localeCompare(b.action));
  const approvalRisks = [...manifest.approval_risks].sort((a, b) =>
    a.action === b.action ? a.risk.localeCompare(b.risk) : a.action.localeCompare(b.action),
  );

  const presence: Record<PermissionCategory, boolean> = {
    filesystem: fsRead.length > 0 || fsWrite.length > 0,
    network: netOut.length > 0,
    secrets: secrets.length > 0,
    external_service: externalServices.length > 0,
    high_risk_action: highRiskActions.length > 0,
  };
  const categories = PERMISSION_CATEGORIES.filter((category) => presence[category]);

  let risk: Risk = "low";
  if (fsWrite.length > 0) risk = maxRisk(risk, "medium");
  if (presence.network) risk = maxRisk(risk, "medium");
  if (presence.secrets) risk = maxRisk(risk, "high");
  if (presence.external_service) risk = maxRisk(risk, "high");
  for (const entry of highRiskActions) risk = maxRisk(risk, entry.risk);
  for (const entry of approvalRisks) risk = maxRisk(risk, entry.risk);

  return {
    filesystem: { read: fsRead, write: fsWrite },
    network: { outbound: netOut },
    secrets,
    external_services: externalServices,
    high_risk_actions: highRiskActions,
    approval_risks: approvalRisks,
    categories,
    risk,
  };
}

// ---------------------------------------------------------------------------
// Capability contribution
// ---------------------------------------------------------------------------

export interface SkillInstallState {
  manifest: SkillManifest;
  enabled: boolean;
}

/**
 * Capabilities an enabled skill contributes, in canonical CAPABILITIES order.
 * A disabled skill contributes nothing. When `runtimeId` is given, the skill
 * only contributes if it lists that runtime in `compatible_runtimes` — this is
 * the seam Phase B's scheduler uses to ask "capabilities for runtime X?".
 */
export function skillContributesCapabilities(
  manifest: SkillManifest,
  enabled: boolean,
  runtimeId?: string,
): Capability[] {
  if (!enabled) return [];
  if (runtimeId !== undefined && !manifest.compatible_runtimes.includes(runtimeId)) return [];
  const present = new Set<Capability>(manifest.capabilities);
  return CAPABILITIES.filter((capability) => present.has(capability));
}

/**
 * Union of capabilities contributed by all enabled installs (deduped, canonical
 * order). Optionally restricted to a runtime. Note: scoping to org/project/
 * install is a Phase B storage concern — this helper does not make capabilities
 * globally active, it only computes a contribution from the inputs it is given.
 */
export function contributedCapabilities(
  installs: readonly SkillInstallState[],
  runtimeId?: string,
): Capability[] {
  const present = new Set<Capability>();
  for (const install of installs) {
    if (!install.enabled) continue;
    if (runtimeId !== undefined && !install.manifest.compatible_runtimes.includes(runtimeId)) {
      continue;
    }
    for (const capability of install.manifest.capabilities) present.add(capability);
  }
  return CAPABILITIES.filter((capability) => present.has(capability));
}
