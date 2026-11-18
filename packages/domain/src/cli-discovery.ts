import { z } from "zod";

/** Closed set of built-in CLIs probed by controlled local discovery (T17 MVP). */
export const DISCOVERABLE_CLI_IDS = ["codex", "claude-code", "copilot", "agy", "gemini", "opencode", "cursor"] as const;
export const DiscoverableCliIdSchema = z.enum(DISCOVERABLE_CLI_IDS);
export type DiscoverableCliId = z.infer<typeof DiscoverableCliIdSchema>;

/** Runtimes eligible for the narrow manual single-turn plain-text adapter slice. */
export const SINGLE_TURN_TEXT_RUNTIME_IDS = ["copilot", "agy"] as const;
export const SingleTurnTextRuntimeIdSchema = z.enum(SINGLE_TURN_TEXT_RUNTIME_IDS);
export type SingleTurnTextRuntimeId = z.infer<typeof SingleTurnTextRuntimeIdSchema>;

export const SINGLE_TURN_TEXT_RUNTIME_FEATURE_V1 = "single-turn-text-runtime.v1" as const;

export function isSingleTurnTextRuntime(runtime: string): runtime is SingleTurnTextRuntimeId {
  return (SINGLE_TURN_TEXT_RUNTIME_IDS as readonly string[]).includes(runtime);
}

export const CliDiscoveryInstallStatusSchema = z.enum(["installed", "missing", "unverified_entrypoint"]);
export type CliDiscoveryInstallStatus = z.infer<typeof CliDiscoveryInstallStatusSchema>;

export const CliDiscoveryExecutionStatusSchema = z.enum([
  "existing_runtime",
  "ready_single_turn",
  "installed_unverified",
  "unsupported",
  "unavailable",
  "disabled",
]);
export type CliDiscoveryExecutionStatus = z.infer<typeof CliDiscoveryExecutionStatusSchema>;

