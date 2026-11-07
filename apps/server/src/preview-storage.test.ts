import { createHash } from "node:crypto";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PgliteDbClient } from "@artoo/storage";
import { loadMigrationStatements, seed } from "@artoo/db";
import { createSession } from "./auth/auth-service.js";
import { DEFAULT_CLAIM_LIMIT } from "./claim-rate-limit.js";
import { startServer } from "./main.js";
import { adoptLegacyStorage, backupStorage, restoreStorage, unlockStorage } from "./storage-operations.js";

import { finishStorageCase, storageCase } from "./test-fixtures/preview-storage-scope.js";

afterEach(finishStorageCase);
function production(dataRoot: string): NodeJS.ProcessEnv {
  return { NODE_ENV: "production", ARTOO_DATA_DIR: dataRoot, ARTOO_PORT: "0", ARTOO_HOST: "127.0.0.1",
    ARTOO_PAIRING_PEPPER: "preview-storage-test-pepper-only", GOOGLE_CLIENT_ID: "test", GOOGLE_CLIENT_SECRET: "test",
    GOOGLE_REDIRECT_URI: "https://artoo.example.test/auth/google/callback", AUTH_OWNER_EMAILS: "owner@example.test",
    AUTH_ALLOWED_EMAILS: "owner@example.test", AUTH_ENFORCE_API: "0", ARTOO_ENABLE_DEV_ROUTES: "1" };
}

