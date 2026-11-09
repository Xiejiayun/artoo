import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { BrowserOperationTraceV3Schema, type ProductBrowserProgramV3, type ProductBrowserStepV3 } from "@artoo/domain";
import { executeBrowserProgramV3 } from "./web-acceptance-pages.js";
import { AcceptanceCleanupError } from "./web-acceptance-cleanup.js";

const digest = `sha256:${"a".repeat(64)}`, origin = "http://127.0.0.1:23456";
const step = (action: string, page = "main", data: object = {}) => ({ action, page, ...data }) as ProductBrowserStepV3;
const navigate = step("navigate", "main", { path: "/" });
const program = (steps: ProductBrowserStepV3[]): ProductBrowserProgramV3 => ({ version: 3, contract_digest: digest, steps });

/** Controlled Playwright seam only; real browser/storage/process tests are separate. */
class ControlledPage extends EventEmitter {
  closed = false; address = "about:blank"; extraFrame = false; confirmClose = true;
  closeWait?: Promise<void>;
  onGoto?: () => void;
  onText?: () => void;
  onScreenshot?: () => void;
  readonly frame = { url: () => this.address };
  constructor(readonly owner: ControlledContext, readonly name: string) { super(); }
  setDefaultTimeout() {} setDefaultNavigationTimeout() {}
  mainFrame() { return this.frame; }
  frames() { return this.extraFrame ? [this.frame, { url: () => "about:srcdoc" }] : [this.frame]; }
  url() { return this.address; }
  isClosed() { return this.closed; }
  context() { return this.owner; }
  async goto(url: string) { this.address = url; this.owner.log.push(`navigate:${this.name}`); this.emit("framenavigated", this.frame); this.onGoto?.(); return { ok: () => true, status: () => 200 }; }
  locator() { return { textContent: async () => { this.owner.log.push(`text:${this.name}`); this.onText?.(); return this.name; },
    count: async () => { this.owner.log.push(`count:${this.name}`); return 1; } }; }
  async screenshot() { this.onScreenshot?.(); this.owner.log.push(`capture:${this.name}`); if (this.closed) throw new Error("closed screenshot"); return Buffer.from(`controlled screenshot ${this.name}`); }
  async close() { this.owner.log.push(`close:${this.name}`); await this.closeWait; if (this.confirmClose && !this.closed) { this.closed = true; this.emit("close"); } }
}
class ControlledContext extends EventEmitter {
  readonly log: string[] = []; readonly all: ControlledPage[] = [];
  closed = false;
  beforePage?: (page: ControlledPage, number: number) => void | Promise<void>;
  onClose?: () => void;
  onDetach?: (page: ControlledPage) => void;
  routeHandler?: (route: { request(): { url(): string }; continue(): Promise<void>; abort(reason: string): Promise<void> }) => unknown;
  websocketHandler?: (socket: { close(): void }) => void;
  pages() { return this.all.filter((page) => !page.closed); }
  async newPage() {
    const number = this.all.length, page = new ControlledPage(this, `page${number}`); this.all.push(page);
    await this.beforePage?.(page, number); this.emit("page", page); return page;
  }
  popup(name = "popup") { const page = new ControlledPage(this, name); this.all.push(page); this.emit("page", page); return page; }
  async route(_pattern: string, handler: NonNullable<ControlledContext["routeHandler"]>) { this.routeHandler = handler; }
  async routeWebSocket(_pattern: string, handler: NonNullable<ControlledContext["websocketHandler"]>) { this.websocketHandler = handler; }
  async newCDPSession(page: ControlledPage) {
    this.log.push(`probe:${page.name}`);
    return { send: async (method: string) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: page.name } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
      if (method === "Runtime.callFunctionOn") return { result: { type: "object", objectId: "observation" } };
      if (method === "Runtime.getProperties") return { result: [{ name: "passed", value: { type: "boolean", value: true } },
        { name: "active", value: { type: "object", subtype: "node", objectId: "active" } }] };
      if (method === "DOM.describeNode") return { node: { shadowRoots: [] } };
      if (method === "Runtime.releaseObjectGroup") return {};
      throw new Error(`unexpected CDP ${method}`);
    }, detach: async () => { this.log.push(`detach:${page.name}`); this.onDetach?.(page); } };
  }
  async close() {
    this.log.push("context-close"); this.onClose?.(); this.closed = true;
    for (const page of this.all) if (!page.closed) { page.closed = true; page.emit("close"); }
  }
}
const inspect = async (page: Page) => { const p = page as unknown as ControlledPage; p.owner.log.push(`inspect:${p.name}`); };
const run = (context: ControlledContext, steps: ProductBrowserStepV3[]) => executeBrowserProgramV3(context as unknown as BrowserContext, origin, program(steps), 500, inspect);

