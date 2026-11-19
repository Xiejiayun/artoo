import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import {
  CliDiscoveryInventoryV1Schema,
  type CliConnectionVerificationOutcomeV1,
  type CliDiscoveryEntryV1,
  type CliDiscoveryInventoryV1,
  type CliDiscoveryReasonCode,
  type DiscoverableCliId,
  type SingleTurnTextRuntimeId,
  isSingleTurnTextRuntime,
} from "@artoo/domain";

export interface ControlledCliSpec {
  readonly id: DiscoverableCliId;
  readonly displayName: string;
  readonly command: string;
  readonly kind: "existing" | "single_turn" | "unsupported";
}

export const CONTROLLED_CLI_CATALOG: readonly ControlledCliSpec[] = Object.freeze([
  Object.freeze({ id: "codex", displayName: "Codex", command: "codex", kind: "existing" }),
  Object.freeze({ id: "claude-code", displayName: "Claude Code", command: "claude", kind: "existing" }),
  Object.freeze({ id: "copilot", displayName: "GitHub Copilot CLI", command: "copilot", kind: "single_turn" }),
  Object.freeze({ id: "agy", displayName: "Antigravity CLI", command: "agy", kind: "single_turn" }),
  Object.freeze({ id: "gemini", displayName: "Gemini CLI", command: "gemini", kind: "unsupported" }),
  Object.freeze({ id: "opencode", displayName: "OpenCode", command: "opencode", kind: "unsupported" }),
  Object.freeze({ id: "cursor", displayName: "Cursor CLI", command: "cursor", kind: "unsupported" }),
]);

export interface ResolvedCliEntrypoint {
  readonly status: "resolved";
  readonly executable: string;
  readonly prefixArgs: readonly string[];
  readonly entrypointPath: string;
  readonly fingerprint: string;
}

export type InspectedCliEntrypoint =
  | ResolvedCliEntrypoint
  | { readonly status: "missing" }
  | { readonly status: "unverified_shim" };

export interface ProbedCliCandidate {
  readonly spec: ControlledCliSpec;
  readonly installStatus: "installed" | "missing" | "unverified_entrypoint";
  readonly failureReasonCode: "not_installed" | "unverified_windows_shim" | "identity_unconfirmed" | null;
  readonly version: string | null;
  readonly fingerprint: string | null;
  readonly resolved: ResolvedCliEntrypoint | null;
}

export interface CliDiscoverySamplerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly timeoutMs?: number;
  readonly binaryOverrides?: Partial<Record<DiscoverableCliId, string>>;
  readonly registeredRuntimes?: ReadonlySet<string>;
  readonly supportedSingleTurnRuntimes?: ReadonlySet<SingleTurnTextRuntimeId>;
  readonly enabledSingleTurnRuntimes?: ReadonlySet<SingleTurnTextRuntimeId>;
  readonly getVerificationOutcome?: (
    runtime: SingleTurnTextRuntimeId,
    fingerprint: string,
  ) => CliConnectionVerificationOutcomeV1 | undefined;
  readonly now?: () => number;
  readonly probeVersion?: (
    id: DiscoverableCliId,
    resolved: ResolvedCliEntrypoint,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
  ) => { confirmed: boolean; version: string | null };
}

export interface CliDiscoverySampler {
  snapshot(): CliDiscoveryInventoryV1;
  refresh(): CliDiscoveryInventoryV1;
  candidate(id: DiscoverableCliId): ProbedCliCandidate | undefined;
}

const NPM_SHIM_SCRIPT_RE = /["']%dp0%[\\/]([^"'\r\n]+\.(?:c?js|mjs))["']/i;
const SEMVER_RE = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z._-]+)?)\b/;

function minimalProbeEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const allowed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TMP|TEMP|TMPDIR|LANG|LC_ALL)$/i.test(key)) {
      allowed[key] = value;
    }
  }
  return allowed;
}

function fileFingerprint(filePath: string): { physical: string; fingerprint: string } | null {
  const stat = statSync(filePath);
  if (!stat.isFile()) return null;
  const physical = realpathSync(filePath);
  const hash = createHash("sha256");
  hash.update(physical);
  hash.update("\0");
  hash.update(String(stat.size));
  hash.update("\0");
  hash.update(String(Math.trunc(stat.mtimeMs)));
  if (stat.size <= 16 * 1024 * 1024) {
    hash.update("\0");
    hash.update(readFileSync(physical));
  }
  return { physical, fingerprint: `sha256:${hash.digest("hex")}` };
}

