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

  it.each(["return", "throw"])("keeps startup unknown when work ends by %s without an ACK", async ending => {
    const gate = createSourceStartReplay(), owner = scope(), original = gate.enter(command(), owner), start = deferred();
    const failure = new Error("Startup audit failed before any ACK"); let starts = 0;
    const work = gate.run(original.ticket, async () => { starts++; await start.promise; if (ending === "throw") throw failure; });
    const completed = ending === "throw" ? expect(work).rejects.toBe(failure) : expect(work).resolves.toBeUndefined();
    const copy = gate.enter(command("retry"), owner); expect(copy.fresh).toBe(false);
    let replied = false;
    const replay = gate.replay(copy.ticket, () => owner, () => true).then(value => { replied = true; return value; });
    await Promise.resolve(); expect(replied).toBe(false); start.resolve(); await completed;
    const unknown: SourceStartOutcome = { status: "rejected", error_code: "process_start_failed",
      message: "Original source startup outcome remains unknown; original execution ownership is retained" };
    expect(await replay).toEqual(unknown);
    const late = gate.enter(command("late-retry"), owner); expect(late.fresh).toBe(false);
    expect(await gate.replay(late.ticket, () => owner, () => true)).toEqual(unknown); expect(starts).toBe(1);
  });

  it.each(["current", "session", "run-stop"])("keeps a detached first ACK unknown after work settled with %s scope", async variant => {
    const gate = createSourceStartReplay(), owner = scope(), original = gate.enter(command(), owner), releaseLate = deferred();
    let late!: Promise<void>, observed: ReturnType<typeof gate.observeAck>;
    await gate.run(original.ticket, async () => {
      late = (async () => {
        await releaseLate.promise;
        observed = gate.observeAck("original", { status: "accepted" }); gate.finishAck(observed, true);
      })();
    });
    const copy = gate.enter(command("retry"), owner); expect(copy.fresh).toBe(false);
    const unknown: SourceStartOutcome = { status: "rejected", error_code: "process_start_failed",
      message: "Original source startup outcome remains unknown; original execution ownership is retained" };
    expect(await gate.replay(copy.ticket, () => owner, () => true)).toEqual(unknown);
    let current = owner;
    if (variant === "session") current = { ...owner, session: {} };
    if (variant === "run-stop") gate.stopRun("run");
    releaseLate.resolve(); await late; expect(observed).toBeUndefined();
    expect(await gate.replay(copy.ticket, () => current, () => true)).toEqual(variant === "current" ? unknown : {
      status: "rejected", error_code: "process_start_failed",
      message: "Original source startup is stopped or no longer belongs to this authenticated epoch/session" });
    if (variant === "current") expect(gate.enter(command("after-late"), current).fresh).toBe(false);
    else expect(() => gate.enter(command("after-late"), current)).toThrow(/session|Stop/);
  });

  it.each(["accepted", "rejected"] as const)("keeps a %s outcome unconfirmed until actual ACK send completion", async status => {
    const gate = createSourceStartReplay(), owner = scope(), original = gate.enter(command(), owner);
    const outcome: SourceStartOutcome = status === "accepted" ? { status } : { status, error_code: "process_start_failed", message: "Startup rejected" };
    let observed: ReturnType<typeof gate.observeAck>;
    await gate.run(original.ticket, async () => { observed = gate.observeAck("original", outcome); expect(observed).toBeDefined(); });
    const copy = gate.enter(command("retry"), owner); expect(copy.fresh).toBe(false);
    expect(await gate.replay(copy.ticket, () => owner, () => true)).toEqual({ status: "rejected", error_code: "process_start_failed",
      message: "Original source startup ACK delivery remains unconfirmed; original execution ownership is retained" });
    gate.finishAck(observed, true);
    const late = gate.enter(command("late-retry"), owner); expect(late.fresh).toBe(false);
    expect(await gate.replay(late.ticket, () => owner, () => true)).toEqual(outcome);
  });

  it.each(["accepted", "rejected"] as const)("preserves the actually sent %s ACK when work later throws", async status => {
    const gate = createSourceStartReplay(), owner = scope(), original = gate.enter(command(), owner);
    const outcome: SourceStartOutcome = status === "accepted" ? { status } : { status, error_code: "process_start_failed", message: "Original startup rejection" };
    const failure = new Error("Failure after the original ACK was sent");
    await expect(gate.run(original.ticket, async () => {
      gate.finishAck(gate.observeAck("original", outcome), true); throw failure;
    })).rejects.toBe(failure);
    const copy = gate.enter(command("retry"), owner); expect(copy.fresh).toBe(false);
    expect(await gate.replay(copy.ticket, () => owner, () => true)).toEqual(outcome);
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
    const failure = new Error("Original ACK send failed");
    await expect(gate.run(original.ticket, async () => {
      const observed = gate.observeAck("original", { status: "accepted" }); expect(observed!.outcome.status).toBe("accepted");
      gate.finishAck(observed, false);
      expect(gate.observeAck("original", { status: "rejected", error_code: "process_start_failed", message: "later send error" })).toBeUndefined();
      throw failure;
    })).rejects.toBe(failure);
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

  it.each(["session", "run-stop"])("does not revive a pending replay with a late sent ACK after %s", async variant => {
    const gate = createSourceStartReplay(), owner = scope(), original = gate.enter(command(), owner), send = deferred();
    const work = gate.run(original.ticket, async () => {
      const observed = gate.observeAck("original", { status: "accepted" }); await send.promise; gate.finishAck(observed, true);
    });
    const copy = gate.enter(command("retry"), owner); let current = owner;
    const replay = gate.replay(copy.ticket, () => current, () => true);
    if (variant === "session") current = { ...owner, session: {} }; else gate.stopRun("run");
    send.resolve(); await work;
    expect(await replay).toEqual({ status: "rejected", error_code: "process_start_failed",
      message: "Original source startup is stopped or no longer belongs to this authenticated epoch/session" });
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
