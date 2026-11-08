import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "playwright";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductBrowserProgramV3, ProductStorageChecksV1, StorageFaultTraceV1 } from "@artoo/domain";
import type { StorageFaultController } from "./web-acceptance-storage.js";
import { executeBrowserProgramV3 } from "./web-acceptance-pages.js";
import { AcceptanceCleanupError } from "./web-acceptance-cleanup.js";

const mocked = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./web-acceptance-storage.js", () => ({ createStorageFaultController: mocked.create }));

const origin = "http://127.0.0.1:23456", digest = `sha256:${"a".repeat(64)}`;
const program: ProductBrowserProgramV3 = { version: 3, contract_digest: digest, steps: [
  { action: "navigate", page: "main", path: "/" },
  { action: "assert_text", page: "main", selector: "#error", text: "Could not save" },
] };
const checks: ProductStorageChecksV1 = { version: 1, windows: [{ id: "save", page: "main", mode: "write-quota",
  arm_before_step: 0, settle_after_step: 1, requirement_criteria: [{ requirement_id: "save", criterion_index: 0 }],
  ui_assertion_steps: [1], min_hits: 1, native_storage: { scope: "all", comparison: "sampled-equal" } }] };

/** Controlled lifecycle seam only. Controller/native-browser evidence has separate suites. */
function fixture() {
  const log: string[] = [], context = new EventEmitter(), page = new EventEmitter();
  let closed = false, address = "about:blank";
  const frame = { url: () => address };
  Object.assign(page, {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
    url: () => address, mainFrame: () => frame, frames: () => [frame], isClosed: () => closed,
    async goto(url: string) { log.push("navigate"); address = url; page.emit("framenavigated", frame); return { ok: () => true, status: () => 200 }; },
    locator: () => ({ async textContent() { log.push("assert"); return "Could not save"; } }),
    async screenshot() { log.push("capture"); return Buffer.from("controlled screenshot"); },
  });
  Object.assign(context, {
    pages: () => [], async route() {}, async routeWebSocket() {},
    async newPage() { context.emit("page", page); return page; },
    async close() { log.push("context-close"); closed = true; page.emit("close"); },
  });
  // This trace sentinel tests forwarding only; trace validation is owned by the real controller.
  const trace = { version: 1, checks_digest: digest, windows: [] } as StorageFaultTraceV1;
  const controller: StorageFaultController = {
    async beforeStep(index) { log.push(`before:${index}`); }, async afterStep(index) { log.push(`after:${index}`); },
    async finish() { log.push("finish"); return trace; },
    async prepareContextClose() { log.push("prepare-close"); },
    async close() { log.push("storage-close"); expect(closed).toBe(true); },
  };
  mocked.create.mockImplementation(async () => { log.push("storage-setup"); return controller; });
  return { log, controller, trace, closed: () => closed,
    run: (sidecar?: ProductStorageChecksV1) => executeBrowserProgramV3(context as unknown as BrowserContext,
      origin, program, 500, async (_page: Page) => { log.push("inspect"); }, sidecar),
  };
}

beforeEach(() => mocked.create.mockReset());

describe("v3 storage-fault executor lifecycle (controlled seam)", () => {
  it("surrounds actions with storage measurement and closes the actual context before accepting evidence", async () => {
    const f = fixture(), result = await f.run(checks);
    expect(result.storage_fault).toBe(f.trace);
    expect(f.log).toEqual(["storage-setup", "before:0", "navigate", "after:0", "before:1", "assert", "after:1",
      "inspect", "capture", "finish", "prepare-close", "context-close", "storage-close"]);
    expect(result.operations).toHaveLength(2); expect(result.captures).toHaveLength(1);
  });
  it("rejects a late controller failure even after screenshots and a complete trace", async () => {
    const f = fixture(), failure = new Error("late document violation"); f.controller.close = async () => { expect(f.closed()).toBe(true); throw failure; };
    const caught = await f.run(checks).catch(error => error);
    expect(caught).toBeInstanceOf(AcceptanceCleanupError); expect(caught.message).toBe("Browser acceptance context cleanup failed");
    expect(caught.cause).toBe(failure); expect(() => { throw caught.cause; }).toThrow("late document violation");
    expect(f.log).toEqual(expect.arrayContaining(["capture", "finish", "context-close"]));
  });
  it("still closes the actual context and controller when preparation fails", async () => {
    const f = fixture(), failure = new Error("unresolved debugger pause"); f.controller.prepareContextClose = async () => { throw failure; };
    const caught = await f.run(checks).catch(error => error);
    expect(caught).toBeInstanceOf(AcceptanceCleanupError); expect(caught.message).toBe("Browser acceptance context cleanup failed");
    expect(caught.cause).toBe(failure); expect(() => { throw caught.cause; }).toThrow("unresolved debugger pause");
    expect(f.log.slice(-2)).toEqual(["context-close", "storage-close"]);
  });
  it("does not install a storage controller or add an extension for an ordinary v3 case", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result).not.toHaveProperty("storage_fault"); expect(mocked.create).not.toHaveBeenCalled();
  });
  it("retains program, preparation and storage-close failures in actual cleanup order", async () => {
    const f = fixture(), programFailure = new Error("before-step failed"), preparationFailure = new Error("pause unresolved"), closeFailure = new Error("storage close failed");
    f.controller.beforeStep = async () => { f.log.push("before-failure"); throw programFailure; };
    f.controller.prepareContextClose = async () => { f.log.push("prepare-failure"); throw preparationFailure; };
    f.controller.close = async () => { f.log.push("close-failure"); expect(f.closed()).toBe(true); throw closeFailure; };
    const caught = await f.run(checks).catch(error => error);
    const originals = (error: unknown): unknown[] => error instanceof AcceptanceCleanupError ? error.errors.flatMap(originals) : [error];
    expect(caught).toBeInstanceOf(AcceptanceCleanupError); expect(caught.message).toBe("Browser acceptance context cleanup failed");
    const errors = originals(caught); expect(errors).toHaveLength(3);
    expect(errors[0]).toBe(programFailure); expect(errors[1]).toBe(preparationFailure); expect(errors[2]).toBe(closeFailure);
    expect(f.log).toEqual(["storage-setup", "before-failure", "prepare-failure", "context-close", "close-failure"]);
  });
});