export const CliDiscoveryReasonCodeSchema = z.enum([
  "existing_runtime",
  "single_turn_no_tools_only",
  "verification_required",
  "execution_unsupported_in_mvp",
  "unverified_windows_shim",
  "identity_unconfirmed",
  "not_installed",
  "auth_required",
  "quota_exceeded",
  "network_error",
  "protocol_error",
  "timeout",
  "verification_unknown",
  "disabled_by_operator",
  "platform_unsupported",
]);
export type CliDiscoveryReasonCode = z.infer<typeof CliDiscoveryReasonCodeSchema>;

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/u;
const LOCAL_PATH_RE =
  /(?:[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|(?:^|[\s"'=(])(?:~\/|\/(?:Users|home|root|tmp|var|etc|opt|usr)\/))/u;

export function containsLocalPathOrControl(value: string): boolean {
  return CONTROL_CHARS_RE.test(value) || LOCAL_PATH_RE.test(value);
}

function assertSafeDisplayText(value: string, field: string, ctx: z.RefinementCtx): void {
  if (containsLocalPathOrControl(value)) {
    ctx.addIssue({
      code: "custom",
      path: [field],
      message: `${field} must not include local filesystem paths or control characters`,
    });
  }
}

export const CliDiscoveryEntryV1Schema = z
  .object({
    id: DiscoverableCliIdSchema,
    display_name: z.string().min(1).max(128),
    install_status: CliDiscoveryInstallStatusSchema,
    execution_status: CliDiscoveryExecutionStatusSchema,
    version: z.string().min(1).max(128).nullable(),
    reason_code: CliDiscoveryReasonCodeSchema,
    reason: z.string().min(1).max(256),
    can_verify: z.boolean(),
    can_dispatch: z.boolean(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    assertSafeDisplayText(entry.display_name, "display_name", ctx);
    assertSafeDisplayText(entry.reason, "reason", ctx);
    if (entry.version !== null) assertSafeDisplayText(entry.version, "version", ctx);

    const dispatchableStatus =
      entry.execution_status === "existing_runtime" || entry.execution_status === "ready_single_turn";
    if (entry.can_dispatch && (entry.install_status !== "installed" || !dispatchableStatus)) {
      ctx.addIssue({
        code: "custom",
        path: ["can_dispatch"],
        message: "Only installed existing or verified single-turn runtimes may be dispatchable",
      });
    }

    if (entry.install_status !== "installed") {
      if (entry.can_dispatch) {
        ctx.addIssue({
          code: "custom",
          path: ["can_dispatch"],
          message: "Non-installed CLIs cannot be dispatched",
        });
      }
      if (entry.can_verify) {
        ctx.addIssue({
          code: "custom",
          path: ["can_verify"],
          message: "Non-installed CLIs cannot be verified",
        });
      }
      if (dispatchableStatus || entry.execution_status === "installed_unverified") {
        ctx.addIssue({
          code: "custom",
          path: ["execution_status"],
          message: "Non-installed CLIs cannot report ready or installed_unverified execution status",
        });
      }
    }

    if (entry.install_status === "missing" && entry.version !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["version"],
        message: "Missing CLIs must report a null version",
      });
    }

    if (entry.execution_status === "ready_single_turn" && !isSingleTurnTextRuntime(entry.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["execution_status"],
        message: "ready_single_turn is reserved for single-turn text runtime adapters",
      });
    }

    if (entry.execution_status === "existing_runtime" && entry.id !== "codex" && entry.id !== "claude-code") {
      ctx.addIssue({
        code: "custom",
        path: ["execution_status"],
        message: "existing_runtime is reserved for codex and claude-code",
      });
    }

    if ((entry.execution_status === "unsupported" || entry.execution_status === "disabled") && entry.can_verify) {
      ctx.addIssue({
        code: "custom",
        path: ["can_verify"],
        message: "Unsupported or disabled CLIs cannot advertise verification",
      });
    }

    if (entry.can_verify && (!isSingleTurnTextRuntime(entry.id) || entry.reason_code === "platform_unsupported")) {
      ctx.addIssue({
        code: "custom",
        path: ["can_verify"],
        message: "Only supported single-turn runtimes on supported platforms may allow connection verification",
      });
    }
  });
export type CliDiscoveryEntryV1 = z.infer<typeof CliDiscoveryEntryV1Schema>;

export const MAX_CLI_DISCOVERY_ENTRIES = 16;

export const CliDiscoveryInventoryV1Schema = z
  .object({
    version: z.literal(1),
    observed_at: z.string().datetime(),
    entries: z.array(CliDiscoveryEntryV1Schema).max(MAX_CLI_DISCOVERY_ENTRIES),
  })
  .strict()
  .superRefine((inventory, ctx) => {
    const seen = new Set<string>();
    inventory.entries.forEach((entry, index) => {
      if (seen.has(entry.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "id"],
          message: `Duplicate CLI discovery entry '${entry.id}'`,
        });
      }
      seen.add(entry.id);
    });
  });
export type CliDiscoveryInventoryV1 = z.infer<typeof CliDiscoveryInventoryV1Schema>;

export const CliConnectionVerificationStatusSchema = z.enum([
  "verified",
  "auth_failed",
  "quota_exceeded",
  "network_error",
  "protocol_error",
  "timeout",
  "unknown",
]);
export type CliConnectionVerificationStatus = z.infer<typeof CliConnectionVerificationStatusSchema>;

export const CliConnectionVerificationOutcomeV1Schema = z
  .object({
    version: z.literal(1),
    runtime: SingleTurnTextRuntimeIdSchema,
    status: CliConnectionVerificationStatusSchema,
    verified_at: z.string().datetime(),
    version_observed: z.string().min(1).max(128).nullable(),
    message: z.string().min(1).max(256),
  })
  .strict()
  .superRefine((outcome, ctx) => {
    assertSafeDisplayText(outcome.message, "message", ctx);
    if (outcome.version_observed !== null) assertSafeDisplayText(outcome.version_observed, "version_observed", ctx);
  });
export type CliConnectionVerificationOutcomeV1 = z.infer<typeof CliConnectionVerificationOutcomeV1Schema>;
