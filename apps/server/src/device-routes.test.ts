import { afterEach, describe, expect, it } from "vitest";

import { idempotencyKeys } from "@artoo/db";
import { createClaimLimiter } from "./claim-rate-limit.js";
import { buildTestServer, type TestServer } from "./test-support.js";

/**
 * #28 v2-C slice 4b — device pairing/enroll/list/revoke HTTP surface. Drives the
 * real flow that issues device credentials and links a device to a computer,
 * replacing the seeded-row shortcut used by the unit tests.
 */
describe("device HTTP flow (pairing → claim → enroll → list → revoke)", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function createPairing(s: TestServer, body: Record<string, unknown> = {}): Promise<string> {
    const res = await s.app.inject({ method: "POST", url: "/api/v1/devices/pairings", payload: body });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.pairing.status).toBe("pending");
    expect(typeof json.code).toBe("string");
    expect(JSON.stringify(json.pairing)).not.toContain(json.code); // raw code never in metadata
    return json.code as string;
  }

  async function claim(
    s: TestServer,
    code: string,
    platform = "windows",
  ): Promise<{ deviceId: string; nodeToken: string; controlToken: string }> {
    const res = await s.app.inject({
      method: "POST",
      url: "/api/v1/devices/claim",
      payload: { code, platform, app_version: "2.0.0", display_name: "Jeremy's ThinkPad" },
    });
    expect(res.statusCode).toBe(201);
    const json = res.json();
    expect(json.device.trust).toBe("active");
    expect(json.node_token.startsWith("sk_device_")).toBe(true);
    expect(json.control_token.startsWith("sk_device_")).toBe(true);
    return { deviceId: json.device.id, nodeToken: json.node_token, controlToken: json.control_token };
  }

  it("creates a pairing, claims it into a device with two credentials", async () => {
    server = await buildTestServer();
    const code = await createPairing(server);
    const { deviceId } = await claim(server, code);
    expect(deviceId).toMatch(/^device_/);
  });

  it("enrolls the claimed device, links a computer, and lists it", async () => {
    server = await buildTestServer();
    const code = await createPairing(server);
    const { deviceId } = await claim(server, code);

    const enroll = await server.app.inject({
      method: "POST",
      url: `/api/v1/devices/${deviceId}/enroll`,
      payload: {},
    });
    expect(enroll.statusCode).toBe(200);
    const e = enroll.json();
    expect(e.created).toBe(true);
    expect(e.computer_id).toMatch(/^computer_/);

    const list = await server.app.inject({ method: "GET", url: "/api/v1/devices" });
    expect(list.statusCode).toBe(200);
    const found = list.json().devices.find((d: { id: string }) => d.id === deviceId);
    expect(found).toBeDefined();
    expect(found.computer_id).toBe(e.computer_id);
  });

  it("revokes a device idempotently", async () => {
    server = await buildTestServer();
    const code = await createPairing(server);
    const { deviceId } = await claim(server, code);

    const r1 = await server.app.inject({ method: "POST", url: `/api/v1/devices/${deviceId}/revoke`, payload: {} });
    expect(r1.statusCode).toBe(200);
    expect(r1.json().revoked).toBe(true);

    const r2 = await server.app.inject({ method: "POST", url: `/api/v1/devices/${deviceId}/revoke`, payload: {} });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().revoked).toBe(false);
  });

  it("rejects an invalid pairing code uniformly", async () => {
    server = await buildTestServer();
    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/devices/claim",
      payload: { code: "WRON-GCOD", platform: "windows", app_version: "1", display_name: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("rejects enrolling a mobile device (remote control surface, not a node host)", async () => {
    server = await buildTestServer();
    const code = await createPairing(server, { intended_platform: "android" });
    const { deviceId } = await claim(server, code, "android");
    const enroll = await server.app.inject({
      method: "POST",
      url: `/api/v1/devices/${deviceId}/enroll`,
      payload: {},
    });
    expect(enroll.statusCode).toBe(400);
  });

  // ── #28 4b review gate 1: the claim route is exempt from the #34 session
  // guard, but every other /api/v1/devices/* route stays session-gated. ────────
  it("with enforceApiAuth, claim is reachable without a session while the rest are 401-gated", async () => {
    server = await buildTestServer({ authConfig: { enforceApiAuth: true } });

    // Session-gated routes reject an unauthenticated request with 401.
    for (const r of [
      { method: "POST" as const, url: "/api/v1/devices/pairings", payload: {} },
      { method: "GET" as const, url: "/api/v1/devices" },
      { method: "POST" as const, url: "/api/v1/devices/device_x/enroll", payload: {} },
      { method: "POST" as const, url: "/api/v1/devices/device_x/revoke", payload: {} },
    ]) {
      const res = await server.app.inject(r);
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }

    // Claim is NOT 401-gated: it reaches the handler (a bad code -> 400, not 401),
    // proving the pairing code — not a session — is the authority here.
    const claimRes = await server.app.inject({
      method: "POST",
      url: "/api/v1/devices/claim",
      payload: { code: "WRON-GCOD", platform: "windows", app_version: "1", display_name: "x" },
    });
    expect(claimRes.statusCode).toBe(400);
    expect(claimRes.json().error.code).toBe("validation_error");
  });

  // ── #28 4b review gate 3: public claim is bounded per source, and the 429
  // fires BEFORE the code is examined (no code-existence oracle). ──────────────
  it("rate-limits claim attempts and the limit fires regardless of code validity", async () => {
    server = await buildTestServer({ claimLimiter: createClaimLimiter({ capacity: 2, windowMs: 60_000 }) });
    const validCode = await createPairing(server); // a real, claimable code

    const wrong = { code: "WRON-GCOD", platform: "windows", app_version: "1", display_name: "x" };
    // First two attempts are within the bound (wrong code -> 400 validation).
    expect((await server.app.inject({ method: "POST", url: "/api/v1/devices/claim", payload: wrong })).statusCode).toBe(400);
    expect((await server.app.inject({ method: "POST", url: "/api/v1/devices/claim", payload: wrong })).statusCode).toBe(400);

    // The third attempt is denied — and even presenting the VALID code yields 429,
    // not 201, so the limiter response cannot be used to probe code existence.
    const third = await server.app.inject({
      method: "POST",
      url: "/api/v1/devices/claim",
      payload: { code: validCode, platform: "windows", app_version: "2.0.0", display_name: "d" },
    });
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe("rate_limited");
  });

  // ── #28 4b re-review: issuance routes are exempt from the idempotency store,
  // so raw codes/tokens are never persisted and cannot be replayed from it. ────
  it("never persists raw codes/tokens via Idempotency-Key, and replay does not re-return secrets", async () => {
    server = await buildTestServer();

    // Pairing + claim WITH an Idempotency-Key on each (the store would otherwise
    // persist the success body).
    const pairing = await server.app.inject({
      method: "POST",
      url: "/api/v1/devices/pairings",
      headers: { "idempotency-key": "pair-key-1" },
      payload: {},
    });
    const code = pairing.json().code as string;

    const claim = await server.app.inject({
      method: "POST",
      url: "/api/v1/devices/claim",
      headers: { "idempotency-key": "claim-key-1" },
      payload: { code, platform: "windows", app_version: "2.0.0", display_name: "d" },
    });
    expect(claim.statusCode).toBe(201);
    const nodeToken = claim.json().node_token as string;
    const controlToken = claim.json().control_token as string;

    // The idempotency store holds nothing for these routes, and certainly none of
    // the raw secrets anywhere in it.
    const rows = await server.db.db.select().from(idempotencyKeys);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(nodeToken);
    expect(dump).not.toContain(controlToken);
    expect(rows.filter((r) => r.scope.includes("/devices/"))).toHaveLength(0);

    // Replay: re-POST claim with the SAME key + code. It is NOT served from the
    // idempotency store (which would leak the raw tokens); it re-runs and hits the
    // single-use atomic guard (the code is already claimed) -> uniform 400.
    const replay = await server.app.inject({
      method: "POST",
      url: "/api/v1/devices/claim",
      headers: { "idempotency-key": "claim-key-1" },
      payload: { code, platform: "windows", app_version: "2.0.0", display_name: "d" },
    });
    expect(replay.statusCode).toBe(400);
    expect(JSON.stringify(replay.json())).not.toContain(nodeToken);
    expect(JSON.stringify(replay.json())).not.toContain(controlToken);
  });
});
