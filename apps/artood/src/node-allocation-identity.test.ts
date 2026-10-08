import { describe, expect, it } from "vitest";
import { RunStartPayloadSchema, type RunStartPayload } from "@artoo/domain";
import { allocateWorkspaceRoot, runStartCommandSchema, type CommandAck, type NodeToServerMessage, type RuntimeAdapter } from "@artoo/protocol";
import { createInProcessChannel } from "@artoo/testkit";
import { createNodeClient } from "./node-client.js";
import { allocationStartBinding, assertMatchingAllocationReplay } from "./node-allocation-identity.js";

function payload(os = "darwin", base = "/approved//运行/"): RunStartPayload {
  const root = allocateWorkspaceRoot({ workspaceRoot: "unused", branchBacked: true,
    targetComputerOs: os, agentInstanceId: "ai_A", runId: "run_1",
    worktreeBase: { version: 1, strategy: "per-run", basePath: base } })!;
  return {
    run_id: "run_1", task_id: "task_1", agent_instance_id: "ai_A", runtime: "codex",
    workspace: { root, branch: "task/run_1" },
    workspace_allocation: { version: 1, strategy: "per-run", base_path: base },
    workspace_retention_reporting: "typed-v1",
    context_pack: { id: "ctx_1", payload: {
      task: { id: "task_1", title: "Make a change", description: "Original request", acceptance_criteria: ["One outcome"] },
      project: { id: "project_1", name: "Project", default_workspace: "/source" },
      workspace: { root, file_scope: ["src/File.ts"] },
      policy: { filesystem_write_scope: ["src/File.ts"], requires_approval: ["git.push"] },
      memory: { task_summary: null, project_notes: [] }, artifacts: { expected: ["report.md"] },
    } },
    policy_snapshot: { filesystem_write_scope: [root], requires_approval: ["git.push"] },
    artifact_rules: { paths: ["report.md"] },
  };
}

function moveRoot(value: RunStartPayload, root: string): void {
  value.workspace.root = root;
  value.policy_snapshot.filesystem_write_scope = [root];
  value.context_pack.payload!.workspace.root = root;
}

function reallocate(value: RunStartPayload, os = "darwin"): void {
  moveRoot(value, allocateWorkspaceRoot({ workspaceRoot: value.workspace.root, branchBacked: true,
    targetComputerOs: os, agentInstanceId: value.agent_instance_id, runId: value.run_id,
    worktreeBase: { version: 1, strategy: "per-run", basePath: value.workspace_allocation!.base_path } })!);
}

function raw(value: RunStartPayload): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]));
  return value;
}

