import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalOwnedResultAuthorContextV1, canonicalOwnedResultRunAdmissionV1,
  type OwnedResultRunAdmissionV1, type RunStartPayload } from "@artoo/domain";
import { allocateWorkspaceRoot, type AgentInstanceConfig, type CommandAck, type NodeSideTransport,
  type NodeToServerMessage, type RuntimeAdapter, type ServerToNodeMessage } from "@artoo/protocol";
import { snapshotOwnedResultRunAdmission } from "./owned-result-admission.js";
import { canonicalOwnedVerification } from "./owned/worktree-verification-contract.js";
import { prepareOwnedResultProfiles, readOwnedResultProfileDescriptors, selectOwnedResultProfile,
  type PreparedOwnedResultProfiles, type PreparedOwnedResultRun, type PreparedOwnedWorktreeVerificationTemplate,
  type OwnedResultFinalizationV1 } from "./owned-worktree-verification.js";
import { createNodeClient, type NodeClient } from "./node-client.js";
import { openLocalJournal, type Journal, type FreshLaunchPermit } from "./managed/journal.js";

interface WorkerView {
  emit(event: string, ...args: unknown[]): boolean;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}
const doubles = vi.hoisted(() => ({ workers: [] as WorkerView[] }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  class WorkerDouble extends EventEmitter {
    postMessage = vi.fn((message: { op: string }) => {
      if (message.op === "close") queueMicrotask(() => this.emit("exit", 0));
      else throw new Error("This rejection-only worker model must not receive storage operations");
    });
    terminate = vi.fn(async () => { this.emit("exit", 1); return 1; });
    constructor() { super(); doubles.workers.push(this); }
  }
  return { Worker: WorkerDouble };
});

// Metadata/dispatch and worker-notification models only. A controlled platform
// value exercises the POSIX codec on every test host. No Git, SQLite, real worker,
// result store, issuer, native process or owned-run success is produced here.
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const clients: NodeClient[] = [], journals: Journal[] = [];
beforeEach(() => { Object.defineProperty(process, "platform", { ...platform, value: "linux" }); });
afterEach(async () => {
  try {
    for (const client of clients.splice(0)) await client.stop();
    for (const journal of journals.splice(0)) await journal.close();
  } finally {
    for (const worker of doubles.workers.splice(0)) worker.emit("exit", 0);
    Object.defineProperty(process, "platform", platform); vi.restoreAllMocks();
  }
});
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

