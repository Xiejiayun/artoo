import { describe, expect, it, vi } from "vitest";
import { AcceptanceCleanupError, withAcceptanceCleanup } from "./web-acceptance-cleanup.js";
import { formatBrowserFailure, markBrowserFailure } from "./browser-failure-diagnostic.js";

describe("acceptance cleanup error presentation", () => {
  it("preserves successful results and a work-only rejection, including throw undefined", async () => {
    const cleanup = vi.fn(async () => {}), result = {};
    expect(await withAcceptanceCleanup("context", async () => result, cleanup)).toBe(result);
    const failure = new Error("actual case failure");
    await expect(withAcceptanceCleanup("context", async () => { throw failure; }, cleanup)).rejects.toBe(failure);
    await expect(withAcceptanceCleanup("context", async () => { throw undefined; }, cleanup)).rejects.toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(3);
  });
  it.each(["context", "browser", "site"] as const)("keeps %s cleanup-only and double failures distinct from expected product rejection", async phase => {
    const failure = new Error("accessible names"), cleanupFailure = new Error("actual cleanup failure");
    for (const workFails of [false, true]) {
      const cleanup = vi.fn(async () => { throw cleanupFailure; });
      const caught = await withAcceptanceCleanup(phase, async () => { if (workFails) throw failure; }, cleanup).catch(error => error);
      expect(caught).toBeInstanceOf(AcceptanceCleanupError);
      expect(caught.phase).toBe(phase); expect(caught.cause).toBe(cleanupFailure);
      expect(caught.errors).toEqual(workFails ? [failure, cleanupFailure] : [cleanupFailure]);
      expect(caught.errors.at(-1)).toBe(cleanupFailure);
      if (workFails) expect(caught.errors[0]).toBe(failure);
      // Exercise the same matcher as the E2E negatives, rather than only testing string contents.
      expect(() => expect(() => { throw caught; }).toThrow("accessible names")).toThrow();
      expect(cleanup).toHaveBeenCalledOnce();
    }
  });
  it("retains an undefined work failure in a double failure", async () => {
    const cleanupFailure = new Error("cleanup");
    const caught = await withAcceptanceCleanup("site", async () => { throw undefined; }, async () => { throw cleanupFailure; }).catch(error => error);
    expect(caught.errors).toHaveLength(2); expect(caught.errors[0]).toBeUndefined(); expect(caught.errors[1]).toBe(cleanupFailure);
  });
  it("retains an undefined cleanup rejection as a real cleanup failure", async () => {
    const caught = await withAcceptanceCleanup("context", async () => {}, async () => { throw undefined; }).catch(error => error);
    expect(caught).toBeInstanceOf(AcceptanceCleanupError); expect(caught.phase).toBe("context");
    expect(caught.errors).toHaveLength(1); expect(caught.errors[0]).toBeUndefined();
  });
  it("presents context plus site failures without claiming owned-browser cleanup failed", async () => {
    const contextFailure = new Error("context"), siteFailure = new Error("site");
    const caught = await withAcceptanceCleanup("site", async () => withAcceptanceCleanup("context", async () => {},
      async () => { throw contextFailure; }), async () => { throw siteFailure; }).catch(error => error);
    expect(caught.phase).toBe("context"); expect(caught.message).toBe("Browser acceptance context cleanup failed");
    expect(caught.cause).toBe(contextFailure); expect(caught.errors[0].errors[0]).toBe(contextFailure); expect(caught.errors[1]).toBe(siteFailure);
  });
  it("keeps both original failures and owned-process facts visible to the existing bounded formatter", async () => {
    const caseFailure = new Error("actual case inspection failure"), cleanupFailure = markBrowserFailure(new Error("actual connection_close failure"),
      "browser-close", { profile_path: "controlled-profile", process_close_observed: false, close_checks_completed: false });
    const caught = await withAcceptanceCleanup("browser", async () => { throw new Error("Browser case saved at 390px", { cause: caseFailure }); },
      async () => { throw cleanupFailure; }).catch(error => error);
    const [details, tail] = formatBrowserFailure(caught).split("\n");
    const records = JSON.parse(details!).errors as { message: string }[];
    expect(records.map(record => record.message)).toContain(caseFailure.message);
    expect(records.map(record => record.message)).toContain(cleanupFailure.message);
    expect(JSON.parse(tail!.slice("browser_failure_summary ".length))).toMatchObject({ phase: "browser-close",
      profile_path: "controlled-profile", process_close_observed: false, close_checks_completed: false });
  });
  it("keeps browser closure primary without changing the order or settlement of outer cleanup", async () => {
    const order: string[] = [], failure = new Error("case"), contextFailure = new Error("context"), browserFailure = new Error("browser"), siteFailure = new Error("site");
    let release!: () => void;
    const browserClosed = new Promise<void>(resolve => { release = resolve; });
    const pending = withAcceptanceCleanup("site", async () => withAcceptanceCleanup("browser", async () =>
      withAcceptanceCleanup("context", async () => { order.push("work"); throw failure; }, async () => { order.push("context"); throw contextFailure; }),
    async () => { order.push("browser-start"); await browserClosed; order.push("browser-settled"); throw browserFailure; }),
    async () => { order.push("site"); throw siteFailure; }).catch(error => error);
    await vi.waitFor(() => expect(order).toEqual(["work", "context", "browser-start"]));
    release(); const caught = await pending;
    expect(order).toEqual(["work", "context", "browser-start", "browser-settled", "site"]);
    expect(caught.phase).toBe("browser"); expect(caught.message).toBe("Browser acceptance owned browser cleanup failed");
    expect(caught.cause).toBe(browserFailure); expect(caught.errors[1]).toBe(siteFailure);
    const browser = caught.errors[0], context = browser.errors[0];
    expect(browser.cause).toBe(browserFailure); expect(browser.errors[1]).toBe(browserFailure);
    expect(context.errors[0]).toBe(failure); expect(context.errors[1]).toBe(contextFailure);
  });
});
