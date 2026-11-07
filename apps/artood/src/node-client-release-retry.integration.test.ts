// Controlled verifier admission only: verificationSupported and recordVerification are fixture boundaries.
// The NodeClient, WebSocket transport, retry permits, publisher, HTTP exchanges and listener closure are real.
// This does not qualify native author/review ownership, Server authentication or a live-provider product run.
import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type ClientRequest, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalProductReleaseRequest, canonicalReleaseJson, type ProductReleaseReceipt, type ProductReleaseRequest,
  type RunVerificationPayload } from "@artoo/domain";
import { commandAckSchema, nodeHelloSchema, productReleaseCommandSchema, productReleaseReceiptMessageSchema,
  type CommandAck, type NodeHello, type ProductReleaseReceiptMessage, type RuntimeAdapter } from "@artoo/protocol";
import * as verification from "./verification.js";
import * as publication from "./product-release.js";
import { createNodeClient, type NodeClient } from "./node-client.js";
import { createWebSocketTransport, type WebSocketNodeTransport } from "./ws-transport.js";

const body = "<h1>Healthy NodeClient release</h1>", faultBody = "Controlled NodeClient retry HTTP 503\n";
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
type WireMessage = NodeHello | CommandAck | ProductReleaseReceiptMessage;
type Executor = ReturnType<typeof publication.createProductReleaseExecutor>;
type Exchange = { ordinal: number; mode: "fault" | "forwarded"; status: number | null; body: string;
  responseFinished: boolean; responseClosed: boolean; backendEnded: boolean; outgoingClosed: boolean };
afterEach(() => vi.restoreAllMocks());

function successor(failed: ProductReleaseReceipt): ProductReleaseRequest {
  if (!failed.retry_source) throw Error("Expected the original executor's settled failure projection");
  const id = failed.request.release_id + "-retry";
  return { ...failed.request, release_id: id, retry: { version: 1, root_release_id: failed.request.release_id,
    previous_release_id: failed.request.release_id, generation: 1, source_id: failed.retry_source.source_id,
    previous_request_digest: digest(canonicalProductReleaseRequest(failed.request)), previous_receipt_digest: digest(canonicalReleaseJson(failed)),
    authorization: { event_id: id + "-fixture-authorized", actor_user_id: "fixture-user", goal_id: failed.request.goal_id, attempt_index: 1 } } };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return (server.address() as AddressInfo).port;
}
async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  let closed = false; server.once("close", () => { closed = true; });
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  expect(closed).toBe(true); expect(server.listening).toBe(false);
}
async function released(port: number): Promise<void> {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen({ host: "127.0.0.1", port, exclusive: true }, resolve); });
    expect(probe.listening).toBe(true);
  } finally { await closeServer(probe); }
}

