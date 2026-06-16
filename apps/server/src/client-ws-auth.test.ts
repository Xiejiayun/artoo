import { devices, deviceTokens, sessions } from "@artoo/db";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { testDeviceAuthConfig } from "./config/device-auth.js";
import { generateSessionToken } from "./auth/oidc-security.js";
import { generateDeviceToken } from "./services/device-credential.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import type { ClientIdentity } from "./ws/client-ws.js";

// The fixed test clock is 2026-06-13T00:00:00Z (see test-support).
const NOW = "2026-06-13T00:00:00.000Z";
const FUTURE = "2026-07-01T00:00:00.000Z";
const PAST = "2026-06-12T00:00:00.000Z";

interface Frame {
  type: string;
  topic?: string;
  event?: { type: string; project_id?: string };
}

async function listen(server: TestServer): Promise<string> {
  const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
  return new URL(address).port;
}

function wsUrl(port: string): string {
  return `ws://127.0.0.1:${port}/api/v1/ws`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  throw new Error(`waitFor timeout: ${label}`);
}

/** Open a control WS with optional headers. Tracked sockets are closed in afterEach. */
function open(port: string, headers: Record<string, string> | undefined, sink: WebSocket[]): WebSocket {
  const socket = new WebSocket(wsUrl(port), headers === undefined ? undefined : { headers });
  socket.on("error", () => {}); // an abrupt server close otherwise surfaces as unhandled 'error'
  sink.push(socket);
  return socket;
}

/** Open a control WS at an explicit query string (for the forbidden `?token=` shape). */
function openQuery(port: string, query: string, sink: WebSocket[]): WebSocket {
  const socket = new WebSocket(`${wsUrl(port)}${query}`);
  socket.on("error", () => {});
  sink.push(socket);
  return socket;
}

/** Resolve the application close code for a rejected connection, or -1 if it stays open. */
function closeCode(socket: WebSocket): Promise<number> {
  return new Promise<number>((resolve) => {
    socket.on("close", (code: number) => resolve(code));
    setTimeout(() => resolve(-1), 2500);
  });
}

/** Open a connection expected to authenticate, subscribe, and collect pushed frames. */
async function connectAndSubscribe(
  socket: WebSocket,
  topics: string[],
): Promise<Frame[]> {
  const frames: Frame[] = [];
  socket.on("message", (data: Buffer) => frames.push(JSON.parse(data.toString()) as Frame));
  await new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve());
    socket.on("close", (code: number) => reject(new Error(`closed ${code} before open`)));
  });
  socket.send(JSON.stringify({ type: "subscribe", topics }));
  await delay(40); // let async auth resolve and the queued subscribe drain
  return frames;
}

async function seedSession(
  s: TestServer,
  opts: { expiresAt?: string; revoked?: boolean } = {},
): Promise<string> {
  const tok = generateSessionToken();
  await s.db.db.insert(sessions).values({
    id: `sess_${tok.lookup}`,
    organizationId: "org_default",
    userId: "user_owner",
    tokenLookup: tok.lookup,
    tokenHash: tok.secretHash,
    createdAt: NOW,
    expiresAt: opts.expiresAt ?? FUTURE,
    lastSeenAt: null,
    revokedAt: opts.revoked === true ? NOW : null,
  });
  return tok.raw;
}

async function seedControlToken(
  s: TestServer,
  name: string,
  opts: { deviceTrust?: "active" | "revoked"; tokenStatus?: "active" | "revoked" } = {},
): Promise<{ raw: string; deviceId: string }> {
  const tok = generateDeviceToken();
  const deviceId = `device_${name}`;
  const deviceTrust = opts.deviceTrust ?? "active";
  const tokenStatus = opts.tokenStatus ?? "active";
  await s.db.db.insert(devices).values({
    id: deviceId,
    organizationId: "org_default",
    displayName: name,
    platform: "windows",
    appVersion: "2.0.0",
    computerId: null,
    enrolledByUserId: "user_owner",
    trust: deviceTrust,
    lastSeenAt: null,
    createdAt: NOW,
    revokedAt: deviceTrust === "revoked" ? NOW : null,
  });
  await s.db.db.insert(deviceTokens).values({
    id: `dtok_${name}`,
    organizationId: "org_default",
    deviceId,
    kind: "control_session",
    tokenLookup: tok.lookup,
    tokenHash: tok.secretHash,
    status: tokenStatus,
    createdAt: NOW,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: tokenStatus === "revoked" ? NOW : null,
  });
  return { raw: tok.raw, deviceId };
}

