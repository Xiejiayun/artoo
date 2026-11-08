// Actual Node TCP/HTTP, local-service lifecycle and ingress. Only the installed
// profile and native service owners are controlled: no model, native process or DB.
import { createServer, Socket } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationHttpService } from "./application-http-ingress.js";
import * as ingressApi from "./application-http-ingress.js";
import type { PreparedApplicationServiceProfile } from "./application-service-profile.js";
import { createHash } from "node:crypto";
import { createApplicationArtifactOwner, readApplicationClientArtifact, type ApplicationClientReader } from "./application-artifact-admission.js";
const state = vi.hoisted(() => ({ describe: vi.fn(), assertStore: vi.fn(), createService: vi.fn(),
  prepareBroker: vi.fn(), prepareRuntime: vi.fn(), prepareClient: vi.fn(), startBroker: vi.fn() }));
vi.mock("./application-service-profile.js", () => ({ describeApplicationServiceProfile: state.describe,
  assertApplicationServiceOpenStore: state.assertStore, prepareProfileApplicationBroker: state.prepareBroker,
  prepareProfileApplicationRuntime: state.prepareRuntime, prepareProfileApplicationClient: state.prepareClient }));
vi.mock("./application-service.js", () => ({ createApplicationService: state.createService }));
vi.mock("./application-broker-process.js", () => ({ startApplicationBrokerProcess: state.startBroker }));
import { startLocalApplicationService, type LocalApplicationService } from "./application-local-service.js";

const profile = Object.freeze({}) as PreparedApplicationServiceProfile;
const testDeadlineMs = 10_000, observationDeadlineMs = 2500;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
async function within<T>(work: Promise<T>, label: string, milliseconds = observationDeadlineMs): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error(`Timed out waiting for ${label}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
type Client = { socket: Socket; connected: Promise<void>; closed: Promise<void>; text(): string };
interface Fixture {
  readonly origin: string;
  start(): Promise<LocalApplicationService>;
  connect(): Client;
  onCleanup(release: () => void): void;
}
async function usingPort(options: { timeoutMs?: number; occupied?: boolean; sameOrigin?: boolean }, run: (fixture: Fixture) => Promise<void>): Promise<void> {
  // Reserve once on port 0, then close that original reservation before starting
  // the fixed-port production listener. A subsequent collision fails, never retries.
  const reservation = createServer(socket => socket.destroy()), clients: Client[] = [], releases: (() => void)[] = [];
  const reserving = new Promise<void>((resolve, reject) => {
    reservation.once("error", reject); reservation.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  let reservationClosing: Promise<void> | undefined, opening: Promise<LocalApplicationService> | undefined;
  const closeReservation = () => reservationClosing ??= new Promise<void>((resolve, reject) => reservation.close(error => {
    if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error); else resolve();
  }));
  try {
    await within(reserving, "original port reservation");
    const address = reservation.address(); if (!address || typeof address === "string") throw Error("Missing original reserved port");
    const port = address.port, origin = `http://127.0.0.1:${port}`;
    if (!options.occupied) await within(closeReservation(), "original reservation closure");
    state.describe.mockReturnValue({ origin, port, timeoutMs: options.timeoutMs ?? 5000,
      maximumAccess: "write", qualifiedForProduct: false,
      ...(options.sameOrigin ? { sameOrigin: { version: 1, apiPrefix: "/api" } } : {}) });
    await run({ origin, start: () => opening ??= startLocalApplicationService(profile),
      onCleanup: release => releases.push(release), connect() {
        const socket = new Socket(), parts: Buffer[] = [];
        const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
        const connected = new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve); socket.on("error", reject);
        });
        const client = { socket, connected, closed, text: () => Buffer.concat(parts).toString("utf8") };
        clients.push(client); socket.on("data", bytes => parts.push(Buffer.from(bytes)));
        socket.connect({ host: "127.0.0.1", port }); return client;
      } });
  } finally {
    for (const release of releases) release();
    for (const client of clients) client.socket.destroy();
    // Keep cleanup attached to the original startup promises even if an earlier
    // observation timed out. A late listener can never escape this closure chain.
    const outcomes = await within(Promise.allSettled([
      reserving.then(closeReservation, closeReservation),
      opening?.then(live => Promise.all([live.close(), live.closed]), () => undefined),
      ...clients.map(client => client.closed),
    ]), "all original listeners and sockets to close", 3000);
    const errors = outcomes.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Original test resource cleanup failed");
    expect(state.prepareBroker).not.toHaveBeenCalled(); expect(state.prepareRuntime).not.toHaveBeenCalled();
    expect(state.startBroker).not.toHaveBeenCalled();
  }
}
let begin: ReturnType<typeof vi.fn<ApplicationHttpService["begin"]>>;
let lastClientReader: ApplicationClientReader | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  lastClientReader = undefined;
  state.prepareClient.mockImplementation(() => lastClientReader = capturedClient().reader);
  begin = vi.fn<ApplicationHttpService["begin"]>(action => ({
    response: Promise.resolve(JSON.stringify({ invocation: action.invocation, response: { status: 200, body: { ok: true } } })),
    settled: Promise.resolve(), cancel() {},
  }));
  state.createService.mockReturnValue({ maximumAccess: "write", begin });
  for (const forbidden of [state.prepareBroker, state.prepareRuntime, state.startBroker]) {
    forbidden.mockImplementation(() => { throw Error("No native preparation or owner allowed in HTTP integration tests"); });
  }
});

