// Controlled Node streams only. No listener, process, guest or database starts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createApplicationHttpIngress, APPLICATION_HTTP_LIMITS, type ApplicationHttpService } from "./application-http-ingress.js";
const origin = "http://127.0.0.1:31000";
const streams: (PassThrough | Writable)[] = [];
afterEach(() => { for (const stream of streams.splice(0)) stream.destroy(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
class Request extends PassThrough {
  httpVersion = "1.1"; rawHeaders = ["Host", "127.0.0.1:31000"]; rawTrailers: string[] = [];
  method = "GET"; url = "/items"; complete = true; aborted = false;
  constructor(method = "GET", from?: string) { super(); this.method = method; if (from) this.rawHeaders.push("Origin", from); streams.push(this); }
}
class Response extends Writable {
  statusCode = 200; headersSent = false; parts: Buffer[] = [];
  constructor() { super(); streams.push(this); }
  setHeader() {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) { this.headersSent = true; this.parts.push(Buffer.from(chunk)); done(); }
}
function fixture(readOnlyGet = true, settlement?: Promise<void>) {
  const cancel = vi.fn(), begin = vi.fn<ApplicationHttpService["begin"]>(action => ({
    response: Promise.resolve(JSON.stringify({ invocation: action.invocation, response: { status: 200, body: { ok: true } } })),
    settled: settlement ?? Promise.resolve(), cancel,
  }));
  const ingress = createApplicationHttpIngress({ origin, purpose: "application", access: "write", timeoutMs: 1000,
    maximumConcurrent: 1, readOnlyGet, service: { maximumAccess: "write", begin } });
  const request = (method = "GET", from?: string) => {
    const input = new Request(method, from), output = new Response();
    const done = ingress.handle(input as unknown as IncomingMessage, output as unknown as ServerResponse); input.end();
    return { input, output, done };
  };
  return { ingress, begin, cancel, request };
}
describe("fixed browser application binding", () => {
  it("lowers a browser GET without Origin to the actual read grant and retains write Origin checks", async () => {
    const f = fixture(), get = f.request(); await get.done;
    expect(get.output.statusCode).toBe(200); expect(f.begin.mock.calls[0]![0].access).toBe("read");
    const missing = f.request("POST"); await missing.done; expect(missing.output.statusCode).toBe(403);
    const post = f.request("POST", origin); await post.done;
    expect(post.output.statusCode).toBe(200); expect(f.begin.mock.calls[1]![0].access).toBe("write");
    expect(f.begin).toHaveBeenCalledTimes(2);
  });
  it("does not alter the existing default write GET or accept a foreign Origin", async () => {
    const fixed = fixture(false), request = fixed.request(); await request.done;
    expect(request.output.statusCode).toBe(403); expect(fixed.begin).not.toHaveBeenCalled();
    const browser = fixture(), foreign = browser.request("GET", "http://evil.example"); await foreign.done;
    expect(foreign.output.statusCode).toBe(403); expect(browser.begin).not.toHaveBeenCalled();
  });
  it("shares the one concurrency slot between read GET and write POST until original settlement", async () => {
    const original = deferred<void>(), f = fixture(true, original.promise), get = f.request();
    await new Promise<void>(resolve => setImmediate(resolve));
    const write = f.request("POST", origin); await write.done;
    expect(write.output.statusCode).toBe(503); expect(f.begin).toHaveBeenCalledTimes(1);
    original.resolve(); await get.done;
    const later = f.request("POST", origin); await later.done;
    expect(later.output.statusCode).toBe(200); expect(f.begin.mock.calls[1]![0].access).toBe("write");
  });
  it("shares 256 admissions across both methods and does not cancel the last original owner when the budget stops", async () => {
    const f = fixture();
    for (let index = 0; index < APPLICATION_HTTP_LIMITS.requests; index++) {
      const request = f.request(index % 2 ? "POST" : "GET", index % 2 ? origin : undefined); await request.done;
      expect(request.output.statusCode).toBe(200);
    }
    await expect(f.ingress.admissionStopped).resolves.toBe("budget_exhausted"); expect(f.cancel).not.toHaveBeenCalled();
    const extra = f.request(); await extra.done; expect(extra.output.statusCode).toBe(503);
    expect(f.begin).toHaveBeenCalledTimes(256);
  });
  it("reports admission closure without resolving an outstanding original settlement", async () => {
    const original = deferred<void>(), f = fixture(true, original.promise), request = f.request();
    await new Promise<void>(resolve => setImmediate(resolve)); f.ingress.close();
    await expect(f.ingress.admissionStopped).resolves.toBe("closed"); await request.done;
    expect(f.cancel).toHaveBeenCalledOnce(); let settled = false; void original.promise.then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false); original.resolve();
  });
  it("reports a last-response failure independently after the budget notification, even with normal settlement", async () => {
    const f = fixture();
    for (let index = 0; index < APPLICATION_HTTP_LIMITS.requests - 1; index++) await f.request().done;
    let reject!: (error: Error) => void;
    const response = new Promise<string>((_resolve, no) => { reject = no; }); void response.catch(() => {});
    f.begin.mockReturnValueOnce({ response, settled: Promise.resolve(), cancel: vi.fn() });
    const last = f.request(); await expect(f.ingress.admissionStopped).resolves.toBe("budget_exhausted");
    reject(Error("last response failed")); await last.done;
    await expect(f.ingress.admissionFailed).resolves.toBeUndefined(); expect(last.output.statusCode).toBe(503);
  });
  it("does not turn a write-capable service into a health/peer binding", () => {
    expect(() => createApplicationHttpIngress({ origin, purpose: "health", access: "read", timeoutMs: 1000,
      readOnlyGet: true, service: { maximumAccess: "write", begin: vi.fn() } })).toThrow("fixed");
  });
});