async function createTask(server: TestServer): Promise<void> {
  await server.app.inject({
    method: "POST",
    url: "/api/v1/tasks",
    payload: { project_id: "proj_artoo", title: "auth WS push", acceptance_criteria: ["x"] },
  });
}

describe("client WS auth gate (#28 slice 3b)", () => {
  let server: TestServer | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    sockets.length = 0;
    await server?.close();
    server = undefined;
  });

  /** A production-like control plane: no anonymous escape. */
  async function prodServer(hooks?: { onAuthenticated?: (id: ClientIdentity) => void }): Promise<string> {
    server = await buildTestServer({
      deviceAuth: testDeviceAuthConfig({ devControlEscape: false }),
      clientWsHooks:
        hooks?.onAuthenticated === undefined
          ? undefined
          : { onAuthenticated: (id) => hooks.onAuthenticated?.(id) },
    });
    return listen(server);
  }

  it("rejects an anonymous connection when the dev escape is off (no anonymous prod WS)", async () => {
    const port = await prodServer();
    await expect(closeCode(open(port, undefined, sockets))).resolves.toBe(1008);
  });

  it("rejects a malformed / unknown session cookie", async () => {
    const port = await prodServer();
    const headers = { Cookie: "artoo_session=not-a-real-token" };
    await expect(closeCode(open(port, headers, sockets))).resolves.toBe(1008);
  });

  it("rejects an expired session cookie", async () => {
    server = await buildTestServer({ deviceAuth: testDeviceAuthConfig({ devControlEscape: false }) });
    const raw = await seedSession(server, { expiresAt: PAST });
    const port = await listen(server);
    const headers = { Cookie: `artoo_session=${raw}` };
    await expect(closeCode(open(port, headers, sockets))).resolves.toBe(1008);
  });

  it("rejects a revoked session cookie", async () => {
    server = await buildTestServer({ deviceAuth: testDeviceAuthConfig({ devControlEscape: false }) });
    const raw = await seedSession(server, { revoked: true });
    const port = await listen(server);
    const headers = { Cookie: `artoo_session=${raw}` };
    await expect(closeCode(open(port, headers, sockets))).resolves.toBe(1008);
  });

  it("rejects an unknown / malformed control bearer token", async () => {
    const port = await prodServer();
    const headers = { Authorization: "Bearer sk_device_deadbeef_nope" };
    await expect(closeCode(open(port, headers, sockets))).resolves.toBe(1008);
  });

  it("rejects a control token whose device has been revoked", async () => {
    server = await buildTestServer({ deviceAuth: testDeviceAuthConfig({ devControlEscape: false }) });
    const { raw } = await seedControlToken(server, "revoked_dev", { deviceTrust: "revoked" });
    const port = await listen(server);
    const headers = { Authorization: `Bearer ${raw}` };
    await expect(closeCode(open(port, headers, sockets))).resolves.toBe(1008);
  });

  it("rejects a control token whose credential has been revoked", async () => {
    server = await buildTestServer({ deviceAuth: testDeviceAuthConfig({ devControlEscape: false }) });
    const { raw } = await seedControlToken(server, "revoked_cred", { tokenStatus: "revoked" });
    const port = await listen(server);
    const headers = { Authorization: `Bearer ${raw}` };
    await expect(closeCode(open(port, headers, sockets))).resolves.toBe(1008);
  });

  it("accepts a valid session cookie, tags a user identity, and pushes events", async () => {
    const identities: ClientIdentity[] = [];
    server = await buildTestServer({
      deviceAuth: testDeviceAuthConfig({ devControlEscape: false }),
      clientWsHooks: { onAuthenticated: (id) => identities.push(id) },
    });
    const raw = await seedSession(server);
    const port = await listen(server);
    const socket = open(port, { Cookie: `artoo_session=${raw}` }, sockets);
    const frames = await connectAndSubscribe(socket, ["project:proj_artoo"]);

    await createTask(server);
    await server.publisher.pumpOnce();
    await waitFor(
      () => frames.some((f) => f.type === "event" && f.event?.type === "task.created"),
      "task.created push to authenticated session",
    );
    expect(identities).toEqual([{ kind: "user", userId: "user_owner" }]);
  });

  it("accepts a valid control_session token and tags a device identity", async () => {
    const identities: ClientIdentity[] = [];
    server = await buildTestServer({
      deviceAuth: testDeviceAuthConfig({ devControlEscape: false }),
      clientWsHooks: { onAuthenticated: (id) => identities.push(id) },
    });
    const { raw, deviceId } = await seedControlToken(server, "control_ok");
    const port = await listen(server);
    const socket = open(port, { Authorization: `Bearer ${raw}` }, sockets);
    // Should open and stay open (not be closed by the auth gate).
    await expect(closeCode(socket)).resolves.toBe(-1);
    expect(identities).toEqual([{ kind: "device", deviceId }]);
  });

  it("accepts an anonymous connection as `dev` when the escape is on (non-prod)", async () => {
    const identities: ClientIdentity[] = [];
    server = await buildTestServer({
      // default testDeviceAuthConfig has devControlEscape: true
      clientWsHooks: { onAuthenticated: (id) => identities.push(id) },
    });
    const port = await listen(server);
    const socket = open(port, undefined, sockets);
    await expect(closeCode(socket)).resolves.toBe(-1);
    expect(identities).toEqual([{ kind: "dev" }]);
  });

  it("still rejects a presented-but-invalid cookie even when the dev escape is on", async () => {
    // The escape only covers truly anonymous dev connections; a failed explicit
    // auth attempt must never silently downgrade to `dev`.
    server = await buildTestServer(); // devControlEscape: true
    const raw = await seedSession(server, { revoked: true });
    const port = await listen(server);
    const headers = { Cookie: `artoo_session=${raw}` };
    await expect(closeCode(open(port, headers, sockets))).resolves.toBe(1008);
  });

  // --- "presented-but-invalid never downgrades to dev" edge cases (codex 3b
  // review finding). These all run with devControlEscape ON to prove the escape
  // covers ONLY truly anonymous connections, not a forbidden/malformed/empty
  // credential — otherwise a client could rely on a forbidden shape and still
  // pass local dev smoke as `dev`. ---

  it("rejects the forbidden `?token=` query shape even with a VALID token + escape on", async () => {
    server = await buildTestServer(); // devControlEscape: true
    const { raw } = await seedControlToken(server, "query_shape");
    const port = await listen(server);
    // Forbidden URL-token shape -> 1008, even though the token itself is valid...
    await expect(
      closeCode(openQuery(port, `?token=${encodeURIComponent(raw)}`, sockets)),
    ).resolves.toBe(1008);
    // ...while the SAME token via the Authorization header is accepted.
    await expect(closeCode(open(port, { Authorization: `Bearer ${raw}` }, sockets))).resolves.toBe(-1);
  });

  it("rejects a non-Bearer / empty Authorization header even with escape on", async () => {
    server = await buildTestServer(); // devControlEscape: true
    const port = await listen(server);
    await expect(
      closeCode(open(port, { Authorization: "Basic dXNlcjpwYXNz" }, sockets)),
    ).resolves.toBe(1008);
    await expect(closeCode(open(port, { Authorization: "Bearer " }, sockets))).resolves.toBe(1008);
  });

  it("rejects a present-but-empty session cookie even with escape on", async () => {
    server = await buildTestServer(); // devControlEscape: true
    const port = await listen(server);
    await expect(closeCode(open(port, { Cookie: "artoo_session=" }, sockets))).resolves.toBe(1008);
  });
});