function request(): OwnedResultRunAdmissionV1 {
  const base = "/model/allocations", runId = "run_owned_1", agentId = "ai_1";
  const root = allocateWorkspaceRoot({ workspaceRoot: "/model/source", branchBacked: true, targetComputerOs: "linux",
    agentInstanceId: agentId, runId, worktreeBase: { version: 1, strategy: "per-run", basePath: base } })!;
  const run_start: RunStartPayload = { run_id: runId, task_id: "task_1", agent_instance_id: agentId, runtime: "fixture",
    workspace: { root, branch: "fixture/author" }, workspace_allocation: { version: 1, strategy: "per-run", base_path: base },
    workspace_retention_reporting: "typed-v1", context_pack: { id: "context_1", payload: {
      task: { id: "task_1", title: "Task", description: "Original author request", acceptance_criteria: ["Checks pass"] },
      project: { id: "project_1", name: "Project", default_workspace: "/model/source" }, workspace: { root, file_scope: ["src"] },
      policy: { filesystem_write_scope: ["src"], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    } }, policy_snapshot: { filesystem_write_scope: [root], requires_approval: [] }, artifact_rules: { paths: ["src/**"] } };
  return { version: 1, run_start, requirement: { version: 1, request_id: "verify_1", capture_request_id: "capture_1",
    verification_materialization_request_id: "materialize_1", author_context_digest: sha(canonicalOwnedResultAuthorContextV1(run_start.context_pack.payload)),
    input: { kind: "baseline" }, profile: { version: 1, node_id: "node_1", project_id: "project_1",
      result_profile: { id: "results", digest: sha("profile"), repository_binding: sha("repository"), baseline_commit: "a".repeat(40) },
      verifier_template: { id: "template", digest: sha("template") }, workspace_strategy: "per-run", verification_mode: "plain-commands",
      verification_context_policy: { version: 1, mode: "none" }, content_paths: ["src"],
      scope: "authored-result command verification; no product-stage, review or publication acceptance" } } };
}
function ordinary(runId = "run_ordinary_1"): RunStartPayload {
  const value = request().run_start;
  value.run_id = runId; value.workspace = { root: "/model/ordinary" };
  delete value.workspace_allocation; delete value.workspace_retention_reporting;
  value.policy_snapshot.filesystem_write_scope = [value.workspace.root]; value.context_pack.payload!.workspace.root = value.workspace.root;
  return value;
}
function command(payload = ordinary(), id = "start"): ServerToNodeMessage {
  return { kind: "command", id, idempotency_key: `${payload.run_id}:start`, type: "run.start", payload };
}
function clientFixture() {
  const received: NodeToServerMessage[] = [];
  let handler: ((value: ServerToNodeMessage) => void) | undefined;
  const transport: NodeSideTransport = { acknowledgesRunEvents: true,
    async send(message) { received.push(message); }, subscribe(listener) { handler = listener; return () => { handler = undefined; }; } };
  const adapter: RuntimeAdapter = { runtimeId: "fixture", start: vi.fn(async (config: AgentInstanceConfig) => ({ runId: config.runId })),
    async *streamEvents() { yield { type: "run.lifecycle", payload: { phase: "completed" } }; },
    stop: vi.fn(async () => {}), collectArtifacts: vi.fn(async () => []) };
  const git = { run: vi.fn(async () => {}) }, client = createNodeClient({ nodeId: "node_1", transport, adapter, git });
  clients.push(client); client.start();
  const ack = (id: string) => received.find((value): value is CommandAck => value.kind === "command.ack" && value.command_id === id);
  return { client, transport, adapter, git, received,
    send(value: ServerToNodeMessage) { if (!handler) throw new Error("Missing test subscriber"); handler(value); },
    async waitAck(id: string) { await vi.waitFor(() => expect(ack(id)).toBeDefined()); return ack(id)!; } };
}
async function journalFixture(schemaVersion: number | undefined) {
  const opening = openLocalJournal({ directory: "/model/journal", controllerScope: "fixture_controller", nodeId: "node_1",
    expectedNamespace: "fixture_namespace" }), worker = doubles.workers.at(-1)!;
  worker.emit("message", { kind: "ready", namespace: "fixture_namespace", incarnation: "fixture_incarnation", pragmas: {},
    ...(schemaVersion === undefined ? {} : { schemaVersion }) });
  const journal = await opening; journals.push(journal); return { journal, worker };
}

describe("shared owned result admission codec (no local authority)", () => {
  it("detaches and freezes the whole request with the public/finalizer canonical digest", () => {
    const raw = request(), snapshot = snapshotOwnedResultRunAdmission(raw);
    expect(snapshot.request).toEqual(raw); expect(snapshot.request).not.toBe(raw);
    expect(Object.isFrozen(snapshot.request.run_start.context_pack.payload!.task)).toBe(true);
    expect(Object.isFrozen(snapshot.request.requirement.profile.result_profile)).toBe(true);
    expect(Object.isFrozen(snapshot.author)).toBe(true);
    expect(snapshot.author.launch_binding_digest).toBe(`sha256:${snapshot.launch.key}`);
    expect(snapshot.digest).toBe(sha(canonicalOwnedResultRunAdmissionV1(raw)));
    expect(snapshot.digest).toBe(sha(canonicalOwnedVerification({ kind: "owned-result-run-admission.v1", ...snapshot.request })));
    expect(JSON.parse(snapshot.canonical)).toEqual(snapshot.request);
    raw.run_start.context_pack.payload!.task.description = "Mutated after snapshot";
    raw.requirement.profile.result_profile.digest = sha("changed");
    expect(snapshot.request.run_start.context_pack.payload!.task.description).toBe("Original author request");
    expect(snapshot.digest).toBe(sha(canonicalOwnedResultRunAdmissionV1(snapshot.request)));
  });

  it("binds changed result selection independently of the ordinary launch key", () => {
    const first = request(), changed = request(); changed.requirement.capture_request_id = "capture_2";
    const left = snapshotOwnedResultRunAdmission(first), right = snapshotOwnedResultRunAdmission(changed);
    expect(left.launch.key).toBe(right.launch.key); expect(left.digest).not.toBe(right.digest);
    const changedContext = request(); changedContext.run_start.context_pack.payload!.task.description = "Updated request";
    expect(() => snapshotOwnedResultRunAdmission(changedContext)).toThrow("context differs");
    changedContext.requirement.author_context_digest = sha(canonicalOwnedResultAuthorContextV1(changedContext.run_start.context_pack.payload));
    const updated = snapshotOwnedResultRunAdmission(changedContext);
    expect(updated.launch.key).not.toBe(left.launch.key); expect(updated.digest).not.toBe(left.digest);
  });

  it("rejects stripping, mismatched context, ordinary verification and unsupported author modes", () => {
    const changes: ((value: OwnedResultRunAdmissionV1) => void)[] = [
      value => { delete value.run_start.workspace_allocation; },
      value => { value.run_start.context_pack = { id: "uri_only", uri: "local://unread" }; },
      value => { value.run_start.verification = { version: 1, request_id: "ordinary", profile_id: "ordinary" }; },
      value => { value.requirement.profile.project_id = "another_project"; },
      value => { value.requirement.author_context_digest = sha("different"); },
      value => { value.run_start.workspace.root += "/changed"; },
      value => { value.run_start.context_pack.payload!.policy.execution_mode = "discussion"; },
      value => { Object.assign(value.run_start.context_pack.payload!.task, { unknown_instruction: true }); },
    ];
    for (const change of changes) { const changed = request(); change(changed); expect(() => snapshotOwnedResultRunAdmission(changed)).toThrow(); }
    Object.defineProperty(process, "platform", { ...platform, value: "unsupported-fixture-os" });
    expect(() => snapshotOwnedResultRunAdmission(request())).toThrow("supported target");
  });
});

describe("result profile registry rejects fabricated authority", () => {
  it("does not accept metadata, clones or forged public tokens as a local registry", () => {
    const descriptor = request().requirement.profile;
    const forged = { version: 1 as const, node_id: "node_1", descriptors: [descriptor] };
    const readNode = vi.fn(() => "node_1"), accessor = Object.defineProperty({}, "node_id", { get: readNode });
    for (const token of [forged, structuredClone(forged), Object.freeze({ ...forged }), accessor]) {
      expect(() => readOwnedResultProfileDescriptors(token as PreparedOwnedResultProfiles, "node_1")).toThrow("original result profile registry");
      expect(() => selectOwnedResultProfile(token as PreparedOwnedResultProfiles, "node_1", descriptor)).toThrow("original result profile registry");
    }
    expect(readNode).not.toHaveBeenCalled();
  });

  it("requires bounded entries and genuine templates before inspecting any supplied store", async () => {
    const readStore = vi.fn(() => { throw new Error("Untrusted store must not be inspected"); });
    const store = new Proxy({}, { get: readStore }), template = { version: 1, id: "template", digest: sha("template") } as PreparedOwnedWorktreeVerificationTemplate;
    await expect(prepareOwnedResultProfiles("node_1", [])).rejects.toThrow("bounded nonempty");
    await expect(prepareOwnedResultProfiles("node_1", Array.from({ length: 65 }, () => ({ store, template })))).rejects.toThrow("bounded nonempty");
    await expect(prepareOwnedResultProfiles("node_1", [{ store, template }])).rejects.toThrow("genuine locally prepared template");
    expect(readStore).not.toHaveBeenCalled();
  });
});

describe("NodeClient result opt-in and legacy mode fences", () => {
  it("rejects an unconfigured distinct command without writing or starting, then preserves ordinary execution", async () => {
    const f = clientFixture(), admission = request();
    f.send({ kind: "command", id: "owned_unconfigured", idempotency_key: `${admission.run_start.run_id}:start`,
      type: "run.start.owned-result.v1", payload: admission });
    expect(await f.waitAck("owned_unconfigured")).toMatchObject({ status: "rejected", error_code: "process_start_failed",
      message: expect.stringContaining("configured managed result execution") });
    expect(f.adapter.start).not.toHaveBeenCalled(); expect(f.git.run).not.toHaveBeenCalled();
    expect(f.received.filter(value => value.kind === "run.event")).toEqual([]);
    f.send(command(ordinary(admission.run_start.run_id), "ordinary_after_rejection"));
    expect(await f.waitAck("ordinary_after_rejection")).toMatchObject({ status: "accepted" });
    await f.client.stop(); expect(f.adapter.start).toHaveBeenCalledTimes(1); expect(f.git.run).not.toHaveBeenCalled();
  });

  it("rejects a forged configured registry synchronously before subscribing or invoking an adapter", () => {
    const f = clientFixture(), subscribe = vi.fn(() => () => {}), descriptor = request().requirement.profile;
    expect(() => createNodeClient({ nodeId: "node_1", transport: { ...f.transport, subscribe }, adapter: f.adapter,
      ownedResultProfiles: { version: 1, node_id: "node_1", descriptors: [descriptor] } })).toThrow("original result profile registry");
    expect(subscribe).not.toHaveBeenCalled(); expect(f.adapter.start).not.toHaveBeenCalled();
  });

  it("guards typed transports before first or duplicate legacy acknowledgements", async () => {
    const f = clientFixture(), payload = ordinary(), base = command(payload);
    for (const [index, marker] of ["owned_result_assignment", "owned_result", "requirement", "run_start"].entries()) {
      f.send({ ...base, id: `initial_${index}`, payload: { ...payload, [marker]: request().requirement } } as ServerToNodeMessage);
      expect(await f.waitAck(`initial_${index}`)).toMatchObject({ status: "rejected", error_code: "process_start_failed" });
    }
    expect(f.adapter.start).not.toHaveBeenCalled(); expect(f.git.run).not.toHaveBeenCalled();
    f.send({ ...base, id: "ordinary", payload: { ...payload, future_ordinary_field: true } } as unknown as ServerToNodeMessage);
    expect(await f.waitAck("ordinary")).toMatchObject({ status: "accepted" });
    for (const [index, marker] of ["owned_result_assignment", "owned_result", "requirement", "run_start"].entries()) {
      f.send({ ...base, id: `duplicate_${index}`, payload: { ...payload, [marker]: request().requirement } } as ServerToNodeMessage);
      expect(await f.waitAck(`duplicate_${index}`)).toMatchObject({ status: "rejected", error_code: "process_start_failed" });
    }
    f.send({ ...base, id: "ordinary_duplicate" });
    expect(await f.waitAck("ordinary_duplicate")).toMatchObject({ status: "accepted" });
    await f.client.stop(); expect(f.adapter.start).toHaveBeenCalledTimes(1); expect(f.git.run).not.toHaveBeenCalled();
  });
});

describe("journal result version gate and forged tokens (mock ready notifications)", () => {
  it("advertises result support only for an explicit v4 ready receipt", async () => {
    for (const version of [undefined, 3, 4]) {
      const { journal, worker } = await journalFixture(version);
      expect(journal.ownedResultFinalizationVersion).toBe(version === 4 ? 1 : undefined);
      expect(worker.postMessage).not.toHaveBeenCalled(); await journal.close();
    }
  });

  it("rejects fabricated prepared admission on both legacy and v4 journals before storage", async () => {
    const value = request(), fake = { version: 1, request: value, admission_digest: sha(canonicalOwnedResultRunAdmissionV1(value)),
      author_launch_digest: sha("caller supplied") } as PreparedOwnedResultRun;
    for (const version of [3, 4]) {
      const { journal, worker } = await journalFixture(version);
      expect(() => journal.admitOwnedResultStart!({ expectedNamespace: journal.namespace, runId: value.run_start.run_id,
        idempotencyKey: `${value.run_start.run_id}:start`, admission: fake })).toThrow("original prepared owned result run");
      expect(worker.postMessage).not.toHaveBeenCalled(); await journal.close();
    }
  });

  it("rejects fabricated settlement permits before reading a claimed result bundle", async () => {
    const { journal, worker } = await journalFixture(4), readBundle = vi.fn(() => { throw new Error("Do not read forged evidence"); });
    const forgedBundle = Object.defineProperty({}, "evidence_event", { get: readBundle }) as OwnedResultFinalizationV1;
    expect(() => journal.settleOwnedResultProcess!({} as FreshLaunchPermit, { runId: "run_owned_1" }, {}, forgedBundle)).toThrow("exact live fresh journal permit");
    expect(readBundle).not.toHaveBeenCalled(); expect(worker.postMessage).not.toHaveBeenCalled();
  });
});