describe("per-run cheap launch contract", () => {
  it("preserves exact base/root spelling and relative ContextPack policy paths", () => {
    const input = payload();
    const before = structuredClone(input);
    const binding = allocationStartBinding(input, "darwin", true)!;
    expect(binding.payload).toEqual(input);
    expect(binding.payload).not.toBe(input);
    expect(binding.payload.workspace.root).toContain("/approved//运行/artoo-runs/");
    expect(binding.payload.context_pack.payload!.policy.filesystem_write_scope).toEqual(["src/File.ts"]);
    expect(input).toEqual(before);
  });

  it.each([undefined, false])("requires committed receipts, got %s", (receipts) => {
    expect(() => allocationStartBinding(payload(), "darwin", receipts)).toThrow(/committed/);
  });

  it.each([undefined, "legacy", "typed-v2"])("rejects non-typed-v1 retention %s", (reporting) => {
    const input = payload(); input.workspace_retention_reporting = reporting;
    expect(() => allocationStartBinding(input, "darwin", true)).toThrow(/typed-v1/);
  });

  const malformedModes: [string, unknown][] = [
    ["null", null], ["unknown version", { version: 2, strategy: "per-run", base_path: "/approved" }],
    ["unknown strategy", { version: 1, strategy: "shared", base_path: "/approved" }],
    ["caller approval", { version: 1, strategy: "per-run", base_path: "/approved", approved: true }],
    ["wrong DTO spelling", { version: 1, strategy: "per-run", basePath: "/approved" }],
  ];
  it.each(malformedModes)("rejects explicit %s allocation", (_, mode) => {
    const input = payload(); raw(input).workspace_allocation = mode;
    expect(() => allocationStartBinding(input, "darwin", true)).toThrow();
  });

  it.each([undefined, null, "", "   ", " branch", "branch ", "branch\0"])("rejects ordinary/invalid branch %j", (branch) => {
    const input = payload(); input.workspace.branch = branch;
    expect(() => allocationStartBinding(input, "darwin", true)).toThrow();
  });

  it.each(["relative/base", "/approved/../other", "/bad\0base"])("rejects invalid base %j", (base) => {
    const input = payload(); input.workspace_allocation!.base_path = base;
    expect(() => allocationStartBinding(input, "darwin", true)).toThrow();
  });

  it.each(["ai_bad/slash", "AI_1", "ai_", "ai_运行"])("rejects invalid instance ID %j", (id) => {
    const input = payload(); input.agent_instance_id = id;
    expect(() => allocationStartBinding(input, "darwin", true)).toThrow();
  });

  it.each(["run_bad/slash", "RUN_1", "run_", "run_运行"])("rejects invalid run ID %j", (id) => {
    const input = payload(); input.run_id = id;
    expect(() => allocationStartBinding(input, "darwin", true)).toThrow();
  });

  it.each(["task_id", "runtime"] as const)("rejects whitespace/control identity %s", (field) => {
    for (const invalid of ["", "   ", " value", "value\0"]) {
      const input = payload(); input[field] = invalid;
      expect(() => allocationStartBinding(input, "darwin", true)).toThrow();
    }
  });

  it.each(["", "  ", "ctx_1\0"])("rejects invalid context ID %j", (id) => {
    const input = payload(); input.context_pack.id = id;
    expect(() => allocationStartBinding(input, "darwin", true)).toThrow();
  });

  it("rejects root equivalence obtained by normalization", () => {
    const input = payload(); moveRoot(input, input.workspace.root.replace("//", "/"));
    expect(() => allocationStartBinding(input, "darwin", true)).toThrow(/exact allocated root/);
  });

  it("rejects a stale deterministic root after authoritative run or instance ID changes", () => {
    for (const field of ["run_id", "agent_instance_id"] as const) {
      const input = payload(); input[field] += "2";
      expect(() => allocationStartBinding(input, "darwin", true)).toThrow(/exact allocated root/);
    }
  });

  it.each([{ scope: [] }, { scope: ["/approved"] }, { scope: ["/approved", "/extra"] }])("rejects transport scope $scope", ({ scope }) => {
    const input = payload(); input.policy_snapshot.filesystem_write_scope = scope;
    expect(() => allocationStartBinding(input, "darwin", true)).toThrow(/exactly/);
  });

  it("rejects duplicated exact-root scope", () => {
    const input = payload(); input.policy_snapshot.filesystem_write_scope.push(input.workspace.root);
    expect(() => allocationStartBinding(input, "darwin", true)).toThrow(/exactly/);
  });

  it.each(["task", "root"])("rejects mismatched inline ContextPack %s", (part) => {
    const input = payload();
    if (part === "task") input.context_pack.payload!.task.id = "task_other";
    else input.context_pack.payload!.workspace.root += "/";
    expect(() => allocationStartBinding(input, "darwin", true)).toThrow(/ContextPack/);
  });

  it("requires inline identity even for a URI that appears local", () => {
    const input = payload(); input.context_pack = { id: "ctx_1", uri: "file:///local/context.json" };
    expect(() => allocationStartBinding(input, "darwin", true)).toThrow(/inline ContextPack/);
  });

  it.each(["win32", "windows"])("compares exact Windows paths lexically on %s", (os) => {
    const input = payload(os, "C:/Approved/");
    expect(allocationStartBinding(input, os, true)!.payload.workspace.root).toContain("C:/Approved/artoo-runs\\");
    input.workspace.root = input.workspace.root.toLowerCase();
    expect(() => allocationStartBinding(input, os, true)).toThrow(/exact allocated root/);
  });

  it("uses the local OS path contract and rejects unsupported OS", () => {
    expect(() => allocationStartBinding(payload("win32", "C:\\Approved"), "darwin", true)).toThrow();
    expect(() => allocationStartBinding(payload(), "win32", true)).toThrow();
    expect(() => allocationStartBinding(payload(), "freebsd", true)).toThrow(/supported target/);
  });

  it("does not reinterpret ordinary/legacy payloads or URI-only packs", () => {
    const input = payload(); delete input.workspace_allocation;
    input.workspace.branch = "   "; input.context_pack = { id: "ctx_1", uri: "inline" };
    expect(allocationStartBinding(input, "unsupported", false)).toBeUndefined();
  });
});

