// Controlled NodeClient integration: real loopback broker and local source manifests,
// simulated runtime lifecycle/support. This is not a native model/provider acceptance run.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { productDevelopmentContext, type ContextPack } from "@artoo/domain";
import type { AgentInstanceConfig, NodeToServerMessage, RunEvent, RunStartCommand, RuntimeAdapter } from "@artoo/protocol";
import { createInProcessChannel } from "@artoo/testkit";
import { createNodeClient } from "./node-client.js";
import * as processAdapter from "./process-adapter.js";
import * as verification from "./verification.js";
import * as sourceRuntime from "./product-source-runtime.js";
import { createWorkspaceToolSession, type WorkspaceToolSession } from "./workspace-tools.js";
import { assertWorkspacePlanningBinding, takeWorkspaceReadOnlyTools } from "./workspace-readonly.js";

const cleanups: (() => Promise<void>)[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });
function deferred<T = void>() {
  let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() >= deadline) throw new Error("Controlled integration condition timed out"); await new Promise(done => setTimeout(done, 10)); }
}
function fixture(options: { supported?: boolean; pauseStartup?: boolean; source?: boolean; profileCount?: number; startupFailure?: "known" | "unknown" } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-node-readonly-"))), workspace = join(root, "planning"); mkdirSync(workspace);
  const futureWorkspace = join(root, "future-worker"); mkdirSync(futureWorkspace); writeFileSync(join(futureWorkspace, "secret.txt"), "not granted to planning");
  const planning = { version: 1, kind: "autonomous-planning", request: "原始完整产品需求", planning_capability_snapshot: {
    version: 1, computer_id: "future-computer", project_id: "project", workspace_root: futureWorkspace, verification_profile_id: "future-profile", capabilities: null } };
  const context: ContextPack = { task: { id: "task", title: "Plan", description: "Planning discussion", acceptance_criteria: [] },
    project: { id: "project", name: "Product", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] },
    conversation: { room_id: "room", turn_id: "turn", current_request: JSON.stringify(planning), messages: [], history_truncated: false },
    memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] } };
  const command: RunStartCommand = { kind: "command", id: "start", type: "run.start", idempotency_key: "run:start", payload: {
    run_id: "run", task_id: "task", agent_instance_id: "agent", runtime: "controlled", workspace: { root: workspace },
    context_pack: { id: "context", payload: context }, policy_snapshot: { filesystem_write_scope: [workspace], requires_approval: [] }, artifact_rules: { paths: [] } } };
  const entered = deferred(), startup = deferred(), ready = deferred(), ended = deferred();
  if (!options.pauseStartup) startup.resolve();
  let nativeClosed = false;
  let config: AgentInstanceConfig | undefined, session: WorkspaceToolSession | undefined;
  const adapter: RuntimeAdapter = { runtimeId: "controlled", start: vi.fn(async value => {
    config = value; entered.resolve(); await startup.promise;
    if (options.startupFailure) throw new Error("Controlled startup failure without a handle");
    const grant = takeWorkspaceReadOnlyTools(value);
    if (grant) session = await createWorkspaceToolSession({ workspaceRoot: value.workspaceRoot, context: value.runStart.context_pack.payload!,
      contextText: JSON.stringify(value.runStart.context_pack.payload), readOnlyGrant: grant });
    ready.resolve(); return { runId: value.runId };
  }), async *streamEvents(): AsyncIterable<RunEvent> { await ended.promise; nativeClosed = true; yield { type: "run.lifecycle", payload: { phase: "completed", reason: null } }; },
    stop: vi.fn(async () => { nativeClosed = true; ended.resolve(); }), collectArtifacts: async () => [] };
  vi.spyOn(processAdapter, "supportsWorkspaceReadOnlyTools").mockImplementation(value => value === adapter && options.supported !== false);
  const native = options.source ? (() => {
    // Controlled local-profile/native-admission seam; the actual broker remains real.
    // Native brand/process closure is exercised separately in windows-verified-adapter.test.ts.
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const profiles = Array.from({ length: options.profileCount ?? 1 }, (_, index) => ({ id: "local-" + index, project_id: "project", workspace_root: workspace }) as verification.PreparedVerificationProfile);
    vi.spyOn(verification, "prepareVerificationProfiles").mockReturnValue(profiles);
    vi.spyOn(verification, "assertVerificationWorkspaceBoundary").mockImplementation(() => {});
    vi.spyOn(verification, "readWindowsVerificationBackend").mockReturnValue({} as ReturnType<typeof verification.readWindowsVerificationBackend>);
    vi.spyOn(sourceRuntime, "assertProductSourceRuntimeConfiguration").mockImplementation(() => {});
    const boundary = vi.spyOn(sourceRuntime, "assertProductSourceWorkspaceBoundary").mockImplementation(() => {});
    const claim = vi.spyOn(sourceRuntime, "claimProductSourceRun").mockImplementation(() => {});
    const release = vi.spyOn(sourceRuntime, "releaseProductSourceRun").mockImplementation(() => {});
    const exportSource = vi.spyOn(sourceRuntime, "captureProductSourceExport"), exportSemantic = vi.spyOn(sourceRuntime, "captureProductSourceExportV2");
    const verify = vi.spyOn(verification, "runVerification");
    const admission = Object.freeze({}) as processAdapter.WindowsPlanningExecutionAdmission;
    const bind = vi.spyOn(processAdapter, "bindWindowsPlanningExecution").mockImplementation((_adapter, exactConfig) => {
      assertWorkspacePlanningBinding(exactConfig); expect(Object.isFrozen(exactConfig)).toBe(true); return admission;
    });
    const closed = vi.spyOn(processAdapter, "assertWindowsPlanningExecutionClosed").mockImplementation(actual => {
      if (actual !== admission || !nativeClosed) throw new verification.VerificationCleanupError("Controlled native planning closure remains unconfirmed");
    });
    const startupClosed = vi.spyOn(processAdapter, "assertWindowsPlanningStartupClosed").mockImplementation(actual => {
      if (actual !== admission || options.startupFailure !== "known") throw new verification.VerificationCleanupError("Controlled native startup closure remains unconfirmed");
    });
    return { profiles, boundary, claim, release, exportSource, exportSemantic, verify, bind, closed, startupClosed };
  })() : undefined;
  const channel = createInProcessChannel(), messages: NodeToServerMessage[] = [];
  channel.serverTransport.subscribe(message => { messages.push(message); });
  const client = createNodeClient({ nodeId: "node", adapter, transport: channel.node, workspace: { allowedRoots: [workspace] },
    ...(options.source ? { productSourceRuntime: {} as sourceRuntime.PreparedProductSourceRuntime } : {}) }); client.start();
  cleanups.push(async () => {
    startup.resolve(); ended.resolve();
    if (options.startupFailure === "unknown") await expect(client.stop(true)).rejects.toThrow(/planning closure remains unconfirmed/);
    else await client.stop(true);
    await session?.close(); rmSync(root, { recursive: true, force: true });
  });
  const send = async (input: unknown) => {
    if (!session) throw new Error("No controlled broker session");
    const broker = JSON.parse(readFileSync(session.configPath, "utf8"));
    const response = await fetch(broker.url, { method: "POST", headers: { authorization: `Bearer ${broker.token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() as any };
  };
  const start = () => channel.serverTransport.send(command);
  const duplicateStart = () => channel.serverTransport.send({ ...command, id: "duplicate" });
  const stop = () => channel.serverTransport.send({ kind: "command", id: "stop", idempotency_key: "run:stop", type: "run.stop", payload: { run_id: "run", reason: "user_cancelled" } });
  const resume = () => channel.serverTransport.send({ kind: "command", id: "resume", idempotency_key: "run:resume", type: "run.resume", payload: { run_id: "run" } });
  return { root, workspace, context, planning, command, adapter, client, messages, entered, startup, ready, ended, send, start, duplicateStart, stop, resume, native,
    get config() { return config; }, get session() { return session; } };
}

describe("controlled NodeClient read-only broker integration", () => {
  it("plans on a source-enabled node using only its immutable context and local native owner", async () => {
    const f = fixture({ source: true }); await f.start(); await f.ready.promise;
    expect(f.native!.bind).toHaveBeenCalledWith(f.adapter, f.config, f.native!.profiles[0], expect.any(AbortSignal), expect.any(Function));
    expect(f.config!.runStart.verification).toBeUndefined();
    expect(f.config!.runStart.policy_snapshot.filesystem_write_scope).toEqual([f.workspace]);
    const broker = JSON.parse(readFileSync(f.session!.configPath, "utf8")); expect(broker.tools).toEqual(["context"]);
    expect((await f.send({ tool: "context" })).status).toBe(200);
    for (const tool of ["read", "write", "verify"]) expect((await f.send({ tool, path: "product/index.html" })).status).toBe(400);
    f.ended.resolve(); await f.client.stop(false);
    expect(f.messages).toContainEqual(expect.objectContaining({ kind: "command.ack", command_id: "start", status: "accepted" }));
    expect(f.messages).toContainEqual(expect.objectContaining({ kind: "run.event", event: { type: "run.lifecycle", payload: { phase: "completed", reason: null } } }));
    expect(f.native!.boundary).toHaveBeenCalled(); expect(f.native!.closed).toHaveBeenCalledTimes(2);
    for (const operation of [f.native!.claim, f.native!.release, f.native!.exportSource, f.native!.exportSemantic, f.native!.verify]) expect(operation).not.toHaveBeenCalled();
    expect((await f.send({ tool: "context" })).status).toBe(400);
  });

  it("stops source-enabled planning through its native closure before acknowledging stop", async () => {
    const f = fixture({ source: true }); await f.start(); await f.ready.promise; await f.stop();
    await waitFor(() => f.messages.some(message => message.kind === "command.ack" && message.command_id === "stop"));
    expect(f.messages).toContainEqual(expect.objectContaining({ kind: "command.ack", command_id: "stop", status: "accepted" }));
    expect(f.native!.closed).toHaveBeenCalled(); expect((await f.send({ tool: "context" })).status).toBe(400);
  });

  it.each([0, 2])("rejects native planning with %s matching local profiles instead of using the future-worker profile", async profileCount => {
    const f = fixture({ source: true, profileCount }); await f.start();
    await waitFor(() => f.messages.some(message => message.kind === "command.ack" && message.status === "rejected"));
    expect(f.messages).toContainEqual(expect.objectContaining({ kind: "command.ack", status: "rejected", message: expect.stringContaining("exactly one local workspace profile") }));
    expect(f.adapter.start).not.toHaveBeenCalled(); expect(f.native!.bind).not.toHaveBeenCalled();
  });

  it.each(["manual", "malformed", "null-snapshot", "foreign-project", "custom-adapter", "product", "write-scope"])("does not exempt %s from source verification", async kind => {
    const f = fixture({ source: true, supported: kind !== "custom-adapter" });
    if (kind === "manual") f.context.conversation!.current_request = "Ordinary discussion";
    if (kind === "malformed") f.context.conversation!.current_request = '{"kind":"autonomous-planning"}';
    if (kind === "null-snapshot") f.context.conversation!.current_request = JSON.stringify({ ...f.planning, planning_capability_snapshot: null });
    if (kind === "foreign-project") f.context.conversation!.current_request = JSON.stringify({ ...f.planning,
      planning_capability_snapshot: { ...f.planning.planning_capability_snapshot, project_id: "other" } });
    if (kind === "product") f.context.product_development = productDevelopmentContext("research");
    if (kind === "write-scope") f.context.policy.filesystem_write_scope = [f.workspace];
    await f.start(); await waitFor(() => f.messages.some(message => message.kind === "command.ack" && message.status === "rejected"));
    expect(f.messages).toContainEqual(expect.objectContaining({ kind: "command.ack", error_code: "process_start_failed" }));
    expect(f.adapter.start).not.toHaveBeenCalled(); expect(f.native!.bind).not.toHaveBeenCalled();
  });

  it("retains unknown native startup closure for stop, replay, and a resume already waiting for startup", async () => {
    const f = fixture({ source: true, pauseStartup: true, startupFailure: "unknown" }); await f.start(); await f.entered.promise;
    await f.resume(); f.startup.resolve();
    await waitFor(() => f.messages.some(message => message.kind === "command.ack" && message.command_id === "resume"));
    expect(f.messages).toContainEqual(expect.objectContaining({ kind: "command.ack", command_id: "resume", status: "rejected",
      error_code: "process_start_failed", message: expect.stringContaining("closure remains unconfirmed") }));
    await f.stop(); await f.start();
    await waitFor(() => f.messages.some(message => message.kind === "command.ack" && message.command_id === "stop"));
    expect(f.messages).toContainEqual(expect.objectContaining({ kind: "command.ack", command_id: "stop", status: "rejected", error_code: "process_start_failed" }));
    expect(f.adapter.start).toHaveBeenCalledOnce(); await expect(f.client.stop(true)).rejects.toThrow(/planning closure remains unconfirmed/);
  });

  it.each(["known", "unknown"] as const)("does not accept a duplicate before its original native startup fails with %s cleanup", async startupFailure => {
    const f = fixture({ source: true, pauseStartup: true, startupFailure }); await f.start(); await f.entered.promise;
    await f.duplicateStart(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.messages.some(message => message.kind === "command.ack" && message.command_id === "duplicate")).toBe(false);
    f.startup.resolve(); await waitFor(() => f.messages.some(message => message.kind === "command.ack" && message.command_id === "duplicate"));
    expect(f.messages).toContainEqual(expect.objectContaining({ kind: "command.ack", command_id: "duplicate", status: "rejected", error_code: "process_start_failed" }));
    expect(f.adapter.start).toHaveBeenCalledOnce();
  });

  it("allows stop after a rejected no-handle startup only when its original native cleanup is confirmed", async () => {
    const f = fixture({ source: true, startupFailure: "known" }); await f.start();
    await waitFor(() => f.messages.some(message => message.kind === "command.ack" && message.command_id === "start" && message.status === "rejected"));
    await f.stop(); await waitFor(() => f.messages.some(message => message.kind === "command.ack" && message.command_id === "stop"));
    expect(f.messages).toContainEqual(expect.objectContaining({ kind: "command.ack", command_id: "stop", status: "accepted" }));
    expect(f.native!.startupClosed).toHaveBeenCalledOnce(); expect(f.native!.verify).not.toHaveBeenCalled();
  });

  it("recognizes the exact planning wrapper and grants only this immutable context", async () => {
    const f = fixture({ pauseStartup: true }); await f.start(); await f.entered.promise;
    expect(f.config!.runStart).not.toBe(f.command.payload); expect(Object.isFrozen(f.config!.runStart)).toBe(true);
    f.context.conversation!.current_request = "caller mutation after admission";
    f.startup.resolve(); await f.ready.promise;
    const response = await f.send({ tool: "context" });
    expect(response.status).toBe(200); expect(response.body.context).toContain("原始完整产品需求");
    expect(response.body.context).not.toContain("caller mutation after admission");
    const broker = JSON.parse(readFileSync(f.session!.configPath, "utf8")); expect(broker.tools).toEqual(["context"]);
    expect((await f.send({ tool: "read", path: f.planning.planning_capability_snapshot.workspace_root + "/secret.txt" })).status).toBe(400);
    expect((await f.send({ tool: "verify" })).status).toBe(400);
  });

  it.each(["manual", "malformed", "null-snapshot", "foreign-project", "custom-adapter"])("keeps %s on its original path", async (kind) => {
    const f = fixture({ supported: kind !== "custom-adapter" });
    if (kind === "manual") f.context.conversation!.current_request = "Ordinary discussion";
    if (kind === "malformed") f.context.conversation!.current_request = '{"kind":"autonomous-planning"}';
    if (kind === "null-snapshot") f.context.conversation!.current_request = JSON.stringify({ ...f.planning, planning_capability_snapshot: null });
    if (kind === "foreign-project") f.context.conversation!.current_request = JSON.stringify({ ...f.planning,
      planning_capability_snapshot: { ...f.planning.planning_capability_snapshot, project_id: "other-project" } });
    await f.start(); await f.ready.promise;
    expect(f.session).toBeUndefined(); expect(f.adapter.start).toHaveBeenCalledOnce();
  });

  it("revokes context reads immediately on run.stop before the controlled runtime finishes", async () => {
    const f = fixture(); await f.start(); await f.ready.promise;
    expect((await f.send({ tool: "context" })).status).toBe(200);
    await f.stop();
    expect((await f.send({ tool: "context" })).status).toBe(400);
    await waitFor(() => f.messages.some(message => message.kind === "command.ack" && message.command_id === "stop" && message.status === "accepted"));
  });

  it("revokes a still-starting planning grant before the adapter consumes it", async () => {
    const f = fixture({ pauseStartup: true }); await f.start(); await f.entered.promise;
    await f.stop(); f.startup.resolve();
    await waitFor(() => f.messages.some(message => message.kind === "command.ack" && message.command_id === "start" && message.status === "rejected"));
    expect(f.session).toBeUndefined();
  });

  it("revokes on node shutdown with cancellation and after natural completion", async () => {
    const f = fixture(); await f.start(); await f.ready.promise;
    await f.client.stop(true);
    expect((await f.send({ tool: "context" })).status).toBe(400);
  });

  it("revokes after the terminal stream even when the controlled adapter retains its broker", async () => {
    const f = fixture(); await f.start(); await f.ready.promise; f.ended.resolve();
    await f.client.stop(false);
    expect((await f.send({ tool: "context" })).status).toBe(400);
  });

  it("does not give a new grant to a replayed completed planning run", async () => {
    const f = fixture(); await f.start(); await f.ready.promise; f.ended.resolve();
    await waitFor(() => f.messages.some(message => message.kind === "run.event" && message.event.type === "run.lifecycle" && message.event.payload.phase === "completed"));
    await f.start(); await new Promise(done => setTimeout(done, 20));
    expect(f.adapter.start).toHaveBeenCalledOnce();
    expect((await f.send({ tool: "context" })).status).toBe(400);
  });

  it("rejects review source mismatch before invoking the runtime (controlled profile selection)", async () => {
    const f = fixture(); delete f.context.conversation;
    mkdirSync(join(f.workspace, "product")); writeFileSync(join(f.workspace, "product", "index.html"), "measured source");
    const verifier = join(f.root, "controlled-verifier.fixture"); writeFileSync(verifier, "measured fixture, never executed");
    const profile = verification.prepareVerificationProfiles([{ id: "profile", project_id: "project", workspace_root: f.workspace,
      commands: [{ id: "fixture", argv: [verifier], timeout_ms: 1000 }], required_files: [], subject_paths: ["product"] }])[0]!;
    const source = verification.subjectManifest(profile).digest;
    f.context.review_subject = { version: 1, task_id: "author", run_id: "author-run", evidence_id: "evidence", subject_digest: `sha256:${"1".repeat(64)}` };
    f.command.payload.verification = { version: 1, request_id: "review-request", profile_id: profile.id, expected_subject_digest: source };
    // The test targets node-to-broker binding before execution. It simulates profile
    // selection, without a Windows backend or any native execution qualification.
    vi.spyOn(verification, "selectVerificationProfile").mockReturnValue(profile);
    await f.start();
    await waitFor(() => f.messages.some(message => message.kind === "command.ack" && message.command_id === "start" && message.status === "rejected"));
    expect(f.messages).toContainEqual(expect.objectContaining({ kind: "command.ack", status: "rejected", message: expect.stringContaining("admitted review") }));
    expect(f.adapter.start).not.toHaveBeenCalled();
  });
});
