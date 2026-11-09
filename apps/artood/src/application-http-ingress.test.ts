import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough, Writable } from "node:stream";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
const publicationAdmissions = vi.hoisted(() => new WeakMap<object, unknown>());
vi.mock("./application-bootstrap-admission.js", () => ({ readApplicationBootstrapPublication: (token: object) => {
  const saved = publicationAdmissions.get(token); if (!saved) throw Error("Original publication admission required"); return saved;
} }));
import { APPLICATION_HTTP_LIMITS as limits, createApplicationHttpIngress,
  readApplicationHttpCounters, subscribeApplicationHttpCounters,
  readApplicationPublicationHttpControl,
  type ApplicationHttpIngressOptions, type ApplicationHttpInvocation, type ApplicationHttpService } from "./application-http-ingress.js";
import { applicationPublicationProbeHeaders, type ApplicationPublicationProbeBinding } from "./application-publication-process-protocol.js";
import { APPLICATION_PUBLICATION_CONTROL_PROBE_HEADER } from "./application-publication-control-protocol.js";

const origin = "http://127.0.0.1:31000", host = "127.0.0.1:31000";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const streams: (PassThrough | Writable)[] = [];
afterEach(() => { for (const stream of streams.splice(0)) stream.destroy(); vi.restoreAllMocks(); });
// Test-only composition also lets malformed raw response fixtures reach ingress.
const correlated = (invocation: string, response: string) => `{"invocation":${JSON.stringify(invocation)},"response":${response}}`;
// Real Node streams with controlled HTTP metadata/output scheduling. These do not
// represent an actual guest, broker process, application authority or OS closure.
class Request extends PassThrough {
  httpVersion = "1.1"; rawHeaders = ["Host", host]; rawTrailers: string[] = [];
  method = "GET"; url = "/items"; complete = false; aborted = false;
  constructor() { super(); streams.push(this); }
  finish(bytes: Buffer | string = "") { this.complete = true; this.end(bytes); }
  get http() { return this as unknown as IncomingMessage; }
}
class Response extends Writable {
  statusCode = 200; headersSent = false; readonly headers = new Map<string, unknown>();
  readonly parts: Buffer[] = []; hold = false; releaseWrite?: () => void;
  constructor() { super(); streams.push(this); }
  setHeader(name: string, value: unknown) { this.headers.set(name, value); }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) {
    this.headersSent = true; this.parts.push(Buffer.from(chunk));
    if (this.hold) this.releaseWrite = done; else done();
  }
  get text() { return Buffer.concat(this.parts).toString("utf8"); }
  get http() { return this as unknown as ServerResponse; }
}
function fixture(options: Partial<ApplicationHttpIngressOptions> = {}, factory?: () => ApplicationHttpInvocation) {
  const calls: { action: Parameters<ApplicationHttpService["begin"]>[0]; signal: AbortSignal; handle: ApplicationHttpInvocation }[] = [];
  const begin = vi.fn<ApplicationHttpService["begin"]>((action, signal) => {
    const original = factory?.() ?? { response: Promise.resolve('{"status":200,"body":{"ok":true}}'), settled: Promise.resolve(), cancel: vi.fn() };
    const handle = { ...original, response: original.response.then(response => correlated(action.invocation, response)) };
    calls.push({ action, signal, handle }); return handle;
  });
  const service: ApplicationHttpService = { maximumAccess: "read", begin };
  const ingress = createApplicationHttpIngress({ origin, purpose: "application", access: "read", timeoutMs: 1000, service, ...options });
  return { ingress, begin, calls, service };
}
async function exchange(f: ReturnType<typeof fixture>, modify?: (request: Request, response: Response) => void, bytes: Buffer | string = "") {
  const request = new Request(), response = new Response(); modify?.(request, response);
  const finished = f.ingress.handle(request.http, response.http); request.finish(bytes); await finished;
  return { request, response };
}
function pending() {
  const output = deferred<string>(), settlement = deferred<void>(), cancel = vi.fn();
  return { output, settlement, cancel, handle: { response: output.promise, settled: settlement.promise, cancel } };
}

