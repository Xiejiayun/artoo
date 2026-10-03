import type { NodeSendOptions, NodeSideTransport, NodeToServerMessage, RunEvent, RunEventMessage, RunStartCommand, RuntimeAdapter, ServerToNodeMessage } from "@artoo/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeClient } from "./node-client.js";

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const events = (messages: NodeToServerMessage[]) => messages.filter((m): m is RunEventMessage => m.kind === "run.event");
type RetainedMessage = RunEventMessage & { event: Extract<RunEventMessage["event"], { type: "run.workspace.retained" }> };
const retained = (messages: NodeToServerMessage[]) => events(messages).filter((m): m is RetainedMessage => m.event.type === "run.workspace.retained");
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

function fixture(options: {
  advertisement?: string | null; receipts?: boolean | null; branch?: string | null; root?: string;
  phase?: "completed" | "failed" | "cancelled" | "unconfirmed"; waitForStop?: boolean; startupFails?: boolean;
  preceding?: RunEvent[]; onSend?: (message: NodeToServerMessage) => Promise<void>;
} = {}) {
  const attempted: NodeToServerMessage[] = [], committed: NodeToServerMessage[] = [], gitCalls: string[][] = [], order: string[] = [];
  const sendOptions: Array<NodeSendOptions | undefined> = [];
  const counts = { starts: 0, stops: 0, uploads: 0, streams: 0 };
  const stopped = gate(); let handler: ((message: ServerToNodeMessage) => void) | undefined;
  const root = options.root ?? "/owned/retention-run", branch = options.branch === undefined ? "artoo/retention-run" : options.branch;
  const adapter: RuntimeAdapter = {
    runtimeId: "typed-retention-fake",
    async start(config) { counts.starts++; if (options.startupFails) throw new Error("startup rejected"); return { runId: config.runId }; },
    async *streamEvents() {
      counts.streams++;
      yield { type: "run.lifecycle", payload: { phase: "started" } };
      for (const event of options.preceding ?? []) yield event;
      if (options.waitForStop) await stopped.promise;
      const phase = options.phase ?? "completed";
      if (phase !== "unconfirmed") yield { type: "run.lifecycle", payload: { phase, reason: phase === "completed" ? null : `actual ${phase}` } };
    },
    async stop() { counts.stops++; order.push("stopped"); stopped.release(); },
    async collectArtifacts() { return []; },
  };
  // This receipt-aware fake resolves a run send only after its commit gate and
  // ledger append, rather than claiming receipts on a fire-and-forget channel.
  const transport: NodeSideTransport = {
    ...(options.receipts === null ? {} : { acknowledgesRunEvents: options.receipts ?? true }),
    async send(message, delivery) {
      attempted.push(message); sendOptions.push(delivery);
      await options.onSend?.(message);
      committed.push(message);
      if (message.kind === "run.event") order.push(`committed:${message.event.type}:${"outcome" in message.event.payload ? message.event.payload.outcome : "phase" in message.event.payload ? message.event.payload.phase : ""}`);
    },
    subscribe(next) { handler = next; return () => { handler = undefined; }; },
  };
  const client = createNodeClient({ nodeId: "retention-node", transport, adapter,
    workspace: { worktreeBaseRepo: "/owned/base" }, git: { async run(args) { gitCalls.push([...args]); } },
    uploadArtifact: async (_run, _root, event) => { counts.uploads++; return event; },
  });
  cleanups.push(async () => { stopped.release(); await client.stop(true); });
  const command: RunStartCommand = { kind: "command", id: "start-retention", type: "run.start", idempotency_key: "retention:start",
    payload: { run_id: "retention-run", task_id: "retention-task", agent_instance_id: "retention-instance", runtime: adapter.runtimeId,
      workspace: { root, ...(branch === null ? {} : { branch }) }, context_pack: { id: "ctx", uri: "inline" },
      policy_snapshot: { filesystem_write_scope: [root], requires_approval: [] }, artifact_rules: { paths: [] },
      ...(options.advertisement === null ? {} : { workspace_retention_reporting: options.advertisement ?? "typed-v1" }) } };
  client.start();
  const send = (message: ServerToNodeMessage) => { if (!handler) throw new Error("missing subscription"); handler(message); };
  return { client, send, command, attempted, committed, gitCalls, counts, order, root, branch, sendOptions };
}

