// Controlled NodeClient integration: real loopback broker and local source manifests,
// simulated runtime lifecycle/support. This is not a native model/provider acceptance run.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextPack } from "@artoo/domain";
import type { AgentInstanceConfig, NodeToServerMessage, RunEvent, RunStartCommand, RuntimeAdapter } from "@artoo/protocol";
import { createInProcessChannel } from "@artoo/testkit";
import { createNodeClient } from "./node-client.js";
import * as processAdapter from "./process-adapter.js";
import * as verification from "./verification.js";
import { createWorkspaceToolSession, type WorkspaceToolSession } from "./workspace-tools.js";
import { takeWorkspaceReadOnlyTools } from "./workspace-readonly.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });
function deferred<T = void>() {
  let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() >= deadline) throw new Error("Controlled integration condition timed out"); await new Promise(done => setTimeout(done, 10)); }
}
function fixture(options: { supported?: boolean; pauseStartup?: boolean } = {}) {
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
  let config: AgentInstanceConfig | undefined, session: WorkspaceToolSession | undefined;
  const adapter: RuntimeAdapter = { runtimeId: "controlled", start: vi.fn(async value => {
    config = value; entered.resolve(); await startup.promise;
    const grant = takeWorkspaceReadOnlyTools(value);
    if (grant) session = await createWorkspaceToolSession({ workspaceRoot: value.workspaceRoot, context: value.runStart.context_pack.payload!,
      contextText: JSON.stringify(value.runStart.context_pack.payload), readOnlyGrant: grant });
    ready.resolve(); return { runId: value.runId };
  }), async *streamEvents(): AsyncIterable<RunEvent> { await ended.promise; yield { type: "run.lifecycle", payload: { phase: "completed", reason: null } }; },
    stop: vi.fn(async () => { ended.resolve(); }), collectArtifacts: async () => [] };
  vi.spyOn(processAdapter, "supportsWorkspaceReadOnlyTools").mockImplementation(value => value === adapter && options.supported !== false);
  const channel = createInProcessChannel(), messages: NodeToServerMessage[] = [];
  channel.serverTransport.subscribe(message => { messages.push(message); });
  const client = createNodeClient({ nodeId: "node", adapter, transport: channel.node, workspace: { allowedRoots: [workspace] } }); client.start();
  cleanups.push(async () => { startup.resolve(); ended.resolve(); await client.stop(true); await session?.close(); rmSync(root, { recursive: true, force: true }); });
  const send = async (input: unknown) => {
    if (!session) throw new Error("No controlled broker session");
    const broker = JSON.parse(readFileSync(session.configPath, "utf8"));
    const response = await fetch(broker.url, { method: "POST", headers: { authorization: `Bearer ${broker.token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() as any };
  };
  const start = () => channel.serverTransport.send(command);
  const stop = () => channel.serverTransport.send({ kind: "command", id: "stop", idempotency_key: "run:stop", type: "run.stop", payload: { run_id: "run", reason: "user_cancelled" } });
  return { root, workspace, context, planning, command, adapter, client, messages, entered, startup, ready, ended, send, start, stop,
    get config() { return config; }, get session() { return session; } };
}

describe("controlled NodeClient read-only broker integration", () => {
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