describe("immutable allocation replay binding", () => {
  const changes: [string, (value: RunStartPayload) => void][] = [
    ["base and corresponding root", (v) => { v.workspace_allocation!.base_path += "/"; reallocate(v); }],
    ["branch", (v) => { v.workspace.branch = "task/changed"; }],
    ["instance and corresponding root", (v) => { v.agent_instance_id = "ai_a"; reallocate(v); }],
    ["run and corresponding root", (v) => { v.run_id = "run_2"; reallocate(v); }],
    ["task and corresponding ContextPack", (v) => { v.task_id = "task_2"; v.context_pack.payload!.task.id = "task_2"; }],
    ["runtime", (v) => { v.runtime = "claude-code"; }],
    ["ContextPack ID", (v) => { v.context_pack.id = "ctx_2"; }],
    ["ContextPack URI", (v) => { v.context_pack.uri = "file:///immutable/pack.json"; }],
    ["ContextPack description", (v) => { v.context_pack.payload!.task.description = "Different instructions"; }],
    ["ContextPack relative policy", (v) => { v.context_pack.payload!.policy.filesystem_write_scope = ["src/Other.ts"]; }],
    ["ContextPack file scope", (v) => { v.context_pack.payload!.workspace.file_scope = ["src/Other.ts"]; }],
    ["ContextPack project", (v) => { v.context_pack.payload!.project.id = "project_2"; }],
    ["ContextPack memory", (v) => { v.context_pack.payload!.memory.project_notes.push("Additional context"); }],
    ["transport approval policy", (v) => { v.policy_snapshot.requires_approval = []; }],
    ["artifact paths", (v) => { v.artifact_rules.paths = ["other.md"]; }],
    ["array order", (v) => { v.artifact_rules.paths = ["b.md", "a.md"]; }],
  ];

  it.each(changes)("rejects changed %s", (_, change) => {
    const original = payload();
    if (_ === "array order") original.artifact_rules.paths = ["a.md", "b.md"];
    const accepted = allocationStartBinding(original, "darwin", true)!;
    const changed = structuredClone(original); change(changed);
    expect(() => assertMatchingAllocationReplay(accepted, allocationStartBinding(changed, "darwin", true))).toThrow(/binding changed/);
    expect(accepted.payload).toEqual(original);
  });

  it("accepts matching parsed content with reordered object properties", () => {
    const accepted = allocationStartBinding(payload(), "darwin", true)!;
    const replay = allocationStartBinding(reverseKeys(payload()) as RunStartPayload, "darwin", true)!;
    expect(replay.key).toBe(accepted.key);
    expect(() => assertMatchingAllocationReplay(accepted, replay)).not.toThrow();
  });

  it("compares a compact historical identity without retaining ContextPack content", () => {
    const accepted = allocationStartBinding(payload(), "darwin", true)!;
    const historical = Object.freeze({ key: accepted.key });
    expect(historical.key).toMatch(/^[0-9a-f]{64}$/);
    expect(() => assertMatchingAllocationReplay(historical, allocationStartBinding(payload(), "darwin", true))).not.toThrow();
    const changed = payload(); changed.context_pack.payload!.task.description = "Changed instructions";
    expect(() => assertMatchingAllocationReplay(historical, allocationStartBinding(changed, "darwin", true))).toThrow(/binding changed/);
  });

  it("captures a detached, recursively frozen snapshot", () => {
    const input = payload();
    const accepted = allocationStartBinding(input, "darwin", true)!;
    const key = accepted.key;
    input.workspace.branch = "later/change";
    input.context_pack.payload!.policy.filesystem_write_scope.push("new.ts");
    expect(accepted.key).toBe(key);
    expect(accepted.payload.workspace.branch).toBe("task/run_1");
    expect(() => accepted.payload.context_pack.payload!.policy.filesystem_write_scope.push("changed.ts")).toThrow();
    expect(() => assertMatchingAllocationReplay(accepted, allocationStartBinding(input, "darwin", true))).toThrow();
  });

  it("rejects both mode upgrade and downgrade; unchanged legacy remains compatible", () => {
    const binding = allocationStartBinding(payload(), "darwin", true)!;
    expect(() => assertMatchingAllocationReplay(binding, undefined)).toThrow(/binding changed/);
    expect(() => assertMatchingAllocationReplay(undefined, binding)).toThrow(/binding changed/);
    expect(() => assertMatchingAllocationReplay(undefined, undefined)).not.toThrow();
  });

  it("current wire decoder preserves the allocation record and rejects unknown mode", () => {
    const command = { kind: "command", id: "cmd_1", idempotency_key: "start", type: "run.start", payload: payload() };
    const decoded = runStartCommandSchema.parse(JSON.parse(JSON.stringify(command)));
    expect(decoded.payload.workspace_allocation).toEqual(command.payload.workspace_allocation);
    raw(command.payload).workspace_allocation = { version: 2, strategy: "per-run", base_path: "/approved" };
    expect(() => runStartCommandSchema.parse(command)).toThrow();
  });

  it("records why an old stripping decoder still needs server session gating", () => {
    const oldDecoder = RunStartPayloadSchema.omit({ workspace_allocation: true });
    const stripped = oldDecoder.parse(payload());
    expect("workspace_allocation" in stripped).toBe(false);
    expect(allocationStartBinding(stripped, "darwin", true)).toBeUndefined();
  });
});