async function fixture() {
  vi.spyOn(verification, "verificationSupported").mockReturnValue(true);
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, "artoo-node-release-wire-")));
  const workspace = join(root, "workspace"), storage = join(root, "storage"), verifierScript = join(root, "verify.mjs");
  mkdirSync(workspace); mkdirSync(join(workspace, "web")); mkdirSync(storage);
  writeFileSync(join(workspace, "web/index.html"), body); writeFileSync(verifierScript, "throw Error('Verifier must not run in this boundary fixture');\n");
  const portReservation = createServer(), proxy = createServer(), wire = new WebSocketServer({ noServer: true });
  const wireHttp = createServer();
  const errors: Error[] = [], frames: WireMessage[] = [], exchanges: Exchange[] = [], outgoing = new Set<ClientRequest>();
  const sockets: { socket: WebSocket; closed: boolean }[] = [];
  const wakeups = new Set<() => void>();
  let client: NodeClient | undefined, transport: WebSocketNodeTransport | undefined, executor: Executor | undefined;
  let prepared: publication.PreparedReleaseProfile | undefined, backendPort: number | undefined, publicPort: number | undefined;
  let inject = false, adapterCalls = 0, closed = false;
  const notify = () => { for (const wake of [...wakeups]) wake(); };
  const fail = (error: unknown) => { errors.push(error instanceof Error ? error : Error(String(error))); notify(); };
  function until<T>(read: () => T | undefined, label: string, observeErrors = true): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(Error(label + "; retained fixture: " + root)); }, 5000);
      const cleanup = () => { clearTimeout(timer); wakeups.delete(check); };
      const check = () => {
        try { if (observeErrors && errors.length) throw errors[0]; const value = read(); if (value !== undefined) { cleanup(); resolve(value); } }
        catch (error) { cleanup(); reject(error); }
      };
      wakeups.add(check); check();
    });
  }
  async function settleHttp(): Promise<void> {
    await until(() => outgoing.size === 0 && exchanges.every(item => item.responseFinished && item.responseClosed
      && (item.mode === "fault" || item.backendEnded && item.outgoingClosed)) ? true : undefined, "HTTP exchange closure not observed");
  }
  async function close(retain = false): Promise<void> {
    if (closed) return; closed = true;
    const cleanupErrors: unknown[] = [];
    const attempt = async (work: () => Promise<unknown>) => { try { await work(); } catch (error) { cleanupErrors.push(error); } };
    await attempt(async () => { await client?.stop(true); if (!client) await executor?.stop(); });
    await attempt(async () => { await transport?.close(); });
    // Transport.close initiates closure; the server's actual socket close event is awaited separately.
    for (const item of sockets) if (!item.closed) item.socket.close(1000, "fixture cleanup");
    await attempt(() => until(() => sockets.every(item => item.closed) ? true : undefined, "WebSocket peers did not close", false));
    if (sockets.some(item => !item.closed)) {
      for (const item of sockets) if (!item.closed) item.socket.terminate();
      await attempt(() => until(() => sockets.every(item => item.closed) ? true : undefined, "Terminated WebSocket peers did not close", false));
    }
    await attempt(() => new Promise<void>((resolve, reject) => wire.close(error => error ? reject(error) : resolve())));
    await attempt(() => closeServer(wireHttp));
    for (const request of outgoing) request.destroy();
    await attempt(() => closeServer(proxy)); await attempt(() => closeServer(portReservation));
    if (backendPort !== undefined) await attempt(() => released(backendPort!));
    if (publicPort !== undefined) await attempt(() => released(publicPort!));
    if (retain || errors.length || cleanupErrors.length) writeFileSync(join(root, "wire-evidence.json"), JSON.stringify({
      scope: "Controlled verifier admission; real NodeClient, WebSocket and HTTP only", frames, exchanges,
      sockets_closed: sockets.map(item => item.closed), errors: errors.map(error => error.message),
      cleanup_errors: cleanupErrors.map(error => String(error)), adapter_calls: adapterCalls,
    }, null, 2) + "\n", { flag: "wx" });
    if (errors.length || cleanupErrors.length) throw new AggregateError([...errors, ...cleanupErrors], "Retained uncertain fixture: " + root);
    if (retain) { process.stderr.write("Retained failed NodeClient retry fixture: " + root + "\n"); return; }
    const tail = relative(parent, realpathSync.native(root));
    if (isAbsolute(tail) || tail.startsWith("..") || !tail.startsWith("artoo-node-release-wire-")) throw Error("Unsafe fixture cleanup path: " + root);
    function writable(directory: string): void {
      chmodSync(directory, 0o700);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name); if (entry.isSymbolicLink()) throw Error("Unexpected fixture link: " + path);
        if (entry.isDirectory()) writable(path); else chmodSync(path, 0o600);
      }
    }
    writable(root); rmSync(root, { recursive: true });
  }
  try {
    backendPort = await listen(portReservation); await closeServer(portReservation);
    proxy.on("error", fail); wireHttp.on("error", fail); wire.on("error", fail);
    proxy.on("request", (request, response) => {
      if (request.method !== "GET" || request.url !== "/") { fail(Error("Unexpected publisher HTTP request")); response.destroy(); return; }
      const exchange: Exchange = { ordinal: exchanges.length + 1, mode: inject ? "fault" : "forwarded", status: null, body: "",
        responseFinished: false, responseClosed: false, backendEnded: false, outgoingClosed: false };
      exchanges.push(exchange);
      response.once("finish", () => { exchange.responseFinished = true; notify(); });
      response.once("close", () => { exchange.responseClosed = true; notify(); }); response.once("error", fail);
      if (inject) {
        inject = false; exchange.status = 503; exchange.body = faultBody;
        response.writeHead(503, { "content-length": Buffer.byteLength(faultBody), connection: "close" }).end(faultBody); return;
      }
      const forwarding = httpRequest({ hostname: "127.0.0.1", port: backendPort, path: "/", method: "GET", agent: false,
        headers: { connection: "close" } }, incoming => {
        exchange.status = incoming.statusCode ?? null;
        incoming.on("data", chunk => { exchange.body += String(chunk); });
        incoming.once("end", () => { exchange.backendEnded = true; notify(); });
        incoming.once("aborted", () => { fail(Error("Publisher HTTP response aborted")); response.destroy(); });
        incoming.once("error", error => { fail(error); response.destroy(); });
        response.writeHead(incoming.statusCode!, incoming.headers); incoming.pipe(response);
      });
      outgoing.add(forwarding);
      forwarding.once("close", () => { exchange.outgoingClosed = true; outgoing.delete(forwarding); notify(); });
      forwarding.once("error", error => { fail(error); response.destroy(); });
      forwarding.setTimeout(3000, () => forwarding.destroy(Error("Publisher HTTP deadline exceeded"))); forwarding.end();
    });
    publicPort = await listen(proxy);
    wireHttp.on("upgrade", (request, socket, head) => wire.handleUpgrade(request, socket, head, peer => wire.emit("connection", peer, request)));
    wire.on("connection", socket => {
      const item = { socket, closed: false };
      sockets.push(item); socket.once("error", fail);
      socket.once("close", () => { item.closed = true; notify(); });
      socket.on("message", data => {
        try {
          const raw = JSON.parse(data.toString());
          frames.push(raw.kind === "node.hello" ? nodeHelloSchema.parse(raw) : raw.kind === "command.ack" ? commandAckSchema.parse(raw)
            : productReleaseReceiptMessageSchema.parse(raw)); notify();
        } catch (error) { fail(error); }
      });
      notify();
    });
    const wirePort = await listen(wireHttp);
    transport = createWebSocketTransport({ url: `ws://127.0.0.1:${wirePort}/node`, reconnectDelayMs: 1,
      hello: { kind: "node.hello", node_id: "fixture-node", protocol_version: "2026-06-11", artood_version: "0.1.0",
        machine: { hostname: "controlled-wire-fixture", os: "windows", arch: "x64" } } });
    // Capture the executor created by NodeClient, returning the unchanged real instance and options.
    const realFactory = publication.createProductReleaseExecutor;
    const factorySpy = vi.spyOn(publication, "createProductReleaseExecutor").mockImplementation((profiles, options) => {
      if (executor) throw Error("The NodeClient must retain one original publisher");
      prepared = profiles[0]; executor = realFactory(profiles, options); return executor;
    });
    const forbiddenAdapter = (): never => { adapterCalls++; throw Error("No author/model/adapter execution belongs in this fixture"); };
    const adapter: RuntimeAdapter = { runtimeId: "unused", async start() { return forbiddenAdapter(); },
      async *streamEvents() { forbiddenAdapter(); }, async stop() { forbiddenAdapter(); }, async collectArtifacts() { return forbiddenAdapter(); } };
    client = createNodeClient({ nodeId: "fixture-node", transport, adapter, workspace: { allowedRoots: [workspace] },
      verificationProfiles: [{ id: "verify", project_id: "project", workspace_root: workspace, subject_paths: ["web"], required_files: ["web/index.html"],
        commands: [{ id: "controlled-not-executed", argv: [process.execPath, verifierScript], timeout_ms: 5000 }] }],
      releaseProfiles: [{ id: "site", project_id: "project", verification_profile_id: "verify", storage_root: storage, output_path: "web",
        public_url: `http://127.0.0.1:${publicPort}`, listen_host: "127.0.0.1", listen_port: backendPort,
        health_checks: [{ path: "/", expect_text: "Healthy" }], health_timeout_ms: 1000 }],
      releaseRetrySession: () => transport!.currentSessionIdentity() });
    client.start(); await transport.ready; await client.ready();
    await until(() => frames.some(frame => frame.kind === "node.hello") ? true : undefined, "Initial hello missing");
    expect(factorySpy).toHaveBeenCalledTimes(1); expect(prepared).toBeDefined(); expect(executor).toBeDefined();
    function attest(id: string): ProductReleaseRequest {
      const verifier = prepared!.verifier, subject = verification.subjectManifest(verifier).digest;
      const evidence: RunVerificationPayload = { version: 1, request_id: id + "-verification", profile_id: verifier.id, profile_digest: verifier.digest,
        subject_digest: subject, outcome: "passed", checks: [{ id: "controlled-verifier-admission", exit_code: 0, duration_ms: 1, output_digest: subject }], required_files: [] };
      executor!.recordVerification(id, "project", workspace, evidence);
      return { version: 1, release_id: id + "-release", goal_id: "fixture-goal", project_id: "project", run_id: id, release_profile_id: prepared!.id,
        verification_request_id: evidence.request_id, verification_profile_id: verifier.id, verification_profile_digest: verifier.digest, subject_digest: subject };
    }
    async function command(request: ProductReleaseRequest, id: string) {
      const start = frames.length, message = productReleaseCommandSchema.parse({ kind: "command", id, idempotency_key: id, type: "product.release", payload: request });
      const peer = sockets.at(-1)!.socket; expect(peer.readyState).toBe(WebSocket.OPEN);
      await new Promise<void>((resolve, reject) => peer.send(JSON.stringify(message), error => error ? reject(error) : resolve()));
      const ack = await until(() => frames.slice(start).find((frame): frame is CommandAck => frame.kind === "command.ack" && frame.command_id === id), "Command ack missing: " + id);
      const received = frames.slice(start);
      expect(ack.node_id).toBe("fixture-node"); expect(received.at(-1)).toEqual(ack);
      const receipts = received.filter((frame): frame is ProductReleaseReceiptMessage => frame.kind === "product.release.receipt");
      expect(receipts.every(frame => frame.node_id === "fixture-node" && frame.payload.request.release_id === request.release_id)).toBe(true);
      return { ack, receipts: receipts.map(frame => frame.payload) };
    }
    return { attest, command, close, settleHttp, exchanges, factorySpy,
      get executor() { return executor!; }, get adapterCalls() { return adapterCalls; }, session: () => transport!.currentSessionIdentity(),
      failNext() { inject = true; }, assertBackendClosed: () => released(backendPort!),
      async reconnect() {
        const old = sockets.at(-1)!, previousCount = sockets.length;
        old.socket.close(1000, "controlled real reconnect");
        await until(() => old.closed && sockets.length === previousCount + 1
          && frames.filter(frame => frame.kind === "node.hello").length === previousCount + 1 ? true : undefined, "Reconnect hello missing");
      } };
  } catch (error) {
    try { await close(true); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Fixture initialization failed: " + root); }
    throw error;
  }
}

