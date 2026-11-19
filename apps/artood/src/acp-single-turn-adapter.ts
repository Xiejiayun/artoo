import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  SINGLE_TURN_TEXT_RUNTIME_FEATURE_V1,
  type RunStartPayload,
  type SingleTurnTextRuntimeId,
  isSingleTurnTextRuntime,
} from "@artoo/domain";
import type {
  AgentInstanceConfig,
  AgentInstanceHandle,
  ArtifactDescriptor,
  RunEvent,
  RuntimeAdapter,
  StopReason,
} from "@artoo/protocol";

import type { CliDiscoverySampler, ResolvedCliEntrypoint } from "./cli-discovery.js";

const COPILOT_EXCLUDED_TOOLS = [
  "bash",
  "powershell",
  "read_powershell",
  "stop_powershell",
  "list_powershell",
  "view",
  "edit",
  "create",
  "apply_patch",
  "glob",
  "grep",
  "rg",
  "semantic_code_search",
  "web_fetch",
  "sql",
  "skill",
  "run_dynamic_workflow",
  "dynamic_workflows_manage",
  "read_agent",
  "list_agents",
  "write_agent",
  "task",
] as const;

const COPILOT_INFO_PREFIX_RE = /^Info:\s+Disabled tools:\s+[a-z0-9_,\s]+\s*/iu;

const ENV_ALLOWLIST_RE =
  /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|LANG|LC_ALL|PROGRAMDATA|COMMONPROGRAMFILES|PROGRAMFILES|PROGRAMFILES\(X86\)|COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|XDG_CONFIG_HOME|XDG_DATA_HOME)$/i;

export interface SingleTurnExecutionFailureClassification {
  readonly code: "auth_failed" | "quota_exceeded" | "network_error" | "protocol_error" | "timeout" | "unknown";
  readonly message: string;
}

export interface AcpSingleTurnAdapterOptions {
  readonly sampler: CliDiscoverySampler;
  readonly isVerifiedReady: (runtime: SingleTurnTextRuntimeId, fingerprint: string) => boolean;
  readonly supportedRuntimes?: ReadonlySet<SingleTurnTextRuntimeId>;
  readonly enabledRuntimes?: ReadonlySet<SingleTurnTextRuntimeId>;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly verifyProcessTreeGone?: (pid: number) => boolean;
}

export interface AcpPromptExecutionOptions {
  readonly runtime: SingleTurnTextRuntimeId;
  readonly resolved: ResolvedCliEntrypoint;
  readonly promptText: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly verifyProcessTreeGone?: (pid: number) => boolean;
  readonly onChunk?: (text: string) => void;
  readonly onProcessSpawned?: (handle: { pid: number; abort: (reason: StopReason) => Promise<void> }) => void;
}

export interface AcpPromptExecutionResult {
  readonly text: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cachedInputTokens?: number;
  };
}

export function buildSingleTurnCliArgs(runtime: SingleTurnTextRuntimeId, prefixArgs: readonly string[]): string[] {
  if (runtime === "copilot") {
    return [
      ...prefixArgs,
      "--acp",
      "--stdio",
      "--excluded-tools",
      ...COPILOT_EXCLUDED_TOOLS,
      "--deny-tool=shell",
      "--deny-tool=write",
      "--disable-builtin-mcps",
      "--no-custom-instructions",
      "--no-ask-user",
      "--disallow-temp-dir",
      "--no-auto-update",
    ];
  }
  return [...prefixArgs, "acp", "--stdio", "--include-default-customizations=false"];
}

export function buildIsolatedSingleTurnEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  isolatedRunDir: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined && ENV_ALLOWLIST_RE.test(key)) {
      result[key] = value;
    }
  }
  result.TMP = isolatedRunDir;
  result.TEMP = isolatedRunDir;
  result.TMPDIR = isolatedRunDir;
  return result;
}

export function extractSingleTurnPromptText(runStart: RunStartPayload): string {
  const task = runStart.context_pack?.payload?.task;
  if (!task) {
    return "Reply concisely with plain text.";
  }
  const parts: string[] = [task.title];
  if (task.description?.trim()) parts.push(task.description.trim());
  if (Array.isArray(task.acceptance_criteria) && task.acceptance_criteria.length > 0) {
    parts.push(`Criteria:\n- ${task.acceptance_criteria.join("\n- ")}`);
  }
  return parts.join("\n\n");
}