/** Resolve one controlled CLI candidate on PATH without invoking a shell. */
export function inspectCliEntrypoint(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { binaryOverride?: string; platform?: NodeJS.Platform } = {},
): InspectedCliEntrypoint {
  const platform = options.platform ?? process.platform;
  const checkCandidate = (candidatePath: string, extension: string): InspectedCliEntrypoint | null => {
    try {
      const lst = lstatSync(candidatePath);
      if (!lst.isFile() && !lst.isSymbolicLink()) return null;
      const st = statSync(candidatePath);
      if (!st.isFile()) return null;
      accessSync(candidatePath, platform === "win32" ? constants.F_OK : constants.X_OK);
      if (platform === "win32" && (extension === ".cmd" || extension === ".bat")) {
        const shim = readFileSync(candidatePath, "utf8");
        const script = NPM_SHIM_SCRIPT_RE.exec(shim)?.[1];
        if (!script) return { status: "unverified_shim" };
        const entry = resolve(dirname(candidatePath), script);
        const identity = fileFingerprint(entry);
        if (!identity) return { status: "unverified_shim" };
        return {
          status: "resolved",
          executable: process.execPath,
          prefixArgs: [identity.physical],
          entrypointPath: identity.physical,
          fingerprint: identity.fingerprint,
        };
      }
      const identity = fileFingerprint(candidatePath);
      if (!identity) return null;
      return {
        status: "resolved",
        executable: identity.physical,
        prefixArgs: [],
        entrypointPath: identity.physical,
        fingerprint: identity.fingerprint,
      };
    } catch {
      return null;
    }
  };

  if (options.binaryOverride) {
    if (
      typeof options.binaryOverride !== "string" ||
      !isAbsolute(options.binaryOverride) ||
      /[\u0000-\u001f\u007f]/.test(options.binaryOverride)
    ) {
      return { status: "missing" };
    }
    const lower = options.binaryOverride.toLowerCase();
    const ext = lower.endsWith(".cmd") ? ".cmd" : lower.endsWith(".bat") ? ".bat" : "";
    return checkCandidate(options.binaryOverride, ext) ?? { status: "missing" };
  }

  const paths =
    Object.entries(env)
      .find(([key]) => key.toLowerCase() === "path")?.[1]
      ?.split(delimiter)
      .filter(isAbsolute) ?? [];
  const extensions = platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  for (const directory of paths) {
    for (const extension of extensions) {
      const match = checkCandidate(join(directory, command + extension), extension);
      if (match) return match;
    }
  }
  return { status: "missing" };
}

function runBoundedCliProbe(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): string | null {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: tmpdir(),
    env: minimalProbeEnvironment(env),
  });
  if (result.error || result.signal !== null || result.status !== 0) return null;
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

/** Confirm CLI product identity and extract sanitized version without spending model quota. */
export function probeCliVersionAndIdentity(
  id: DiscoverableCliId,
  resolved: ResolvedCliEntrypoint,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 3000,
): { confirmed: boolean; version: string | null } {
  const versionOutput = runBoundedCliProbe(resolved.executable, [...resolved.prefixArgs, "--version"], env, timeoutMs);
  if (!versionOutput) return { confirmed: false, version: null };
  const cleanVersion = (match: RegExpExecArray | null): string | null =>
    match && match[1] && match[1].length <= 64 ? match[1] : null;
  switch (id) {
    case "copilot": {
      const version = cleanVersion(/GitHub Copilot CLI\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z._-]+)?)/i.exec(versionOutput));
      return version ? { confirmed: true, version } : { confirmed: false, version: null };
    }
    case "agy": {
      if (/copilot|gemini\s+cli|cursor|opencode|codex|claude/i.test(versionOutput)) {
        return { confirmed: false, version: null };
      }
      const named = /antigravity[^\r\n]*?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z._-]+)?)/i.exec(versionOutput);
      const bare = /^\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z._-]+)?)\s*$/m.exec(versionOutput);
      const version = cleanVersion(named ?? bare);
      if (!version) return { confirmed: false, version: null };
      if (!named) {
        const help = runBoundedCliProbe(resolved.executable, [...resolved.prefixArgs, "acp", "--help"], env, timeoutMs);
        if (!help || !/antigravity/i.test(help)) return { confirmed: false, version: null };
      }
      return { confirmed: true, version };
    }
    case "gemini": {
      if (/antigravity|copilot|cursor|opencode|codex|claude/i.test(versionOutput)) {
        return { confirmed: false, version: null };
      }
      const named = /gemini[^\r\n]*?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z._-]+)?)/i.exec(versionOutput);
      const bare = /^\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z._-]+)?)\s*$/m.exec(versionOutput);
      const version = cleanVersion(named ?? bare);
      if (!version) return { confirmed: false, version: null };
      if (!named) {
        const help = runBoundedCliProbe(resolved.executable, [...resolved.prefixArgs, "--help"], env, timeoutMs);
        if (!help || !/gemini/i.test(help)) return { confirmed: false, version: null };
      }
      return { confirmed: true, version };
    }
    case "opencode": {
      const version = cleanVersion(/opencode[^\r\n]*?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z._-]+)?)/i.exec(versionOutput));
      return version ? { confirmed: true, version } : { confirmed: false, version: null };
    }
    case "cursor": {
      const version = cleanVersion(/cursor[^\r\n]*?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z._-]+)?)/i.exec(versionOutput));
      return version ? { confirmed: true, version } : { confirmed: false, version: null };
    }
    case "codex": {
      const version = cleanVersion(
        /codex[^\r\n]*?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z._-]+)?)/i.exec(versionOutput) ??
          /^\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z._-]+)?)\s*$/m.exec(versionOutput),
      );
      return version ? { confirmed: true, version } : { confirmed: false, version: null };
    }
    case "claude-code": {
      const match = /claude/i.test(versionOutput) ? SEMVER_RE.exec(versionOutput) : null;
      const version = cleanVersion(match);
      return version ? { confirmed: true, version } : { confirmed: false, version: null };
    }
  }
}

