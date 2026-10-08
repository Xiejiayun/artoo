import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocket as PeerSocket, WebSocketServer } from "ws";
import type { NodeHello, ServerToNodeMessage } from "../../../packages/protocol/dist/index.js";
import { buildTestServer } from "../../../apps/server/dist/test-support.js";
import { testDeviceAuthConfig } from "../../../apps/server/dist/config/device-auth.js";

export async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 15000): Promise<void> {
  const end = performance.now() + timeout;
  while (!(await check())) {
    if (performance.now() >= end) throw new Error(`Timed out observing ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
export const hello = (nodeId: string): NodeHello => ({ kind: "node.hello", node_id: nodeId,
  protocol_version: "2026-06-11", artood_version: "artifact-candidate", machine: { hostname: "owned-ws-fixture", os: process.platform, arch: process.arch } });
export function command(type: string, payload: unknown): unknown {
  const id = randomUUID(); return { kind: "command", id, idempotency_key: id, type, payload };
}

/** Constructor-failure cleanup only: these acquired handles have not started a
 * fixture writer. All close operations are attempted within one finite budget;
 * a timeout remains unknown and never becomes a successful closure claim. */
export async function closeSetupResources(resources: Array<{ name: string; close(): Promise<void> }>) {
  const deadline = performance.now() + 10000;
  const results: Array<{ resource: string; closed: boolean; error?: string }> = [];
  for (const resource of [...resources].reverse()) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.resolve().then(() => resource.close()), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Setup cleanup deadline expired; closure remains unknown")), Math.max(0, deadline - performance.now()));
      })]);
      results.push({ resource: resource.name, closed: true });
    } catch (error) { results.push({ resource: resource.name, closed: false, error: String(error) }); }
    finally { clearTimeout(timer); }
  }
  return results;
}

/** Real loopback receiver; only OIDC's external identity provider is local/fake.
 * Auth/session, pairing/claim/enroll and all subsequent HTTP routes are real. */
export async function authenticatedReceiver(workspaceRoot?: string) {
  const server = await buildTestServer({ ...(workspaceRoot ? { workspaceRoot } : {}),
    deviceAuth: testDeviceAuthConfig({ devNodeToken: null }),
    authConfig: { enforceApiAuth: true, ownerEmails: ["managed-owner@example.invalid"] } });
  try {
  server.ctx.clock = { now: () => new Date(), nowIso: () => new Date().toISOString() };
  // registerAuthRoutes already captured this provider's http object. Stage the
  // actual registered provider, using its supported per-code expiry override
  // for this real-clock WS fixture; do not replace ctx.oidcHttp after mounting.
  const oidc = server.fakeOidc;
  const origin = await server.app.listen({ host: "127.0.0.1", port: 0 });
  const routes: Array<{ method: string; path: string; status: number }> = [];
  let cookie = "";
  async function request(method: string, path: string, payload?: unknown, session = true) {
    const response = await fetch(origin + path, { method, redirect: "manual",
      headers: { ...(session && cookie ? { cookie } : {}), ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    routes.push({ method, path: path.split("?")[0]!, status: response.status });
    return response;
  }
  const start = await request("GET", "/auth/google/start?return_to=/board", undefined, false);
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("location")!);
  const flowCookie = start.headers.getSetCookie().find((value) => value.startsWith("artoo_auth_flow="))!.split(";")[0]!;
  oidc.stageCode("managed-owner-code", { sub: "managed-owner", email: "managed-owner@example.invalid", email_verified: true, name: "Managed fixture owner" },
    authorize.searchParams.get("nonce")!, Math.floor(Date.parse(server.ctx.clock.nowIso()) / 1000) + 3600);
  cookie = flowCookie;
  const callback = await request("GET", `/auth/google/callback?code=managed-owner-code&state=${encodeURIComponent(authorize.searchParams.get("state")!)}`);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/board", "OIDC callback did not reach its authenticated return path");
  const sessionCookie = callback.headers.getSetCookie().find((value) => value.startsWith("artoo_session="));
  assert.ok(sessionCookie, "Successful OIDC callback omitted its session cookie");
  cookie = sessionCookie.split(";")[0]!;
  const identity = await request("GET", "/auth/session"); assert.equal(identity.status, 200);
  assert.equal((await identity.json() as { user: { role: string } }).user.role, "owner");
  const pairing = await request("POST", "/api/v1/devices/pairings", {}); assert.equal(pairing.status, 201);
  const code = (await pairing.json() as { code: string }).code;
  const claim = await request("POST", "/api/v1/devices/claim", { code, platform: "macos", app_version: "0.1.0", display_name: "Owned managed WS fixture" }, false);
  assert.equal(claim.status, 201);
  const claimed = await claim.json() as { node_token: string; device: { id: string } };
  const enrolled = await request("POST", `/api/v1/devices/${claimed.device.id}/enroll`, {}); assert.equal(enrolled.status, 200);
  const nodeId = (await enrolled.json() as { computer_id: string }).computer_id;
  return { server, origin, nodeId, routes, request,
    nodeUrl: `${origin.replace(/^http/, "ws")}/api/v1/node?token=${encodeURIComponent(claimed.node_token)}`,
    async close() { await server.close(); } };
  } catch (error) {
    const cleanup = await closeSetupResources([{ name: "authenticated-receiver", close: () => server.close() }]);
    throw new Error(`Authenticated receiver setup failed: ${String(error)}; acquired-resource cleanup: ${JSON.stringify(cleanup)}`, { cause: error });
  }
}

export interface WireRecord { at: string; tick: number; generation: number; direction: "up" | "down"; text: string; frame: any;
  forwarded: boolean; dropped: boolean; physical?: unknown }
export type WireDecision = "forward" | "hold" | "drop";
/** Owned transparent loopback proxy. Held bytes always originate at a real peer.
 * It never manufactures qualified receipts or physical/process evidence. */
export async function privateProxy(target: string) {
  const listener = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
  const connections: Array<{ generation: number; client: PeerSocket; upstream: PeerSocket }> = [];
  const records: WireRecord[] = [], held: Array<{ record: WireRecord; send(): void }> = [];
  let policy: ((record: WireRecord) => WireDecision) | undefined, observe: (() => unknown) | undefined, closing = false;
  listener.on("connection", (client) => {
    const upstream = new PeerSocket(target), generation = connections.length + 1;
    const connection = { client, upstream, generation }; connections.push(connection);
    const preopen: string[] = []; let bytes = 0;
    const forward = (direction: "up" | "down", text: string) => {
      const destination = direction === "up" ? upstream : client;
      const record: WireRecord = { at: new Date().toISOString(), tick: performance.now(), generation, direction,
        text, frame: JSON.parse(text), forwarded: false, dropped: false, ...(observe ? { physical: observe() } : {}) };
      records.push(record);
      const send = () => { if (destination.readyState !== PeerSocket.OPEN) throw new Error("Original held frame's socket is closed"); destination.send(text); record.forwarded = true; };
      const decision = policy?.(record) ?? "forward";
      if (decision === "hold") held.push({ record, send });
      else if (decision === "drop") record.dropped = true;
      else send();
    };
    client.on("message", (data) => {
      const text = data.toString();
      if (upstream.readyState === PeerSocket.CONNECTING) {
        bytes += Buffer.byteLength(text);
        if (preopen.length >= 16 || bytes > 4 * 1024 * 1024) { client.close(1008); upstream.terminate(); return; }
        preopen.push(text);
      } else if (upstream.readyState === PeerSocket.OPEN) forward("up", text);
    });
    upstream.on("open", () => { for (const text of preopen.splice(0)) forward("up", text); });
    upstream.on("message", (data) => { if (client.readyState === PeerSocket.OPEN) forward("down", data.toString()); });
    client.on("close", () => { if (upstream.readyState !== PeerSocket.CLOSED) upstream.terminate(); });
    upstream.on("close", (code) => { if (client.readyState === PeerSocket.OPEN) client.close([1000,1008].includes(code) ? code : 1011); });
    client.on("error", () => { if (!closing) upstream.terminate(); });
    upstream.on("error", () => { if (!closing) client.terminate(); });
  });
  return { url: `ws://127.0.0.1:${(listener.address() as AddressInfo).port}`, connections, records, held,
    setPolicy(next?: (record: WireRecord) => WireDecision) { policy = next; },
    observePhysical(next?: () => unknown) { observe = next; },
    cut(code?: number) { const latest = connections.at(-1); if (!latest) throw new Error("No owned proxy connection");
      if (code) latest.client.close(code); else latest.client.terminate(); latest.upstream.terminate(); },
    release(predicate: (record: WireRecord) => boolean = () => true) {
      for (let i = held.length - 1; i >= 0; i--) if (predicate(held[i]!.record)) { const item = held.splice(i, 1)[0]!; item.send(); }
    },
    async close() {
      closing = true; for (const item of connections) { item.client.terminate(); item.upstream.terminate(); }
      await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    } };
}

/** Scripted loopback protocol peer for T cases only; never qualified receipt evidence. */
export async function scriptedPeer() {
  const listener = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => { listener.once("listening", resolve); listener.once("error", reject); });
  const peers: Array<{ socket: PeerSocket; messages: any[] }> = [];
  let onMessage: ((peer: typeof peers[number], message: any) => void) | undefined;
  listener.on("connection", (socket) => {
    const peer = { socket, messages: [] as any[] }; peers.push(peer);
    socket.on("error", () => {});
    socket.on("message", (data) => { const value = JSON.parse(data.toString()); peer.messages.push(value); onMessage?.(peer, value); });
  });
  return { peers, url: `ws://127.0.0.1:${(listener.address() as AddressInfo).port}`,
    onMessage(handler?: typeof onMessage) { onMessage = handler; },
    send(peer: typeof peers[number], message: unknown) { peer.socket.send(JSON.stringify(message)); },
    async close() { for (const peer of peers) peer.socket.terminate(); await new Promise<void>((resolve) => listener.close(() => resolve())); } };
}
export type BusinessCommand = Extract<ServerToNodeMessage, { type: "run.start" | "run.stop" | "run.resume" }>;