describe("publication-only private ingress gate", () => {
  function controlled(factory?: () => ApplicationHttpInvocation) {
    const digest = "sha256:" + "a".repeat(64), token = Object.freeze({}) as NonNullable<ApplicationHttpIngressOptions["publication"]>;
    publicationAdmissions.set(token, { version: 1, challenge: "11111111-1111-4111-8111-111111111111",
      control: { version: 1, read_path: "/api/items?limit=1" },
      identity: { publication_id: "publication1", lease_id: "lease1", owner_id: "owner1", generation: 1, deployment_generation: "generation1",
        reopen_pin_digest: digest, database_identity: { device: "1", inode: "2" }, schema_digest: digest, scope_digest: digest, artifact_digest: digest, origin } });
    const f = fixture({ publication: token, maximumConcurrent: 1 }, factory);
    return { ...f, control: readApplicationPublicationHttpControl(f.ingress) };
  }
  it("starts paused, admits exactly one fixed GET nonce and waits for both owner and transport settlement", async () => {
    const invocation = pending(), f = controlled(() => invocation.handle), nonce = "22222222-2222-4222-8222-222222222222";
    const denied = await exchange(f, request => { request.url = "/api/items?limit=1"; });
    expect(denied.response.statusCode).toBe(503); expect(f.begin).not.toHaveBeenCalled();
    let settled = false; const probe = f.control.probe("/api/items?limit=1", nonce).then(() => { settled = true; });
    const wrong = await exchange(f, request => { request.url = "/api/items?limit=2"; request.rawHeaders.push(APPLICATION_PUBLICATION_CONTROL_PROBE_HEADER, nonce); });
    expect(wrong.response.statusCode).toBe(503); expect(f.control.mode).toBe("armed");
    const request = new Request(), response = new Response(); response.hold = true; request.url = "/api/items?limit=1";
    request.rawHeaders.push(APPLICATION_PUBLICATION_CONTROL_PROBE_HEADER, nonce);
    const work = f.ingress.handle(request.http, response.http); request.finish();
    expect(f.control.mode).toBe("paused");
    const duplicate = await exchange(f, duplicate => { duplicate.url = request.url; duplicate.rawHeaders.push(APPLICATION_PUBLICATION_CONTROL_PROBE_HEADER, nonce); });
    expect(duplicate.response.statusCode).toBe(503);
    invocation.output.resolve('{"status":200,"body":{"ok":true}}'); await tick(); expect(settled).toBe(false);
    invocation.settlement.resolve(); await tick(); expect(settled).toBe(false);
    response.releaseWrite?.(); await work; await probe;
    expect(f.begin).toHaveBeenCalledOnce(); expect(response.headers.has(APPLICATION_PUBLICATION_CONTROL_PROBE_HEADER)).toBe(false);
    expect(JSON.stringify(f.calls[0]!.action)).not.toContain(nonce);
    expect(readApplicationHttpCounters(f.ingress)).toMatchObject({ requests_used: 1, in_flight: 0, closed_transports: 1 });
    expect(() => f.control.probe(request.url, nonce)).toThrow(/private.*probe/);
    f.control.resume(); expect(f.control.mode).toBe("running"); f.control.pause(); expect(f.control.mode).toBe("paused"); f.ingress.close();
  });
  it("keeps Stop dominant over an armed probe and never grants public control", async () => {
    const f = controlled(), nonce = "22222222-2222-4222-8222-222222222222";
    const probe = f.control.probe("/", nonce); f.ingress.drain();
    await expect(probe).rejects.toThrow(/stopped/); expect(() => f.control.resume()).toThrow(/quiescent/);
    const rejected = await exchange(f, request => { request.url = "/"; request.rawHeaders.push(APPLICATION_PUBLICATION_CONTROL_PROBE_HEADER, nonce); });
    expect(rejected.response.statusCode).toBe(503); expect(f.begin).not.toHaveBeenCalled();
    expect(() => readApplicationPublicationHttpControl({ ...f.ingress })).toThrow(/Original/);
  });
  it("retains ordinary manual routing without a publication selection", async () => {
    const f = fixture(); const result = await exchange(f);
    expect(result.response.statusCode).toBe(200); expect(f.begin).toHaveBeenCalledOnce();
    expect(() => readApplicationPublicationHttpControl(f.ingress)).toThrow(/Original/); f.ingress.close();
  });
});

