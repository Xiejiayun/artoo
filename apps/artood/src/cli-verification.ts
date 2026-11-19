import {
  CliConnectionVerificationOutcomeV1Schema,
  containsLocalPathOrControl,
  type CliConnectionVerificationOutcomeV1,
  type CliDiscoveryInventoryV1,
  type SingleTurnTextRuntimeId,
} from "@artoo/domain";
import type { RuntimeAdapter } from "@artoo/protocol";

import {
  classifySingleTurnError,
  executeAcpSingleTurnPrompt,
  type AcpPromptExecutionOptions,
  type AcpPromptExecutionResult,
} from "./acp-single-turn-adapter.js";
import type { AdapterRegistry } from "./adapter-registry.js";
import {
  createCliDiscoverySampler,
  type CliDiscoverySampler,
  type CliDiscoverySamplerOptions,
} from "./cli-discovery.js";

export interface SingleTurnRuntimeControllerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly registry?: AdapterRegistry;
  readonly supportedRuntimes?: ReadonlySet<SingleTurnTextRuntimeId>;
  readonly enabledRuntimes?: ReadonlySet<SingleTurnTextRuntimeId>;
  readonly binaryOverrides?: CliDiscoverySamplerOptions["binaryOverrides"];
  readonly registeredRuntimes?: ReadonlySet<string>;
  readonly probeVersion?: CliDiscoverySamplerOptions["probeVersion"];
  readonly verificationTimeoutMs?: number;
  readonly now?: () => number;
  readonly runPrompt?: (options: AcpPromptExecutionOptions) => Promise<AcpPromptExecutionResult>;
}

export interface SingleTurnRuntimeController {
  readonly sampler: CliDiscoverySampler;
  readonly supportedRuntimes: ReadonlySet<SingleTurnTextRuntimeId>;
  readonly enabledRuntimes: ReadonlySet<SingleTurnTextRuntimeId>;
  featureEnabled(): boolean;
  snapshot(): CliDiscoveryInventoryV1;
  refresh(): CliDiscoveryInventoryV1;
  verifyConnection(
    runtime: SingleTurnTextRuntimeId,
  ): Promise<{ outcome: CliConnectionVerificationOutcomeV1; cli_discovery: CliDiscoveryInventoryV1 }>;
  isVerifiedReady(runtime: SingleTurnTextRuntimeId, expectedFingerprint?: string): boolean;
  bindAdapter(adapter: RuntimeAdapter): void;
}

function sanitizeVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  const trimmed = version.trim();
  if (!trimmed || trimmed.length > 128 || containsLocalPathOrControl(trimmed)) return null;
  return trimmed;
}

