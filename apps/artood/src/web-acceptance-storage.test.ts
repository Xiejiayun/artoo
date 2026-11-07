import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import type { ProductBrowserStepV3, ProductStorageChecksV1, StorageFaultModeV1 } from "@artoo/domain";
import { createStorageFaultController } from "./web-acceptance-storage.js";
import { nativeStorageSnapshotV1, STORAGE_FAULT_INITIALIZER_SOURCE, STORAGE_FAULT_INITIALIZER_DIGEST } from "./web-acceptance-storage-source.js";

const origin = "http://127.0.0.1:23456";
const navigate: ProductBrowserStepV3 = { action: "navigate", page: "main", path: "/" };
const assertion: ProductBrowserStepV3 = { action: "assert_text", page: "main", selector: "#error", text: "Could not save" };
const check = (start = 0, end = 1, mode: StorageFaultModeV1 = "write-quota", id = "fault") => ({ id, page: "main" as const, mode,
  arm_before_step: start, settle_after_step: end, requirement_criteria: [{ requirement_id: "save", criterion_index: 0 }],
  ui_assertion_steps: [end], min_hits: 1 as const, native_storage: { scope: "all" as const, comparison: "sampled-equal" as const } });
type Counts = { installed: boolean; mode: string; read_hits: number; write_hits: number; controls: number };

/** Protocol seam only: these tests do not claim a native Chromium acceptance result. */
class Session extends EventEmitter {
  log: string[] = []; calls: { method: string; params: Record<string, any> }[] = [];
  entries: [string, string][] = []; closed = false; pageClosed = false; contextId = 0; returned = 0;
  source = STORAGE_FAULT_INITIALIZER_SOURCE; counts = new Map<string, Counts>(); results = new Map<string, Counts>();
  onResume?: () => void; malformedProperty = false; invalidInitial = false; missingRegistration = false;
  announceBlankDuringSetup = true;
  async send(method: string, params: Record<string, any> = {}): Promise<any> {
    this.calls.push({ method, params }); this.log.push(method);
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.enable") {
      if (this.announceBlankDuringSetup) this.emit("Page.frameNavigated", { frame: { id: "main", url: "about:blank" } });
      return {};
    }
    if (["Runtime.enable", "Debugger.enable", "DOMStorage.enable", "Runtime.releaseObject"].includes(method)) return {};
    if (method === "Page.addScriptToEvaluateOnNewDocument") return this.missingRegistration ? {} : { identifier: "registered" };
    if (method === "DOMStorage.getDOMStorageItems") return { entries: structuredClone(this.entries) };
    if (method === "Debugger.getScriptSource") return { scriptSource: this.source };
    if (method === "Debugger.evaluateOnCallFrame") {
      const handle = `controller-${this.contextId}`;
      this.counts.set(handle, { installed: !this.invalidInitial, mode: "none", read_hits: 0, write_hits: 0, controls: 0 });
      return { result: { type: "function", objectId: handle } };
    }
    if (method === "Runtime.callFunctionOn") {
      const counts = this.counts.get(params.objectId); if (!counts) throw new Error("Execution context was destroyed");
      const operation = params.arguments[0].value;
      if (operation === "arm") { counts.mode = params.arguments[1].value; counts.controls++; }
      const objectId = `result-${++this.returned}`; this.results.set(objectId, { ...counts });
      return { result: { type: "object", objectId } };
    }
    if (method === "Runtime.getProperties") return { result: Object.entries(this.results.get(params.objectId)!).map(([name, value]) => ({
      name, enumerable: true, isOwn: true, ...(this.malformedProperty && name === "read_hits" ? { get: { type: "function" } } : {}),
      value: { type: typeof value, value },
    })) };
    if (method === "Debugger.resume") { this.onResume?.(); return {}; }
    throw new Error(`Unexpected controlled CDP command ${method}`);
  }
  document(overrides: { frameId?: string; isDefault?: boolean; origin?: string; missingMetadata?: boolean } = {}) {
    this.log.push("actual-navigation");
    this.counts.clear(); this.emit("Runtime.executionContextsCleared"); this.contextId++;
    this.emit("Page.frameNavigated", { frame: { id: "main", url: `${origin}/` } });
    this.emit("Runtime.executionContextCreated", { context: { id: this.contextId, uniqueId: `epoch-${this.contextId}`,
      origin: overrides.origin ?? origin, auxData: { frameId: overrides.frameId ?? "main", isDefault: overrides.isDefault ?? true } } });
    if (!overrides.missingMetadata) this.emit("Debugger.scriptParsed", { scriptId: `script-${this.contextId}`, executionContextId: this.contextId });
    this.pause();
  }
  pause() { this.emit("Debugger.paused", { callFrames: [{ callFrameId: "paused", location: { scriptId: `script-${this.contextId}` } }] }); }
  hit() {
    const counts = this.counts.get(`controller-${this.contextId}`)!;
    if (counts.mode === "read-security") counts.read_hits++;
    if (counts.mode === "write-quota") counts.write_hits++;
  }
  mutate() { this.emit("DOMStorage.domStorageItemUpdated", { storageId: { securityOrigin: origin, isLocalStorage: true }, key: "committed" }); }
  dispose() { this.pageClosed = true; this.emit("Runtime.executionContextsCleared"); this.closed = true; this.emit("close"); }
  async detach() { this.closed = true; this.emit("close"); }
}
async function fixture(steps: ProductBrowserStepV3[] = [navigate, assertion], windows = [check()]) {
  const session = new Session(), page = { url: () => "about:blank", isClosed: () => session.pageClosed,
    context: () => ({ newCDPSession: async () => session }) } as unknown as Page;
  const checks: ProductStorageChecksV1 = { version: 1, windows };
  const controller = await createStorageFaultController(page, origin, steps, checks, 500);
  return { session, controller, checks, async navigate(index = 0, overrides: Parameters<Session["document"]>[0] = {}) {
    await controller.beforeStep(index); session.document(overrides); await controller.afterStep(index);
  }, async step(index: number) { await controller.beforeStep(index); await controller.afterStep(index); },
  async close(failing = false) {
    if (failing) await expect(controller.prepareContextClose()).rejects.toThrow(); else await controller.prepareContextClose();
    session.dispose();
    if (failing) await expect(controller.close()).rejects.toThrow(); else await controller.close();
  } };
}

