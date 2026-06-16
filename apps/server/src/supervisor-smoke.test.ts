import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { computers, devices, deviceTokens } from "@artoo/db";
import {
  createChildProcessSpawner,
  createNodeSupervisor,
  toBootstrapEnv,
  type SupervisorSettings
} from "@artoo/node-supervisor";
import { afterEach, describe, expect, it } from "vitest";

import { generateDeviceToken } from "./services/device-credential.js";
import { buildTestServer, type TestServer } from "./test-support.js";

/**
 * Gated supervisor smoke (#29 v2-D slice 4b). Opt-in ONLY: skipped unless
 * ARTOO_SUPERVISOR_SMOKE=1. It spawns a REAL artood child process via the
 * production child_process spawner and supervises it against a real listening
 * test server, proving the local-node control plane end to end:
 *   start -> real artood connects + heartbeats (agent_runtimes) -> running ->
 *   stop ends the child -> restart -> a FRESH heartbeat updates last_seen_at.
 *   ARTOO_SUPERVISOR_SMOKE=1 npx vitest run apps/server/src/supervisor-smoke.test.ts
 *
 * Requires a prior build (`apps/artood/dist/main.js`); it fails loudly if absent
 * rather than running stale/missing code. The run workspace lives under the OS
 * temp dir, never the project repo.
 */
const ENABLED = process.env.ARTOO_SUPERVISOR_SMOKE === "1";
const artoodMain = fileURLToPath(new URL("../../artood/dist/main.js", import.meta.url));

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 25_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return true;
    await sleep(250);
  }
  return false;
}

describe.skipIf(!ENABLED)("gated supervisor smoke (real artood child)", () => {
  let server: TestServer | undefined;
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    await server?.close();
    server = undefined;
  });

  it("start -> heartbeat -> stop ends child -> restart -> fresh last_seen_at", async () => {
    if (!existsSync(artoodMain)) {
      throw new Error(`build first: missing ${artoodMain} — run \`npm run build\` before this gated smoke`);
    }

    const wsRoot = mkdtempSync(join(tmpdir(), "artoo-sup-smoke-"));
    cleanups.push(() => rmSync(wsRoot, { recursive: true, force: true }));
    if (!wsRoot.startsWith(tmpdir())) throw new Error("smoke refuses to operate outside the OS temp dir");

    server = await buildTestServer();
    const srv = server;
    // Mutable server clock so a post-restart heartbeat is time-distinguishable
    // (recordHeartbeatRuntimes stamps last_seen_at from ctx.clock).
    let serverNow = "2026-06-13T00:00:00.000Z";
    srv.ctx.clock = { now: () => new Date(serverNow), nowIso: () => serverNow };

    await srv.app.listen({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => srv.app.close());
    const addr = srv.app.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    async function pollLastSeen(): Promise<string | null> {
      const res = await srv.app.inject({
        method: "GET",
        url: "/api/v1/computers/computer_local_mock/runtimes"
      });
      const runtimes = (res.json().runtimes ?? []) as Array<{ runtime: string; last_seen_at: string | null }>;
      return runtimes.find((r) => r.runtime === "codex")?.last_seen_at ?? null;
    }

    const settings: SupervisorSettings = {
      serverNodeUrl: `ws://127.0.0.1:${port}/api/v1/node`,
      nodeId: "computer_local_mock",
      nodeCredential: "dev",
      runtimes: ["codex"],
      allowedRoots: [wsRoot]
    };
    const env = { ...toBootstrapEnv(settings), ARTOO_HEARTBEAT_INTERVAL_MS: "500" };
    const health = { iso: null as string | null };

    const supervisor = createNodeSupervisor({
      spawner: createChildProcessSpawner([process.execPath, artoodMain]),
      health: { lastHeartbeatIso: () => health.iso },
      nowIso: () => serverNow,
      schedule: (fn, ms) => setTimeout(fn, ms),
      staleAfterMs: 60_000
    });
    cleanups.push(() => supervisor.stop());

    // --- start -> real artood heartbeats -> running ---
    supervisor.start(env);
    const up = await waitFor(async () => {
      health.iso = await pollLastSeen();
      supervisor.tick();
      return supervisor.state() === "running";
    });
    expect(up).toBe(true);
    const firstSeen = health.iso;
    expect(firstSeen).not.toBeNull(); // a real heartbeat row appeared

    // --- stop really ends the child (supervisor only reaches stopped on exit) ---
    supervisor.stop();
    expect(await waitFor(() => supervisor.state() === "stopped")).toBe(true);

    // --- restart -> a FRESH heartbeat updates last_seen_at (compare by instant;
    //     the API returns Postgres timestamptz form, not the ISO source string) ---
    serverNow = "2026-06-13T00:00:30.000Z"; // advance the server clock
    supervisor.start(env);
    const firstInstant = Date.parse(firstSeen ?? "");
    const restarted = await waitFor(async () => {
      health.iso = await pollLastSeen();
      supervisor.tick();
      return supervisor.state() === "running" && Date.parse(health.iso ?? "") > firstInstant;
    });
    expect(restarted).toBe(true);
    expect(Date.parse(health.iso ?? "")).toBeGreaterThan(firstInstant); // updated, fresh after restart
  });
});

/**
 * Seed a linked device + active node token + its computer row, mirroring the #28
 * 3a node-ws auth-gate fixture (`seedNodeToken` in node-ws.test.ts). Returns the
 * raw `sk_device_<lookup>_<secret>` node token. NON-PRODUCTION: the device↔computer
 * link is inserted directly because the real enrollment slice does not exist yet.
 */