export function assertValidSingleTurnRunStart(payload: RunStartPayload): void {
  if (!isSingleTurnTextRuntime(payload.runtime)) {
    throw new Error(`Runtime '${payload.runtime}' is not a single-turn text runtime`);
  }
  if (payload.workspace.branch !== undefined) {
    throw new Error("Single-turn runtimes do not support branch-backed workspaces");
  }
  if (payload.workspace_allocation !== undefined) {
    throw new Error("Single-turn runtimes do not support workspace allocation");
  }
  if (payload.verification !== undefined) {
    throw new Error("Single-turn runtimes do not support workspace verification");
  }
  if ((payload.policy_snapshot?.filesystem_write_scope?.length ?? 0) > 0) {
    throw new Error("Single-turn runtimes require an empty filesystem_write_scope");
  }
  if ((payload.artifact_rules?.paths?.length ?? 0) > 0) {
    throw new Error("Single-turn runtimes require empty artifact rules");
  }
  const cp = payload.context_pack?.payload;
  if (
    cp &&
    (cp.goal_context ||
      cp.dependency_context ||
      cp.product_development ||
      cp.product_research_revision ||
      cp.product_design_revision ||
      cp.review_subject ||
      cp.review_feedback ||
      cp.agent_review_subject ||
      cp.app_delivery ||
      cp.app_publication ||
      cp.application_publication ||
      cp.verification_capabilities ||
      cp.release_capabilities ||
      cp.imported_clean_validation ||
      cp.imported_clean_validation_review_subject ||
      cp.imported_design_review_subject ||
      cp.imported_execution ||
      cp.imported_execution_review_subject ||
      cp.imported_execution_repair ||
      cp.imported_validation ||
      cp.imported_validation_review_subject ||
      cp.imported_recovery_validation ||
      cp.imported_recovery_validation_review_subject ||
      cp.transferred_product_input ||
      cp.imported_review_subject)
  ) {
    throw new Error("Single-turn runtimes only accept standalone plain-text tasks");
  }
}

export function classifySingleTurnError(rawMessage: string): SingleTurnExecutionFailureClassification {
  const lower = rawMessage.toLowerCase();
  if (/timeout|timed out|etimedout|deadline/.test(lower)) {
    return { code: "timeout", message: "请求或验证超时" };
  }
  if (/protocol_error|tool_use_forbidden|session\/request_permission|unexpected rpc|jsonrpc|json-rpc/.test(lower)) {
    return { code: "protocol_error", message: "协议握手或返回异常" };
  }
  if (/auth|unauthori|unauthenticat|login|sign in|credential|token|401|\bforbidden\b|403/.test(lower)) {
    return { code: "auth_failed", message: "请在本机登录" };
  }
  if (/quota|rate limit|credit|usage limit|exhausted|billing|429|payment required|402/.test(lower)) {
    return { code: "quota_exceeded", message: "额度不足，请检查账号配额" };
  }
  if (
    /enotfound|econnrefused|econnreset|etimedout|network|dns|socket|tls|ssl|fetch failed|getaddrinfo|offline/.test(
      lower,
    )
  ) {
    return { code: "network_error", message: "网络故障，无法连接 Provider" };
  }
  if (/protocol|initialize|session\/new|tool call|exit/.test(lower)) {
    return { code: "protocol_error", message: "协议握手或返回异常" };
  }
  return { code: "unknown", message: "执行失败，状态未知" };
}

function defaultVerifyProcessTreeGoneWin32(pid: number): boolean {
  try {
    const res = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `if (Get-CimInstance Win32_Process -Filter "ProcessId=${Math.trunc(pid)} OR ParentProcessId=${Math.trunc(pid)}" -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }`,
      ],
      { windowsHide: true, timeout: 5000, stdio: "ignore" },
    );
    return res.status === 0;
  } catch {
    return false;
  }
}

function isPidGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

