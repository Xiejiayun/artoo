import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApplicationArtifactOwner } from "./application-artifact-admission.js";
import { APPLICATION_QUICKJS_BOOTSTRAP_ID, APPLICATION_QUICKJS_SESSION_LIMITS as limits,
  createApplicationQuickJSSession, type ApplicationQuickJSContext, type ApplicationQuickJSHandle,
  type ApplicationQuickJSModule, type ApplicationQuickJSResult, type ApplicationQuickJSRuntime } from "./application-quickjs-session.js";

// Controlled public-API fixtures only: evalCode below NEVER evaluates its text.
// The fake models 0.32's owned results and its borrowed notAPromise result exactly.
class Handle implements ApplicationQuickJSHandle {
  alive = true; disposals = 0;
  constructor(readonly value: unknown, readonly label: string, readonly borrowed = false) {}
  dispose() { if (this.borrowed || !this.alive) throw Error("wrong handle ownership"); this.disposals++; this.alive = false; }
}
class Fn { constructor(readonly kind: "factory" | "handler" | "receive" | "drain") {} }
interface PromiseValue { readonly promise: true; state: "pending" | "fulfilled" | "rejected" }
class Context implements ApplicationQuickJSContext {
  alive = true; inEval = false; readonly handles: Handle[] = []; readonly undefined = new Handle(undefined, "undefined", true);
  readonly evaluationCalls: { text: string; filename: string; type: string }[] = [];
  readonly receives: string[] = []; readonly queue: unknown[] = [];
  readonly guest = { receive: new Fn("receive"), drain: new Fn("drain"), status: "open" };
  readonly namespace = { handle: new Fn("handler") };
  promise: PromiseValue | undefined; importName: string | undefined; namespaceWithoutHandler = false;
  oversizedDrain = false; oversizedString = false; readCalls = 0; disposalCalls = 0;
  constructor(readonly runtime: Runtime) {}
  new(value: unknown, label = "value"): Handle { const h = new Handle(value, label); this.handles.push(h); return h; }
  evalCode(text: string, filename: string, options: { type: "global" | "module" }) {
    this.evaluationCalls.push({ text, filename, type: options.type });
    if (options.type === "global") return { value: this.new(new Fn("factory"), "factory") };
    this.inEval = true;
    try {
      if (this.importName) {
        const normalized = this.runtime.normalizer!(filename, this.importName, this);
        if (typeof normalized !== "string") return { error: this.new("fixed module failure", "error") };
        const loaded = this.runtime.loader!(normalized, this);
        if (typeof loaded !== "string") return { error: this.new("fixed loader failure", "error") };
      }
      return { value: this.new(this.promise ?? (this.namespaceWithoutHandler ? {} : this.namespace), "evaluation") };
    } finally { this.inEval = false; }
  }
  getPromiseState(handle: ApplicationQuickJSHandle) {
    const h = handle as Handle, value = h.value as PromiseValue | undefined;
    if (!value?.promise) return { type: "fulfilled" as const, value: h, notAPromise: true };
    if (value.state === "pending") return { type: "pending" as const };
    if (value.state === "rejected") return { type: "rejected" as const, error: this.new("private TLA error", "rejection") };
    return { type: "fulfilled" as const, value: this.new(this.namespace, "promise-namespace") };
  }
  typeof(handle: ApplicationQuickJSHandle) { const value = (handle as Handle).value; return value instanceof Fn ? "function" : typeof value; }
  getProp(handle: ApplicationQuickJSHandle, key: string | number) {
    const value = (handle as Handle).value as Record<string | number, unknown>;
    if (this.oversizedString && typeof value === "string" && key === "length") return this.new(2_000_000, "length");
    return this.new(value[key], "property:" + key);
  }
  getNumber(handle: ApplicationQuickJSHandle) { return Number((handle as Handle).value); }
  newString(text: string) { return this.new(text, "input"); }
  callFunction(fn: ApplicationQuickJSHandle, _self: ApplicationQuickJSHandle, ...args: ApplicationQuickJSHandle[]): ApplicationQuickJSResult<Handle> {
    const kind = ((fn as Handle).value as Fn).kind;
    if (kind === "factory") {
      if (!((args[0] as Handle).value instanceof Fn)) throw Error("not guest handler");
      return { value: this.new(this.guest, "guest") };
    }
    if (kind === "receive") {
      const text = (args[0] as Handle).value as string; this.receives.push(text);
      if (JSON.parse(text).kind === "shutdown") this.guest.status = "shutdown";
      return { value: this.new(undefined, "void") };
    }
    if (kind === "drain") return { value: this.new(this.oversizedDrain ? Array(65).fill("{}") : this.queue.splice(0, 64), "drained") };
    throw Error("unexpected call");
  }
  dispose() {
    this.disposalCalls++;
    if (this.inEval) throw Error("disposed inside QuickJS stack");
    if (this.handles.some(h => h.alive)) throw Error("owned handles leaked");
    this.alive = false;
  }
}
class Runtime implements ApplicationQuickJSRuntime {
  alive = true; readonly context = new Context(this); heap = 0; stack = 0; infinite = false;
  readonly jobs: (() => void)[] = []; readonly executeCounts: number[] = [];
  loader: Parameters<ApplicationQuickJSRuntime["setModuleLoader"]>[0] | undefined;
  normalizer: Parameters<ApplicationQuickJSRuntime["setModuleLoader"]>[1] | undefined;
  interrupt: Parameters<ApplicationQuickJSRuntime["setInterruptHandler"]>[0] | undefined;
  jobError = false; badCount = false;
  newContext() { return this.context; }
  setMemoryLimit(bytes: number) { this.heap = bytes; }
  setMaxStackSize(bytes: number) { this.stack = bytes; }
  setInterruptHandler(handler: NonNullable<Runtime["interrupt"]>) { this.interrupt = handler; }
  setModuleLoader(loader: NonNullable<Runtime["loader"]>, normalizer: NonNullable<Runtime["normalizer"]>) { this.loader = loader; this.normalizer = normalizer; }
  hasPendingJob() { return this.jobs.length > 0 || this.infinite || this.jobError || this.badCount; }
  executePendingJobs(count: number): ApplicationQuickJSResult<number> {
    this.executeCounts.push(count);
    if (this.jobError) return { error: this.context.new("private job error", "job-error") };
    if (this.badCount) return { value: 2 };
    const job = this.jobs.shift(); if (job) job(); return { value: job || this.infinite ? 1 : 0 };
  }
  dispose() { if (this.context.alive) throw Error("context must close first"); this.alive = false; }
}
const hash = (value: string | Uint8Array) => "sha256:" + createHash("sha256").update(value).digest("hex");
function artifact() {
  const files = (list: [string, string][]) => list.map(([path, text]) => ({ path, bytes: Buffer.from(text) }));
  const source = files([["product/client/index.html", "<p>fixture</p>"], ["product/server/handler.ts", "// fixture source"], ["product/server/helper.ts", "// helper"]]);
  const artifacts = files([["client/index.html", "<p>fixture</p>"], ["server/handler.js", "// UNEXECUTED PRODUCT FIXTURE"], ["server/helper.js", "// UNEXECUTED HELPER"]]);
  const toolchain = files([[APPLICATION_QUICKJS_BOOTSTRAP_ID, "// UNEXECUTED TRUSTED BOOTSTRAP FIXTURE"]]);
  const pins = (entries: typeof source) => {
    const files = entries.map(f => ({ path: f.path, bytes: f.bytes.length, sha256: hash(f.bytes) })).sort((a, b) => a.path < b.path ? -1 : 1);
    return { files, digest: hash(JSON.stringify(files)) };
  };
  const owner = createApplicationArtifactOwner({ version: 1, source: pins(source), artifacts: pins(artifacts), toolchain: pins(toolchain) });
  return { owner, captured: owner.capture({ source, artifacts, toolchain }) };
}
function fixture(configure: (runtime: Runtime) => void = () => {}) {
  const runtime = new Runtime(), a = artifact(); configure(runtime);
  let time = 0; const binds: unknown[] = [], module: ApplicationQuickJSModule = { newRuntime: () => runtime };
  const boundary = { onRuntime: (value: ApplicationQuickJSRuntime) => { binds.push(value); },
    onContext: (value: ApplicationQuickJSContext) => { binds.push(value); },
    boundedReadString(context: ApplicationQuickJSContext, value: ApplicationQuickJSHandle, maximum: number) {
      expect(context).toBe(runtime.context); runtime.context.readCalls++;
      const text = (value as Handle).value; if (typeof text !== "string" || Buffer.byteLength(text) > maximum) throw Error("bounded fake reader");
      return text;
    } };
  const options = { module, artifactOwner: a.owner, captured: a.captured, boundary, deadline: 1000, now: () => time };
  return { runtime, context: runtime.context, ...a, options, binds, setTime: (value: number) => { time = value; },
    create: () => createApplicationQuickJSSession(options) };
}
const invoke = JSON.stringify({ kind: "invoke", call_id: "call-1", request: { request_id: "request-1", method: "GET", path: "/", query: {}, body: null } });
const response = JSON.stringify({ kind: "response", call_id: "call-1", response: { status: 200, body: { ok: true } } });