function mapFailureOutcome(status: CliConnectionVerificationOutcomeV1["status"]): {
  reasonCode: CliDiscoveryReasonCode;
  reason: string;
} {
  switch (status) {
    case "auth_failed":
      return { reasonCode: "auth_required", reason: "请在本机登录" };
    case "quota_exceeded":
      return { reasonCode: "quota_exceeded", reason: "额度不足，请检查账号配额" };
    case "network_error":
      return { reasonCode: "network_error", reason: "网络故障，无法连接 Provider" };
    case "protocol_error":
      return { reasonCode: "protocol_error", reason: "协议握手或返回异常" };
    case "timeout":
      return { reasonCode: "timeout", reason: "连接验证超时" };
    default:
      return { reasonCode: "verification_unknown", reason: "连接状态未知" };
  }
}

function projectEntry(candidate: ProbedCliCandidate, options: CliDiscoverySamplerOptions): CliDiscoveryEntryV1 {
  const { spec } = candidate;
  if (candidate.installStatus === "missing") {
    return {
      id: spec.id,
      display_name: spec.displayName,
      install_status: "missing",
      execution_status: spec.kind === "unsupported" ? "unsupported" : "unavailable",
      version: null,
      reason_code: "not_installed",
      reason: "未安装",
      can_verify: false,
      can_dispatch: false,
    };
  }
  if (candidate.installStatus === "unverified_entrypoint") {
    const isShim = candidate.failureReasonCode === "unverified_windows_shim";
    return {
      id: spec.id,
      display_name: spec.displayName,
      install_status: "unverified_entrypoint",
      execution_status: "unavailable",
      version: null,
      reason_code: isShim ? "unverified_windows_shim" : "identity_unconfirmed",
      reason: isShim
        ? "入口未确认（Windows shim 无法识别，已拒绝回退到 shell）"
        : "入口未确认（不凭同名文件名认定产品）",
      can_verify: false,
      can_dispatch: false,
    };
  }
  if (spec.kind === "existing") {
    const registered = options.registeredRuntimes?.has(spec.id) ?? false;
    return registered
      ? {
          id: spec.id,
          display_name: spec.displayName,
          install_status: "installed",
          execution_status: "existing_runtime",
          version: candidate.version,
          reason_code: "existing_runtime",
          reason: "已就绪（既有运行时）",
          can_verify: false,
          can_dispatch: true,
        }
      : {
          id: spec.id,
          display_name: spec.displayName,
          install_status: "installed",
          execution_status: "disabled",
          version: candidate.version,
          reason_code: "disabled_by_operator",
          reason: "已安装，当前节点未注册此运行时",
          can_verify: false,
          can_dispatch: false,
        };
  }
  if (!isSingleTurnTextRuntime(spec.id)) {
    return {
      id: spec.id,
      display_name: spec.displayName,
      install_status: "installed",
      execution_status: "unsupported",
      version: candidate.version,
      reason_code: "execution_unsupported_in_mvp",
      reason: "已安装，暂不支持执行",
      can_verify: false,
      can_dispatch: false,
    };
  }
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "win32" || arch !== "x64") {
    return {
      id: spec.id,
      display_name: spec.displayName,
      install_status: "installed",
      execution_status: "unavailable",
      version: candidate.version,
      reason_code: "platform_unsupported",
      reason: "已安装，当前平台暂未开放执行资格（仅支持 Windows x64）",
      can_verify: false,
      can_dispatch: false,
    };
  }
  if (!options.supportedSingleTurnRuntimes?.has(spec.id)) {
    return {
      id: spec.id,
      display_name: spec.displayName,
      install_status: "installed",
      execution_status: "unsupported",
      version: candidate.version,
      reason_code: "execution_unsupported_in_mvp",
      reason: "已安装，暂不支持执行",
      can_verify: false,
      can_dispatch: false,
    };
  }
  if (!options.enabledSingleTurnRuntimes?.has(spec.id)) {
    return {
      id: spec.id,
      display_name: spec.displayName,
      install_status: "installed",
      execution_status: "disabled",
      version: candidate.version,
      reason_code: "disabled_by_operator",
      reason: "已安装，节点未启用此运行时",
      can_verify: false,
      can_dispatch: false,
    };
  }
  const outcome =
    candidate.fingerprint && options.getVerificationOutcome
      ? options.getVerificationOutcome(spec.id, candidate.fingerprint)
      : undefined;
  if (!outcome) {
    return {
      id: spec.id,
      display_name: spec.displayName,
      install_status: "installed",
      execution_status: "installed_unverified",
      version: candidate.version,
      reason_code: "verification_required",
      reason: "已安装，未验证",
      can_verify: true,
      can_dispatch: false,
    };
  }
  if (outcome.status === "verified") {
    return {
      id: spec.id,
      display_name: spec.displayName,
      install_status: "installed",
      execution_status: "ready_single_turn",
      version: candidate.version,
      reason_code: "single_turn_no_tools_only",
      reason: "已就绪 · 仅手动单轮",
      can_verify: true,
      can_dispatch: true,
    };
  }
  const mapped = mapFailureOutcome(outcome.status);
  return {
    id: spec.id,
    display_name: spec.displayName,
    install_status: "installed",
    execution_status: "unavailable",
    version: candidate.version,
    reason_code: mapped.reasonCode,
    reason: mapped.reason,
    can_verify: true,
    can_dispatch: false,
  };
}