describe("fixed application HTTP ingress", () => {
  it("overwrites reserved response identity with original host markers and observes actual admission/transport settlement", async () => {
    const digest = "sha256:" + "a".repeat(64), token = Object.freeze({}) as NonNullable<ApplicationHttpIngressOptions["publication"]>;
    const binding: ApplicationPublicationProbeBinding = { version: 1, challenge: "11111111-1111-4111-8111-111111111111",
      identity: { publication_id: "publication1", lease_id: "lease1", owner_id: "owner1", generation: 1, deployment_generation: "generation1",
        reopen_pin_digest: digest, database_identity: { device: "1", inode: "2" }, schema_digest: digest, scope_digest: digest, artifact_digest: digest, origin } };
    publicationAdmissions.set(token, binding);
    const invocation = pending(), f = fixture({ publication: token, maximumConcurrent: 1 }, () => invocation.handle);
    const observer = vi.fn(), unsubscribe = subscribeApplicationHttpCounters(f.ingress, observer);
    const request = new Request(), response = new Response();
    request.rawHeaders.push("x-artoo-publication-probe", "forged-request", "x-artoo-publication-identity", "forged-request");
    response.setHeader("x-artoo-publication-probe", "forged-response"); response.setHeader("x-artoo-publication-identity", "forged-response");
    const work = f.ingress.handle(request.http, response.http); request.finish();
    expect(readApplicationHttpCounters(f.ingress)).toMatchObject({ requests_used: 1, in_flight: 1, closed_transports: 0 });
    invocation.output.resolve('{"status":200,"body":{"ok":true}}'); invocation.settlement.resolve(); await work;
    for (const [name, value] of Object.entries(applicationPublicationProbeHeaders(binding))) expect(response.headers.get(name)).toBe(value);
    expect(readApplicationHttpCounters(f.ingress)).toMatchObject({ requests_used: 1, in_flight: 0, closed_transports: 1 });
    expect(observer.mock.calls.at(-1)?.[0]).toMatchObject({ requests_used: 1, in_flight: 0, closed_transports: 1 });
    expect(() => fixture({ publication: { ...token } })).toThrow("Original publication admission");
    expect(() => readApplicationHttpCounters({ ...f.ingress })).toThrow("Original"); unsubscribe();
  });
  it("maps canonical input into the existing begin action with host correlation and immutable policy", async () => {
    const f = fixture();
    const { response } = await exchange(f, request => {
      request.url = "/items/?name=%E4%B8%AD+a&__proto__=safe";
      request.rawHeaders.push("X-Request-Id", "attacker", "Cookie", "not-forwarded", "Authorization", "not-forwarded");
    });
    expect(response.statusCode).toBe(200); expect(JSON.parse(response.text)).toEqual({ ok: true });
    const call = f.calls[0]!;
    expect(Object.isFrozen(call.action)).toBe(true);
    expect(call.action).toMatchObject({ kind: "begin", purpose: "application", access: "read" });
    expect(call.action.lifetimeMs).toBeGreaterThan(0); expect(call.action.lifetimeMs).toBeLessThanOrEqual(1000);
    const request = JSON.parse(call.action.requestJson);
    expect(request).toEqual({ request_id: call.action.invocation, method: "GET", path: "/items/",
      query: JSON.parse('{"name":"中 a","__proto__":"safe"}'), body: null });
    expect(request.request_id).not.toBe("attacker");
    expect(response.headers).toEqual(new Map<string, unknown>([["connection", "close"], ["cache-control", "no-store"],
      ["x-content-type-options", "nosniff"], ["content-length", 11], ["content-type", "application/json; charset=utf-8"]]));
  });

  it("accepts fragmented UTF-8 JSON, passes only parsed DTO data, and supports empty 204", async () => {
    const f = fixture({}, () => ({ response: Promise.resolve('{"status":204,"body":null}'), settled: Promise.resolve(), cancel() {} }));
    const request = new Request(), response = new Response(), bytes = Buffer.from('{"text":"中"}');
    request.method = "POST"; request.rawHeaders.push("Origin", origin, "Content-Type", "application/json; charset=utf-8", "Content-Length", String(bytes.length));
    const done = f.ingress.handle(request.http, response.http);
    for (const byte of bytes) request.write(Buffer.from([byte])); request.finish(); await done;
    expect(JSON.parse(f.calls[0]!.action.requestJson).body).toEqual({ text: "中" });
    expect(response.statusCode).toBe(204); expect(response.text).toBe("");
    expect(response.headers.get("content-length")).toBe(0); expect(response.headers.has("content-type")).toBe(false);
  });

  it.each(["health", "peer"] as const)("requires a dedicated read binding for %s", async purpose => {
    expect(() => fixture({ purpose, access: "read", service: { maximumAccess: "write", begin: vi.fn() } })).toThrow("fixed");
    const f = fixture({ purpose }); await exchange(f);
    expect(f.calls[0]!.action).toMatchObject({ purpose, access: "read" });
    const rejected = await exchange(f, request => { request.method = "POST"; request.rawHeaders.push("Origin", origin); });
    expect(rejected.response.statusCode).toBe(403); expect(f.begin).toHaveBeenCalledTimes(1);
  });

  it("captures trusted service/policy functions and never changes purpose from the path", async () => {
    const begin = vi.fn<ApplicationHttpService["begin"]>(action => ({ response: Promise.resolve(correlated(action.invocation, '{"status":200,"body":null}')), settled: Promise.resolve(), cancel() {} }));
    const service = { maximumAccess: "write" as "read" | "write", begin };
    const f = fixture({ service, access: "write" }); service.maximumAccess = "read"; service.begin = vi.fn();
    await exchange(f, request => { request.url = "/health"; request.rawHeaders.push("Origin", origin); });
    expect(begin.mock.calls[0]![0]).toMatchObject({ purpose: "application", access: "write" });
    expect(service.begin).not.toHaveBeenCalled();
  });

  const invalid: [string, number, (request: Request) => void][] = [
    ["unsupported method", 405, r => { r.method = "HEAD"; }],
    ["HTTP version", 400, r => { r.httpVersion = "1.0"; }],
    ["missing Host", 403, r => { r.rawHeaders = []; }],
    ["foreign Host", 403, r => { r.rawHeaders = ["Host", "evil.example"]; }],
    ["duplicate Host", 400, r => { r.rawHeaders.push("host", host); }],
    ["duplicate Origin", 400, r => { r.rawHeaders.push("Origin", origin, "origin", origin); }],
    ["foreign Origin", 403, r => { r.rawHeaders.push("Origin", "http://evil.example"); }],
    ["null Origin", 403, r => { r.rawHeaders.push("Origin", "null"); }],
    ["missing mutation Origin", 403, r => { r.method = "POST"; }],
    ["cross-site fetch", 403, r => { r.rawHeaders.push("Sec-Fetch-Site", "cross-site"); }],
    ["forwarded host", 400, r => { r.rawHeaders.push("X-Forwarded-Host", host); }],
    ["upgrade", 400, r => { r.rawHeaders.push("Connection", "keep-alive, Upgrade"); }],
    ["expect", 400, r => { r.rawHeaders.push("Expect", "100-continue"); }],
    ["declared trailer", 400, r => { r.rawHeaders.push("Trailer", "X-Extra"); }],
    ["ambiguous framing", 400, r => { r.rawHeaders.push("Transfer-Encoding", "chunked", "Content-Length", "0"); }],
    ["noncanonical length", 400, r => { r.rawHeaders.push("Content-Length", "00"); }],
    ["large declared body", 413, r => { r.rawHeaders.push("Content-Length", String(limits.bodyBytes + 1)); }],
    ["encoded content", 415, r => { r.rawHeaders.push("Content-Encoding", "gzip"); }],
    ["wrong content type", 415, r => { r.rawHeaders.push("Content-Type", "text/plain"); }],
    ["header budget", 400, r => { r.rawHeaders.push("X-Large", "a".repeat(limits.headerBytes)); }],
    ["absolute target", 400, r => { r.url = origin + "/items"; }],
    ["authority target", 400, r => { r.url = "//evil.example/items"; }],
    ["dot path", 400, r => { r.url = "/items/../secret"; }],
    ["encoded path", 400, r => { r.url = "/items/%2e%2e"; }],
    ["backslash", 400, r => { r.url = "/items\\secret"; }],
    ["fragment", 400, r => { r.url = "/items#secret"; }],
    ["duplicate query", 400, r => { r.url = "/items?a=1&a=2"; }],
    ["encoded query key", 400, r => { r.url = "/items?%61=1"; }],
    ["invalid query UTF-8", 400, r => { r.url = "/items?a=%ff"; }],
    ["query value budget", 400, r => { r.url = "/items?a=" + "a".repeat(4097); }],
    ["query count", 400, r => { r.url = "/items?" + Array.from({ length: 33 }, (_, i) => `a${i}=1`).join("&"); }],
    ["target budget", 400, r => { r.url = "/" + "a".repeat(limits.targetBytes); }],
  ];
  it.each(invalid)("rejects %s before starting owner work", async (_name, status, modify) => {
    const f = fixture(), { response } = await exchange(f, modify);
    expect(response.statusCode).toBe(status); expect(f.begin).not.toHaveBeenCalled();
  });

  it("does not give a writable GET an Origin exemption", async () => {
    const begin = vi.fn(), f = fixture({ access: "write", service: { maximumAccess: "write", begin } });
    expect((await exchange(f)).response.statusCode).toBe(403); expect(begin).not.toHaveBeenCalled();
  });

  it("does not interpret a plain HTTP socket as the configured HTTPS origin", async () => {
    const f = fixture({ origin: "https://127.0.0.1:31000" });
    expect((await exchange(f)).response.statusCode).toBe(400); expect(f.begin).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid UTF-8", Buffer.from([0xff])], ["deep JSON", "[".repeat(34) + "0" + "]".repeat(34)],
    ["nonfinite number", "1e999"], ["surrogate", '"\\ud800"'], ["trailing text", "null null"],
    ["array count", JSON.stringify(Array.from({ length: 1025 }, () => 1))],
  ])("rejects %s bodies through the actual wire contract", async (_name, bytes) => {
    const f = fixture(), { response } = await exchange(f, request => {
      request.method = "POST"; request.rawHeaders.push("Origin", origin, "Content-Type", "application/json");
    }, bytes as Buffer | string);
    expect(response.statusCode).toBe(400); expect(f.begin).not.toHaveBeenCalled();
  });

  it("rejects actual body overflow, length mismatch, undeclared trailers and GET bodies", async () => {
    const f = fixture(), request = new Request(), response = new Response();
    request.method = "POST"; request.rawHeaders.push("Origin", origin, "Content-Type", "application/json", "Transfer-Encoding", "chunked");
    const done = f.ingress.handle(request.http, response.http);
    for (let i = 0; i < 5; i++) request.write(Buffer.alloc(limits.chunkBytes, 32)); await done;
    expect(response.statusCode).toBe(413); expect(f.begin).not.toHaveBeenCalled();
    const mismatch = await exchange(f, r => { r.method = "POST"; r.rawHeaders.push("Origin", origin, "Content-Length", "10", "Content-Type", "application/json"); }, "null");
    expect(mismatch.response.statusCode).toBe(400);
    expect((await exchange(f, r => { r.rawTrailers = ["X-Extra", "no"]; })).response.statusCode).toBe(400);
    expect((await exchange(f, r => { r.rawHeaders.push("Content-Type", "application/json"); }, "null")).response.statusCode).toBe(400);
    expect(f.begin).not.toHaveBeenCalled();
  });

  it.each([["redirect", '{"status":302,"body":null}'], ["204 body", '{"status":204,"body":1}'],
    ["extra fields", '{"status":200,"body":null,"headers":{}}'], ["nonfinite", '{"status":200,"body":1e999}'],
    ["body budget", '{"status":200,"body":"' + "x".repeat(limits.bodyBytes) + '"}'], ["null", "null"], ["syntax", "not-json"]])(
    "rejects malformed or out-of-contract owner response: %s", async (_name, output) => {
      const f = fixture({}, () => ({ response: Promise.resolve(output), settled: Promise.resolve(), cancel() {} }));
      expect((await exchange(f)).response.statusCode).toBe(502);
      expect((await exchange(f)).response.statusCode).toBe(503); expect(f.begin).toHaveBeenCalledTimes(1);
    });

  it("rejects a response associated with another original invocation", async () => {
    const begin = vi.fn<ApplicationHttpService["begin"]>(() => ({
      response: Promise.resolve(correlated("other-invocation", '{"status":200,"body":"other"}')), settled: Promise.resolve(), cancel() {} }));
    const f = fixture({ service: { maximumAccess: "read", begin } });
    const { response } = await exchange(f); expect(response.statusCode).toBe(502); expect(response.text).not.toContain("other");
    expect((await exchange(f)).response.statusCode).toBe(503); expect(begin).toHaveBeenCalledTimes(1);
  });

  it("waits for owner settlement before delivering a successful response", async () => {
    const p = pending(), f = fixture({}, () => p.handle), request = new Request(), response = new Response();
    const done = f.ingress.handle(request.http, response.http); request.finish(); await tick();
    p.output.resolve('{"status":200,"body":null}'); await tick(); expect(response.headersSent).toBe(false);
    p.settlement.resolve(); await done; expect(response.statusCode).toBe(200); expect(p.cancel).not.toHaveBeenCalled();
  });

  it("keeps cancelled work in the concurrency budget until the owner settles", async () => {
    const work: ReturnType<typeof pending>[] = [], f = fixture({ maximumConcurrent: 1 }, () => {
      const value = pending(); work.push(value); return value.handle;
    });
    const request = new Request(), response = new Response(), abort = new AbortController();
    const done = f.ingress.handle(request.http, response.http, abort.signal); request.finish(); await tick();
    expect((await exchange(f)).response.statusCode).toBe(503);
    abort.abort(); await done;
    expect(work[0]!.cancel).toHaveBeenCalledTimes(1); expect(f.calls[0]!.signal.aborted).toBe(true);
    expect((await exchange(f)).response.statusCode).toBe(503); expect(f.begin).toHaveBeenCalledTimes(1);
    work[0]!.settlement.resolve(); await tick();
    const next = new Request(), nextResponse = new Response(), nextDone = f.ingress.handle(next.http, nextResponse.http);
    next.finish(); await tick(); expect(f.begin).toHaveBeenCalledTimes(2);
    work[1]!.output.resolve('{"status":200,"body":2}'); work[1]!.settlement.resolve(); await nextDone;
    work[0]!.output.resolve('{"status":200,"body":"late"}'); await tick();
    expect(response.statusCode).toBe(503); expect(response.text).not.toContain("late");
  });

  it("bounds upload time before owner admission and ignores late input", async () => {
    const f = fixture({ timeoutMs: 20 }), request = new Request(), response = new Response();
    const done = f.ingress.handle(request.http, response.http); await done;
    expect(response.statusCode).toBe(504); request.finish(); await tick(); expect(f.begin).not.toHaveBeenCalled();
  });

  it("passes only the remaining request lifetime after upload and checks elapsed time before delivery", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const p = pending(), waiting = fixture({}, () => p.handle);
    const request = new Request(), response = new Response(), done = waiting.ingress.handle(request.http, response.http);
    now = 700; request.finish(); await tick(); expect(waiting.calls[0]!.action.lifetimeMs).toBe(300);
    // Let elapsed time win before the timer callback gets an opportunity to run.
    now = 1001; p.output.resolve('{"status":200,"body":"too late"}'); p.settlement.resolve(); await done;
    expect(response.statusCode).toBe(504); expect(response.text).not.toContain("too late");
  });

  it("cancels a deadline once, rejects late success and retains the unsettled slot", async () => {
    const p = pending(), f = fixture({ timeoutMs: 20, maximumConcurrent: 1 }, () => p.handle);
    const { response } = await exchange(f); expect(response.statusCode).toBe(504); expect(p.cancel).toHaveBeenCalledTimes(1);
    expect(f.calls[0]!.signal.aborted).toBe(true); expect((await exchange(f)).response.statusCode).toBe(503);
    p.output.resolve('{"status":200,"body":"late"}'); p.settlement.resolve(); await tick();
    expect(response.text).toContain("request_deadline"); expect(response.text).not.toContain("late");
  });

  it("destroys a stalled output after its deadline instead of reporting finish", async () => {
    const f = fixture({ timeoutMs: 20 }), request = new Request(), response = new Response(); response.hold = true;
    const done = f.ingress.handle(request.http, response.http); request.finish(); await done;
    expect(response.headersSent).toBe(true); expect(response.writableFinished).toBe(false); expect(response.destroyed).toBe(true);
  });

  it("closes a blocked first deadline reply while retaining the unsettled owner slot", async () => {
    const p = pending(); let calls = 0;
    const f = fixture({ timeoutMs: 10, maximumConcurrent: 1 }, () => calls++ === 0 ? p.handle
      : { response: Promise.resolve('{"status":200,"body":null}'), settled: Promise.resolve(), cancel() {} });
    const request = new Request(), response = new Response(); response.hold = true;
    let resolved = false;
    const done = f.ingress.handle(request.http, response.http).then(() => { resolved = true; });
    request.finish();
    try {
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(p.cancel).toHaveBeenCalledTimes(1); expect(response.statusCode).toBe(504);
      expect(response.headersSent).toBe(true); expect(response.writableFinished).toBe(false);
      expect(response.destroyed).toBe(true); expect(resolved).toBe(true);
      expect((await exchange(f)).response.statusCode).toBe(503); expect(f.begin).toHaveBeenCalledTimes(1);
      p.settlement.resolve(); await tick();
      expect((await exchange(f)).response.statusCode).toBe(200); expect(f.begin).toHaveBeenCalledTimes(2);
    } finally {
      // The pre-fix failure must still close its controlled stream and observe the
      // original pending promises; cleanup is not an assertion of normal finish.
      f.ingress.close(); p.settlement.resolve(); p.output.reject(Error("late test owner failure")); await done; await tick();
    }
  });

  it("handles abort during synchronous begin and forwards cancellation after obtaining the handle", async () => {
    const p = pending(), abort = new AbortController();
    const f = fixture({}, () => { abort.abort(); return p.handle; }), request = new Request(), response = new Response();
    const done = f.ingress.handle(request.http, response.http, abort.signal); request.finish(); await done; await tick();
    expect(response.statusCode).toBe(503); expect(p.cancel).toHaveBeenCalledTimes(1);
    p.settlement.resolve(); p.output.reject(Error("late private failure")); await tick();
  });

  it("does not start an already aborted request and treats response close as cancellation", async () => {
    const abort = new AbortController(); abort.abort(); const f = fixture();
    const request = new Request(), response = new Response();
    await f.ingress.handle(request.http, response.http, abort.signal); expect(f.begin).not.toHaveBeenCalled();
    const p = pending(), g = fixture({}, () => p.handle), next = new Request(), nextResponse = new Response();
    const done = g.ingress.handle(next.http, nextResponse.http); next.finish(); await tick(); nextResponse.destroy(); await done;
    expect(p.cancel).toHaveBeenCalledTimes(1); expect(g.calls[0]!.signal.aborted).toBe(true);
    p.settlement.resolve(); p.output.reject(Error("closed")); await tick();
  });

  it.each(["throw", "reject"])("fails closed on cancellation %s without losing original settlement", async mode => {
    const p = pending(); p.cancel.mockImplementation(() => { if (mode === "throw") throw Error("private"); return Promise.reject(Error("private")); });
    const f = fixture({}, () => p.handle), request = new Request(), response = new Response();
    const done = f.ingress.handle(request.http, response.http); request.finish(); await tick(); f.ingress.close(); await done; await tick();
    expect((await exchange(f)).response.statusCode).toBe(503); expect(p.cancel).toHaveBeenCalledTimes(1);
    p.settlement.resolve(); p.output.reject(Error("late")); await tick();
  });

  it.each(["response", "settlement"])("fails closed on owner %s rejection", async which => {
    const p = pending(), f = fixture({}, () => p.handle), request = new Request(), response = new Response();
    const done = f.ingress.handle(request.http, response.http); request.finish(); await tick();
    if (which === "response") p.output.reject(Error("private")); else p.settlement.reject(Error("private"));
    await done; expect(response.statusCode).toBe(503); expect(response.text).not.toContain("private");
    expect((await exchange(f)).response.statusCode).toBe(503); p.settlement.resolve(); p.output.resolve('{"status":200,"body":null}'); await tick();
  });

  it("rejects further requests when its fixed lifetime request budget is exhausted", async () => {
    const f = fixture(); for (let index = 0; index < limits.requests; index++) expect((await exchange(f)).response.statusCode).toBe(200);
    expect((await exchange(f)).response.statusCode).toBe(503); expect(f.begin).toHaveBeenCalledTimes(limits.requests);
  });

  it("drains a previously accepted body and original settlement without admitting or cancelling another request", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const owner = pending(), f = fixture({}, () => owner.handle), request = new Request(), response = new Response();
    request.method = "POST"; request.rawHeaders.push("Origin", origin, "Content-Type", "application/json");
    let done = false; const work = f.ingress.handle(request.http, response.http).then(() => { done = true; });
    f.ingress.drain(); f.ingress.drain();
    expect(await f.ingress.admissionStopped).toBe("draining");
    expect((await exchange(f)).response.statusCode).toBe(503); expect(f.begin).not.toHaveBeenCalled();
    now = 700; request.finish('{"accepted":true}'); await tick();
    expect(f.calls[0]!.action.lifetimeMs).toBe(300); expect(f.calls[0]!.signal.aborted).toBe(false);
    owner.output.resolve('{"status":200,"body":{"accepted":true}}'); await tick();
    expect(done).toBe(false); expect(response.parts).toHaveLength(0); expect(owner.cancel).not.toHaveBeenCalled();
    owner.settlement.resolve(); await work;
    expect(response.statusCode).toBe(200); expect(response.text).toBe('{"accepted":true}');
    expect((await exchange(f)).response.statusCode).toBe(503); expect(f.begin).toHaveBeenCalledTimes(1);
  });

  it("does not extend the original upload deadline when admission drains", async () => {
    let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
    const f = fixture(), request = new Request(), response = new Response();
    const work = f.ingress.handle(request.http, response.http);
    now = 900; f.ingress.drain(); now = 1001; request.finish(); await work;
    expect(response.statusCode).toBe(504); expect(f.begin).not.toHaveBeenCalled();
    expect(await f.ingress.admissionStopped).toBe("draining");
  });

  it("still cancels once and reports a late failure after a requested drain", async () => {
    const owner = pending(), f = fixture({}, () => owner.handle), request = new Request(), response = new Response();
    owner.cancel.mockImplementation(() => { throw Error("controlled late cancellation failure"); });
    const work = f.ingress.handle(request.http, response.http); request.finish(); await tick();
    f.ingress.drain(); expect(await f.ingress.admissionStopped).toBe("draining");
    expect(owner.cancel).not.toHaveBeenCalled(); f.ingress.close(); f.ingress.close(); await work;
    await f.ingress.admissionFailed;
    expect(owner.cancel).toHaveBeenCalledOnce(); expect(f.calls[0]!.signal.aborted).toBe(true);
    expect(response.statusCode).toBe(503); owner.settlement.resolve(); owner.output.reject(Error("cancelled")); await tick();
  });
});