describe("bounded native storage snapshots", () => {
  it("sorts exact native key/value pairs and counts UTF-8 bytes without exposing entries in the summary", () => {
    const snapshot = nativeStorageSnapshotV1([["z", "中文"], ["a", ""]]);
    expect(snapshot.entries).toEqual([["a", ""], ["z", "中文"]]); expect(snapshot.summary).toMatchObject({ key_count: 2, utf8_bytes: 8 });
    expect(snapshot.summary).not.toHaveProperty("entries");
    expect(snapshot.summary.digest).toBe(nativeStorageSnapshotV1([["a", ""], ["z", "中文"]]).summary.digest);
  });
  it.each([[["same", "one"], ["same", "two"]], [["key", 1]], [["key", "value", "extra"]],
    Array.from({ length: 513 }, (_, i) => [`${i}`, ""]), [["key", "x".repeat(1048576)]]].map(entries => ({ entries })))("rejects malformed, duplicate or oversized native snapshots", ({ entries }) => {
    expect(() => nativeStorageSnapshotV1(entries)).toThrow();
  });
});

describe("private storage-fault controller (controlled CDP seam)", () => {
  it.each(["read-security", "write-quota"] as const)("arms %s before the first product script resumes and measures actual fresh hits", async mode => {
    const f = await fixture([navigate, assertion], [check(0, 1, mode)]);
    f.session.onResume = () => { expect(f.session.counts.get("controller-1")!.mode).toBe(mode); f.session.hit(); };
    await f.navigate(); await f.step(1);
    const trace = await f.controller.finish();
    expect(trace.windows[0]).toMatchObject({ baseline_phase: "first-document-paused", document_epoch: 1,
      installation: { script_digest: STORAGE_FAULT_INITIALIZER_DIGEST, confirmed: true },
      sequence: ["baseline", "armed", "settled", "disarmed"], hits: { baseline: 0, final: 1, delta: 1 },
      native_storage: { before: { key_count: 0 }, after: { key_count: 0 }, equal: true }, events: { coverage: "observed-only", observed_mutations: 0 } });
    const commands = f.session.calls;
    expect(commands.find(call => call.method === "Page.addScriptToEvaluateOnNewDocument")!.params.source).toBe(STORAGE_FAULT_INITIALIZER_SOURCE);
    expect(commands.findIndex(call => call.method === "DOMStorage.getDOMStorageItems")).toBeLessThan(commands.findIndex(call => call.method === "Debugger.resume"));
    expect(commands.filter(call => call.method === "Runtime.callFunctionOn").every(call => call.params.functionDeclaration === "function(operation,value){return this(operation,value);}")).toBe(true);
    await f.close();
  });
  it("samples a reload baseline before leaving the old document and binds fresh hits to the new epoch", async () => {
    const steps: ProductBrowserStepV3[] = [navigate, { action: "click", page: "main", selector: "#save" }, { action: "reload", page: "main" }, assertion];
    const f = await fixture(steps, [check(2, 3)]);
    await f.navigate(); await f.controller.beforeStep(1); f.session.entries = [["committed", "saved"]]; f.session.mutate(); await f.controller.afterStep(1);
    await f.controller.beforeStep(2);
    const beforeNavigation = f.session.log.lastIndexOf("DOMStorage.getDOMStorageItems");
    f.session.onResume = () => f.session.hit(); f.session.document(); await f.controller.afterStep(2); await f.step(3);
    const trace = await f.controller.finish();
    expect(beforeNavigation).toBeLessThan(f.session.log.lastIndexOf("actual-navigation"));
    expect(trace.windows[0]).toMatchObject({ baseline_phase: "before-step", document_epoch: 2,
      hits: { baseline: 0, final: 1, delta: 1 }, native_storage: { before: { key_count: 1 }, after: { key_count: 1 } } });
    expect(f.session.calls.filter(call => call.method === "DOMStorage.getDOMStorageItems")).toHaveLength(2);
    await f.close();
  });
  it("rejects unload deletion instead of replacing its earlier baseline with the new document's storage", async () => {
    const f = await fixture([navigate, { action: "reload", page: "main" }, assertion], [check(1, 2)]);
    await f.navigate(); f.session.entries = [["committed", "saved"]]; await f.controller.beforeStep(1);
    f.session.entries = []; f.session.mutate(); f.session.document();
    await expect(f.controller.afterStep(1)).rejects.toThrow("mutation"); await f.close(true);
  });
  it("rejects unequal native samples even without a delivered mutation event", async () => {
    const f = await fixture(); await f.navigate(); f.session.hit(); f.session.entries = [["bypass", "written"]];
    await f.controller.beforeStep(1); await expect(f.controller.afterStep(1)).rejects.toThrow("snapshots differ");
    await f.controller.prepareContextClose(); f.session.dispose(); await f.controller.close();
  });
  it("rejects an observed write-then-restore even when both sampled values are equal", async () => {
    const f = await fixture(); await f.navigate(); f.session.hit(); f.session.entries = [["temporary", "change"]]; f.session.mutate(); f.session.entries = []; f.session.mutate();
    await expect(f.controller.beforeStep(1)).rejects.toThrow("mutation"); await f.close(true);
  });
  it("requires a fresh hit in each window instead of reusing the first window's count", async () => {
    const f = await fixture([navigate, assertion, { action: "click", page: "main", selector: "#retry" }, assertion], [check(0, 1), check(2, 3, "write-quota", "again")]);
    await f.navigate(); f.session.hit(); await f.step(1); await f.step(2);
    await f.controller.beforeStep(3); await expect(f.controller.afterStep(3)).rejects.toThrow("fresh fault hit");
    await f.controller.prepareContextClose(); f.session.dispose(); await f.controller.close();
  });
  it.each([{ frameId: "iframe" }, { isDefault: false }, { origin: "https://example.com" }, { missingMetadata: true }])("rejects untrusted paused context metadata %j", async overrides => {
    const f = await fixture(); await f.controller.beforeStep(0); f.session.document(overrides);
    await expect(f.controller.afterStep(0)).rejects.toThrow(/authorized|context/); await f.close(true);
  });
  it("rejects identical-source duplicate pauses without obtaining or replacing another controller handle", async () => {
    const f = await fixture(); await f.navigate(); const admittedCalls = f.session.calls.filter(call => call.method === "Debugger.evaluateOnCallFrame").length;
    f.session.pause(); await expect(f.controller.beforeStep(1)).rejects.toThrow("duplicate debugger pause");
    expect(f.session.calls.filter(call => call.method === "Debugger.evaluateOnCallFrame")).toHaveLength(admittedCalls); await f.close(true);
  });
  it("rejects a previous document's identical source while a new navigation is pending", async () => {
    const f = await fixture([navigate, { action: "reload", page: "main" }, assertion], [check(1, 2)]);
    await f.navigate(); await f.controller.beforeStep(1); f.session.pause();
    await expect(f.controller.afterStep(1)).rejects.toThrow("authorized"); await f.close(true);
  });
  it.each(["source", "initial", "properties"])("fails closed on a malformed %s observation", async kind => {
    const f = await fixture();
    if (kind === "source") f.session.source = "debugger;";
    if (kind === "initial") f.session.invalidInitial = true;
    if (kind === "properties") f.session.malformedProperty = true;
    await expect(f.navigate()).rejects.toThrow(/source|installation|non-data/); await f.close(true);
  });
  it("keeps document guards alive after finish, including during actual context closure", async () => {
    const f = await fixture(); await f.navigate(); f.session.hit(); await f.step(1); await f.controller.finish();
    await f.controller.prepareContextClose(); f.session.document(); f.session.dispose();
    await expect(f.controller.close()).rejects.toThrow(/explicit navigation|unauthorized|Unexpected/);
  });
  it("rejects spontaneous document changes outside an active window", async () => {
    const f = await fixture([navigate, { action: "click", page: "main", selector: "#save" }, assertion], [check(1, 2)]);
    await f.navigate(); f.session.document(); await expect(f.controller.beforeStep(1)).rejects.toThrow(/explicit navigation|unauthorized/); await f.close(true);
  });
  it("rejects event overflow and a disconnected measurement session", async () => {
    const overflow = await fixture([navigate, { action: "click", page: "main", selector: "#save" }, assertion], [check(1, 2)]);
    await overflow.navigate(); for (let i = 0; i < 513; i++) overflow.session.mutate();
    await expect(overflow.controller.beforeStep(1)).rejects.toThrow("case bound"); await overflow.close(true);
    const disconnected = await fixture(); await disconnected.navigate(); disconnected.session.emit("close");
    await expect(disconnected.controller.beforeStep(1)).rejects.toThrow("disconnected"); await disconnected.close(true);
  });
});
