import { contextPacks, runs } from "@artoo/db";
import { ContextPackSchema, PRODUCT_SOURCE_RECOVERY_FEATURE_V1, SOURCE_CLEAN_RESTART_FEATURE_V1, productDevelopmentContext } from "@artoo/domain";
import type { NodeTransport, RunStartCommand, ServerToNodeMessage } from "@artoo/protocol";
import type { DrizzleDb } from "@artoo/storage";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachNodeBinding, type NodeBinding } from "./node-binding.js";
import { buildTestServer, type TestServer } from "./test-support.js";

const computer = "computer_local_mock", root = "/work/source-replay";
const profile = { profile_id: "default", project_id: "proj_artoo", workspace_root: root };
const features = ["run-verification.v1", "product-stage-verification.v1", PRODUCT_SOURCE_RECOVERY_FEATURE_V1];

// Controlled server transport and qualification boundary. No native process,
// real pairing, provider request or product acceptance is exercised here.
describe("normal source startup re-delivers one complete pending command identity", () => {
  let server: TestServer, qualified: boolean;
  const bindings: NodeBinding[] = [], sent: ServerToNodeMessage[] = [], exposed: RunStartCommand[] = [];
  beforeEach(async () => {
    server = await buildTestServer({ workspaceRoot: root });
    server.ctx.onRunQueued = async () => {};
    qualified = true;
  });
  afterEach(async () => {
    for (const binding of bindings.splice(0)) binding.close();
    sent.length = 0; exposed.length = 0;
    await server.close();
  });
  function wire(options: { features?: string[]; onSend?: (message: ServerToNodeMessage, binding: NodeBinding) => void | Promise<void> } = {}) {
    const transport: NodeTransport = {
      async send(message) {
        sent.push(structuredClone(message));
        if (message.type === "run.start") exposed.push(message);
        await options.onSend?.(message, binding);
      },
      subscribe() { return () => {}; }, async close() {},
    };
    const binding: NodeBinding = attachNodeBinding(server.ctx, transport, computer, options.features ?? features,
      () => server.nodeRegistry.get(computer) === binding, [profile], [], [], () => false, undefined,
      { identity: { deviceId: "device_fixture", computerId: computer, tokenLookup: "controlled-fixture" },
        sessionId: "session_fixture", artifactDir: "/controlled/artifacts", qualifiedRunEventReceiptsReady: () => qualified });
    bindings.push(binding); server.nodeRegistry.register(computer, binding); return binding;
  }
  async function queued(staged = true) {
    const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Retain the complete startup request", acceptance_criteria: ["Start once while delivering retries"], required_capabilities: [],
    } });
    expect(created.statusCode, created.body).toBe(201);
    const taskId = created.json().task.id as string;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` })).statusCode).toBe(200);
    const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto" } });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const run = assigned.json().run as { id: string; context_pack_id: string };
    if (staged) {
      await server.db.db.update(runs).set({ verificationRequirement: { version: 1, request_id: "verify_source", profile_id: "default" } }).where(eq(runs.id, run.id));
      const [stored] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.context_pack_id));
      const context = ContextPackSchema.parse(stored!.payload);
      context.product_development = productDevelopmentContext("research");
      await server.db.db.update(contextPacks).set({ payload: context }).where(eq(contextPacks.id, run.context_pack_id));
    }
    return run;
  }
  const storedRun = async (id: string) => (await server.db.db.select().from(runs).where(eq(runs.id, id)))[0]!;
  const starts = () => sent.filter((message): message is RunStartCommand => message.type === "run.start");
  const accept = (binding: NodeBinding, id: string) => binding.receive({ kind: "command.ack", node_id: computer, command_id: id, status: "accepted" });
  const reject = (binding: NodeBinding, id: string) => binding.receive({ kind: "command.ack", node_id: computer, command_id: id,
    status: "rejected", error_code: "process_start_failed", message: "Controlled startup rejection" });

  it("keeps sending the exact immutable request past the old waiter-exhaustion boundary without waiting for ACK", async () => {
    const run = await queued(), binding = wire(), before = await storedRun(run.id);
    // More than twice the former 64-waiter failure boundary; no ACK is returned.
    for (let attempt = 0; attempt < 130; attempt++) await binding.dispatchRunStart(run.id);
    expect(starts()).toHaveLength(130);
    expect(new Set(starts().map(command => command.id)).size).toBe(1);
    for (const command of starts()) expect(command).toEqual(starts()[0]);
    expect(new Set(exposed).size).toBe(1);
    const original = exposed[0]!;
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(original.payload.context_pack.payload!.task)).toBe(true);
    expect(Object.isFrozen(original.payload.policy_snapshot.filesystem_write_scope)).toBe(true);
    expect(() => { original.payload.workspace.root = "/mutated"; }).toThrow(TypeError);
    expect(await storedRun(run.id)).toEqual(before);
  });

  it("retains possible exposure after send throws and retries the same complete request", async () => {
    const run = await queued(); let attempts = 0;
    const binding = wire({ onSend(message) { if (message.type === "run.start" && ++attempts === 1) throw new Error("delivery outcome unknown"); } });
    const before = await storedRun(run.id);
    await expect(binding.dispatchRunStart(run.id)).rejects.toThrow("delivery outcome unknown");
    expect(await storedRun(run.id)).toEqual(before);
    await binding.dispatchRunStart(run.id);
    expect(starts()).toHaveLength(2); expect(starts()[1]).toEqual(starts()[0]);
    expect(await storedRun(run.id)).toEqual(before);
  });

  it("keeps the identity while accepted ACK precedes the first committed lifecycle, including ACK during send", async () => {
    const run = await queued();
    const binding = wire({ onSend(message, current) { if (message.type === "run.start") accept(current, message.id); } });
    await binding.dispatchRunStart(run.id);
    await binding.dispatchRunStart(run.id);
    await binding.dispatchRunStart(run.id);
    expect(starts()).toHaveLength(3);
    expect(starts()[1]).toEqual(starts()[0]); expect(starts()[2]).toEqual(starts()[0]);
    expect((await storedRun(run.id)).status).toBe("queued");
  });

  it.each(["context", "verification", "runtime"] as const)("refuses a changed %s without replacing the originally exposed request", async change => {
    const run = await queued(), binding = wire();
    await binding.dispatchRunStart(run.id);
    const original = structuredClone(starts()[0]!);
    const before = await storedRun(run.id);
    const [pack] = await server.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.context_pack_id));
    if (change === "context") {
      const context = ContextPackSchema.parse(pack!.payload); context.task.title = "Changed after possible exposure";
      await server.db.db.update(contextPacks).set({ payload: context }).where(eq(contextPacks.id, run.context_pack_id));
    } else if (change === "verification") {
      await server.db.db.update(runs).set({ verificationRequirement: { version: 1, request_id: "verify_changed", profile_id: "default" } }).where(eq(runs.id, run.id));
    } else await server.db.db.update(runs).set({ runtimeId: "changed-runtime" }).where(eq(runs.id, run.id));
    await expect(binding.dispatchRunStart(run.id)).rejects.toThrow("complete request changed");
    expect(starts()).toEqual([original]);
    await server.db.db.update(contextPacks).set({ payload: pack!.payload }).where(eq(contextPacks.id, run.context_pack_id));
    await server.db.db.update(runs).set({ verificationRequirement: before.verificationRequirement, runtimeId: before.runtimeId }).where(eq(runs.id, run.id));
    await binding.dispatchRunStart(run.id);
    expect(starts()[1]).toEqual(original);
  });

  it("does not fall back to a new identity when the qualified source scope is withdrawn", async () => {
    const run = await queued(), binding = wire();
    await binding.dispatchRunStart(run.id); qualified = false;
    await expect(binding.dispatchRunStart(run.id)).rejects.toThrow("original dispatch scope");
    expect(starts()).toHaveLength(1);
    qualified = true; await binding.dispatchRunStart(run.id);
    expect(starts()[1]).toEqual(starts()[0]);
  });

  it("rechecks the current binding and run ownership on cached delivery", async () => {
    const run = await queued(), binding = wire();
    await binding.dispatchRunStart(run.id);
    await server.db.db.update(runs).set({ computerId: "computer_other" }).where(eq(runs.id, run.id));
    await expect(binding.dispatchRunStart(run.id)).rejects.toThrow("not owned");
    await server.db.db.update(runs).set({ computerId: computer }).where(eq(runs.id, run.id));
    wire();
    await expect(binding.dispatchRunStart(run.id)).rejects.toThrow("no longer current");
    expect(starts()).toHaveLength(1);
  });

  it("rechecks authorization, confirms Stop, and ignores a late rejected startup ACK", async () => {
    const run = await queued();
    const binding = wire({ onSend(message, current) { if (message.type === "run.stop") accept(current, message.id); } });
    await binding.dispatchRunStart(run.id);
    server.ctx.aiDataSharingPolicy = null;
    await expect(binding.dispatchRunStart(run.id)).rejects.toMatchObject({ code: "ai_sharing_unconfigured", details: { stop_confirmed: true } });
    expect(sent.map(message => message.type)).toEqual(["run.start", "run.stop"]);
    expect((await storedRun(run.id)).status).toBe("cancelled");
    reject(binding, starts()[0]!.id); await binding.drain();
    expect((await storedRun(run.id)).status).toBe("cancelled");
  });

  it("does not forget the original command when Stop is rejected", async () => {
    const run = await queued();
    const binding = wire({ onSend(message, current) { if (message.type === "run.stop") reject(current, message.id); } });
    await binding.dispatchRunStart(run.id);
    await expect(binding.dispatchRunStop(run.id)).rejects.toThrow("could not stop");
    await binding.dispatchRunStart(run.id);
    expect(starts()[1]).toEqual(starts()[0]);
    expect((await storedRun(run.id)).status).toBe("queued");
  });

  it("handles a matching rejection once and never sends another start for that failed run", async () => {
    const run = await queued(), binding = wire();
    await binding.dispatchRunStart(run.id);
    reject(binding, starts()[0]!.id); await binding.drain();
    expect((await storedRun(run.id)).status).toBe("failed");
    const failed = await storedRun(run.id);
    reject(binding, starts()[0]!.id); await binding.drain();
    await binding.dispatchRunStart(run.id);
    expect(starts()).toHaveLength(1); expect(await storedRun(run.id)).toEqual(failed);
  });

  it.each(["started", "failed"] as const)("retires the original startup ACK after a qualified %s lifecycle", async phase => {
    const run = await queued(), binding = wire();
    await binding.dispatchRunStart(run.id);
    binding.receive({ kind: "run.event", node_id: computer, run_id: run.id, sequence: 0,
      event: { type: "run.lifecycle", payload: { phase, ...(phase === "failed" ? { reason: "Controlled process failure" } : {}) } } });
    await binding.drain();
    expect(sent.at(-1)).toMatchObject({ type: "run.event.ack", payload: { status: "accepted" } });
    const advanced = await storedRun(run.id);
    expect(advanced.status).toBe(phase === "started" ? "running" : "failed");
    reject(binding, starts()[0]!.id); await binding.drain();
    expect(await storedRun(run.id)).toEqual(advanced);
    await binding.dispatchRunStart(run.id); expect(starts()).toHaveLength(1);
  });

  it("retires queued startup state when the persisted run advances independently", async () => {
    const run = await queued(), binding = wire();
    await binding.dispatchRunStart(run.id);
    await server.db.db.update(runs).set({ status: "running" }).where(eq(runs.id, run.id));
    await binding.dispatchRunStart(run.id);
    reject(binding, starts()[0]!.id); await binding.drain();
    expect((await storedRun(run.id)).status).toBe("running"); expect(starts()).toHaveLength(1);
  });

  it.each(["lifecycle", "stop"] as const)("does not resurrect a start retired by %s while a resend awaits its transaction", async retirement => {
    const run = await queued();
    const binding = wire({ onSend(message, current) { if (message.type === "run.stop") accept(current, message.id); } });
    await binding.dispatchRunStart(run.id);
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const transaction = server.db.transaction.bind(server.db);
    // Pause only the next real transaction entry, after the resend captured its
    // original command. Ingestion and Stop still use the real database below.
    server.db.transaction = async <T>(work: (tx: DrizzleDb) => Promise<T>): Promise<T> => {
      server.db.transaction = transaction; entered(); await proceed; return transaction(work);
    };
    const resend = binding.dispatchRunStart(run.id);
    try {
      await reached;
      if (retirement === "stop") await binding.dispatchRunStop(run.id);
      else {
        binding.receive({ kind: "run.event", node_id: computer, run_id: run.id, sequence: 0,
          event: { type: "run.lifecycle", payload: { phase: "started" } } });
        await binding.drain();
        expect(sent.at(-1)).toMatchObject({ type: "run.event.ack", payload: { status: "accepted" } });
      }
    } finally { server.db.transaction = transaction; release(); await resend; }
    expect(starts()).toHaveLength(1);
    const retired = await storedRun(run.id);
    reject(binding, starts()[0]!.id); await binding.drain();
    expect(await storedRun(run.id)).toEqual(retired);
  });

  it.each(["stop", "rejection"] as const)("retains the original retirement fence across the first startup read: %s", async retirement => {
    const run = await queued();
    const binding = wire({ onSend(message, current) { if (message.type === "run.stop") accept(current, message.id); } });
    await binding.dispatchRunStart(run.id);
    let readEntered!: () => void, releaseRead!: () => void, rejectionEntered!: () => void, releaseRejection!: () => void;
    const reading = new Promise<void>(resolve => { readEntered = resolve; });
    const continueRead = new Promise<void>(resolve => { releaseRead = resolve; });
    const rejecting = new Promise<void>(resolve => { rejectionEntered = resolve; });
    const continueRejection = new Promise<void>(resolve => { releaseRejection = resolve; });
    const database = server.db.db, select = database.select, transaction = server.db.transaction.bind(server.db);
    // Gate only awaiting the next real select. Its builder and result remain
    // unchanged; concurrent Stop/ACK handling uses the restored database method.
    database.select = function (...args: Parameters<typeof database.select>) {
      database.select = select;
      const builder = Reflect.apply(select, database, args), from = builder.from.bind(builder);
      builder.from = (...tables: unknown[]) => {
        const query = Reflect.apply(from, builder, tables) as { then: (...callbacks: unknown[]) => PromiseLike<unknown> };
        const then = query.then.bind(query);
        query.then = (...callbacks: unknown[]) => {
          readEntered(); return continueRead.then(() => Reflect.apply(then, query, callbacks));
        };
        return query;
      };
      return builder;
    } as typeof database.select;
    const resend = binding.dispatchRunStart(run.id);
    try {
      await reading;
      if (retirement === "stop") await binding.dispatchRunStop(run.id);
      else {
        // Keep rejection's state transition pending, so a no-send assertion
        // depends on the retained retirement fence rather than terminal status.
        server.db.transaction = async <T>(work: (tx: DrizzleDb) => Promise<T>): Promise<T> => {
          server.db.transaction = transaction; rejectionEntered(); await continueRejection; return transaction(work);
        };
        reject(binding, starts()[0]!.id); await rejecting;
      }
      expect((await storedRun(run.id)).status).toBe("queued");
      releaseRead(); await resend;
      expect((await storedRun(run.id)).status).toBe("queued");
      expect(starts()).toHaveLength(1);
    } finally {
      database.select = select; server.db.transaction = transaction;
      releaseRead(); releaseRejection(); await resend; await binding.drain();
    }
    expect((await storedRun(run.id)).status).toBe(retirement === "stop" ? "queued" : "failed");
  });

  it.each(["stop", "rejection"] as const)("blocks a fresh invocation after %s while durable state is still queued", async retirement => {
    const run = await queued();
    const binding = wire({ onSend(message, current) { if (message.type === "run.stop") accept(current, message.id); } });
    await binding.dispatchRunStart(run.id);
    const original = starts()[0]!;
    let entered!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const transaction = server.db.transaction.bind(server.db);
    try {
      if (retirement === "stop") await binding.dispatchRunStop(run.id);
      else {
        server.db.transaction = async <T>(work: (tx: DrizzleDb) => Promise<T>): Promise<T> => {
          server.db.transaction = transaction; entered(); await proceed; return transaction(work);
        };
        reject(binding, original.id); await reached;
      }
      expect((await storedRun(run.id)).status).toBe("queued");
      const generate = server.ctx.idGen.generate.bind(server.ctx.idGen), allocated: string[] = [];
      server.ctx.idGen.generate = prefix => { allocated.push(prefix); return generate(prefix); };
      try {
        await binding.dispatchRunStart(run.id); await binding.dispatchRunStart(run.id);
      } finally { server.ctx.idGen.generate = generate; }
      expect(allocated).not.toContain("cmd");
      expect(starts()).toEqual([original]);
      expect((await storedRun(run.id)).status).toBe("queued");
    } finally { server.db.transaction = transaction; release(); await binding.drain(); }
    expect((await storedRun(run.id)).status).toBe(retirement === "stop" ? "queued" : "failed");
    if (retirement === "rejection") {
      await binding.dispatchRunStart(run.id);
      expect(starts()).toEqual([original]);
    }
  });

  it("cannot dispatch or ingest a late original ACK after binding close", async () => {
    const run = await queued(), binding = wire();
    await binding.dispatchRunStart(run.id); binding.close();
    reject(binding, starts()[0]!.id); await binding.drain();
    await expect(binding.dispatchRunStart(run.id)).rejects.toThrow();
    expect((await storedRun(run.id)).status).toBe("queued"); expect(starts()).toHaveLength(1);
  });

  it("preserves legacy manual fallback ContextPack allocation", async () => {
    const run = await queued(false), binding = wire();
    await server.db.db.update(runs).set({ contextPackId: null }).where(eq(runs.id, run.id));
    await binding.dispatchRunStart(run.id); await binding.dispatchRunStart(run.id);
    expect(starts()).toHaveLength(2);
    expect(starts()[1]!.id).not.toBe(starts()[0]!.id);
    expect(starts()[1]!.payload.context_pack.id).not.toBe(starts()[0]!.payload.context_pack.id);
    expect(starts()[0]!.payload.context_pack).toHaveProperty("uri");
    expect(starts()[0]!.payload).not.toHaveProperty("verification");
  });

  it.each(["legacy", "clean"] as const)("preserves ordinary %s verified dispatch behavior", async mode => {
    const run = await queued();
    const binding = wire({ features: mode === "clean" ? [...features, SOURCE_CLEAN_RESTART_FEATURE_V1] : features.filter(feature => feature !== PRODUCT_SOURCE_RECOVERY_FEATURE_V1) });
    await binding.dispatchRunStart(run.id); await binding.dispatchRunStart(run.id);
    expect(starts()).toHaveLength(2);
    expect(starts()[1]!.id).not.toBe(starts()[0]!.id);
    expect(starts()[1]!.payload).toEqual(starts()[0]!.payload);
  });
});