describe("actual loopback HTTP adapter boundary (controlled service only)", () => {
  it("serves JSON using actual Node HTTP and closes the temporary listener", async () => {
    let ingress: ReturnType<typeof createApplicationHttpIngress> | undefined;
    const server = createServer({ maxHeaderSize: limits.headerBytes }, (request, response) => { void ingress!.handle(request, response); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("test listener");
    const actualOrigin = `http://127.0.0.1:${address.port}`;
    const begin = vi.fn<ApplicationHttpService["begin"]>(action => ({
      response: Promise.resolve(JSON.stringify({ invocation: action.invocation, response: { status: 201, body: JSON.parse(action.requestJson).body } })), settled: Promise.resolve(), cancel() {} }));
    ingress = createApplicationHttpIngress({ origin: actualOrigin, purpose: "application", access: "write", timeoutMs: 1000,
      service: { maximumAccess: "write", begin } });
    try {
      const result = await new Promise<{ status: number | undefined; text: string; connection: string | undefined }>((resolve, reject) => {
        const request = httpRequest(actualOrigin + "/items", { method: "POST", headers: { Origin: actualOrigin, "Content-Type": "application/json" } }, response => {
          const parts: Buffer[] = []; response.on("data", bytes => parts.push(Buffer.from(bytes))); response.once("error", reject);
          response.once("end", () => resolve({ status: response.statusCode, text: Buffer.concat(parts).toString(), connection: response.headers.connection }));
        });
        request.once("error", reject); request.end('{"realHttp":true}');
      });
      expect(result).toEqual({ status: 201, text: '{"realHttp":true}', connection: "close" }); expect(begin).toHaveBeenCalledTimes(1);
    } finally { ingress.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it("forwards an actual disconnected client's cancellation once", async () => {
    const p = pending(), begun = deferred<void>(), cancelled = deferred<void>();
    p.cancel.mockImplementation(() => { cancelled.resolve(); });
    let ingress: ReturnType<typeof createApplicationHttpIngress> | undefined, invocationSignal: AbortSignal | undefined;
    const server = createServer((request, response) => { void ingress!.handle(request, response); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw Error("test listener");
    const actualOrigin = `http://127.0.0.1:${address.port}`;
    ingress = createApplicationHttpIngress({ origin: actualOrigin, purpose: "application", access: "read", timeoutMs: 1000,
      service: { maximumAccess: "read", begin(action, signal) { invocationSignal = signal; begun.resolve();
        return { ...p.handle, response: p.output.promise.then(output => correlated(action.invocation, output)) }; } } });
    const request = httpRequest(actualOrigin + "/items"); request.on("error", () => {});
    try {
      request.end(); await begun.promise; request.destroy(); await cancelled.promise;
      expect(p.cancel).toHaveBeenCalledTimes(1); expect(invocationSignal?.aborted).toBe(true);
    } finally {
      p.settlement.resolve(); p.output.reject(Error("test client disconnected")); ingress.close(); request.destroy();
      server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
