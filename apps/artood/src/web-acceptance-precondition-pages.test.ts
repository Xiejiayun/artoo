import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "playwright";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductBrowserProgramV3, ProductStoragePreconditionBindingV1, StoragePreconditionTraceV1 } from "@artoo/domain";
import type { StoragePreconditionController } from "./web-acceptance-storage.js";
import { executeBrowserProgramV3 } from "./web-acceptance-pages.js";
import { AcceptanceCleanupError } from "./web-acceptance-cleanup.js";

const mocks = vi.hoisted(() => ({ seed: vi.fn(), fault: vi.fn() }));
vi.mock("./web-acceptance-storage.js", () => ({ createStoragePreconditionController: mocks.seed, createStorageFaultController: mocks.fault }));
const origin = "http://127.0.0.1:23456", digest = "sha256:" + "a".repeat(64);
const program: ProductBrowserProgramV3 = { version: 3, contract_digest: digest, steps: [
  { action: "navigate", page: "main", path: "/" }, { action: "assert_text", page: "main", selector: "#error", text: "Malformed" },
] };
const binding: ProductStoragePreconditionBindingV1 = { source: { path: ".artoo/product/design.json", checksum: digest, size: 100, case_id: "malformed" },
  precondition: { version: 1, local_storage: { key: "journal", value: "{" }, requirement_criteria: [{ requirement_id: "malformed", criterion_index: 0 }], ui_assertion_steps: [1] } };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

/** Page/controller lifecycle seam only. The sentinel is never native-storage evidence. */
function fixture() {
  const log: string[] = [], context = new EventEmitter(), page = new EventEmitter();
  let closed = false, address = "about:blank", abort = false;
  const frame = { url: () => address }, navigationEntered = deferred();
  let holdNavigation = false;
  Object.assign(page, {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => address, mainFrame: () => frame, frames: () => [frame], isClosed: () => closed,
    async goto(url: string) { log.push("navigate"); navigationEntered.resolve();
      if (holdNavigation) await new Promise<void>(() => {});
      address = url; page.emit("framenavigated", frame); return { ok: () => true, status: () => 200 }; },
    locator: () => ({ async textContent() { log.push("assert"); return "Malformed"; } }),
    async screenshot() { log.push("capture"); return Buffer.from("controlled screenshot"); },
  });
  Object.assign(context, { pages: () => [], async route() {}, async routeWebSocket() {},
    async newPage() { context.emit("page", page); return page; },
    async close() { log.push("context-close"); closed = true; page.emit("close"); },
  });
  const trace = { version: 1, descriptor_digest: digest } as StoragePreconditionTraceV1;
  const controller: StoragePreconditionController = {
    async beforeStep(index) { log.push("before:" + index); }, async afterStep(index) { log.push("after:" + index); },
    async finish() { log.push("finish"); return { storage_precondition: trace }; },
    abortPending() { log.push("abort"); abort = true; },
    async prepareContextClose() { log.push("prepare-close"); expect(abort).toBe(true); },
    async close() { log.push("storage-close"); expect(closed).toBe(true); },
  };
  return { log, page, controller, trace, navigationEntered, closed: () => closed, aborted: () => abort,
    hold: () => { holdNavigation = true; },
    run: () => executeBrowserProgramV3(context as unknown as BrowserContext, origin, program, 30,
      async (_page: Page) => { log.push("inspect"); }, undefined, binding),
  };
}

beforeEach(() => { mocks.seed.mockReset(); mocks.fault.mockReset(); });
describe("precondition cleanup and ownership (controlled lifecycle seam)", () => {
  it("forwards the measured precondition and aborts pending work before any cleanup await", async () => {
    const f = fixture(); mocks.seed.mockResolvedValue(f.controller); const actual = await f.run();
    expect(actual.storage_precondition).toBe(f.trace); expect(actual).not.toHaveProperty("storage_fault");
    expect(f.log).toEqual(["before:0", "navigate", "after:0", "before:1", "assert", "after:1", "inspect", "capture", "finish",
      "abort", "prepare-close", "context-close", "storage-close"]);
    expect(mocks.fault).not.toHaveBeenCalled();
  });
  it("latches immediately when navigation times out, even while cleanup is waiting, and closes only its case", async () => {
    const failing = fixture(), other = fixture(), cleanupEntered = deferred(), releaseCleanup = deferred(); failing.hold();
    mocks.seed.mockImplementation(async (page: Page) => page === (failing.page as unknown as Page) ? failing.controller : other.controller);
    failing.controller.prepareContextClose = async () => {
      failing.log.push("prepare-close"); expect(failing.aborted()).toBe(true); cleanupEntered.resolve(); await releaseCleanup.promise;
    };
    const rejected = expect(failing.run()).rejects.toThrow(/protected timeout/);
    await failing.navigationEntered.promise; await cleanupEntered.promise;
    expect(failing.aborted()).toBe(true); expect(other.closed()).toBe(false); expect(other.aborted()).toBe(false);
    releaseCleanup.resolve(); await rejected; expect(failing.closed()).toBe(true); expect(other.closed()).toBe(false);
    await other.run(); expect(other.closed()).toBe(true);
  });
  it("still closes the actual case when paused-controller cleanup fails", async () => {
    const f = fixture(), failure = new Error("unresolved seed pause"); mocks.seed.mockResolvedValue(f.controller);
    f.controller.prepareContextClose = async () => { expect(f.aborted()).toBe(true); throw failure; };
    const caught = await f.run().catch(error => error);
    expect(caught).toBeInstanceOf(AcceptanceCleanupError); expect(caught.message).toBe("Browser acceptance context cleanup failed");
    expect(caught.cause).toBe(failure); expect(() => { throw caught.cause; }).toThrow("unresolved seed pause"); expect(f.closed()).toBe(true);
    expect(f.log.slice(-2)).toEqual(["context-close", "storage-close"]);
  });
  it("preserves a synchronous abort-latch failure without attempting cleanup that the latch prevented", async () => {
    const f = fixture(), programFailure = new Error("before-step failed"), latchFailure = new Error("abort latch failed"); mocks.seed.mockResolvedValue(f.controller);
    f.controller.beforeStep = async () => { f.log.push("before-failure"); throw programFailure; };
    f.controller.abortPending = () => { f.log.push("abort-failure"); throw latchFailure; };
    const caught = await f.run().catch(error => error);
    expect(caught).toBeInstanceOf(AcceptanceCleanupError); expect(caught.message).toBe("Browser acceptance context cleanup failed");
    expect(caught.errors[0]).toBe(programFailure); expect(caught.errors[1]).toBe(latchFailure); expect(caught.cause).toBe(latchFailure);
    expect(f.log).toEqual(["before-failure", "abort-failure"]); expect(f.closed()).toBe(false);
  });
  it("sets the abort latch in the failing body's continuation before an already queued microtask", async () => {
    const f = fixture(), failure = new Error("synchronous before-step failure"); mocks.seed.mockResolvedValue(f.controller);
    let abortedAtContinuation: boolean | undefined;
    f.controller.beforeStep = () => {
      f.log.push("before-failure");
      queueMicrotask(() => { f.log.push("queued-continuation"); abortedAtContinuation = f.aborted(); });
      throw failure;
    };
    await expect(f.run()).rejects.toBe(failure);
    expect(abortedAtContinuation).toBe(true);
    expect(f.log.indexOf("abort")).toBeLessThan(f.log.indexOf("queued-continuation"));
    expect(f.closed()).toBe(true);
  });
});