function probeCatalog(options: CliDiscoverySamplerOptions): {
  observedAt: string;
  candidates: ProbedCliCandidate[];
} {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 3000;
  const probe = options.probeVersion ?? probeCliVersionAndIdentity;
  const candidates: ProbedCliCandidate[] = CONTROLLED_CLI_CATALOG.map((spec) => {
    const inspected = inspectCliEntrypoint(spec.command, env, {
      binaryOverride: options.binaryOverrides?.[spec.id],
      platform,
    });
    if (inspected.status === "missing") {
      return {
        spec,
        installStatus: "missing",
        failureReasonCode: "not_installed",
        version: null,
        fingerprint: null,
        resolved: null,
      };
    }
    if (inspected.status === "unverified_shim") {
      return {
        spec,
        installStatus: "unverified_entrypoint",
        failureReasonCode: "unverified_windows_shim",
        version: null,
        fingerprint: null,
        resolved: null,
      };
    }
    const identity = probe(spec.id, inspected, env, timeoutMs);
    if (!identity.confirmed) {
      return {
        spec,
        installStatus: "unverified_entrypoint",
        failureReasonCode: "identity_unconfirmed",
        version: null,
        fingerprint: null,
        resolved: null,
      };
    }
    return {
      spec,
      installStatus: "installed",
      failureReasonCode: null,
      version: identity.version,
      fingerprint: inspected.fingerprint,
      resolved: inspected,
    };
  });
  return {
    observedAt: new Date(options.now?.() ?? Date.now()).toISOString(),
    candidates,
  };
}

/**
 * Probe the built-in CLI catalog once on startup and only re-probe on explicit
 * refresh(); ordinary heartbeat snapshot() calls never spawn CLI subprocesses.
 */
export function createCliDiscoverySampler(options: CliDiscoverySamplerOptions = {}): CliDiscoverySampler {
  let state = probeCatalog(options);
  const buildInventory = (): CliDiscoveryInventoryV1 =>
    CliDiscoveryInventoryV1Schema.parse({
      version: 1,
      observed_at: state.observedAt,
      entries: state.candidates.map((candidate) => projectEntry(candidate, options)),
    });
  return {
    snapshot: () => buildInventory(),
    refresh: () => {
      state = probeCatalog(options);
      return buildInventory();
    },
    candidate: (id) => state.candidates.find((item) => item.spec.id === id),
  };
}
