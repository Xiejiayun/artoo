import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchReleaseHealthGet } from "./release-health-transport.js";

const endpoint = new URL("http://127.0.0.1:19876/");
const transportError = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error("socket failure"), { code }) });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("bounded release health GET transport", () => {
  it.each(["ECONNRESET", "UND_ERR_SOCKET"])("retries %s once with the identical signal and fixed GET options", async (code) => {
    vi.spyOn(performance, "now").mockReturnValue(10);
    const controller = new AbortController(), response = new Response("actual bytes", { headers: { "x-artoo-release-id": "release-1" } });
    const fetch = vi.fn().mockRejectedValueOnce(transportError(code)).mockResolvedValueOnce(response); vi.stubGlobal("fetch", fetch);
    expect(await fetchReleaseHealthGet(endpoint, controller.signal, 100)).toBe(response);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of fetch.mock.calls) expect(call).toEqual([endpoint, {
      method: "GET", redirect: "error", cache: "no-store", signal: controller.signal,
    }]);
    expect(await response.text()).toBe("actual bytes"); expect(response.headers.get("x-artoo-release-id")).toBe("release-1");
  });

  it("fails after a second reset instead of adding another attempt", async () => {
    vi.spyOn(performance, "now").mockReturnValue(10);
    const failure = transportError("ECONNRESET"), fetch = vi.fn().mockRejectedValue(failure); vi.stubGlobal("fetch", fetch);
    await expect(fetchReleaseHealthGet(endpoint, new AbortController().signal, 100)).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ABORT_ERR"])("does not retry %s", async (code) => {
    vi.spyOn(performance, "now").mockReturnValue(10);
    const failure = transportError(code), fetch = vi.fn().mockRejectedValue(failure); vi.stubGlobal("fetch", fetch);
    await expect(fetchReleaseHealthGet(endpoint, new AbortController().signal, 100)).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([404, 500, 503])("returns actual HTTP %s unchanged without retrying", async (status) => {
    vi.spyOn(performance, "now").mockReturnValue(10);
    const response = new Response("failed health", { status }), fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal("fetch", fetch);
    expect(await fetchReleaseHealthGet(endpoint, new AbortController().signal, 100)).toBe(response);
    expect(response.status).toBe(status); expect(await response.text()).toBe("failed health"); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry body failures after receiving a response", async () => {
    vi.spyOn(performance, "now").mockReturnValue(10);
    const failure = transportError("UND_ERR_SOCKET");
    const response = new Response(new ReadableStream({ start(controller) { controller.error(failure); } }));
    const fetch = vi.fn().mockResolvedValue(response); vi.stubGlobal("fetch", fetch);
    const actual = await fetchReleaseHealthGet(endpoint, new AbortController().signal, 100);
    await expect(actual.text()).rejects.toBe(failure); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the original deadline elapsed before its timer callback ran", async () => {
    let now = 10; vi.spyOn(performance, "now").mockImplementation(() => now);
    const failure = transportError("ECONNRESET"), signal = new AbortController().signal;
    const fetch = vi.fn().mockImplementation(async () => { now = 100; throw failure; }); vi.stubGlobal("fetch", fetch);
    await expect(fetchReleaseHealthGet(endpoint, signal, 100)).rejects.toBe(failure);
    expect(signal.aborted).toBe(false); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a retry response arriving after the original deadline instead of extending it", async () => {
    let now = 10; vi.spyOn(performance, "now").mockImplementation(() => now);
    const fetch = vi.fn().mockImplementationOnce(async () => { now = 90; throw transportError("ECONNRESET"); })
      .mockImplementationOnce(async () => { now = 101; return new Response("too late"); }); vi.stubGlobal("fetch", fetch);
    await expect(fetchReleaseHealthGet(endpoint, new AbortController().signal, 100)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry a reset if cancellation has already occurred", async () => {
    vi.spyOn(performance, "now").mockReturnValue(10);
    const controller = new AbortController(), failure = transportError("ECONNRESET");
    const fetch = vi.fn().mockImplementation(async () => { controller.abort(); throw failure; }); vi.stubGlobal("fetch", fetch);
    await expect(fetchReleaseHealthGet(endpoint, controller.signal, 100)).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("the same cancellation signal still interrupts the second GET", async () => {
    vi.spyOn(performance, "now").mockReturnValue(10);
    const controller = new AbortController(), reason = new DOMException("deadline", "TimeoutError");
    const fetch = vi.fn().mockRejectedValueOnce(transportError("ECONNRESET")).mockImplementationOnce((_url, options) => {
      const pending = new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
      controller.abort(reason); return pending;
    }); vi.stubGlobal("fetch", fetch);
    await expect(fetchReleaseHealthGet(endpoint, controller.signal, 100)).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls[1]![1].signal).toBe(controller.signal);
  });

  it("does not start any GET with an expired deadline or cancelled signal", async () => {
    vi.spyOn(performance, "now").mockReturnValue(100);
    const fetch = vi.fn(), controller = new AbortController(); vi.stubGlobal("fetch", fetch);
    await expect(fetchReleaseHealthGet(endpoint, controller.signal, 100)).rejects.toMatchObject({ name: "TimeoutError" });
    controller.abort(); await expect(fetchReleaseHealthGet(endpoint, controller.signal, 200)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });
});
