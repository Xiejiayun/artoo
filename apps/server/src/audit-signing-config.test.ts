import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { describe, expect } from "vitest";

import { auditKeyIdV1, verifyAuditExportV1 } from "./audit-signature.js";
import { loadAuditSignerV1 } from "./config/audit-signing.js";
import { startServer } from "./main.js";
import { settledServerFixture } from "./test-fixtures/settled-server-fixture.js";

describe("protected audit signing startup configuration", () => {
  const scope = settledServerFixture(() => ({
    started: performance.now(),
    phases: [] as { phase: string; elapsed_ms: number }[],
  }));
  const it = scope.it;
  scope.beforeEach((state, context) => {
    context.onTestFailed(() => {
      console.error("Audit signing startup phases:", JSON.stringify(state.phases));
    });
  });
  scope.afterEach();
  function phase(name: string) {
    scope.checkpoint();
    const state = scope.current();
    state.phases.push({ phase: name, elapsed_ms: Math.round(performance.now() - state.started) });
  }

  async function fixture() {
    phase("fixture");
    const root = await scope.temporary("artoo-audit-keys-test-");
    const pair = generateKeyPairSync("ed25519");
    const keyId = auditKeyIdV1(pair.publicKey);
    const ring = {
      version: 1,
      issuer: "artoo:config-test",
      keys: [
        {
          key_id: keyId,
          status: "active",
          public_key_spki_pem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
      ],
    };
    const config = {
      version: 1,
      issuer: ring.issuer,
      active_key_id: keyId,
      private_key_file: join(root, "private.pem"),
      public_keyring_file: join(root, "public.json"),
    };
    const configPath = join(root, "config.json");
    await writeFile(config.private_key_file, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    await writeFile(config.public_keyring_file, JSON.stringify(ring));
    await writeFile(configPath, JSON.stringify(config));
    return { root, pair, ring, config, configPath };
  }

  it("loads configured keys through real startup and signs an actual HTTP task export", async () => {
    const f = await fixture();
    phase("starting");
    const runtime = scope.own(
      await startServer({
        NODE_ENV: "development",
        ARTOO_PORT: "0",
        ARTOO_PAIRING_PEPPER: "test-audit-pepper",
        ARTOO_DATA_DIR: join(f.root, "data"),
        ARTOO_DB_DIR: join(f.root, "data", "db"),
        ARTOO_AUDIT_SIGNING_CONFIG: f.configPath,
      }),
    );
    try {
      phase("listening");
      const address = runtime.app.server.address();
      if (!address || typeof address === "string") throw new Error("Expected test TCP port");
      const base = `http://127.0.0.1:${address.port}/api/v1`;
      phase("creating-task");
      const created = await fetch(`${base}/tasks`, {
        signal: scope.context().signal,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: "proj_artoo",
          title: "Configured signature",
          acceptance_criteria: ["Verify the HTTP export"],
        }),
      });
      phase("task-response");
      expect(created.status).toBe(201);
      const task = (await created.json()).task;
      phase("exporting");
      const response = await fetch(`${base}/tasks/${task.id}/audit-bundle/export?signing=ed25519-v1`, {
        signal: scope.context().signal,
      });
      phase("export-response");
      expect(response.status).toBe(200);
      const envelope = verifyAuditExportV1((await response.json()).export, f.ring);
      phase("verified");
      expect(envelope.kind).toBe("task");
      expect(envelope.signing.issuer).toBe(f.config.issuer);
    } finally {
      await runtime.close();
    }
  });

  it("keeps missing configuration deferred and accepts a bound active Ed25519 key", async () => {
    expect(await loadAuditSignerV1({})).toBeUndefined();
    const f = await fixture();
    const signer = await loadAuditSignerV1({ ARTOO_AUDIT_SIGNING_CONFIG: f.configPath });
    expect(signer?.sign).toBeTypeOf("function");
    expect(JSON.stringify(signer)).toBe("{}");
  });

  it.each(["", "relative/config.json", "does-not-exist"])("rejects explicitly invalid paths %#", async (path) => {
    await expect(loadAuditSignerV1({ ARTOO_AUDIT_SIGNING_CONFIG: path })).rejects.toThrow(
      /^ARTOO_AUDIT_SIGNING_CONFIG is invalid; refusing to start$/,
    );
  });

  it.each([
    "malformed",
    "unknown-version",
    "relative-private",
    "missing-private",
    "mismatched-private",
    "wrong-issuer",
    "retired",
    "revoked",
    "wrong-fingerprint",
    "duplicate",
    "private-in-public",
  ])("fails closed for %s without exposing key material", async (mode) => {
    const f = await fixture();
    if (mode === "malformed") await writeFile(f.configPath, '{"secret":"PRIVATE_SENTINEL"');
    if (mode === "unknown-version") await writeFile(f.configPath, JSON.stringify({ ...f.config, version: 2 }));
    if (mode === "relative-private")
      await writeFile(f.configPath, JSON.stringify({ ...f.config, private_key_file: "relative.pem" }));
    if (mode === "missing-private")
      await writeFile(f.configPath, JSON.stringify({ ...f.config, private_key_file: join(f.root, "missing.pem") }));
    if (mode === "mismatched-private")
      await writeFile(
        f.config.private_key_file,
        generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
      );
    if (mode === "wrong-issuer") f.ring.issuer = "artoo:wrong";
    if (mode === "retired" || mode === "revoked") f.ring.keys[0]!.status = mode;
    if (mode === "wrong-fingerprint") f.ring.keys[0]!.key_id = `ed25519-spki-sha256:${"0".repeat(64)}`;
    if (mode === "duplicate") f.ring.keys.push(f.ring.keys[0]!);
    if (mode === "private-in-public")
      f.ring.keys[0]!.public_key_spki_pem = await readFile(f.config.private_key_file, "utf8");
    await writeFile(f.config.public_keyring_file, JSON.stringify(f.ring));
    await expect(loadAuditSignerV1({ ARTOO_AUDIT_SIGNING_CONFIG: f.configPath })).rejects.toThrow(
      /^ARTOO_AUDIT_SIGNING_CONFIG is invalid; refusing to start$/,
    );
  });

  it("rejects invalid configured signing in the real startup before creating data", async () => {
    const f = await fixture();
    await writeFile(f.config.private_key_file, "PRIVATE_SENTINEL invalid key");
    const dataRoot = join(f.root, "data-must-not-exist");
    await expect(
      startServer({
        NODE_ENV: "development",
        ARTOO_PORT: "0",
        ARTOO_PAIRING_PEPPER: "test-audit-pepper",
        ARTOO_DATA_DIR: dataRoot,
        ARTOO_DB_DIR: join(dataRoot, "db"),
        ARTOO_AUDIT_SIGNING_CONFIG: f.configPath,
      }).then((runtime) => scope.own(runtime)),
    ).rejects.toThrow(/^ARTOO_AUDIT_SIGNING_CONFIG is invalid; refusing to start$/);
    expect(existsSync(dataRoot)).toBe(false);
  });
});