describe("v3 page lifecycle and actual execution (controlled browser seam)", () => {
  it("captures every actual page in creation order, binding closed captures to the exact close operation", async () => {
    const context = new ControlledContext(), steps = [navigate, step("open_page", "peer", { path: "/peer" }),
      step("assert_text", "peer", { selector: "body", text: "page1" }), step("close_page", "peer"),
      step("assert_count", "main", { selector: "h1", count: 1 }), step("open_page", "third", { path: "/third" }),
      step("assert_count", "third", { selector: "h1", count: 1 })];
    const actual = await run(context, steps);
    expect(actual.operations.map(({ index, action, page_id }) => ({ index, action, page_id }))).toEqual(steps.map((s, index) => ({ index, action: s.action, page_id: s.page })));
    expect(actual.captures.map(({ page_id, timing }) => ({ page_id, timing }))).toEqual([
      { page_id: "main", timing: { kind: "case-end" } }, { page_id: "peer", timing: { kind: "before-close", step_index: 3 } },
      { page_id: "third", timing: { kind: "case-end" } },
    ]);
    expect(actual.operations[1]!.observation).toEqual({ kind: "page-opened", status_code: 200 });
    expect(actual.operations[3]!.observation).toEqual({ kind: "page-closed", closed: true });
    expect(actual.screenshots.get("peer")!.toString()).toContain("page1");
    expect(context.log.indexOf("capture:page1")).toBeLessThan(context.log.indexOf("close:page1"));
    expect(context.log.indexOf("close:page1")).toBeLessThan(context.log.indexOf("navigate:page2"));
    expect(context.log.at(-1)).toBe("context-close"); expect(context.all.every((page) => page.closed)).toBe(true);
    expect(BrowserOperationTraceV3Schema.safeParse({ version: 3, format: "static-web-trace.v3", case_id: "case",
      viewport: { id: "compact", width: 390, height: 600 }, device_scale_factor: 1, program_digest: digest,
      operations: actual.operations, captures: actual.captures }).success).toBe(true);
  });
  it("awaits actual close before proceeding and closes each page's focus probe before its page", async () => {
    const context = new ControlledContext(); let release!: () => void;
    context.beforePage = (page, index) => { if (index === 1) page.closeWait = new Promise((resolve) => { release = resolve; }); };
    const pending = run(context, [navigate, step("focus", "main", { selector: "#main" }), step("open_page", "peer", { path: "/" }),
      step("focus", "peer", { selector: "#peer" }), step("close_page", "peer"), step("assert_count", "main", { selector: "h1", count: 1 })]);
    await vi.waitFor(() => expect(context.log).toContain("close:page1"));
    expect(context.log).not.toContain("count:page0");
    expect(context.log.indexOf("detach:page1")).toBeLessThan(context.log.indexOf("close:page1"));
    release(); await pending;
    expect(context.log).toContain("count:page0"); expect(context.log).toContain("detach:page0");
    expect(context.log.filter((item) => item.startsWith("probe:"))).toHaveLength(2);
  });
  it("a racing popup cannot claim the page name reserved for the returned newPage object", async () => {
    const context = new ControlledContext(); let popup: ControlledPage | undefined;
    context.beforePage = (_page, index) => { if (index === 1) popup = context.popup(); };
    await expect(run(context, [navigate, step("open_page", "peer", { path: "/peer" }), step("assert_count", "peer", { selector: "h1", count: 1 })])).rejects.toThrow("unexpected page or popup");
    expect(popup?.closed).toBe(true); expect(context.log).not.toContain("navigate:popup");
    expect(context.log).not.toContain("navigate:page1"); expect(context.closed).toBe(true);
  });
  it.each(["early-frame", "frame-event", "remote", "blank", "blob", "data", "download", "websocket", "popup", "self-close"])("rejects %s behavior on the secondary page", async (kind) => {
    const context = new ControlledContext();
    context.beforePage = (page, index) => {
      if (index !== 1) return;
      if (kind === "early-frame") page.extraFrame = true;
      page.onGoto = () => {
        if (kind === "frame-event") page.emit("frameattached", {});
        if (kind === "remote" || kind === "blank") { page.address = kind === "remote" ? "https://example.com" : "about:blank"; page.emit("framenavigated", page.frame); }
        if (kind === "blob" || kind === "data") { page.address = kind === "blob" ? `blob:${origin}/generated` : "data:text/html,generated"; page.emit("framenavigated", page.frame); }
        if (kind === "download") page.emit("download", {});
        if (kind === "websocket") context.websocketHandler!({ close() {} });
        if (kind === "popup") context.popup();
        if (kind === "self-close") { page.closed = true; page.emit("close"); }
      };
    };
    await expect(run(context, [navigate, step("open_page", "peer", { path: "/" }), step("assert_count", "peer", { selector: "h1", count: 1 })])).rejects.toThrow("Unsupported product behavior");
    expect(context.closed).toBe(true); expect(context.all.every((page) => page.closed)).toBe(true);
  });
  it.each(["capture", "context-close"])("rechecks violations raised during %s", async (when) => {
    const context = new ControlledContext();
    if (when === "capture") context.beforePage = (page) => { page.onScreenshot = () => page.emit("download", {}); };
    else context.onClose = () => context.all[0]!.emit("download", {});
    await expect(run(context, [navigate])).rejects.toThrow("download"); expect(context.closed).toBe(true);
  });
  it("does not return successful evidence if a page close reports success without actual closure", async () => {
    const context = new ControlledContext(); context.beforePage = (page, index) => { if (index === 1) page.confirmClose = false; };
    await expect(run(context, [navigate, step("open_page", "peer", { path: "/" }), step("close_page", "peer")])).rejects.toThrow("confirm actual closure");
    expect(context.closed).toBe(true);
  });
  it.each([
    [navigate, step("close_page")],
    [navigate, step("assert_count", "missing", { selector: "h1", count: 1 })],
    [navigate, step("open_page", "peer", { path: "/" }), step("close_page", "peer"), step("reload", "peer")],
    [navigate, step("open_page", "peer", { path: "/" }), step("close_page", "peer"), step("open_page", "peer", { path: "/" })],
    [navigate, step("open_page", "peer", { path: "/" }), step("close_page", "peer"), step("open_page", "third", { path: "/" }), step("open_page", "fourth", { path: "/" })],
  ])("rejects an invalid lifetime before opening any browser page: %j", async (...steps) => {
    const context = new ControlledContext(); await expect(run(context, steps)).rejects.toThrow();
    expect(context.all).toEqual([]); expect(context.closed).toBe(true);
  });
  it("rejects an existing untracked page instead of adopting it as main", async () => {
    const context = new ControlledContext(); const existing = new ControlledPage(context, "existing"); context.all.push(existing);
    await expect(run(context, [navigate])).rejects.toThrow("unexpected page"); expect(existing.closed).toBe(true);
  });
  it.each([false, true])("preserves the original program failure and context cleanup failure with program failure=%s", async programFails => {
    const context = new ControlledContext(), programFailure = new Error("actual navigation failure"), contextFailure = new Error("actual context close failure");
    if (programFails) context.beforePage = page => { page.onGoto = () => { throw programFailure; }; };
    context.onClose = () => { throw contextFailure; };
    const caught = await run(context, [navigate]).catch(error => error);
    expect(caught).toBeInstanceOf(AcceptanceCleanupError); expect(caught.message).toBe("Browser acceptance context cleanup failed");
    const originals = (error: unknown): unknown[] => error instanceof AcceptanceCleanupError ? error.errors.flatMap(originals) : [error];
    const errors = originals(caught);
    expect(caught.cause).toBe(contextFailure); expect(errors.at(-1)).toBe(contextFailure);
    expect(errors).toHaveLength(programFails ? 2 : 1);
    if (programFails) expect(errors[0]).toBe(programFailure);
    expect(context.log.filter(entry => entry === "context-close")).toHaveLength(1);
    expect(context.closed).toBe(false);
  });
  it("retains program and focus failures, skips later focus probes after failure, and still closes the context", async () => {
    const context = new ControlledContext(), programFailure = new Error("actual text failure"), focusFailure = new Error("actual focus close failure");
    context.beforePage = (page, index) => { if (index === 0) page.onText = () => { throw programFailure; }; };
    context.onDetach = () => { throw focusFailure; };
    const caught = await run(context, [navigate, step("focus", "main", { selector: "#main" }), step("open_page", "peer", { path: "/" }),
      step("focus", "peer", { selector: "#peer" }), step("assert_text", "main", { selector: "body", text: "page0" })]).catch(error => error);
    expect(caught).toBeInstanceOf(AcceptanceCleanupError); expect(caught.message).toBe("Browser acceptance context cleanup failed");
    expect(caught.errors[0]).toBe(programFailure); expect(caught.errors[1]).toBe(focusFailure); expect(caught.cause).toBe(focusFailure);
    expect(context.log.filter(entry => entry.startsWith("probe:"))).toEqual(["probe:page0", "probe:page1"]);
    expect(context.log.filter(entry => entry.startsWith("detach:"))).toEqual(["detach:page0"]);
    expect(context.log.at(-1)).toBe("context-close"); expect(context.closed).toBe(true);
  });
});