describe("bounded session over the actual QuickJS 0.32 public API shape (controlled engine)", () => {
  it("loads fixed bootstrap first and transfers the borrowed synchronous namespace exactly once", () => {
    const f = fixture(), session = f.create();
    expect(session.status.state).toBe("ready"); expect(session.status.qualifiedForProduct).toBe(false);
    expect(f.context.evaluationCalls.map(c => [c.filename, c.type])).toEqual([[APPLICATION_QUICKJS_BOOTSTRAP_ID, "global"], ["server/handler.js", "module"]]);
    expect(f.binds).toEqual([f.runtime, f.context]);
    expect(f.runtime.heap).toBe(limits.heapBytes); expect(f.runtime.stack).toBe(limits.stackBytes);
    const borrowed = f.context.handles.find(h => h.label === "evaluation")!; expect(borrowed.disposals).toBe(1);
    session.close(); session.close(); expect(session.status.guestDisposed).toBe(true);
    expect(f.context.handles.every(h => h.disposals === 1)).toBe(true); expect(f.context.undefined.disposals).toBe(0);
    expect(f.context.disposalCalls).toBe(1); expect(f.runtime.alive).toBe(false);
  });
  it("waits for TLA and frees the Promise plus newly owned namespace separately", () => {
    const f = fixture(runtime => { runtime.context.promise = { promise: true, state: "pending" };
      runtime.jobs.push(() => { runtime.context.promise!.state = "fulfilled"; }); });
    const session = f.create(); expect(session.status.state).toBe("initializing");
    expect(session.pump()).toMatchObject({ state: "ready", jobs: 1 }); expect(f.runtime.executeCounts).toEqual([1]);
    expect(f.context.handles.find(h => h.label === "evaluation")!.disposals).toBe(1);
    expect(f.context.handles.find(h => h.label === "promise-namespace")!.disposals).toBe(1);
    session.close(); expect(session.status.guestDisposed).toBe(true);
  });
  it("does not reinterpret idle unresolved TLA as ready or renew its original deadline", () => {
    const f = fixture(r => { r.context.promise = { promise: true, state: "pending" }; }), session = f.create();
    expect(session.pump().state).toBe("initializing"); f.setTime(999); expect(session.pump().state).toBe("initializing");
    f.setTime(1000); expect(() => session.pump()).toThrow("deadline");
    expect(session.status).toMatchObject({ state: "failed", guestDisposed: true });
  });
  it("disposes TLA rejection without stringifying its product error", () => {
    const f = fixture(r => { r.context.promise = { promise: true, state: "rejected" }; });
    expect(f.create).toThrow("guest"); expect(f.context.readCalls).toBe(0);
    expect(f.context.handles.find(h => h.label === "rejection")!.disposals).toBe(1); expect(f.runtime.alive).toBe(false);
  });
  it("owns a newly returned Promise result even when the deadline expires during inspection", () => {
    const f = fixture(r => { r.context.promise = { promise: true, state: "pending" }; }), session = f.create();
    const original = f.context.getPromiseState.bind(f.context);
    f.context.getPromiseState = handle => { f.context.promise!.state = "fulfilled"; const value = original(handle); f.setTime(1000); return value; };
    expect(() => session.pump()).toThrow("deadline");
    expect(f.context.handles.find(h => h.label === "promise-namespace")!.disposals).toBe(1);
    expect(session.status.guestDisposed).toBe(true);
  });
  it("admits only original captured relative modules", () => {
    const f = fixture(r => { r.context.importName = "./helper.js"; }), session = f.create();
    expect(session.status.state).toBe("ready"); session.close();
    for (const name of ["node:fs", "std", "https://example.com/a.js", "../../outside.js", "./missing.js", APPLICATION_QUICKJS_BOOTSTRAP_ID]) {
      const rejected = fixture(r => { r.context.importName = name; }); expect(rejected.create).toThrow();
      expect(rejected.context.disposalCalls).toBe(1); expect(rejected.runtime.alive).toBe(false);
    }
  });
  it("rejects modules after capture revocation without disposing inside loader callbacks", () => {
    const f = fixture(), session = f.create(); f.owner.revoke(f.captured);
    const result = f.runtime.loader!("server/helper.js", f.context); expect(typeof result).toBe("object");
    expect(f.runtime.alive).toBe(true); expect(() => session.pump()).toThrow("module"); expect(f.runtime.alive).toBe(false);
  });
  it("rejects a loader call associated with another context", () => {
    const f = fixture(), session = f.create();
    expect(typeof f.runtime.normalizer!("server/handler.js", "./helper.js", new Runtime().context)).toBe("object");
    expect(() => session.pump()).toThrow("module");
  });
  it("rejects a module without its guest-local handle export", () => {
    const f = fixture(r => { r.context.namespaceWithoutHandler = true; }); expect(f.create).toThrow("guest");
    expect(f.runtime.alive).toBe(false);
  });
  it("never drains more than positive one-job slices and fails the lifetime job limit", () => {
    const f = fixture(r => { r.infinite = true; }), session = f.create();
    expect(session.pump().jobs).toBe(limits.jobsPerPump);
    for (let i = 1; i < limits.jobs / limits.jobsPerPump; i++) session.pump();
    expect(() => session.pump()).toThrow("jobs"); expect(f.runtime.executeCounts.every(n => n === 1)).toBe(true);
    expect(session.status.guestDisposed).toBe(true);
  });
  it.each(["jobError", "badCount"] as const)("fails closed on %s", key => {
    const f = fixture(r => { r[key] = true; }), session = f.create(); expect(() => session.pump()).toThrow();
    expect(f.runtime.alive).toBe(false);
  });
  it("detects elapsed time inside a job before any successful output", () => {
    const f = fixture(), session = f.create(); f.runtime.jobs.push(() => f.setTime(1000));
    expect(() => session.pump()).toThrow("deadline"); expect(() => session.drain()).toThrow();
  });
  it("rejects backwards clocks and interrupts the original runtime only", () => {
    const f = fixture(), session = f.create(); f.setTime(100); session.pump(); f.setTime(99);
    expect(f.runtime.interrupt!(f.runtime)).toBe(true); expect(() => session.pump()).toThrow("owner");
    const g = fixture(), other = g.create(); expect(g.runtime.interrupt!(new Runtime())).toBe(true);
    expect(() => other.pump()).toThrow("owner");
  });
  it("passes primitive input and bounded output JSON through the existing wire contract", () => {
    const f = fixture(), session = f.create(); session.receive(invoke); expect(f.context.receives).toEqual([invoke]);
    f.context.queue.push(response); expect(session.drain()).toEqual([response]);
    expect(f.context.handles.filter(h => ["input", "drained"].includes(h.label)).every(h => !h.alive)).toBe(true);
    session.receive('{"kind":"shutdown"}'); expect(session.status).toMatchObject({ state: "closed", guestDisposed: true });
    expect(() => session.receive(invoke)).toThrow("closed");
  });
  it.each(["null", '{"kind":"invoke"}', '{"kind":"cancel","call_id":"x","authority":"write"}'])("rejects malformed input %s", text => {
    const f = fixture(), session = f.create(); expect(() => session.receive(text)).toThrow("input");
    expect(f.context.receives).toEqual([]); expect(session.status.guestDisposed).toBe(true);
  });
  it("rejects a receive while TLA is pending", () => {
    const f = fixture(r => { r.context.promise = { promise: true, state: "pending" }; }), session = f.create();
    expect(() => session.receive(invoke)).toThrow("input"); expect(session.status.guestDisposed).toBe(true);
  });
  it("bounds drained list length and primitive string length before raw decoding", () => {
    const f = fixture(), session = f.create(); f.context.oversizedDrain = true;
    expect(() => session.drain()).toThrow("output"); expect(session.status.guestDisposed).toBe(true);
    const g = fixture(), other = g.create(), reads = g.context.readCalls;
    g.context.queue.push(response); g.context.oversizedString = true;
    expect(() => other.drain()).toThrow("output"); expect(g.context.readCalls).toBe(reads);
  });
  it("rejects a bounded C-string read that truncates at an embedded NUL", () => {
    const f = fixture(), original = f.options.boundary.boundedReadString;
    f.options.boundary.boundedReadString = (context, handle, maximum) => original(context, handle, maximum).split("\0")[0]!;
    const session = f.create(); f.context.queue.push(response + "\0private suffix");
    expect(() => session.drain()).toThrow("output"); expect(session.status.guestDisposed).toBe(true);
  });
  it.each(["null", '{"kind":"response","call_id":"call-1","response":{"status":302,"body":null}}'])("rejects invalid drained output %s", text => {
    const f = fixture(), session = f.create(); f.context.queue.push(text); expect(() => session.drain()).toThrow("output");
  });
  it("does not revive a closed session or reuse a module for another session", () => {
    const f = fixture(), session = f.create(); session.close(); expect(() => session.pump()).toThrow("closed");
    expect(f.create).toThrow("owner"); expect(session.status.qualifiedForProduct).toBe(false);
  });
  it("never upgrades uncertain handle cleanup after repeated close calls", () => {
    const f = fixture(), session = f.create();
    const retained = f.context.handles.find(handle => handle.label === "property:receive")!;
    retained.dispose = () => { throw Error("unconfirmed handle release"); };
    // Actual primitive-pointer leaks need not prevent their parent scopes from
    // closing. Model that narrower case without claiming a real interpreter run.
    f.context.dispose = () => { f.context.disposalCalls++; f.context.alive = false; };
    session.close(); expect(retained.alive).toBe(true); expect(f.runtime.alive).toBe(false);
    expect(session.status).toMatchObject({ state: "failed", failure: "dispose", guestDisposed: false });
    session.close(); session.close();
    expect(session.status).toMatchObject({ state: "failed", failure: "dispose", guestDisposed: false });
  });
  it("caps repeated idle pumps independently of elapsed time", () => {
    const f = fixture(), session = f.create();
    for (let count = 1; count < limits.operations; count++) session.pump();
    expect(() => session.pump()).toThrow("operations"); expect(session.status.guestDisposed).toBe(true);
  });
});