async function seedLinkedNodeToken(
  server: TestServer,
  name: string,
  computerId: string,
  iso: string
): Promise<string> {
  const tok = generateDeviceToken();
  await server.db.db.insert(computers).values({
    id: computerId,
    organizationId: "org_default",
    displayName: computerId,
    hostname: computerId,
    os: "windows",
    arch: "x64",
    status: "online",
    createdAt: iso
  });
  await server.db.db.insert(devices).values({
    id: `device_${name}`,
    organizationId: "org_default",
    displayName: name,
    platform: "windows",
    appVersion: "2.0.0",
    computerId,
    enrolledByUserId: "user_owner",
    trust: "active",
    lastSeenAt: null,
    createdAt: iso,
    revokedAt: null
  });
  await server.db.db.insert(deviceTokens).values({
    id: `dtok_${name}`,
    organizationId: "org_default",
    deviceId: `device_${name}`,
    kind: "node",
    tokenLookup: tok.lookup,
    tokenHash: tok.secretHash,
    status: "active",
    createdAt: iso,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null
  });
  return tok.raw;
}

/**
 * NON-PRODUCTION / SEEDED supervisor smoke (#29 follow-up, codex-approved). Proves
 * the supervisor drives a REAL artood child onto the server through the #28 3a
 * device-auth gate's ACCEPT path using a real `sk_device_...` node token bound to a
 * linked computer (NOT the dev-escape `token=dev`). The device↔computer link is
 * seeded directly because the production enrollment slice does not exist yet; once
 * it lands, an enrollment-minted token replaces the seed. Same gate, real child,
 * real token. Gated identically (ARTOO_SUPERVISOR_SMOKE=1), tmpdir-only.
 */
describe.skipIf(!ENABLED)("gated supervisor smoke — seeded non-production device token", () => {
  let server: TestServer | undefined;
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    await server?.close();
    server = undefined;
  });

  it("real sk_device_ token (linked computer + matching hello) -> running -> stop -> restart", async () => {
    if (!existsSync(artoodMain)) {
      throw new Error(`build first: missing ${artoodMain} — run \`npm run build\` before this gated smoke`);
    }

    const wsRoot = mkdtempSync(join(tmpdir(), "artoo-sup-dev-smoke-"));
    cleanups.push(() => rmSync(wsRoot, { recursive: true, force: true }));
    if (!wsRoot.startsWith(tmpdir())) throw new Error("smoke refuses to operate outside the OS temp dir");

    server = await buildTestServer();
    const srv = server;
    // Mutable server clock so a post-restart heartbeat is time-distinguishable.
    let serverNow = "2026-06-13T00:00:00.000Z";
    srv.ctx.clock = { now: () => new Date(serverNow), nowIso: () => serverNow };

    const computerId = "computer_linked";
    // Real device node token bound to a linked computer (seeded link — non-prod).
    const nodeToken = await seedLinkedNodeToken(srv, "supervised", computerId, serverNow);

    await srv.app.listen({ port: 0, host: "127.0.0.1" });
    cleanups.push(() => srv.app.close());
    const addr = srv.app.server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    async function pollLastSeen(): Promise<string | null> {
      const res = await srv.app.inject({
        method: "GET",
        url: `/api/v1/computers/${computerId}/runtimes`
      });
      const runtimes = (res.json().runtimes ?? []) as Array<{ runtime: string; last_seen_at: string | null }>;
      return runtimes.find((r) => r.runtime === "codex")?.last_seen_at ?? null;
    }

    const settings: SupervisorSettings = {
      serverNodeUrl: `ws://127.0.0.1:${port}/api/v1/node`,
      nodeId: computerId, // node.hello.node_id must === the linked computerId
      nodeCredential: nodeToken, // real sk_device_ token (NOT token=dev)
      runtimes: ["codex"],
      allowedRoots: [wsRoot]
    };
    const env = { ...toBootstrapEnv(settings), ARTOO_HEARTBEAT_INTERVAL_MS: "500" };
    const health = { iso: null as string | null };

    const supervisor = createNodeSupervisor({
      spawner: createChildProcessSpawner([process.execPath, artoodMain]),
      health: { lastHeartbeatIso: () => health.iso },
      nowIso: () => serverNow,
      schedule: (fn, ms) => setTimeout(fn, ms),
      staleAfterMs: 60_000
    });
    cleanups.push(() => supervisor.stop());

    // --- start -> real artood connects through the gate's ACCEPT path -> running ---
    supervisor.start(env);
    const up = await waitFor(async () => {
      health.iso = await pollLastSeen();
      supervisor.tick();
      return supervisor.state() === "running";
    });
    expect(up).toBe(true);
    const firstSeen = health.iso;
    // A heartbeat row under the linked computer proves the real device token was
    // accepted (gate bound it to computerId and hello matched) — not dev-escape.
    expect(firstSeen).not.toBeNull();

    // --- stop really ends the child ---
    supervisor.stop();
    expect(await waitFor(() => supervisor.state() === "stopped")).toBe(true);

    // --- restart -> a FRESH heartbeat updates last_seen_at (compare by instant) ---
    serverNow = "2026-06-13T00:00:30.000Z";
    supervisor.start(env);
    const firstInstant = Date.parse(firstSeen ?? "");
    const restarted = await waitFor(async () => {
      health.iso = await pollLastSeen();
      supervisor.tick();
      return supervisor.state() === "running" && Date.parse(health.iso ?? "") > firstInstant;
    });
    expect(restarted).toBe(true);
    expect(Date.parse(health.iso ?? "")).toBeGreaterThan(firstInstant); // updated, fresh after restart
  });
});
