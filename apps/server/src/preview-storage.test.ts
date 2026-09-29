import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PgliteDbClient } from "@artoo/storage";
import { loadMigrationStatements, seed } from "@artoo/db";
import { createSession } from "./auth/auth-service.js";
import { startServer } from "./main.js";
import { adoptLegacyStorage, backupStorage, restoreStorage, unlockStorage } from "./storage-operations.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() { const root = await mkdtemp(join(tmpdir(), "artoo-preview-storage-")); roots.push(root); return root; }
function production(dataRoot: string): NodeJS.ProcessEnv {
  return { NODE_ENV: "production", ARTOO_DATA_DIR: dataRoot, ARTOO_PORT: "0", ARTOO_HOST: "127.0.0.1",
    ARTOO_PAIRING_PEPPER: "preview-storage-test-pepper-only", GOOGLE_CLIENT_ID: "test", GOOGLE_CLIENT_SECRET: "test",
    GOOGLE_REDIRECT_URI: "https://artoo.example.test/auth/google/callback", AUTH_OWNER_EMAILS: "owner@example.test",
    AUTH_ALLOWED_EMAILS: "owner@example.test", AUTH_ENFORCE_API: "0", ARTOO_ENABLE_DEV_ROUTES: "1" };
}

describe("durable production startup and recovery", () => {
  it("protects APIs, excludes fake resources, survives restart and a verified complete backup restore", async () => {
    const root = await temporary();
    const data = join(root, "data");
    let server = await startServer(production(data));
    let closed = false;
    try {
      expect((await server.app.inject({ url: "/health/ready" })).statusCode).toBe(200);
      expect((await server.app.inject({ url: "/api/v1/bootstrap" })).statusCode).toBe(401);
      const session = await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId: "user_owner" });
      const headers = { authorization: `Bearer ${session.raw}` };
      expect((await server.app.inject({ url: "/api/v1/bootstrap", headers })).json().computers).toEqual([]);
      expect((await server.app.inject({ method: "POST", url: "/dev/tasks/nope/run", headers })).statusCode).toBe(404);
      const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", headers,
        payload: { project_id: "proj_artoo", title: "Preserve my task", acceptance_criteria: ["Durable after restore"] } });
      expect(created.statusCode).toBe(201);
      const id = created.json().task.id;
      const bytes = Buffer.from("durable artifact bytes");
      const digest = createHash("sha256").update(bytes).digest("hex");
      await mkdir(join(data, "artifacts"), { recursive: true });
      await writeFile(join(data, "artifacts", digest), bytes);
      await expect(backupStorage(join(data, "db"), join(data, "artifacts"), join(root, "busy"))).rejects.toThrow("locked");
      await expect(unlockStorage(join(data, "db"))).rejects.toThrow("still running");
      await server.close(); closed = true;
      server = await startServer(production(data)); closed = false;
      expect((await server.app.inject({ url: `/api/v1/tasks/${id}`, headers })).json().task.title).toBe("Preserve my task");
      await server.close(); closed = true;
      const backup = join(root, "backup");
      await backupStorage(join(data, "db"), join(data, "artifacts"), backup);
      const restored = join(root, "restored");
      await restoreStorage(backup, restored);
      expect(await readFile(join(restored, "artifacts", digest))).toEqual(bytes);
      server = await startServer(production(restored)); closed = false;
      expect((await server.app.inject({ url: `/api/v1/tasks/${id}`, headers })).json().task.title).toBe("Preserve my task");
      await expect(restoreStorage(backup, restored)).rejects.toThrow("refusing overwrite");
      await writeFile(join(backup, "artifacts", digest), "tampered");
      await expect(restoreStorage(backup, join(root, "corrupt"))).rejects.toThrow("checksum mismatch");
    } finally { if (!closed) await server.close(); }
  // Several cold persistent database boots plus a complete archive restore;
  // allow CPU contention from the other WASM integration tests in the full gate.
  }, 60_000);

  it("fails closed before opening the database and prevents concurrent writers", async () => {
    const root = await temporary();
    await expect(startServer({ ...production(join(root, "invalid")), AUTH_ALLOWED_EMAILS: "" })).rejects.toThrow("production requires");
    const dbDir = join(root, "db");
    const first = await PgliteDbClient.create({ dataDir: dbDir });
    try { await expect(PgliteDbClient.create({ dataDir: dbDir })).rejects.toThrow("locked"); }
    finally { await first.close(); }
    const reopened = await PgliteDbClient.create({ dataDir: dbDir });
    await reopened.close();
  });

  it("adopts the reviewed legacy schema only after backup and upgrades it on next boot", async () => {
    const root = await temporary(); const data = join(root, "data");
    const db = await PgliteDbClient.create({ dataDir: join(data, "db") });
    const legacy = await loadMigrationStatements("0012_team_comms.sql");
    // Simulate the actual pre-journal release, without calling migrate().
    const { sql } = await import("drizzle-orm");
    for (const statement of legacy) await db.db.execute(sql.raw(statement));
    await seed(db, new Date().toISOString(), { demoResources: false, ownerEmail: "owner@example.test" });
    await db.close();
    await adoptLegacyStorage(join(data, "db"), join(data, "artifacts"), join(root, "legacy-backup"), "0012_team_comms.sql");
    expect(JSON.parse(await readFile(join(root, "legacy-backup", "manifest.json"), "utf8")).format).toBe("artoo-backup-v1");
    const server = await startServer(production(data));
    try { expect((await server.app.inject({ url: "/health/ready" })).statusCode).toBe(200); }
    finally { await server.close(); }
  });

  it("recovers a dead lock through a directory alias without allowing two recovery owners", async () => {
    const root = await temporary(); const dbDir = join(root, "db"); const alias = join(root, "alias");
    const db = await PgliteDbClient.create({ dataDir: dbDir }); await db.close();
    await symlink(dbDir, alias, process.platform === "win32" ? "junction" : "dir");
    const lockDir = `${dbDir}.artoo-lock`;
    await mkdir(lockDir); await writeFile(join(lockDir, "owner.json"), JSON.stringify({ pid: 2_000_000_000, hostname: hostname() }));
    const recovered = await Promise.allSettled([unlockStorage(alias), unlockStorage(alias)]);
    expect(recovered.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const restarted = await PgliteDbClient.create({ dataDir: alias });
    try { await expect(unlockStorage(dbDir)).rejects.toThrow("still running"); }
    finally { await restarted.close(); }
  });
});
