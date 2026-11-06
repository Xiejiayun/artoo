import { describe, expect, it } from "vitest";
import { runStartCommandSchema, type RunStartCommand } from "@artoo/protocol";
import { createSourceStartReplay, type SourceStartOutcome } from "./source-start-replay.js";

const command = (id = "original", runId = "run"): RunStartCommand => runStartCommandSchema.parse({ kind: "command", id,
  type: "run.start", idempotency_key: `${runId}:start`, payload: { run_id: runId, task_id: "task", agent_instance_id: "agent", runtime: "fixture",
    workspace: { root: "/workspace" }, context_pack: { id: "context", uri: "artoo://context/original" },
    policy_snapshot: { filesystem_write_scope: ["/workspace"], requires_approval: ["external.post"] }, artifact_rules: { paths: ["product/**"] } } });
const scope = () => ({ runtime: {}, session: {} });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

describe("bounded source startup replay facts", () => {
  it("joins the original startup and its actual ACK send, despite different reply IDs", async () => {
    const gate = createSourceStartReplay(), owner = scope(), original = gate.enter(command(), owner), start = deferred(), send = deferred();
    const work = gate.run(original.ticket, async () => {
      await start.promise; const observed = gate.observeAck("original", { status: "accepted" });
      await send.promise; gate.finishAck(observed, true);
    });
    const copy = gate.enter(command("retry"), owner); expect(copy.fresh).toBe(false);
    let replied = false; const replay = gate.replay(copy.ticket, () => owner, () => true).then(value => { replied = true; return value; });
    await Promise.resolve(); expect(replied).toBe(false); start.resolve(); await Promise.resolve(); expect(replied).toBe(false);
    send.resolve(); await work; expect(await replay).toEqual({ status: "accepted" });
    expect(gate.enter(command("late-retry"), owner).fresh).toBe(false);
  });

  it.each(["context", "policy", "artifacts", "runtime", "deadline", "idempotency", "unknown-field"])("does not drop %s from the original complete binding", field => {
    const gate = createSourceStartReplay(), owner = scope(); gate.enter(command(), owner); const changed = command("retry");
    if (field === "context") changed.payload.context_pack.uri = "artoo://context/changed";
    if (field === "policy") changed.payload.policy_snapshot.requires_approval = [];
    if (field === "artifacts") changed.payload.artifact_rules.paths = ["**"];
    if (field === "runtime") changed.payload.runtime = "other";
    if (field === "deadline") changed.deadline_at = "2030-01-01T00:00:00Z";
    if (field === "idempotency") changed.idempotency_key = "other:start";
    if (field === "unknown-field") Object.assign(changed.payload, { hidden_authority: true });
    expect(() => gate.enter(changed, owner)).toThrow(); gate.invalidate();
  });

  it("keeps real startup success distinct from an ACK delivery failure", async () => {
    const gate = createSourceStartReplay(), owner = scope(), original = gate.enter(command(), owner);
    await gate.run(original.ticket, async () => {
      const observed = gate.observeAck("original", { status: "accepted" }); expect(observed!.outcome.status).toBe("accepted");
      gate.finishAck(observed, false);
      expect(gate.observeAck("original", { status: "rejected", error_code: "process_start_failed", message: "later send error" })).toBeUndefined();
    });
    const copy = gate.enter(command("retry"), owner); expect(copy.fresh).toBe(false);
    expect(await gate.replay(copy.ticket, () => owner, () => true)).toMatchObject({ status: "rejected", message: expect.stringContaining("ACK delivery failed") });
  });

  it("only lets the original async operation settle its own ACK", async () => {
    const gate = createSourceStartReplay(), owner = scope(), original = gate.enter(command(), owner);
    expect(gate.observeAck("original", { status: "accepted" })).toBeUndefined();
    const failure: SourceStartOutcome = { status: "rejected", error_code: "process_start_failed", message: "Original native closure unknown" };
    await gate.run(original.ticket, async () => {
      expect(gate.observeAck("another-command", { status: "accepted" })).toBeUndefined();
      gate.finishAck(gate.observeAck("original", failure), true);
    });
    expect(await gate.replay(gate.enter(command("retry"), owner).ticket, () => owner, () => true)).toEqual(failure);
  });

  it("binds original and retry command IDs to their first admitted run", () => {
    const gate = createSourceStartReplay(), owner = scope(); gate.enter(command(), owner); gate.enter(command("retry"), owner);
    expect(() => gate.enter(command("retry", "other-run"), owner)).toThrow(/command ID belongs/);
    expect(() => gate.enter(command("original", "other-run"), owner)).toThrow(/command ID belongs/);
    expect(gate.enter(command("retry"), owner).fresh).toBe(false); gate.invalidate();
  });

  it("bounds command aliases without allowing a retired reply ID to acquire another run", () => {
    const gate = createSourceStartReplay(), owner = scope(); gate.enter(command(), owner);
    for (let index = 1; index < 4096; index++) gate.enter(command(`retry-${index}`), owner);
    expect(() => gate.enter(command("overflow"), owner)).toThrow(/command identity capacity reached/);
    expect(() => gate.enter(command("retry-1", "other-run"), owner)).toThrow(/command ID belongs/);
    expect(gate.enter(command("retry-1"), owner).fresh).toBe(false); gate.invalidate();
  });

  it.each(["session", "epoch", "unsafe", "run-stop", "node-stop"])("rejects a stale accepted result after %s", async variant => {
    const gate = createSourceStartReplay(), owner = scope(), original = gate.enter(command(), owner);
    await gate.run(original.ticket, async () => { gate.finishAck(gate.observeAck("original", { status: "accepted" }), true); });
    const copy = gate.enter(command("retry"), owner);
    if (variant === "run-stop") gate.stopRun("run");
    if (variant === "node-stop") gate.invalidate();
    const current = variant === "session" ? { ...owner, session: {} } : variant === "epoch" ? { ...owner, runtime: {} } : owner;
    expect(await gate.replay(copy.ticket, () => current, () => variant !== "unsafe")).toMatchObject({ status: "rejected" });
  });

  it("wakes pending waiters on Stop without claiming the original startup closed", async () => {
    const gate = createSourceStartReplay(), owner = scope(); gate.enter(command(), owner);
    const copy = gate.enter(command("retry"), owner), replay = gate.replay(copy.ticket, () => owner, () => true);
    gate.stopRun("run"); expect(await replay).toMatchObject({ status: "rejected", error_code: "process_start_failed" });
    expect(() => gate.enter(command("again"), owner)).toThrow(/Stop fence/);
  });

  it("retains Stop before original admission and fails closed if Stop tombstones fill", () => {
    const gate = createSourceStartReplay(), owner = scope(); gate.stopRun("run");
    expect(() => gate.enter(command(), owner)).toThrow(/fenced by Stop/);
    for (let index = 1; index < 1024; index++) gate.stopRun(`run-${index}`);
    expect(() => gate.enter(command("overflow", "overflow"), owner)).toThrow(/capacity reached/);
    gate.stopRun("stop-overflow");
    expect(gate.isStopped("any-future-run")).toBe(true);
    expect(() => gate.enter(command("future", "future"), owner)).toThrow(/stopping/);
  });

  it("bounds retained identities without evicting a completed startup into a fresh execution", async () => {
    const gate = createSourceStartReplay(), owner = scope(), first = gate.enter(command(), owner);
    await gate.run(first.ticket, async () => { gate.finishAck(gate.observeAck("original", { status: "accepted" }), true); });
    for (let index = 1; index < 1024; index++) gate.enter(command(`command-${index}`, `run-${index}`), owner);
    expect(() => gate.enter(command("overflow", "overflow"), owner)).toThrow(/capacity reached/);
    expect(gate.enter(command("original-retry"), owner).fresh).toBe(false); gate.invalidate();
  });
});