describe("durable production startup and recovery", () => {
  it("protects APIs, excludes fake resources, survives restart and a verified complete backup restore", storageCase(async scope => {
    const root = await scope.temporary();
    const data = join(root, "data");
    let server = scope.own(await scope.maintenance(startServer({ ...production(data), ARTOO_TRUSTED_PROXIES: "127.0.0.1, ::1" })));
    let closed = false;
    try {
      scope.checkpoint();
      expect((await server.app.inject({ url: "/health/ready" })).statusCode).toBe(200);
      expect((await server.app.inject({ url: "/api/v1/bootstrap" })).statusCode).toBe(401);
      // Exercise the production environment wiring through the public route:
      // exhausting one forwarded client's allowance must not block its peer.
      const claimAttempt = (forwardedFor: string) => server.app.inject({
        method: "POST", url: "/api/v1/devices/claim", remoteAddress: "127.0.0.1",
        headers: { "x-forwarded-for": forwardedFor },
        payload: { code: "WRON-GCOD", platform: "windows", app_version: "1", display_name: "x" },
      });
      for (let attempt = 0; attempt < DEFAULT_CLAIM_LIMIT.capacity; attempt++) {
        scope.checkpoint();
        expect((await claimAttempt("198.51.100.10")).statusCode).toBe(400);
      }
      expect((await claimAttempt("198.51.100.10")).statusCode).toBe(429);
      expect((await claimAttempt("198.51.100.20")).statusCode).toBe(400);
      scope.checkpoint();
      const session = await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId: "user_owner" });
      const headers = { authorization: `Bearer ${session.raw}` };
      expect((await server.app.inject({ url: "/api/v1/bootstrap", headers })).json().computers).toEqual([]);
      expect((await server.app.inject({ method: "POST", url: "/dev/tasks/nope/run", headers })).statusCode).toBe(404);
      scope.checkpoint();
      const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", headers,
        payload: { project_id: "proj_artoo", title: "Preserve my task", acceptance_criteria: ["Durable after restore"] } });
      expect(created.statusCode).toBe(201);
      const id = created.json().task.id;
      scope.checkpoint();
      const bytes = Buffer.from("durable artifact bytes");
      const digest = createHash("sha256").update(bytes).digest("hex");
      await mkdir(join(data, "artifacts"), { recursive: true });
      await writeFile(join(data, "artifacts", digest), bytes);
      await scope.expectedRejection(backupStorage(join(data, "db"), join(data, "artifacts"), join(root, "busy")), operation => expect(operation).rejects.toThrow("locked"));
      await scope.expectedRejection(unlockStorage(join(data, "db")), operation => expect(operation).rejects.toThrow("still running"));
      await scope.close(server); closed = true; scope.checkpoint();
      server = scope.own(await scope.maintenance(startServer(production(data)))); closed = false; scope.checkpoint();
      expect((await server.app.inject({ url: `/api/v1/tasks/${id}`, headers })).json().task.title).toBe("Preserve my task");
      await scope.close(server); closed = true; scope.checkpoint();
      const backup = join(root, "backup");
      await scope.maintenance(backupStorage(join(data, "db"), join(data, "artifacts"), backup)); scope.checkpoint();
      const restored = join(root, "restored");
      await scope.maintenance(restoreStorage(backup, restored)); scope.checkpoint();
      expect(await readFile(join(restored, "artifacts", digest))).toEqual(bytes);
      server = scope.own(await scope.maintenance(startServer(production(restored)))); closed = false; scope.checkpoint();
      expect((await server.app.inject({ url: `/api/v1/tasks/${id}`, headers })).json().task.title).toBe("Preserve my task");
      await scope.expectedRejection(restoreStorage(backup, restored), operation => expect(operation).rejects.toThrow("refusing overwrite"));
      await writeFile(join(backup, "artifacts", digest), "tampered");
      await scope.expectedRejection(restoreStorage(backup, join(root, "corrupt")), operation => expect(operation).rejects.toThrow("checksum mismatch"));
    } finally { if (!closed) await scope.close(server); }
  // Several cold persistent database boots plus a complete archive restore;
  // allow CPU contention from the other WASM integration tests in the full gate.
  }), 60_000);

  it("fails closed before opening the database and prevents concurrent writers", storageCase(async scope => {
    const root = await scope.temporary();
    await scope.expectedRejection(startServer({ ...production(join(root, "invalid")), AUTH_ALLOWED_EMAILS: "" }).then(resource => scope.own(resource)), operation => expect(operation).rejects.toThrow("production requires"));
    const invalidProxyData = join(root, "invalid-proxy");
    await scope.expectedRejection(startServer({ ...production(invalidProxyData), ARTOO_TRUSTED_PROXIES: "true" }).then(resource => scope.own(resource)), operation => expect(operation).rejects.toThrow("ARTOO_TRUSTED_PROXIES"));
    await expect(access(invalidProxyData)).rejects.toMatchObject({ code: "ENOENT" });
    const dbDir = join(root, "db");
    scope.checkpoint();
    const first = scope.own(await scope.maintenance(PgliteDbClient.create({ dataDir: dbDir })));
    try { scope.checkpoint(); await scope.expectedRejection(PgliteDbClient.create({ dataDir: dbDir }).then(resource => scope.own(resource)), operation => expect(operation).rejects.toThrow("locked")); }
    finally { await scope.close(first); }
    scope.checkpoint();
    const reopened = scope.own(await scope.maintenance(PgliteDbClient.create({ dataDir: dbDir })));
    await scope.close(reopened);
  }));

  it("adopts the reviewed legacy schema only after backup and upgrades it on next boot", storageCase(async scope => {
    const root = await scope.temporary(); const data = join(root, "data");
    const db = scope.own(await scope.maintenance(PgliteDbClient.create({ dataDir: join(data, "db") })));
    try {
      scope.checkpoint();
      const legacy = await loadMigrationStatements("0012_team_comms.sql");
      // Simulate the actual pre-journal release, without calling migrate().
      const { sql } = await import("drizzle-orm");
      for (const statement of legacy) { scope.checkpoint(); await db.db.execute(sql.raw(statement)); }
      await seed(db, new Date().toISOString(), { demoResources: false, ownerEmail: "owner@example.test" });
    } finally { await scope.close(db); }
    scope.checkpoint();
    await scope.maintenance(adoptLegacyStorage(join(data, "db"), join(data, "artifacts"), join(root, "legacy-backup"), "0012_team_comms.sql"));
    scope.checkpoint();
    expect(JSON.parse(await readFile(join(root, "legacy-backup", "manifest.json"), "utf8")).format).toBe("artoo-backup-v1");
    const server = scope.own(await scope.maintenance(startServer(production(data))));
    try { scope.checkpoint(); expect((await server.app.inject({ url: "/health/ready" })).statusCode).toBe(200); }
    finally { await scope.close(server); }
  // Three persistent database opens, one reference database initialization and
  // a complete compressed backup share the same integration budget as above.
  }), 60_000);

  it("recovers a dead lock through a directory alias without allowing two recovery owners", storageCase(async scope => {
    const root = await scope.temporary(); const dbDir = join(root, "db"); const alias = join(root, "alias");
    const db = scope.own(await scope.maintenance(PgliteDbClient.create({ dataDir: dbDir }))); await scope.close(db); scope.checkpoint();
    await symlink(dbDir, alias, process.platform === "win32" ? "junction" : "dir");
    const lockDir = `${dbDir}.artoo-lock`;
    await mkdir(lockDir); await writeFile(join(lockDir, "owner.json"), JSON.stringify({ pid: 2_000_000_000, hostname: hostname() }));
    const recovered = await Promise.allSettled([unlockStorage(alias), unlockStorage(alias)]);
    expect(recovered.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    scope.checkpoint();
    const restarted = scope.own(await scope.maintenance(PgliteDbClient.create({ dataDir: alias })));
    try { scope.checkpoint(); await scope.expectedRejection(unlockStorage(dbDir), operation => expect(operation).rejects.toThrow("still running")); }
    finally { await scope.close(restarted); }
  }));
});
