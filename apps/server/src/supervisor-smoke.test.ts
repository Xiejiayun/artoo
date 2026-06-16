import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createChildProcessSpawner,
  createNodeSupervisor,
  toBootstrapEnv,
  type SupervisorSettings
} from "@artoo/node-supervisor";
import { afterEach, describe, expect, it } from "vitest";

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