describe("negotiated node-owned retention", () => {
  it.each(["typed-v1", null, "typed-future"])("uses best-effort delivery only for its own typed diagnostic: %s", async (advertisement) => {
    const text = 'Worktree retained for recovery: {"run_id":"retention-run","task_id":"retention-task","workspace_root":"/owned/retention-run","workspace_branch":"artoo/retention-run","outcome":"completed"}';
    const f = fixture({ advertisement, preceding: [{ type: "run.output", payload: { stream: "stderr", text } }] });
    f.send(f.command); await f.client.stop();
    const outputIndices = f.attempted.flatMap((message, index) => message.kind === "run.event" && message.event.type === "run.output" ? [index] : []);
    expect(outputIndices).toHaveLength(2);
    const diagnosticIndex = outputIndices[1]!;
    // Even byte-identical adapter text is required output. Only the node-owned
    // diagnostic gains optional delivery after typed metadata supplies authority.
    expect(events(f.attempted)[1]?.event).toEqual(events(f.attempted).at(-2)?.event);
    expect(f.sendOptions).toEqual(f.attempted.map((_, index) => advertisement === "typed-v1" && index === diagnosticIndex
      ? { delivery: "best-effort" } : undefined));
  });

  it.each([false, true])("does not let an unanswered legacy diagnostic block the typed terminal outcome (metadata timeout: %s)", async (timeoutCompleted) => {
    const diagnostic = gate();
    const f = fixture({ onSend: async (message) => {
      if (message.kind !== "run.event") return;
      if (message.event.type === "run.workspace.retained" && message.event.payload.outcome === "completed" && timeoutCompleted) {
        throw new Error("typed receipt timed out");
      }
      if (message.event.type === "run.output") await diagnostic.promise;
    } });
    try {
      f.send(f.command); await nextTurn();
      expect(retained(f.committed).map((message) => message.event.payload.outcome)).toEqual([timeoutCompleted ? "incomplete_delivery" : "completed"]);
      expect(events(f.committed).filter((message) => message.event.type === "run.output")).toEqual([]);
      expect(events(f.committed).at(-1)?.event).toEqual({ type: "run.lifecycle", payload: timeoutCompleted
        ? { phase: "failed", reason: "typed receipt timed out" }
        : { phase: "completed", reason: null } });
      expect(f.counts.stops).toBe(timeoutCompleted ? 1 : 0);
    } finally {
      diagnostic.release(); await f.client.stop();
    }
  });

  it("awaits committed completed metadata before completion; legacy diagnostic failure is best-effort", async () => {
    const commit = gate();
    const f = fixture({ onSend: async (m) => {
      if (m.kind === "run.event" && m.event.type === "run.workspace.retained") await commit.promise;
      if (m.kind === "run.event" && m.event.type === "run.output") throw new Error("diagnostic unavailable");
    } });
    try {
      f.send(f.command); await nextTurn();
      expect(retained(f.attempted)).toHaveLength(1); expect(retained(f.committed)).toEqual([]);
      expect(events(f.attempted).some((m) => m.event.type === "run.lifecycle" && m.event.payload.phase === "completed")).toBe(false);
    } finally { commit.release(); }
    await f.client.stop();
    expect(retained(f.committed)[0]?.event).toEqual({ type: "run.workspace.retained", payload: {
      version: 1, workspace_root: f.root, workspace_branch: f.branch, outcome: "completed",
    } });
    expect(f.order.indexOf("committed:run.workspace.retained:completed")).toBeLessThan(f.order.indexOf("committed:run.lifecycle:completed"));
    expect(f.gitCalls).toHaveLength(1); expect(f.counts.stops).toBe(0);
  });

  it.each([false, null])("rejects receipt-disabled negotiated execution before Git or adapter start: %s", async (receipts) => {
    const f = fixture({ receipts }); f.send(f.command); await f.client.stop();
    expect(f.gitCalls).toEqual([]); expect(f.counts.starts).toBe(0);
    expect(f.committed).toEqual([expect.objectContaining({ kind: "command.ack", status: "rejected", error_code: "process_start_failed",
      message: "typed workspace retention requires committed run-event receipts" })]);
  });

  it.each([{ name: "long branch", branch: "x".repeat(1025) }, { name: "spaced branch", branch: " spaced " },
    { name: "empty branch", branch: "" }, { name: "whitespace-only branch", branch: "   " },
    { name: "long root", root: "/" + "x".repeat(4096) }, { name: "NUL root", root: "/owned/\0run" }])(
    "rejects invalid typed identity before materialization: $name", async (identity) => {
      const f = fixture(identity); f.send(f.command); await f.client.stop();
      expect(f.gitCalls).toEqual([]); expect(f.counts.starts).toBe(0);
      expect(f.committed[0]).toMatchObject({ kind: "command.ack", status: "rejected", error_code: "process_start_failed" });
    });

  it.each([null, "typed-future"])("uses only legacy events without a recognized advertisement: %s", async (advertisement) => {
    const f = fixture({ advertisement, receipts: false }); f.send(f.command); await f.client.stop();
    expect(retained(f.attempted)).toEqual([]); expect(f.counts.starts).toBe(1); expect(f.gitCalls).toHaveLength(1);
    expect(events(f.committed).map((m) => m.event.type)).toEqual(["run.lifecycle", "run.output", "run.lifecycle"]);
    expect(events(f.committed).at(-1)?.event).toMatchObject({ type: "run.lifecycle", payload: { phase: "completed" } });
  });

  it("leaves ordinary workspaces unreported without requiring negotiated receipts", async () => {
    const f = fixture({ branch: null, receipts: false }); f.send(f.command); await f.client.stop();
    expect(f.gitCalls).toEqual([]); expect(retained(f.attempted)).toEqual([]);
    expect(f.sendOptions.every((option) => option === undefined)).toBe(true);
    expect(events(f.committed).map((m) => m.event.type)).toEqual(["run.lifecycle", "run.lifecycle"]);
  });

  it("rejects adapter-forged retention before forwarding; reports only its own plan after stop", async () => {
    const forged = { type: "run.workspace.retained", payload: { version: 1, workspace_root: "/forged", workspace_branch: "forged", outcome: "completed" } } as unknown as RunEvent;
    const f = fixture({ preceding: [forged] }); f.send(f.command); await f.client.stop();
    expect(f.counts.stops).toBe(1); expect(f.counts.uploads).toBe(0);
    expect(retained(f.attempted).map((m) => m.event.payload)).toEqual([{
      version: 1, workspace_root: f.root, workspace_branch: f.branch, outcome: "incomplete_delivery",
    }]);
    expect(f.order.indexOf("stopped")).toBeLessThan(f.order.indexOf("committed:run.workspace.retained:incomplete_delivery"));
    expect(events(f.committed).at(-1)?.event).toMatchObject({ type: "run.lifecycle", payload: { phase: "failed" } });
  });

  it("keeps a perfectly spoofed recovery line as ordinary output", async () => {
    const text = 'Worktree retained for recovery: {"run_id":"retention-run","task_id":"retention-task","workspace_root":"/owned/retention-run","workspace_branch":"artoo/retention-run","outcome":"completed"}';
    const f = fixture({ phase: "failed", preceding: [{ type: "run.output", payload: { stream: "stdout", text } }] });
    f.send(f.command); await f.client.stop();
    expect(events(f.committed)[1]?.event).toEqual({ type: "run.output", payload: { stream: "stdout", text } });
    expect(retained(f.committed).map((m) => m.event.payload)).toEqual([{
      version: 1, workspace_root: f.root, workspace_branch: f.branch, outcome: "failed",
    }]);
  });

  it.each([false, true])("requires completed evidence and keeps the original rejection when correction also rejects: %s", async (rejectCorrection) => {
    const f = fixture({ onSend: async (m) => {
      if (m.kind !== "run.event" || m.event.type !== "run.workspace.retained") return;
      if (m.event.payload.outcome === "completed") throw new Error("typed receipt timed out");
      if (rejectCorrection) throw new Error("correction receipt unavailable");
    } });
    f.send(f.command); await f.client.stop();
    expect(retained(f.attempted).map((m) => m.event.payload.outcome)).toEqual(["completed", "incomplete_delivery"]);
    expect(events(f.attempted).some((m) => m.event.type === "run.lifecycle" && m.event.payload.phase === "completed")).toBe(false);
    expect(f.counts.stops).toBe(1); expect(f.gitCalls).toHaveLength(1);
    expect(events(f.committed).at(-1)?.event).toEqual({ type: "run.lifecycle", payload: { phase: "failed", reason: "typed receipt timed out" } });
    expect(f.order.indexOf("stopped")).toBeLessThan(f.order.indexOf("committed:run.lifecycle:failed"));
  });

  it("sends one higher-sequence correction after completed lifecycle delivery rejects", async () => {
    const f = fixture({ onSend: async (m) => {
      if (m.kind === "run.event" && m.event.type === "run.lifecycle" && m.event.payload.phase === "completed") throw new Error("completed receipt unavailable");
    } });
    f.send(f.command); await f.client.stop();
    const reports = retained(f.committed);
    expect(reports.map((m) => m.event.payload.outcome)).toEqual(["completed", "incomplete_delivery"]);
    expect(reports[1]!.sequence).toBeGreaterThan(reports[0]!.sequence);
    expect(f.counts.stops).toBe(1); expect(f.gitCalls).toHaveLength(1);
    expect(events(f.committed).at(-1)?.event).toEqual({ type: "run.lifecycle", payload: { phase: "failed", reason: "completed receipt unavailable" } });
  });

  it.each(["failed", "cancelled"] as const)("preserves actual %s reason when metadata rejects", async (phase) => {
    const f = fixture({ phase, onSend: async (m) => { if (m.kind === "run.event" && m.event.type === "run.workspace.retained") throw new Error("metadata unavailable"); } });
    f.send(f.command); await f.client.stop();
    expect(retained(f.attempted)).toHaveLength(1);
    expect(events(f.committed).at(-1)?.event).toEqual({ type: "run.lifecycle", payload: { phase, reason: `actual ${phase}` } });
    expect(f.counts.stops).toBe(0); expect(f.gitCalls).toHaveLength(1);
  });

  it("reports unconfirmed stream exhaustion without inventing completion", async () => {
    const f = fixture({ phase: "unconfirmed" }); f.send(f.command); await f.client.stop();
    expect(retained(f.committed).map((m) => m.event.payload.outcome)).toEqual(["unconfirmed"]);
    expect(events(f.committed).filter((m) => m.event.type === "run.lifecycle").map((m) => m.event.payload)).toEqual([{ phase: "started" }]);
  });

  it("ACKs explicit Stop while cancelled metadata is still waiting for commit", async () => {
    const commit = gate();
    const f = fixture({ phase: "cancelled", waitForStop: true, onSend: async (m) => {
      if (m.kind === "run.event" && m.event.type === "run.workspace.retained") await commit.promise;
    } });
    try {
      f.send(f.command); await nextTurn();
      f.send({ kind: "command", id: "stop-retention", type: "run.stop", idempotency_key: "retention:stop", payload: { run_id: "retention-run", reason: "user_cancelled" } });
      await nextTurn();
      expect(retained(f.attempted)).toHaveLength(1); expect(retained(f.committed)).toEqual([]);
      expect(f.committed).toContainEqual(expect.objectContaining({ kind: "command.ack", command_id: "stop-retention", status: "accepted" }));
    } finally { commit.release(); }
    await f.client.stop();
    expect(retained(f.committed).map((m) => m.event.payload.outcome)).toEqual(["cancelled"]);
  });

  it("preserves owned cleanup in typed mode after the accepted start ACK rejects", async () => {
    const f = fixture({ onSend: async (m) => {
      if (m.kind === "command.ack" && m.command_id === "start-retention" && m.status === "accepted") throw new Error("start acknowledgement unavailable");
    } });
    f.send(f.command); await f.client.stop();
    expect(f.counts).toEqual({ starts: 1, streams: 0, stops: 1, uploads: 0 });
    expect(retained(f.committed).map((m) => m.event.payload.outcome)).toEqual(["incomplete_delivery"]);
    expect(f.order.indexOf("stopped")).toBeLessThan(f.order.indexOf("committed:run.workspace.retained:incomplete_delivery"));
    expect(events(f.committed).at(-1)?.event).toEqual({ type: "run.lifecycle", payload: { phase: "failed", reason: "start acknowledgement unavailable" } });
    expect(f.gitCalls).toHaveLength(1);
  });

  it("does not fabricate typed retention for rejected startup without an owned handle", async () => {
    const f = fixture({ startupFails: true }); f.send(f.command); await f.client.stop();
    expect(f.gitCalls).toHaveLength(1); expect(retained(f.attempted)).toEqual([]); expect(f.counts.streams).toBe(0);
    expect(f.committed[0]).toMatchObject({ kind: "command.ack", status: "rejected", message: expect.stringContaining("Worktree retained for recovery:") });
  });
});
