import { EventEmitter } from "node:events";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import type { ProductBrowserProgramV3, ProductBrowserStepV3, ProductStorageChecksV1, ProductStoragePreconditionBindingV1 } from "@artoo/domain";
import { createStoragePreconditionController } from "./web-acceptance-storage.js";
import { STORAGE_FAULT_INITIALIZER_SOURCE, nativeStorageSnapshotV1 } from "./web-acceptance-storage-source.js";
import { canonicalWebAcceptance as canonical, webAcceptanceDigest as sha } from "./web-acceptance-identity.js";
import { deriveStoragePreconditionExpectation } from "./web-acceptance-precondition.js";

const origin = "http://127.0.0.1:23456", digest = "sha256:" + "a".repeat(64);
const navigate: ProductBrowserStepV3 = { action: "navigate", page: "main", path: "/" };
const assertion: ProductBrowserStepV3 = { action: "assert_text", page: "main", selector: "#error", text: "Invalid document" };
const refs = [{ requirement_id: "malformed", criterion_index: 0 }];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const source = { path: ".artoo/product/design.json" as const, checksum: sha("controlled design bytes"), size: 23, case_id: "malformed" };
function binding(preserve = false): ProductStoragePreconditionBindingV1 {
  return { source, precondition: { version: 1, local_storage: { key: "journal.document", value: '{invalid \n raw "data"' },
    requirement_criteria: refs, ui_assertion_steps: [1], ...(preserve ? { preservation_checks: [{ after_step: 1,
      requirement_criteria: refs, ui_assertion_steps: [1] }] } : {}) } };
}

/** Controlled CDP seam only; these tests do not establish native-browser or product acceptance. */
class Session extends EventEmitter {
  entries: [string, string][] = []; calls: { method: string; params: any }[] = [];
  source = STORAGE_FAULT_INITIALIZER_SOURCE; pageClosed = false; contextId = 0; resumed = 0;
  counts = new Map<string, { installed: true; mode: string; read_hits: number; write_hits: number; controls: number }>();
  results = new Map<string, object>(); returned = 0; readCount = 0;
  writeEntered = deferred(); readbackEntered = deferred(); writeGate?: ReturnType<typeof deferred>; readbackGate?: ReturnType<typeof deferred>;
  delayEvent = false; corruptReadback = false; pendingSeed?: { key: string; value: string }; onResume?: () => void;
  async send(method: string, params: any = {}): Promise<any> {
    this.calls.push({ method, params: structuredClone(params) });
    if (method === "Page.enable") { this.emit("Page.frameNavigated", { frame: { id: "main", url: "about:blank" } }); return {}; }
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", url: "about:blank" } } };
    if (["Runtime.enable", "Debugger.enable", "DOMStorage.enable", "Runtime.releaseObject"].includes(method)) return {};
    if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "registered-main-only" };
    if (method === "DOMStorage.setDOMStorageItem") {
      this.writeEntered.resolve(); if (this.writeGate) await this.writeGate.promise;
      if (this.pageClosed) throw new Error("Controlled target already closed");
      this.entries = [[params.key, this.corruptReadback ? "substituted" : params.value]]; this.pendingSeed = { key: params.key, value: params.value };
      if (!this.delayEvent) this.deliverSeedEvent(); return {};
    }
    if (method === "DOMStorage.getDOMStorageItems") {
      if (++this.readCount === 2) { this.readbackEntered.resolve(); if (this.readbackGate) await this.readbackGate.promise; }
      return { entries: structuredClone(this.entries) };
    }
    if (method === "Debugger.getScriptSource") return { scriptSource: this.source };
    if (method === "Debugger.evaluateOnCallFrame") {
      const handle = "controller-" + this.contextId;
      this.counts.set(handle, { installed: true, mode: "none", read_hits: 0, write_hits: 0, controls: 0 });
      return { result: { type: "function", objectId: handle } };
    }
    if (method === "Runtime.callFunctionOn") {
      const counts = this.counts.get(params.objectId); if (!counts) throw new Error("Destroyed context");
      if (params.arguments[0].value === "arm") { counts.mode = params.arguments[1].value; counts.controls++; }
      const objectId = "result-" + ++this.returned; this.results.set(objectId, { ...counts });
      return { result: { type: "object", objectId } };
    }
    if (method === "Runtime.getProperties") return { result: Object.entries(this.results.get(params.objectId)!).map(([name, value]) => ({
      name, enumerable: true, isOwn: true, value: { type: typeof value, value } })) };
    if (method === "Debugger.resume") { this.resumed++; this.onResume?.(); return {}; }
    throw new Error("Unexpected controlled CDP command " + method);
  }
  deliverSeedEvent(overrides: object = {}) {
    if (!this.pendingSeed) throw new Error("No controlled seed write");
    this.emit("DOMStorage.domStorageItemAdded", { storageId: { securityOrigin: origin, isLocalStorage: true },
      key: this.pendingSeed.key, newValue: this.pendingSeed.value, ...overrides });
  }
  document() {
    this.counts.clear(); this.emit("Runtime.executionContextsCleared"); this.contextId++;
    this.emit("Page.frameNavigated", { frame: { id: "main", url: origin + "/" } });
    this.emit("Runtime.executionContextCreated", { context: { id: this.contextId, uniqueId: "epoch-" + this.contextId, origin,
      auxData: { frameId: "main", isDefault: true } } });
    this.emit("Debugger.scriptParsed", { scriptId: "script-" + this.contextId, executionContextId: this.contextId }); this.pause();
  }
  pause() { this.emit("Debugger.paused", { callFrames: [{ callFrameId: "paused", location: { scriptId: "script-" + this.contextId } }] }); }
  hit() { const counts = this.counts.get("controller-" + this.contextId)!;
    if (counts.mode === "read-security") counts.read_hits++; if (counts.mode === "write-quota") counts.write_hits++; }
  productWrite(value: string) { this.entries = [["journal.document", value]];
    this.emit("DOMStorage.domStorageItemUpdated", { storageId: { securityOrigin: origin, isLocalStorage: true }, key: "journal.document", newValue: value }); }
  dispose() { this.pageClosed = true; this.emit("Runtime.executionContextsCleared"); this.emit("close"); }
  async detach() { this.emit("close"); }
}
async function fixture(input = binding(), steps: ProductBrowserStepV3[] = [navigate, assertion], checks?: ProductStorageChecksV1, timeout = 100) {
  const session = new Session();
  const page = { url: () => "about:blank", isClosed: () => session.pageClosed,
    context: () => ({ newCDPSession: async () => session }) } as unknown as Page;
  const program: ProductBrowserProgramV3 = { version: 3, contract_digest: digest, steps };
  const controller = await createStoragePreconditionController(page, origin, steps, input, sha(canonical(program)), timeout, checks);
  return { session, controller, program, input, async navigate(index = 0) {
    await controller.beforeStep(index); session.document(); await controller.afterStep(index);
  }, async step(index: number) { await controller.beforeStep(index); await controller.afterStep(index); },
  async close(failed = false) {
    controller.abortPending();
    if (failed) await expect(controller.prepareContextClose()).rejects.toThrow(); else await controller.prepareContextClose();
    session.dispose(); expect(session.pageClosed).toBe(true);
    if (failed) await expect(controller.close()).rejects.toThrow(); else await controller.close();
  } };
}