export function createSingleTurnRuntimeController(
  options: SingleTurnRuntimeControllerOptions = {},
): SingleTurnRuntimeController {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const supportedRuntimes = options.supportedRuntimes ?? new Set<SingleTurnTextRuntimeId>(["copilot"]);
  const enabledRuntimes = options.enabledRuntimes ?? new Set<SingleTurnTextRuntimeId>(["copilot"]);
  const now = options.now ?? (() => Date.now());
  const runPrompt = options.runPrompt ?? ((execOpts) => executeAcpSingleTurnPrompt(execOpts, platform));

  const verifiedByRuntime = new Map<
    SingleTurnTextRuntimeId,
    { fingerprint: string; outcome: CliConnectionVerificationOutcomeV1 }
  >();
  let boundAdapter: RuntimeAdapter | undefined;

  let samplerInstance: CliDiscoverySampler | undefined;
  const getSampler = (): CliDiscoverySampler => {
    samplerInstance ??= createCliDiscoverySampler({
      env: options.env,
      platform,
      arch,
      binaryOverrides: options.binaryOverrides,
      registeredRuntimes: options.registeredRuntimes,
      supportedSingleTurnRuntimes: supportedRuntimes,
      enabledSingleTurnRuntimes: enabledRuntimes,
      probeVersion: options.probeVersion,
      now,
      getVerificationOutcome: (runtime, fingerprint) => {
        const record = verifiedByRuntime.get(runtime);
        if (!record || record.fingerprint !== fingerprint) return undefined;
        return record.outcome;
      },
    });
    return samplerInstance;
  };
  const sampler: CliDiscoverySampler = {
    snapshot: () => getSampler().snapshot(),
    refresh: () => getSampler().refresh(),
    candidate: (id) => getSampler().candidate(id),
  };

  const syncRegistry = (): void => {
    if (!options.registry) return;
    for (const runtime of ["copilot", "agy"] as const) {
      const candidate = sampler.candidate(runtime);
      const record = verifiedByRuntime.get(runtime);
      const ready =
        platform === "win32" &&
        arch === "x64" &&
        supportedRuntimes.has(runtime) &&
        enabledRuntimes.has(runtime) &&
        candidate?.installStatus === "installed" &&
        candidate.fingerprint !== null &&
        record?.fingerprint === candidate.fingerprint &&
        record.outcome.status === "verified" &&
        boundAdapter !== undefined;

      if (ready && boundAdapter) {
        options.registry.set?.({ runtime, adapter: boundAdapter, capabilities: [] });
      } else {
        options.registry.remove?.(runtime);
      }
    }
  };

  return {
    sampler,
    supportedRuntimes,
    enabledRuntimes,

    featureEnabled(): boolean {
      return platform === "win32" && arch === "x64" && supportedRuntimes.size > 0;
    },

    snapshot(): CliDiscoveryInventoryV1 {
      return sampler.snapshot();
    },

    refresh(): CliDiscoveryInventoryV1 {
      const inv = sampler.refresh();
      for (const runtime of ["copilot", "agy"] as const) {
        const record = verifiedByRuntime.get(runtime);
        const current = sampler.candidate(runtime);
        if (
          record &&
          (!current || current.installStatus !== "installed" || current.fingerprint !== record.fingerprint)
        ) {
          verifiedByRuntime.delete(runtime);
        }
      }
      syncRegistry();
      return inv;
    },

    isVerifiedReady(runtime, expectedFingerprint): boolean {
      if (platform !== "win32" || arch !== "x64") return false;
      if (!supportedRuntimes.has(runtime) || !enabledRuntimes.has(runtime)) return false;
      const candidate = sampler.candidate(runtime);
      const record = verifiedByRuntime.get(runtime);
      if (!candidate || candidate.installStatus !== "installed" || !candidate.fingerprint || !record) {
        return false;
      }
      if (expectedFingerprint !== undefined && candidate.fingerprint !== expectedFingerprint) {
        return false;
      }
      return record.fingerprint === candidate.fingerprint && record.outcome.status === "verified";
    },

    bindAdapter(adapter: RuntimeAdapter): void {
      boundAdapter = adapter;
      syncRegistry();
    },

    async verifyConnection(runtime: SingleTurnTextRuntimeId) {
      const invBefore = sampler.refresh();
      const candidate = sampler.candidate(runtime);
      const checkedAt = new Date(now()).toISOString();

      if (platform !== "win32" || arch !== "x64") {
        const outcome = CliConnectionVerificationOutcomeV1Schema.parse({
          version: 1,
          runtime,
          status: "unknown",
          verified_at: checkedAt,
          version_observed: sanitizeVersion(candidate?.version),
          message: "当前平台暂未开放单轮纯文本执行验证（仅支持 Windows x64）",
        });
        syncRegistry();
        return { outcome, cli_discovery: sampler.snapshot() };
      }

      if (!supportedRuntimes.has(runtime) || !enabledRuntimes.has(runtime)) {
        const outcome = CliConnectionVerificationOutcomeV1Schema.parse({
          version: 1,
          runtime,
          status: "unknown",
          verified_at: checkedAt,
          version_observed: sanitizeVersion(candidate?.version),
          message: supportedRuntimes.has(runtime)
            ? "当前节点未启用该单轮运行时"
            : "该 CLI 在当前版本尚未开放受控无工具执行资格",
        });
        syncRegistry();
        return { outcome, cli_discovery: invBefore };
      }

      if (!candidate || candidate.installStatus !== "installed" || !candidate.resolved || !candidate.fingerprint) {
        verifiedByRuntime.delete(runtime);
        const outcome = CliConnectionVerificationOutcomeV1Schema.parse({
          version: 1,
          runtime,
          status: "unknown",
          verified_at: checkedAt,
          version_observed: null,
          message:
            candidate?.failureReasonCode === "unverified_windows_shim"
              ? "Windows 入口未确认，已拒绝验证"
              : candidate?.failureReasonCode === "identity_unconfirmed"
                ? "可执行程序身份未确认，已拒绝验证"
                : "本机未检测到可用 CLI",
        });
        syncRegistry();
        return { outcome, cli_discovery: sampler.snapshot() };
      }

      try {
        const result = await runPrompt({
          runtime,
          resolved: candidate.resolved,
          promptText: 'Reply ONLY with exact text "OK" and do not call any tools.',
          env: options.env,
          timeoutMs: options.verificationTimeoutMs ?? 25_000,
        });
        const validReply = result.text.trim().length > 0;
        const outcome = CliConnectionVerificationOutcomeV1Schema.parse({
          version: 1,
          runtime,
          status: validReply ? "verified" : "protocol_error",
          verified_at: new Date(now()).toISOString(),
          version_observed: sanitizeVersion(candidate.version),
          message: validReply ? "连接验证通过（无工具纯文本会话）" : "协议返回空响应",
        });
        verifiedByRuntime.set(runtime, { fingerprint: candidate.fingerprint, outcome });
      } catch (err) {
        const classified = classifySingleTurnError(err instanceof Error ? err.message : String(err));
        const outcome = CliConnectionVerificationOutcomeV1Schema.parse({
          version: 1,
          runtime,
          status: classified.code,
          verified_at: new Date(now()).toISOString(),
          version_observed: sanitizeVersion(candidate.version),
          message:
            classified.code === "auth_failed"
              ? "请在本机登录"
              : classified.code === "quota_exceeded"
                ? "额度不足，请检查账号配额"
                : classified.code === "network_error"
                  ? "网络故障，无法连接 Provider"
                  : classified.code === "timeout"
                    ? "连接验证超时"
                    : "协议握手或返回异常",
        });
        verifiedByRuntime.set(runtime, { fingerprint: candidate.fingerprint, outcome });
      }

      const finalDiscovery = sampler.snapshot();
      syncRegistry();
      return {
        outcome: verifiedByRuntime.get(runtime)!.outcome,
        cli_discovery: finalDiscovery,
      };
    },
  };
}
