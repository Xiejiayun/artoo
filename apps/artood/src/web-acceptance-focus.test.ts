import type { Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { createMainFrameFocusProbe } from "./web-acceptance-focus.js";

function fixture() {
  const state = { frame: "first", context: 11, passed: true, shadow: [] as { shadowRootType: string }[], failContext: false, exception: false };
  const send = vi.fn(async (method: string) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: state.frame } } };
    if (method === "Page.createIsolatedWorld") {
      if (state.failContext) throw new Error("Execution context was destroyed");
      return { executionContextId: state.context };
    }
    if (method === "Runtime.callFunctionOn") return state.exception
      ? { result: {}, exceptionDetails: { text: "fixed probe failed" } }
      : { result: { type: "object", objectId: "observation" } };
    if (method === "Runtime.getProperties") return { result: [{ name: "passed", value: { type: "boolean", value: state.passed } },
      { name: "active", value: { type: "object", subtype: "node", objectId: "active" } }] };
    if (method === "DOM.describeNode") return { node: { shadowRoots: state.shadow } };
    if (method === "Runtime.releaseObjectGroup") return {};
    throw new Error(`Unexpected CDP method ${method}`);
  });
  const detach = vi.fn(async () => undefined), evaluate = vi.fn(async () => { throw new Error("Never use the product world"); });
  const page = { context: () => ({ newCDPSession: async () => ({ send, detach }) }), evaluate } as unknown as Page;
  return { state, send, detach, evaluate, page };
}

describe("protected focus observations in a browser isolated world", () => {
  it("uses only fixed code and value arguments and rebinds the current main frame after navigation", async () => {
    const f = fixture(), probe = await createMainFrameFocusProbe(f.page), selector = "#user-data-'\"-unique";
    expect(await probe.observe({ action: "assert_focused", selector })).toBe(true);
    expect(f.send).toHaveBeenCalledWith("Page.createIsolatedWorld", { frameId: "first", worldName: "artoo-protected-main-frame-focus-v2", grantUniveralAccess: false });
    const first = f.send.mock.calls.find((call) => call[0] === "Runtime.callFunctionOn") as unknown as [string, { functionDeclaration: string; arguments: unknown; executionContextId: number }];
    expect(first[1].functionDeclaration).not.toContain(selector);
    expect(first[1].arguments).toEqual([{ value: { action: "assert_focused", selector } }]);
    expect(first[1].executionContextId).toBe(11);
    f.state.frame = "after-navigation"; f.state.context = 22;
    expect(await probe.observe({ action: "keyboard-scope" })).toBe(true);
    expect(f.send).toHaveBeenCalledWith("Page.createIsolatedWorld", { frameId: "after-navigation", worldName: "artoo-protected-main-frame-focus-v2", grantUniveralAccess: false });
    expect(f.evaluate).not.toHaveBeenCalled();
    expect(f.send.mock.calls.filter((call) => call[0] === "Runtime.releaseObjectGroup")).toHaveLength(2);
    await probe.close(); expect(f.detach).toHaveBeenCalledOnce();
  });
  it.each(["open", "closed"])("rejects an active host with an %s author shadow root", async (kind) => {
    const f = fixture(); f.state.shadow = [{ shadowRootType: kind }];
    const probe = await createMainFrameFocusProbe(f.page);
    await expect(probe.observe({ action: "assert_focused", selector: "#host" })).rejects.toThrow("iframe/shadow");
    expect(f.send).toHaveBeenCalledWith("DOM.describeNode", { objectId: "active", depth: 1, pierce: true });
    expect(f.send).toHaveBeenCalledWith("Runtime.releaseObjectGroup", { objectGroup: "artoo-protected-focus-v2" });
    await probe.close();
  });
  it("keeps native controls with a browser-owned shadow root available", async () => {
    const f = fixture(); f.state.shadow = [{ shadowRootType: "user-agent" }];
    const probe = await createMainFrameFocusProbe(f.page);
    expect(await probe.observe({ action: "keyboard-scope" })).toBe(true); await probe.close();
  });
  it("fails closed if a navigation destroys the execution context and never falls back to the product world", async () => {
    const f = fixture(); f.state.failContext = true;
    const probe = await createMainFrameFocusProbe(f.page);
    await expect(probe.observe({ action: "assert_focused", selector: "#expected" })).rejects.toThrow("destroyed");
    expect(f.evaluate).not.toHaveBeenCalled(); await probe.close();
  });
  it("releases remote handles when the fixed probe throws", async () => {
    const f = fixture(); f.state.exception = true;
    const probe = await createMainFrameFocusProbe(f.page);
    await expect(probe.observe({ action: "keyboard-scope" })).rejects.toThrow("fixed probe failed");
    expect(f.send).toHaveBeenCalledWith("Runtime.releaseObjectGroup", { objectGroup: "artoo-protected-focus-v2" });
    await probe.close();
  });
});