export async function terminateAndConfirmProcessTree(
  child: ChildProcess,
  closedPromise: Promise<void>,
  options: {
    platform?: NodeJS.Platform;
    timeoutMs?: number;
    verifyProcessTreeGone?: (pid: number) => boolean;
  } = {},
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    await closedPromise;
    return;
  }
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 8000;
  const checkGone =
    options.verifyProcessTreeGone ?? (platform === "win32" ? defaultVerifyProcessTreeGoneWin32 : (p) => isPidGone(p));

  try {
    child.stdin?.end();
  } catch {
    /* ignore */
  }
  if (platform === "win32") {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
      windowsHide: true,
      timeout: Math.min(timeoutMs, 5000),
      stdio: "ignore",
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    closedPromise.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (!settled || !isPidGone(pid) || !checkGone(pid)) {
    throw new Error("停止未确认：无法确认单轮 CLI 进程树已完全退出，已保留运行槽位");
  }
}

export class ToolIsolationViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolIsolationViolationError";
  }
}

export async function executeAcpSingleTurnPrompt(
  opts: AcpPromptExecutionOptions,
  platform: NodeJS.Platform = process.platform,
): Promise<AcpPromptExecutionResult> {
  const cwd = mkdtempSync(join(tmpdir(), "artoo-acp-run-"));
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const env = buildIsolatedSingleTurnEnvironment(opts.env ?? process.env, cwd);
  const args = buildSingleTurnCliArgs(opts.runtime, opts.resolved.prefixArgs);

  const child = spawn(opts.resolved.executable, args, {
    cwd,
    env,
    detached: platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let closed = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const closedPromise = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      closed = true;
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
  });

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  let sessionId: string | null = null;
  let abortedByStop = false;
  let stopPromise: Promise<void> | null = null;
  let textBuffer = "";
  let firstChunkSeen = false;
  let stderrTail = "";

  const failAllPending = (err: Error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  };

  child.on("error", (err) => {
    failAllPending(err);
  });
  child.once("close", (code, signal) => {
    if (!abortedByStop && pending.size > 0) {
      failAllPending(
        new Error(
          `protocol_error: ACP process exited unexpectedly (code=${String(code)}, signal=${String(signal)}) ${stderrTail}`.trim(),
        ),
      );
    }
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-1024);
  });

  const abortExecution = async (_reason: StopReason): Promise<void> => {
    if (stopPromise) return stopPromise;
    abortedByStop = true;
    stopPromise = (async () => {
      if (sessionId && !closed) {
        try {
          child.stdin?.write(
            JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }) + "\n",
          );
        } catch {
          /* best effort before forceful termination */
        }
      }
      failAllPending(new Error("Execution stopped by user"));
      await terminateAndConfirmProcessTree(child, closedPromise, {
        platform,
        timeoutMs: opts.stopTimeoutMs,
        verifyProcessTreeGone: opts.verifyProcessTreeGone,
      });
    })();
    return stopPromise;
  };

  if (child.pid !== undefined) {
    opts.onProcessSpawned?.({ pid: child.pid, abort: abortExecution });
  }

  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const entry = pending.get(Number(msg.id));
      if (!entry) return;
      pending.delete(Number(msg.id));
      clearTimeout(entry.timer);
      if (msg.error && typeof msg.error === "object") {
        const errObj = msg.error as { message?: string; code?: unknown };
        entry.reject(new Error(`protocol_error: ${errObj.message ?? JSON.stringify(errObj)}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (msg.id !== undefined && typeof msg.method === "string") {
      // Fail closed on ANY tool or permission callback requested by the CLI.
      const reply =
        msg.method === "session/request_permission"
          ? { jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }
          : {
              jsonrpc: "2.0",
              id: msg.id,
              error: { code: -32601, message: "Tools are disabled in Artoo single-turn mode" },
            };
      try {
        child.stdin?.write(JSON.stringify(reply) + "\n");
      } catch {
        /* ignore */
      }
      failAllPending(new ToolIsolationViolationError(`protocol_error: tool_use_forbidden (${msg.method})`));
      return;
    }
    if (msg.method === "session/update" && msg.params && typeof msg.params === "object") {
      const update = (msg.params as { update?: Record<string, unknown> }).update;
      if (!update) return;
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        failAllPending(
          new ToolIsolationViolationError(
            `protocol_error: tool_use_forbidden (${String(update.name ?? update.kind ?? "tool")})`,
          ),
        );
        return;
      }
      if (update.sessionUpdate === "agent_message_chunk") {
        const content = update.content as { type?: unknown; text?: unknown } | undefined;
        if (content?.type === "text" && typeof content.text === "string") {
          let chunk = content.text;
          if (!firstChunkSeen) {
            firstChunkSeen = true;
            chunk = chunk.replace(COPILOT_INFO_PREFIX_RE, "");
          }
          if (chunk.length > 0) {
            textBuffer += chunk;
            opts.onChunk?.(chunk);
          }
        }
      }
    }
  });

  const rpc = (method: string, params: unknown, callTimeoutMs = timeoutMs): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (abortedByStop) {
        reject(new Error("Execution stopped by user"));
        return;
      }
      if (closed) {
        reject(new Error(`protocol_error: process closed (${String(exitCode)}/${String(exitSignal)})`));
        return;
      }
      const reqId = nextId++;
      const timer = setTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`timeout: ACP ${method} timed out after ${callTimeoutMs}ms`));
      }, callTimeoutMs);
      pending.set(reqId, { resolve, reject, timer });
      child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: reqId, method, params }) + "\n");
    });

  let result: AcpPromptExecutionResult | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  let cleanupError: unknown;
  try {
    const initTimeout = Math.min(timeoutMs, 20_000);
    const init = (await rpc(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "artoo-artood", version: "0.1.0" },
      },
      initTimeout,
    )) as { authMethods?: unknown } | undefined;
    if (!init || typeof init !== "object") {
      throw new Error("protocol_error: invalid initialize response");
    }
    const sess = (await rpc("session/new", { cwd, mcpServers: [] }, initTimeout)) as { sessionId?: string } | undefined;
    if (!sess || typeof sess.sessionId !== "string" || !sess.sessionId) {
      throw new Error("protocol_error: missing sessionId from session/new");
    }
    sessionId = sess.sessionId;
    const promptRes = (await rpc(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text: opts.promptText }] },
      timeoutMs,
    )) as {
      stopReason?: string;
      usage?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number };
    };
    if (promptRes?.stopReason === "cancelled" && !abortedByStop) {
      throw new Error("protocol_error: prompt cancelled unexpectedly");
    }
    result = {
      text: textBuffer.trim(),
      ...(promptRes?.usage
        ? {
            usage: {
              inputTokens: promptRes.usage.inputTokens,
              outputTokens: promptRes.usage.outputTokens,
              cachedInputTokens: promptRes.usage.cachedReadTokens,
            },
          }
        : {}),
    };
  } catch (err) {
    primaryError = err;
    hasPrimaryError = true;
  } finally {
    rl.close();
    if (!closed) {
      try {
        await terminateAndConfirmProcessTree(child, closedPromise, {
          platform,
          timeoutMs: opts.stopTimeoutMs,
          verifyProcessTreeGone: opts.verifyProcessTreeGone,
        });
      } catch (err) {
        cleanupError = err;
      }
    }
    if (cleanupError === undefined) {
      try {
        rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      } catch {
        /* ignore best-effort temp cleanup only after process tree confirmed exited */
      }
    }
  }
  if (cleanupError !== undefined) {
    if (hasPrimaryError) {
      throw new AggregateError([primaryError, cleanupError], "Execution failed and process cleanup is unconfirmed");
    }
    throw cleanupError;
  }
  if (hasPrimaryError) {
    throw primaryError;
  }
  return result!;
}

export function createAcpSingleTurnAdapter(options: AcpSingleTurnAdapterOptions): RuntimeAdapter {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const supported = options.supportedRuntimes ?? new Set<SingleTurnTextRuntimeId>(["copilot"]);
  const enabled = options.enabledRuntimes ?? new Set<SingleTurnTextRuntimeId>(["copilot"]);

  interface RunSessionState {
    readonly runId: string;
    readonly queue: RunEvent[];
    waiters: Array<() => void>;
    done: boolean;
    abort?: (reason: StopReason) => Promise<void>;
    stoppedByUser: boolean;
  }

  const sessions = new Map<string, RunSessionState>();

  const pushEvent = (state: RunSessionState, event: RunEvent) => {
    state.queue.push(event);
    const pendingWaiters = state.waiters;
    state.waiters = [];
    for (const wake of pendingWaiters) wake();
  };

  return {
    runtimeId: "acp-single-turn",

    async start(config: AgentInstanceConfig): Promise<AgentInstanceHandle> {
      if (platform !== "win32" || arch !== "x64") {
        throw new Error(`Single-turn execution requires Windows x64 (got ${platform}/${arch})`);
      }
      if (!isSingleTurnTextRuntime(config.runtime)) {
        throw new Error(`Unsupported single-turn runtime '${config.runtime}'`);
      }
      if (!supported.has(config.runtime) || !enabled.has(config.runtime)) {
        throw new Error(`Single-turn runtime '${config.runtime}' is not enabled on this node`);
      }
      assertValidSingleTurnRunStart(config.runStart);

      const candidate = options.sampler.candidate(config.runtime);
      if (!candidate || candidate.installStatus !== "installed" || !candidate.resolved || !candidate.fingerprint) {
        throw new Error(`Single-turn CLI '${config.runtime}' is not installed with a verified entrypoint`);
      }
      if (!options.isVerifiedReady(config.runtime, candidate.fingerprint)) {
        throw new Error(`Single-turn CLI '${config.runtime}' requires live connection verification before running`);
      }

      const state: RunSessionState = {
        runId: config.runId,
        queue: [],
        waiters: [],
        done: false,
        stoppedByUser: false,
      };
      sessions.set(config.runId, state);

      const promptText = extractSingleTurnPromptText(config.runStart);
      const resolved = candidate.resolved;
      const runtime = config.runtime;

      void (async () => {
        pushEvent(state, { type: "run.lifecycle", payload: { phase: "started" } });
        try {
          const result = await executeAcpSingleTurnPrompt(
            {
              runtime,
              resolved,
              promptText,
              env: options.env,
              timeoutMs: options.requestTimeoutMs,
              stopTimeoutMs: options.stopTimeoutMs,
              verifyProcessTreeGone: options.verifyProcessTreeGone,
              onChunk: (chunk) => {
                pushEvent(state, { type: "run.output", payload: { stream: "stdout", text: chunk } });
              },
              onProcessSpawned: (procHandle) => {
                state.abort = procHandle.abort;
                if (state.stoppedByUser) {
                  void procHandle.abort("user_cancelled").catch(() => {});
                }
              },
            },
            platform,
          );
          if (state.stoppedByUser) {
            state.done = true;
            pushEvent(state, { type: "run.lifecycle", payload: { phase: "cancelled", reason: "user_cancelled" } });
            return;
          }
          if (result.usage) {
            pushEvent(state, {
              type: "run.usage",
              payload: {
                ...(result.usage.inputTokens !== undefined ? { input_tokens: result.usage.inputTokens } : {}),
                ...(result.usage.outputTokens !== undefined ? { output_tokens: result.usage.outputTokens } : {}),
                ...(result.usage.cachedInputTokens !== undefined
                  ? { cached_input_tokens: result.usage.cachedInputTokens }
                  : {}),
              },
            });
          }
          if (result.text.length > 0) {
            pushEvent(state, { type: "run.answer", payload: { text: result.text.slice(0, 200_000) } });
          }
          state.done = true;
          pushEvent(state, { type: "run.lifecycle", payload: { phase: "completed" } });
        } catch (err) {
          state.done = true;
          if (state.stoppedByUser) {
            pushEvent(state, { type: "run.lifecycle", payload: { phase: "cancelled", reason: "user_cancelled" } });
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          const classified = classifySingleTurnError(msg);
          pushEvent(state, {
            type: "run.lifecycle",
            payload: {
              phase: "failed",
              reason: `${classified.code}: ${classified.message}`,
            },
          });
        } finally {
          state.done = true;
          const pendingWaiters = state.waiters;
          state.waiters = [];
          for (const wake of pendingWaiters) wake();
        }
      })();

      return { runId: config.runId };
    },

    async *streamEvents(handle: AgentInstanceHandle): AsyncIterable<RunEvent> {
      const state = sessions.get(handle.runId);
      if (!state) return;
      try {
        let cursor = 0;
        while (true) {
          while (cursor < state.queue.length) {
            yield state.queue[cursor++]!;
          }
          if (state.done && cursor >= state.queue.length) break;
          await new Promise<void>((resolve) => state.waiters.push(resolve));
        }
      } finally {
        if (state.done) sessions.delete(handle.runId);
      }
    },

    async stop(handle: AgentInstanceHandle, reason: StopReason): Promise<void> {
      const state = sessions.get(handle.runId);
      if (!state) return;
      state.stoppedByUser = true;
      if (state.abort) {
        await state.abort(reason);
      }
    },

    async collectArtifacts(): Promise<ArtifactDescriptor[]> {
      return [];
    },
  };
}
