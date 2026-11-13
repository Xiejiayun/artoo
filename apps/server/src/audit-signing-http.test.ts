import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AuditBundleExportSchema, GoalAuditBundleExportSchema } from "@artoo/domain";
import { describe, expect, vi } from "vitest";

import { auditKeyIdV1, createAuditSignerV1, verifyAuditExportV1 } from "./audit-signature.js";
import { settledServerFixture } from "./test-fixtures/settled-server-fixture.js";
import { buildTestServer, type BuildTestServerOptions, type TestServer } from "./test-support.js";

const pair = generateKeyPairSync("ed25519");
const keyId = auditKeyIdV1(pair.publicKey);
const ring = {
  version: 1,
  issuer: "artoo:http-test",
  keys: [
    {
      key_id: keyId,
      status: "active",
      public_key_spki_pem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
  ],
};
const signer = createAuditSignerV1(
  pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  ring,
  ring.issuer,
  keyId,
);
describe("signed audit HTTP exports", () => {
  const scope = settledServerFixture(() => ({}));
  const it = scope.it;
  scope.afterEach();
  async function testServer(options: BuildTestServerOptions = {}) {
    const server = await buildTestServer({ ...options, onResourceAcquired: (resource) => scope.own(resource) });
    scope.checkpoint();
    return server;
  }

  async function subjects(s: TestServer) {
    scope.checkpoint();
    const taskResponse = await s.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { project_id: "proj_artoo", title: "Signed task", acceptance_criteria: ["Preserve evidence"] },
    });
    expect(taskResponse.statusCode).toBe(201);
    const goalResponse = await s.app.inject({
      method: "POST",
      url: "/api/v1/goals",
      payload: { project_id: "proj_artoo", title: "Signed goal", objective: "Signed goal evidence" },
    });
    expect(goalResponse.statusCode).toBe(201);
    return {
      task: taskResponse.json().task.id as string,
      room: taskResponse.json().room.id as string,
      goal: goalResponse.json().goal.id as string,
    };
  }
  function exportUrl(kind: "tasks" | "goals", id: string, suffix = "?signing=ed25519-v1") {
    scope.checkpoint();
    return `/api/v1/${kind}/${id}/audit-bundle/export${suffix}`;
  }

  function offline(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    scope.checkpoint();
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("../../../scripts/audit-verify.mjs", import.meta.url)), ...args],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (bytes) => {
        stdout += bytes;
      });
      child.stderr.on("data", (bytes) => {
        stderr += bytes;
      });
      const deadline = setTimeout(() => {
        child.kill();
      }, 15000);
      let spawnError: Error | undefined;
      child.once("error", (error) => {
        spawnError = error;
      });
      child.once("close", (code) => {
        clearTimeout(deadline);
        if (spawnError) reject(spawnError);
        else resolve({ code, stdout, stderr });
      });
    });
  }

  it("preserves exact legacy responses with or without a signer and negotiates task/goal signatures after redaction", async () => {
    const server = await testServer();
    const ids = await subjects(server);
    const message = await server.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${ids.room}/messages`,
      payload: {
        kind: "text",
        body: "ARTOO_TOKEN=sk_agent_audit_secret_1234567890",
        payload: { token: "structured-secret" },
      },
    });
    expect(message.statusCode).toBe(201);
    for (const kind of ["tasks", "goals"] as const) {
      const id = kind === "tasks" ? ids.task : ids.goal;
      const legacy = await server.app.inject({ method: "GET", url: exportUrl(kind, id, "") });
      const deferred = await server.app.inject({ method: "GET", url: exportUrl(kind, id) });
      expect(legacy.statusCode).toBe(200);
      expect(deferred.json()).toEqual(legacy.json());
      (kind === "tasks" ? AuditBundleExportSchema : GoalAuditBundleExportSchema).parse(legacy.json().export);
      server.ctx.auditSigner = signer;
      const configuredLegacy = await server.app.inject({ method: "GET", url: exportUrl(kind, id, "") });
      expect(configuredLegacy.json()).toEqual(legacy.json());
      const signed = await server.app.inject({ method: "GET", url: exportUrl(kind, id) });
      expect(signed.statusCode).toBe(200);
      const envelope = verifyAuditExportV1(signed.json().export, ring);
      expect(envelope.kind).toBe(kind === "tasks" ? "task" : "goal");
      expect(envelope.bundle).toEqual(legacy.json().export.bundle);
      expect(signed.body).not.toContain("sk_agent_audit_secret_1234567890");
      expect(signed.body).not.toContain("structured-secret");
      expect(signed.body).not.toContain("PRIVATE KEY");
      server.ctx.auditSigner = undefined;
    }
  });

  it("rejects unsupported negotiation and cross-organization subjects without invoking signing", async () => {
    const server = await testServer();
    const ids = await subjects(server);
    const sign = vi.fn(signer.sign);
    server.ctx.auditSigner = { sign };
    for (const kind of ["tasks", "goals"] as const) {
      const id = kind === "tasks" ? ids.task : ids.goal;
      for (const suffix of ["?signing=unknown", "?signing=", "?signing=ed25519-v1&signing=ed25519-v1"]) {
        expect((await server.app.inject({ method: "GET", url: exportUrl(kind, id, suffix) })).statusCode).toBe(400);
      }
      server.ctx.organizationId = "org_other";
      expect((await server.app.inject({ method: "GET", url: exportUrl(kind, id) })).statusCode).toBe(404);
      server.ctx.organizationId = "org_default";
    }
    expect(sign).not.toHaveBeenCalled();
  });

  it("requires the existing authenticated user session for both signed routes", async () => {
    const server = await testServer({ authConfig: { enforceApiAuth: true } });
    const sign = vi.fn(signer.sign);
    server.ctx.auditSigner = { sign };
    for (const kind of ["tasks", "goals"] as const) {
      expect((await server.app.inject({ method: "GET", url: exportUrl(kind, "unknown") })).statusCode).toBe(401);
    }
    expect(sign).not.toHaveBeenCalled();
    const start = await server.app.inject({ method: "GET", url: "/auth/google/start?return_to=/channels" });
    const authz = new URL(String(start.headers.location));
    const binding = start.cookies.find((cookie) => cookie.name === "artoo_auth_flow")!.value;
    server.fakeOidc.stageCode(
      "audit-login",
      { sub: "audit-user", email: "audit@example.com", email_verified: true, name: "Audit User" },
      authz.searchParams.get("nonce")!,
    );
    const callback = await server.app.inject({
      method: "GET",
      url: `/auth/google/callback?code=audit-login&state=${encodeURIComponent(authz.searchParams.get("state")!)}`,
      cookies: { artoo_auth_flow: binding },
    });
    expect(callback.statusCode).toBe(302);
    const session = callback.cookies.find((cookie) => cookie.name === "artoo_session")!.value;
    // A real authenticated request reaches the existing subject lookup.
    for (const kind of ["tasks", "goals"] as const)
      expect(
        (
          await server.app.inject({
            method: "GET",
            url: exportUrl(kind, "unknown"),
            cookies: { artoo_session: session },
          })
        ).statusCode,
      ).toBe(404);
    expect(sign).not.toHaveBeenCalled();
    for (const kind of ["tasks", "goals"] as const) {
      const payload =
        kind === "tasks"
          ? { project_id: "proj_artoo", title: "Authenticated task", acceptance_criteria: ["Signed after auth"] }
          : { project_id: "proj_artoo", title: "Authenticated goal", objective: "Signed after auth" };
      const created = await server.app.inject({
        method: "POST",
        url: `/api/v1/${kind}`,
        payload,
        cookies: { artoo_session: session },
      });
      expect(created.statusCode).toBe(201);
      const subject = kind === "tasks" ? created.json().task : created.json().goal;
      const response = await server.app.inject({
        method: "GET",
        url: exportUrl(kind, subject.id),
        cookies: { artoo_session: session },
      });
      expect(response.statusCode).toBe(200);
      expect(verifyAuditExportV1(response.json().export, ring).kind).toBe(kind === "tasks" ? "task" : "goal");
    }
  });

  it("runs the actual offline CLI on an HTTP export and rejects tampering, unsigned data and revoked trust", async () => {
    const server = await testServer();
    const ids = await subjects(server);
    server.ctx.auditSigner = signer;
    const response = await server.app.inject({ method: "GET", url: exportUrl("tasks", ids.task) });
    expect(response.statusCode).toBe(200);
    const root = await scope.temporary("artoo-audit-offline-test-");
    const bundleFile = join(root, "export.json"),
      ringFile = join(root, "trusted-public.json");
    await writeFile(bundleFile, JSON.stringify(response.json().export));
    await writeFile(ringFile, JSON.stringify(ring));
    const valid = await offline([bundleFile, ringFile]);
    expect(valid.code, valid.stderr).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({
      verified: true,
      issuer: ring.issuer,
      key_id: keyId,
      kind: "task",
    });
    const tampered = response.json().export;
    tampered.bundle.task.title = "tampered";
    await writeFile(bundleFile, JSON.stringify(tampered));
    expect((await offline([bundleFile, ringFile])).code).toBe(1);
    await writeFile(bundleFile, JSON.stringify(response.json().export));
    await writeFile(ringFile, JSON.stringify({ ...ring, keys: [{ ...ring.keys[0], status: "revoked" }] }));
    expect((await offline([bundleFile, ringFile])).code).toBe(1);
    const legacy = await server.app.inject({ method: "GET", url: exportUrl("tasks", ids.task, "") });
    await writeFile(bundleFile, JSON.stringify(legacy.json().export));
    expect((await offline([bundleFile, ringFile])).code).toBe(1);
    expect((await offline([bundleFile])).code).toBe(1);
  });
});