function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => { resolve = ready; });
  return { promise, resolve };
}

function rig() {
  const channel = createInProcessChannel();
  const allowStart = deferred(); const allowFinish = deferred(); const enteredStart = deferred();
  const received: NodeToServerMessage[] = [];
  const gitCalls: string[][] = [];
  const handles: object[] = [];
  let starts = 0;
  const adapter: RuntimeAdapter = {
    runtimeId: "codex",
    async start(config) { starts++; enteredStart.resolve(); await allowStart.promise;
      const handle = { runId: config.runId }; handles.push(handle); return handle; },
    async *streamEvents() { yield { type: "run.lifecycle", payload: { phase: "started" } }; await allowFinish.promise;
      yield { type: "run.lifecycle", payload: { phase: "completed" } }; },
    async stop() { allowFinish.resolve(); }, async collectArtifacts() { return []; },
  };
  channel.serverTransport.subscribe((message) => { received.push(message); });
  const client = createNodeClient({ nodeId: "computer_1", transport: { ...channel.node, acknowledgesRunEvents: true },
    adapter, git: { async run(args) { gitCalls.push([...args]); } },
    workspace: { worktreeBaseRepo: "/source" } });
  client.start();
  async function sendStart(id: string, value: RunStartPayload): Promise<void> {
    await channel.serverTransport.send({ kind: "command", id, type: "run.start", idempotency_key: id, payload: value });
  }
  async function ack(id: string): Promise<CommandAck> {
    await expect.poll(() => received.find((message) => message.kind === "command.ack" && message.command_id === id)).toBeDefined();
    return received.find((message) => message.kind === "command.ack" && message.command_id === id) as CommandAck;
  }
  async function close() { allowStart.resolve(); allowFinish.resolve(); await client.stop(); await channel.close(); }
  return { channel, client, allowStart, allowFinish, enteredStart, received, gitCalls, handles, sendStart, ack, close,
    get starts() { return starts; } };
}