describe("actual local application HTTP listener with controlled native owners", () => {
  it("drains a real accepted partial body through its original owner settlement before closing", async () => {
    const admitted = deferred<void>(), createIngress = ingressApi.createApplicationHttpIngress;
    // Observe the actual ingress call only; its body, deadline and transport code
    // remain real. The protected native invocation is the controlled boundary.
    const ingressObserver = vi.spyOn(ingressApi, "createApplicationHttpIngress").mockImplementation(options => {
      const original = createIngress(options);
      return Object.freeze({ ...original, handle(...args: Parameters<typeof original.handle>) {
        const work = original.handle(...args); admitted.resolve(); return work;
      } });
    });
    try {
      await usingPort({ sameOrigin: true }, async f => {
        const entered = deferred<void>(), response = deferred<string>(), settled = deferred<void>();
        const cancel = vi.fn(); let normalClosure: (() => void) | undefined, invocationSignal: AbortSignal | undefined;
        state.createService.mockImplementation(options => {
          normalClosure = options.observeNormalClosure; return { maximumAccess: "write", begin };
        });
        let invocation: string | undefined;
        begin.mockImplementation((action, signal) => {
          invocation = action.invocation; invocationSignal = signal; entered.resolve();
          return { response: response.promise, settled: settled.promise, cancel };
        });
        f.onCleanup(() => { response.resolve(JSON.stringify({ invocation, response: { status: 200, body: { saved: true } } })); settled.resolve(); });
        const live = await within(f.start(), "partial-body listener"), client = f.connect();
        await within(client.connected, "partial-body connection");
        const body = '{"value":7}', split = 4;
        client.socket.write(`POST /api/items HTTP/1.1\r\nHost: ${new URL(f.origin).host}\r\nOrigin: ${f.origin}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body.slice(0, split)}`);
        await within(admitted.promise, "actual HTTP admission before complete body"); expect(begin).not.toHaveBeenCalled();
        let drained = false, clientClosed = false;
        const draining = live.drain(); void draining.then(() => { drained = true; }, () => { drained = true; });
        void client.closed.then(() => { clientClosed = true; });
        expect(() => readApplicationClientArtifact(lastClientReader!, "client/app.js")).not.toThrow();
        client.socket.write(body.slice(split)); await within(entered.promise, "late original owner after body completion");
        expect(invocationSignal?.aborted).toBe(false); expect(cancel).not.toHaveBeenCalled();
        response.resolve(JSON.stringify({ invocation, response: { status: 200, body: { saved: true } } }));
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(drained).toBe(false); expect(clientClosed).toBe(false); expect(client.text()).toBe("");
        // This is a controlled normal-owner observation, not native evidence.
        normalClosure!(); settled.resolve();
        await within(Promise.all([draining, live.closed, client.closed]), "normal owner, transport and listener closure");
        expect(client.text()).toMatch(/^HTTP\/1\.1 200 /u);
        expect(client.text().split("\r\n\r\n")[1]).toBe('{"saved":true}');
        expect(begin).toHaveBeenCalledOnce(); expect(cancel).not.toHaveBeenCalled();
        expect(() => readApplicationClientArtifact(lastClientReader!, "client/app.js")).toThrow("client-reader-required");
      });
    } finally { ingressObserver.mockRestore(); }
  }, testDeadlineMs);

  it("listens on loopback and lowers a GET without Origin to read access", async () => {
    await usingPort({}, async f => {
      const live = await within(f.start(), "local listener startup"); expect(live.origin).toBe(f.origin);
      const client = f.connect(); await within(client.connected, "GET connection");
      client.socket.write(`GET /items HTTP/1.1\r\nHost: ${new URL(f.origin).host}\r\nConnection: close\r\n\r\n`);
      await within(client.closed, "GET response and original socket closure");
      expect(client.text()).toMatch(/^HTTP\/1\.1 200 /u);
      expect(client.text().split("\r\n\r\n")[1]).toBe('{"ok":true}');
      expect(begin).toHaveBeenCalledTimes(1); expect(begin.mock.calls[0]![0]).toMatchObject({ access: "read", purpose: "application" });
      expect(JSON.parse(begin.mock.calls[0]![0].requestJson)).toMatchObject({ method: "GET", path: "/items" });
      expect(state.assertStore).toHaveBeenCalledWith(profile);
    });
  }, testDeadlineMs);

  it("rejects more than 64 complete raw headers before beginning an owner", async () => {
    await usingPort({}, async f => {
      await within(f.start(), "local listener startup");
      const client = f.connect(); await within(client.connected, "header-count connection");
      const extra = Array.from({ length: 63 }, (_value, index) => `X-Test-${index}: value`);
      client.socket.write(["GET /items HTTP/1.1", `Host: ${new URL(f.origin).host}`, "Connection: close", ...extra, "", ""].join("\r\n"));
      await within(client.closed, "header-count rejection and original socket closure");
      expect(client.text()).toMatch(/^HTTP\/1\.1 400 /u);
      expect(client.text().split("\r\n\r\n")[1]).toBe('{"error":"invalid_request"}');
      expect(begin).not.toHaveBeenCalled();
    });
  }, testDeadlineMs);

  it("closes a header-only socket at the short header deadline without beginning an owner", async () => {
    await usingPort({ timeoutMs: 200 }, async f => {
      await within(f.start(), "local listener startup");
      const client = f.connect(); await within(client.connected, "header-only connection");
      const started = performance.now();
      client.socket.write(`GET /items HTTP/1.1\r\nHost: ${new URL(f.origin).host}\r\nX-Incomplete: `);
      await within(client.closed, "incomplete header closure", 2000);
      // Well before the separate 5200 ms absolute socket lifetime or Node's
      // default 30-second incomplete-request scan. Timing is not a benchmark.
      expect(performance.now() - started).toBeLessThan(2000);
      expect(client.text()).toBe(""); expect(begin).not.toHaveBeenCalled();
    });
  }, testDeadlineMs);

  it("waits for the original settled promise after a real client disconnect and explicit close", async () => {
    await usingPort({}, async f => {
      const response = deferred<string>(), settlement = deferred<void>(), begun = deferred<void>(), cancelled = deferred<void>();
      const cancel = vi.fn(() => cancelled.resolve()); let invocationSignal: AbortSignal | undefined;
      f.onCleanup(() => { settlement.resolve(); response.resolve("{}"); });
      const originalOwner = { response: response.promise, settled: settlement.promise, cancel };
      begin.mockImplementation((_action, signal) => { invocationSignal = signal; begun.resolve(); return originalOwner; });
      const live = await within(f.start(), "local listener startup"), client = f.connect();
      await within(client.connected, "disconnect-test connection");
      client.socket.write(`GET /items HTTP/1.1\r\nHost: ${new URL(f.origin).host}\r\nConnection: close\r\n\r\n`);
      await within(begun.promise, "original owner begin"); client.socket.destroy();
      await within(Promise.all([cancelled.promise, client.closed]), "disconnect cancellation and original socket closure");
      expect(cancel).toHaveBeenCalledTimes(1); expect(invocationSignal?.aborted).toBe(true);
      expect(begin.mock.results[0]!.value).toBe(originalOwner);
      let closingDone = false, closedDone = false;
      const closing = live.close(); void closing.then(() => { closingDone = true; }, () => { closingDone = true; });
      void live.closed.then(() => { closedDone = true; }, () => { closedDone = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(closingDone).toBe(false); expect(closedDone).toBe(false); expect(cancel).toHaveBeenCalledTimes(1);
      settlement.resolve(); await within(Promise.all([closing, live.closed]), "original owner settlement and service closure");
      expect(closingDone).toBe(true); expect(closedDone).toBe(true);
    });
  }, testDeadlineMs);

  it("fails on an occupied loopback port before beginning an owner", async () => {
    await usingPort({ occupied: true }, async f => {
      const error = await within(f.start().then(() => undefined, failure => failure), "occupied-port rejection");
      expect(error).toBeInstanceOf(Error); expect(error.message).toBe("Application listener startup failed");
      expect(error.cause).toMatchObject({ code: "EADDRINUSE" });
      expect(error.cleanup).toEqual([{ status: "fulfilled", value: undefined }]);
      expect(begin).not.toHaveBeenCalled();
    });
  }, testDeadlineMs);
});

const clientHtml = '<!doctype html><link rel="stylesheet" href="/app.css"><script type="module" src="/app.js"></script>';
const clientScript = 'export const endpoint = "/api/items";';
function capturedClient() {
  const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text) });
  const input = {
    source: [file("product/client/index.html", clientHtml), file("product/client/app.ts", clientScript),
      file("product/client/app.css", "body{color:black}"), file("product/server/handler.ts", "// private source")],
    artifacts: [file("client/index.html", clientHtml), file("client/app.js", clientScript),
      file("client/app.css", "body{color:black}"), file("server/handler.js", "// private server")],
    toolchain: [file("compiler/entry.js", "// private compiler")],
  };
  const sha = (bytes: Uint8Array | string) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
  const pins = (files: typeof input.source) => {
    const filesByPath = files.map(f => ({ path: f.path, bytes: f.bytes.length, sha256: sha(f.bytes) }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { files: filesByPath, digest: sha(JSON.stringify(filesByPath)) };
  };
  const owner = createApplicationArtifactOwner({ version: 1, source: pins(input.source), artifacts: pins(input.artifacts), toolchain: pins(input.toolchain) });
  const capture = owner.capture(input); return { owner, capture, reader: owner.clientReader(capture) };
}
async function exchange(f: Fixture, target: string, method = "GET", extra: readonly string[] = [], body = ""): Promise<string> {
  const client = f.connect(); await within(client.connected, "same-origin TCP connection");
  client.socket.write([method + " " + target + " HTTP/1.1", "Host: " + new URL(f.origin).host, "Connection: close", ...extra, "", body].join("\r\n"));
  await within(client.closed, "same-origin response and original socket close"); return client.text();
}

describe("same-origin captured client assets over actual loopback with controlled native owners", () => {
  it("serves HTML/CSS/JS and HEAD without a broker, with unchanged /api paths and access grants", async () => {
    await usingPort({ sameOrigin: true }, async f => {
      const live = await within(f.start(), "same-origin listener");
      const page = await exchange(f, "/", "GET", ["Sec-Fetch-Site: none"]);
      expect(page).toContain("content-type: text/html; charset=utf-8"); expect(page.split("\r\n\r\n")[1]).toBe(clientHtml);
      expect(await exchange(f, "/app.css")).toContain("content-type: text/css; charset=utf-8");
      const head = await exchange(f, "/app.js", "HEAD");
      expect(head).toContain("content-type: text/javascript; charset=utf-8");
      expect(head).toContain("content-length: " + Buffer.byteLength(clientScript)); expect(head.split("\r\n\r\n")[1]).toBe("");
      expect(begin).not.toHaveBeenCalled();
      expect(await exchange(f, "/api/items?q=one", "GET", ["Sec-Fetch-Site: same-origin"])).toMatch(/^HTTP\/1\.1 200 /u);
      expect(begin.mock.calls[0]![0].access).toBe("read");
      expect(JSON.parse(begin.mock.calls[0]![0].requestJson)).toMatchObject({ path: "/api/items", query: { q: "one" } });
      expect(await exchange(f, "/api/items", "POST", ["Origin: " + f.origin, "Content-Type: application/json", "Content-Length: 2"], "{}"))
        .toMatch(/^HTTP\/1\.1 200 /u);
      expect(begin.mock.calls[1]![0].access).toBe("write");
      expect(JSON.parse(begin.mock.calls[1]![0].requestJson).path).toBe("/api/items");
      expect(await exchange(f, "/apix")).toMatch(/^HTTP\/1\.1 404 /u); expect(begin).toHaveBeenCalledTimes(2);
      await live.close(); await live.closed;
      expect(() => readApplicationClientArtifact(lastClientReader!, "client/index.html")).toThrow("client-reader-required");
    });
  }, testDeadlineMs);
  it("applies the same raw-header, origin, target and body policy before every static read", async () => {
    await usingPort({ sameOrigin: true }, async f => {
      await within(f.start(), "policy listener");
      for (const [target, method, headers, status] of [
        ["/", "GET", ["Origin: http://untrusted.invalid"], 403],
        ["/", "GET", ["Sec-Fetch-Site: cross-site"], 403],
        ["/", "GET", ["Host: wrong.invalid"], 400],
        ["/", "GET", ["X-Test: one", "X-Test: two"], 400],
        ["/", "GET", ["Forwarded: host=wrong.invalid"], 400],
        ["/%2e%2e/server/handler.js", "GET", [], 400],
        ["/../server/handler.js", "GET", [], 400],
        ["/server/handler.js", "GET", [], 404],
        ["/product/client/index.html", "GET", [], 404],
        ["/application-runtime.json", "GET", [], 404],
        ["/", "POST", ["Origin: " + f.origin], 405],
        ["/api/items", "HEAD", [], 405],
        ["/", "GET", ["Content-Length: 1"], 400],
      ] as const) expect(await exchange(f, target, method, headers)).toMatch(new RegExp("^HTTP/1.1 " + status + " ", "u"));
      const tooMany = Array.from({ length: 63 }, (_v, i) => "X-Test-" + i + ": value");
      expect(await exchange(f, "/", "GET", tooMany)).toMatch(/^HTTP\/1\.1 400 /u);
      expect(begin).not.toHaveBeenCalled();
    });
  }, testDeadlineMs);
  it("leaves an old profile's root route on the JSON API and creates no client reader", async () => {
    await usingPort({}, async f => {
      await within(f.start(), "legacy listener");
      const response = await exchange(f, "/"); expect(response.split("\r\n\r\n")[1]).toBe('{"ok":true}');
      expect(begin).toHaveBeenCalledTimes(1); expect(state.prepareClient).not.toHaveBeenCalled();
    });
  }, testDeadlineMs);
  it("shares the single original-owner concurrency slot between API and static requests", async () => {
    await usingPort({ sameOrigin: true }, async f => {
      await within(f.start(), "shared slot listener");
      const entered = deferred<void>(), response = deferred<string>(), settled = deferred<void>();
      let action: Parameters<ApplicationHttpService["begin"]>[0] | undefined;
      const release = () => {
        response.resolve(JSON.stringify({ invocation: action?.invocation, response: { status: 200, body: { ok: true } } }));
        settled.resolve();
      };
      f.onCleanup(release);
      begin.mockImplementationOnce(input => { action = input; entered.resolve(); return { response: response.promise, settled: settled.promise, cancel() {} }; });
      const api = f.connect(); await within(api.connected, "pending API connection");
      api.socket.write("GET /api/items HTTP/1.1\r\nHost: " + new URL(f.origin).host + "\r\nConnection: close\r\n\r\n");
      await within(entered.promise, "original API owner creation");
      expect(await exchange(f, "/app.js")).toMatch(/^HTTP\/1\.1 503 /u);
      release(); await within(api.closed, "API settlement and close");
      expect(await exchange(f, "/app.js")).toMatch(/^HTTP\/1\.1 200 /u);
      expect(begin).toHaveBeenCalledTimes(1);
    });
  }, testDeadlineMs);
  it("counts static requests in the shared 256 admission budget and drains the final asset before revocation", async () => {
    await usingPort({ sameOrigin: true }, async f => {
      const live = await within(f.start(), "budget listener");
      for (let index = 0; index < 256; index++) expect(await exchange(f, "/app.js")).toMatch(/^HTTP\/1\.1 200 /u);
      await within(live.closed, "budget drain"); expect(begin).not.toHaveBeenCalled();
      expect(() => readApplicationClientArtifact(lastClientReader!, "client/app.js")).toThrow("client-reader-required");
    });
  }, testDeadlineMs);
  it("revokes its reader if service construction or listener binding fails", async () => {
    await usingPort({ sameOrigin: true }, async f => {
      state.createService.mockImplementationOnce(() => { throw Error("controlled construction failure"); });
      await expect(f.start()).rejects.toThrow("construction failure");
      expect(() => readApplicationClientArtifact(lastClientReader!, "client/index.html")).toThrow("client-reader-required");
    });
    await usingPort({ sameOrigin: true, occupied: true }, async f => {
      await expect(f.start()).rejects.toThrow("listener startup failed");
      expect(() => readApplicationClientArtifact(lastClientReader!, "client/index.html")).toThrow("client-reader-required");
    });
  }, testDeadlineMs);
});