describe("native precondition lifecycle (controlled CDP seam)", () => {
  it("writes raw data while paused and confirms native readback before resume without interpolating fixture source", async () => {
    const f = await fixture(binding(true));
    f.session.onResume = () => expect(f.session.entries).toEqual([[f.input.precondition.local_storage.key, f.input.precondition.local_storage.value]]);
    await f.navigate(); await f.step(1); const actual = (await f.controller.finish()).storage_precondition!;
    const { origin: _origin, installation, sequence: _sequence, ...facts } = actual;
    expect({ ...facts, installation_script_digest: installation.script_digest }).toEqual(deriveStoragePreconditionExpectation(f.input, f.program));
    const calls = f.session.calls, write = calls.findIndex(call => call.method === "DOMStorage.setDOMStorageItem");
    expect(calls[write]!.params).toEqual({ storageId: { securityOrigin: origin, isLocalStorage: true }, ...f.input.precondition.local_storage });
    expect(calls.slice(0, write).some(call => call.method === "DOMStorage.getDOMStorageItems")).toBe(true);
    expect(calls.slice(write + 1).findIndex(call => call.method === "DOMStorage.getDOMStorageItems")).toBeLessThan(
      calls.slice(write + 1).findIndex(call => call.method === "Debugger.resume"));
    expect(calls.find(call => call.method === "Page.addScriptToEvaluateOnNewDocument")!.params.source).toBe(STORAGE_FAULT_INITIALIZER_SOURCE);
    expect(actual).not.toHaveProperty("local_storage");
    expect(JSON.stringify(actual)).not.toContain(JSON.stringify(f.input.precondition.local_storage.value).slice(1, -1)); await f.close();
  });
  it("waits for the exact seed event even when acknowledgement and readback arrived first", async () => {
    const f = await fixture(); f.session.delayEvent = true;
    await f.controller.beforeStep(0); f.session.document(); const advanced = f.controller.afterStep(0);
    await f.session.readbackEntered.promise; expect(f.session.resumed).toBe(0); f.session.deliverSeedEvent();
    await advanced; await f.step(1); await f.controller.finish(); expect(f.session.resumed).toBe(1); await f.close();
  });
  it.each(["nonempty", "readback", "source", "wrong-origin", "duplicate-event", "missing-event"])("fails closed on %s without resuming product code", async issue => {
    const f = await fixture();
    if (issue === "nonempty") f.session.entries = [["existing", "preserved"]];
    if (issue === "readback") f.session.corruptReadback = true;
    if (issue === "source") f.session.source = "copied initializer";
    if (["wrong-origin", "duplicate-event", "missing-event"].includes(issue)) f.session.delayEvent = true;
    await f.controller.beforeStep(0); f.session.document(); const rejected = expect(f.controller.afterStep(0)).rejects.toThrow();
    if (["wrong-origin", "duplicate-event"].includes(issue)) {
      await f.session.readbackEntered.promise;
      if (issue === "wrong-origin") f.session.deliverSeedEvent({ storageId: { securityOrigin: "http://127.0.0.1:9999", isLocalStorage: true } });
      else { f.session.deliverSeedEvent(); f.session.deliverSeedEvent(); }
    }
    await rejected; expect(f.session.resumed).toBe(0);
    if (["nonempty", "source"].includes(issue)) expect(f.session.calls.some(call => call.method === "DOMStorage.setDOMStorageItem")).toBe(false);
    await f.close(true);
  });
  it.each(["write", "readback"])("rejects late %s completion after the synchronous cleanup latch", async phase => {
    const f = await fixture(); const gate = deferred();
    if (phase === "write") f.session.writeGate = gate; else f.session.readbackGate = gate;
    await f.controller.beforeStep(0); f.session.document(); const rejected = expect(f.controller.afterStep(0)).rejects.toThrow(/clos/);
    await (phase === "write" ? f.session.writeEntered.promise : f.session.readbackEntered.promise);
    f.controller.abortPending(); gate.resolve(); await rejected;
    expect(f.session.resumed).toBe(0); await f.close(true);
  });
  it("does not resume the first admission when a duplicate pause arrives during a delayed write", async () => {
    const f = await fixture(); f.session.writeGate = deferred();
    await f.controller.beforeStep(0); f.session.document(); const rejected = expect(f.controller.afterStep(0)).rejects.toThrow();
    await f.session.writeEntered.promise; f.session.pause(); f.session.writeGate.resolve(); await rejected;
    expect(f.session.resumed).toBe(0); await f.close(true);
  });
  it("never seeds again after product Reset and explicit main reload", async () => {
    const steps: ProductBrowserStepV3[] = [navigate, assertion, { action: "click", page: "main", selector: "#reset" },
      { action: "reload", page: "main" }, assertion];
    const f = await fixture(binding(), steps); await f.navigate(); await f.step(1);
    await f.controller.beforeStep(2); f.session.productWrite('{"entries":[]}'); await f.controller.afterStep(2);
    await f.navigate(3); await f.step(4); const result = await f.controller.finish();
    expect(f.session.entries).toEqual([["journal.document", '{"entries":[]}']]);
    expect(f.session.calls.filter(call => call.method === "DOMStorage.setDOMStorageItem")).toHaveLength(1);
    expect(result.storage_precondition!.seed_apply_count).toBe(1); await f.close();
  });
  it("lets the existing controlled peer lifecycle change data without installing a peer seed or incrementing main epoch", async () => {
    const steps: ProductBrowserStepV3[] = [navigate, assertion, { action: "open_page", page: "peer", path: "/" },
      { action: "click", page: "peer", selector: "#reset" }, { action: "reload", page: "peer" },
      { action: "close_page", page: "peer" }, { action: "click", page: "main", selector: "#retry" }, assertion];
    const f = await fixture(binding(), steps); await f.navigate(); await f.step(1); await f.step(2);
    await f.controller.beforeStep(3); f.session.productWrite('{"entries":[]}'); await f.controller.afterStep(3);
    for (const index of [4, 5, 6, 7]) await f.step(index); const result = await f.controller.finish();
    expect(result.storage_precondition!.document_epoch).toBe(1); expect(f.session.contextId).toBe(1);
    expect(f.session.calls.filter(call => call.method === "Page.addScriptToEvaluateOnNewDocument")).toHaveLength(1);
    expect(f.session.calls.filter(call => call.method === "DOMStorage.setDOMStorageItem")).toHaveLength(1); await f.close();
  });
  it("uses seeded bytes as the fault baseline and preserves the old mutation rejection", async () => {
    const checks: ProductStorageChecksV1 = { version: 1, windows: [{ id: "fail-reset", page: "main", mode: "write-quota",
      arm_before_step: 0, settle_after_step: 1, requirement_criteria: refs, ui_assertion_steps: [1], min_hits: 1,
      native_storage: { scope: "all", comparison: "sampled-equal" } }] };
    const f = await fixture(binding(true), [navigate, assertion], checks); f.session.onResume = () => f.session.hit();
    await f.navigate(); await f.step(1); const result = await f.controller.finish();
    expect(result.storage_fault!.windows[0]!.native_storage.before).toEqual(nativeStorageSnapshotV1(f.session.entries).summary);
    expect(result.storage_fault!.windows[0]!.events.observed_mutations).toBe(0); await f.close();
    const bad = await fixture(binding(), [navigate, assertion], checks); bad.session.onResume = () => { bad.session.hit(); bad.session.productWrite("changed"); };
    await expect(bad.navigate()).rejects.toThrow("mutation observed"); await bad.close(true);
  });
  it("rejects a preservation checkpoint after product data changed", async () => {
    const f = await fixture(binding(true)); await f.navigate(); f.session.productWrite("changed");
    await expect(f.step(1)).rejects.toThrow("no longer equals");
    // The direct after-step exception rejects the case; actual owned context still closes normally.
    await f.close();
  });
});