function localPayload() { return payload(process.platform, process.platform === "win32" ? "C:\\Approved\\" : "/approved//运行/"); }

describe("node ACK ordering and compatibility without physical allocation", () => {
  it("rejects a runtime without the authenticated owned seam before any Git or adapter operation", async () => {
    const test = rig();
    try {
      await test.sendStart("fresh", localPayload());
      expect(await test.ack("fresh")).toMatchObject({ status: "rejected", error_code: "process_start_failed",
        message: expect.stringContaining("complete authenticated owned-run") });
      expect(test.gitCalls).toEqual([]); expect(test.starts).toBe(0);
    } finally { await test.close(); }
  });

  it.each(["starting", "live", "finished"])("rejects adding mode to a known %s legacy launch before run-ID ACK", async (state) => {
    const test = rig();
    try {
      const legacy = localPayload(); delete legacy.workspace_allocation;
      await test.sendStart("original", legacy); await test.enteredStart.promise;
      if (state !== "starting") { test.allowStart.resolve(); expect((await test.ack("original")).status).toBe("accepted"); }
      if (state === "finished") {
        test.allowFinish.resolve(); await test.client.stop(); test.client.start();
      }
      await test.sendStart("changed", localPayload());
      expect(await test.ack("changed")).toMatchObject({ status: "rejected", message: expect.stringContaining("binding changed") });
      expect(test.starts).toBe(1); expect(test.gitCalls).toHaveLength(1);
      await test.sendStart("legacy-retry", structuredClone(legacy));
      expect((await test.ack("legacy-retry")).status).toBe("accepted");
      expect(test.starts).toBe(1); expect(test.gitCalls).toHaveLength(1);
    } finally { await test.close(); }
  });

  it("rejects malformed explicit mode on an existing run before early ACK", async () => {
    const test = rig();
    try {
      const legacy = localPayload(); delete legacy.workspace_allocation;
      await test.sendStart("original", legacy); await test.enteredStart.promise;
      const invalid = localPayload(); raw(invalid).workspace_allocation = { version: 999 };
      await test.sendStart("invalid", invalid);
      expect((await test.ack("invalid")).status).toBe("rejected");
      expect(test.starts).toBe(1);
    } finally { await test.close(); }
  });

  it("does not bind a cancelled-before-start tombstone or permit a late writer", async () => {
    const test = rig();
    try {
      await test.channel.serverTransport.send({ kind: "command", id: "cancel", idempotency_key: "cancel", type: "run.stop",
        payload: { run_id: "run_1", reason: "user_cancelled" } });
      expect((await test.ack("cancel")).status).toBe("accepted");
      await test.sendStart("late-allocation", localPayload());
      expect((await test.ack("late-allocation")).status).toBe("accepted");
      const other = localPayload(); other.workspace.branch = "different/branch";
      await test.sendStart("another-late", other);
      expect((await test.ack("another-late")).status).toBe("accepted");
      const malformed = localPayload(); malformed.workspace.branch = " ";
      await test.sendStart("invalid-late", malformed);
      expect((await test.ack("invalid-late")).status).toBe("rejected");
      expect(test.gitCalls).toEqual([]); expect(test.starts).toBe(0);
    } finally { await test.close(); }
  });

  it("run.resume remains an owned-handle probe with no allocation or second writer", async () => {
    const test = rig();
    try {
      const legacy = localPayload(); delete legacy.workspace_allocation;
      await test.sendStart("original", legacy); await test.enteredStart.promise; test.allowStart.resolve();
      expect((await test.ack("original")).status).toBe("accepted");
      const handle = test.handles[0];
      await test.channel.serverTransport.send({ kind: "command", id: "resume", idempotency_key: "resume", type: "run.resume", payload: { run_id: "run_1" } });
      expect((await test.ack("resume")).status).toBe("accepted");
      expect(test.handles).toEqual([handle]); expect(test.starts).toBe(1); expect(test.gitCalls).toHaveLength(1);
    } finally { await test.close(); }
  });
});