describe("NodeClient release retry over real WebSocket and HTTP", () => {
  it("routes a settled 503 failure, original-permit retry and immutable receipt replay through the command handler", async () => {
    const f = await fixture(); let passed = false;
    try {
      const request = f.attest("first"); f.failNext();
      const first = await f.command(request, "first-command");
      expect(first.ack.status).toBe("accepted"); expect(first.receipts).toHaveLength(1);
      const failed = first.receipts[0]!;
      expect(failed).toMatchObject({ outcome: "rolled_back", endpoint: null, previous_release_id: null,
        retry_source: { closure: "local-release-settled.v1", recovery: { kind: "listener-closed", active_release_id: null, active_artifact_digest: null } } });
      expect(failed.health_checks).toMatchObject([{ path: "/", status_code: 503, body_digest: digest(faultBody), passed: false }]);
      expect(f.executor.isAttemptSettled(request)).toBe(true); await f.settleHttp(); await f.assertBackendClosed();
      const retry = successor(failed), published = await f.command(retry, "retry-command");
      expect(published.ack.status).toBe("accepted"); expect(published.receipts).toHaveLength(1);
      expect(published.receipts[0]).toMatchObject({ request: retry, outcome: "published", artifact_digest: request.subject_digest, previous_release_id: null });
      expect(published.receipts[0]!.retry_source).toBeUndefined(); expect(f.executor.isAttemptSettled(retry)).toBe(true);
      await f.settleHttp();
      expect(f.exchanges.map(({ mode, status, body }) => ({ mode, status, body }))).toEqual([
        { mode: "fault", status: 503, body: faultBody }, { mode: "forwarded", status: 200, body }]);
      const completed = structuredClone(f.exchanges);
      const replayFirst = await f.command(request, "replay-first-new-command"), replayRetry = await f.command(retry, "replay-retry-new-command");
      expect(replayFirst.ack.status).toBe("accepted"); expect(replayFirst.receipts).toEqual([failed]);
      expect(replayRetry.ack.status).toBe("accepted"); expect(replayRetry.receipts).toEqual(published.receipts);
      await f.settleHttp(); expect(f.exchanges).toEqual(completed);
      expect(f.factorySpy).toHaveBeenCalledTimes(1); expect(f.adapterCalls).toBe(0);
      passed = true;
    } finally { await f.close(!passed); }
  });

  it("replays the failed receipt after a real reconnect but rejects a new retry from the old connection", async () => {
    const f = await fixture(); let passed = false;
    try {
      const request = f.attest("before-reconnect"), originalSession = f.session(); expect(originalSession).toBeDefined();
      f.failNext(); const first = await f.command(request, "before-reconnect-command");
      expect(first.ack.status).toBe("accepted"); expect(first.receipts).toHaveLength(1);
      const failed = first.receipts[0]!; expect(failed.outcome).toBe("rolled_back"); expect(failed.retry_source).toBeDefined();
      expect(failed.health_checks).toMatchObject([{ path: "/", status_code: 503, body_digest: digest(faultBody), passed: false }]);
      await f.settleHttp(); await f.assertBackendClosed(); const completed = structuredClone(f.exchanges), originalExecutor = f.executor;
      expect(completed).toHaveLength(1); expect(completed[0]).toMatchObject({ mode: "fault", status: 503, body: faultBody });
      await f.reconnect(); expect(f.session()).toBeDefined(); expect(f.session()).not.toBe(originalSession); expect(f.executor).toBe(originalExecutor);
      const replay = await f.command(request, "after-reconnect-history-command");
      expect(replay.ack.status).toBe("accepted"); expect(replay.receipts).toEqual([failed]);
      const rejected = await f.command(successor(failed), "after-reconnect-new-retry-command");
      expect(rejected.ack).toMatchObject({ status: "rejected", error_code: "process_start_failed",
        message: expect.stringContaining("original live authenticated session") });
      expect(rejected.receipts).toEqual([]); await f.settleHttp(); expect(f.exchanges).toEqual(completed);
      await f.assertBackendClosed(); expect(f.factorySpy).toHaveBeenCalledTimes(1); expect(f.adapterCalls).toBe(0);
      passed = true;
    } finally { await f.close(!passed); }
  });
});
