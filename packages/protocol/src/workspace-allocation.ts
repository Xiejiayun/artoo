import { Buffer } from "node:buffer";
import { posix, win32 } from "node:path";

/** Persist only through a route that authorizes the selected instance's administrator. */
export interface WorktreeBaseConfiguration {
  readonly version: 1;
  readonly strategy: "per-run";
  readonly basePath: string;
}

export interface AllocationInput {
  /** Existing ordinary/legacy exact root, including its existing nullable semantics. */
  readonly workspaceRoot: string | null;
  /** Derived by the caller from the already validated assignment's non-null branch. */
  readonly branchBacked: boolean;
  /** The selected computer's recorded OS, never the server host's OS. */
  readonly targetComputerOs: string;
  readonly agentInstanceId: string;
  readonly runId: string;
  /** The selected instance's persisted setting. Only undefined means absent. */
  readonly worktreeBase?: unknown;
}

export type WorkspaceAllocationErrorCode =
  | "invalid_assignment"
  | "invalid_configuration"
  | "unsupported_os"
  | "invalid_base_path"
  | "invalid_identifier"
  | "path_too_long";

export class WorkspaceAllocationError extends Error {
  readonly code: WorkspaceAllocationErrorCode;

  constructor(code: WorkspaceAllocationErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceAllocationError";
    this.code = code;
  }
}

const MAX_ID_ASCII_LENGTH = 64;
const POSIX_MAX_PATH_BYTES = 4095;
// Version 1 deliberately excludes Windows extended-length/device namespaces.
const WINDOWS_MAX_PATH_UNITS = 259;

function pathKind(os: string): "posix" | "windows" {
  if (os === "darwin" || os === "macos" || os === "linux") return "posix";
  if (os === "win32" || os === "windows") return "windows";
  throw new WorkspaceAllocationError("unsupported_os", "Per-run worktrees require a supported target computer OS");
}

function invalidBase(reason: string): never {
  throw new WorkspaceAllocationError("invalid_base_path", reason);
}

function validateBase(base: string, kind: "posix" | "windows"): void {
  if (!base.isWellFormed() || /[\u0000-\u001f\u007f;,]/u.test(base)) {
    invalidBase("Worktree base contains malformed Unicode, control characters, or unsupported configuration delimiters");
  }

  let components: string[];
  if (kind === "posix") {
    if (!posix.isAbsolute(base) || base.startsWith("//") || base.includes("\\")) {
      invalidBase("Worktree base must be a fully qualified POSIX path with one leading slash and no Windows separators");
    }
    if (Buffer.byteLength(base, "utf8") > POSIX_MAX_PATH_BYTES) invalidBase("POSIX worktree base exceeds the version 1 byte limit");
    components = base.split("/").filter(Boolean);
    if (components.some((part) => Buffer.byteLength(part, "utf8") > 255)) {
      invalidBase("POSIX worktree base component exceeds the version 1 byte limit");
    }
  } else {
    const driveRoot = /^[A-Za-z]:[\\/]/.test(base);
    const uncRoot = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(base);
    if ((!driveRoot && !uncRoot) || !win32.isAbsolute(base)) {
      invalidBase("Worktree base must be a fully qualified Windows drive or UNC share path");
    }
    if (base.length > WINDOWS_MAX_PATH_UNITS) invalidBase("Windows worktree base exceeds the version 1 UTF-16 limit");
    components = base.slice(driveRoot ? 3 : 2).split(/[\\/]/).filter(Boolean);
    for (const part of components) {
      if (part.length > 255 || /[<>:"|?*]/.test(part) || /[. ]$/.test(part)) {
        invalidBase("Windows worktree base contains an unsupported component");
      }
      const deviceStem = part.split(".")[0]!.replace(/ +$/, "");
      if (/^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(deviceStem)) {
        invalidBase("Windows device names are not supported in a worktree base");
      }
    }
  }
  if (components.some((part) => part === "." || part === "..")) {
    invalidBase("Worktree base must not contain dot or parent-traversal segments");
  }
}

/**
 * Validate the new setting at the administrator boundary and again when allocating.
 * Input is a persisted JSON value, not an arbitrary instance config object.
 * This performs lexical validation only; it cannot establish approval or disk safety.
 */
export function validateWorktreeBaseConfiguration(
  value: unknown,
  targetComputerOs: string,
): WorktreeBaseConfiguration {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceAllocationError("invalid_configuration", "Worktree base setting must be a versioned object");
  }
  const config = value as Record<string, unknown>;
  const keys = Object.keys(config);
  if (keys.length !== 3 || !keys.every((key) => ["version", "strategy", "basePath"].includes(key)) ||
      config.version !== 1 || config.strategy !== "per-run" || typeof config.basePath !== "string") {
    throw new WorkspaceAllocationError("invalid_configuration", "Worktree base setting requires exactly version 1, per-run strategy and basePath");
  }
  validateBase(config.basePath, pathKind(targetComputerOs));
  return { version: 1, strategy: "per-run", basePath: config.basePath };
}

function encodedId(id: string, prefix: "ai" | "run"): string {
  if (typeof id !== "string" || id.length > MAX_ID_ASCII_LENGTH ||
      !(prefix === "ai" ? /^ai_[A-Za-z0-9_-]+$/ : /^run_[A-Za-z0-9_-]+$/).test(id)) {
    throw new WorkspaceAllocationError("invalid_identifier", `${prefix} identifier must be a prefixed ASCII segment of at most 64 characters`);
  }
  // Injective encoding, rather than lowercasing or a collision-prone slug/hash.
  // ai_A and ai_a stay distinct even on a case-insensitive target filesystem.
  return Buffer.from(id, "ascii").toString("hex");
}

/**
 * Resolve a NEW assignment's root before run/ContextPack/lease persistence.
 * Use only the selected instance's administrator-approved setting and immutable IDs.
 * Persist this return value once; never call again to move an existing run after a
 * settings change. No paths are created, resolved on disk, checked for existence,
 * authorized, adopted, or deleted. The node must enforce those physical boundaries.
 */
export function allocateWorkspaceRoot(input: AllocationInput): string | null {
  if (typeof input.branchBacked !== "boolean") {
    throw new WorkspaceAllocationError("invalid_assignment", "branchBacked must be explicitly true or false");
  }
  if (!input.branchBacked || input.worktreeBase === undefined) return input.workspaceRoot;

  const config = validateWorktreeBaseConfiguration(input.worktreeBase, input.targetComputerOs);
  const kind = pathKind(input.targetComputerOs);
  const separator = kind === "windows" ? "\\" : "/";
  const suffix = ["artoo-runs", `i-${encodedId(input.agentInstanceId, "ai")}`, `r-${encodedId(input.runId, "run")}`].join(separator);
  const hasTrailingSeparator = kind === "windows" ? /[\\/]$/.test(config.basePath) : config.basePath.endsWith("/");
  // Do not join/resolve/normalize the base: its exact spelling is part of the record.
  const root = config.basePath + (hasTrailingSeparator ? "" : separator) + suffix;
  if ((kind === "windows" && root.length > WINDOWS_MAX_PATH_UNITS) ||
      (kind === "posix" && Buffer.byteLength(root, "utf8") > POSIX_MAX_PATH_BYTES)) {
    throw new WorkspaceAllocationError("path_too_long", "Allocated worktree root exceeds the version 1 target path limit");
  }
  return root;
}
