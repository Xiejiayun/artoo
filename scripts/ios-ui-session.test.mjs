import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock } from "@artoo/testkit";
import { buildTestServer } from "../apps/server/dist/test-support.js";
import { createSession, provisionUser, revokeSession } from "../apps/server/dist/auth/auth-service.js";
import { testDeviceAuthConfig } from "../apps/server/dist/config/device-auth.js";
import { nativeUIFixtureSessionConfig, nativeUISuiteTimeouts, selectUISuites } from "../apps/ios/scripts/ui-suite-contract.mjs";

// Exercise the real session store and HTTP authentication with dev escapes off.
// Advancing the server clock avoids waiting an hour or changing suite deadlines.
for (const { suite } of selectUISuites("all")) {
  test(`${suite} fixture can read persisted results through its budget, but expiry and revocation still deny access`, async (t) => {
    const server = await buildTestServer({ authConfig: { enforceApiAuth: true },
      deviceAuth: testDeviceAuthConfig({ devControlEscape: false, devNodeToken: null }) });
    t.after(() => server.close());
    const clock = createFakeClock(server.ctx.clock.now());
    server.ctx.clock = clock;
    const started = clock.now().getTime();
    const member = await provisionUser(server.ctx, { subject: `native-${suite}-member`,
      email: "member@native.test", emailVerified: true, displayName: "Native fixture member" });
    const config = nativeUIFixtureSessionConfig(suite);
    const owner = await createSession(server.ctx, config, { userId: "user_owner" });
    const memberSession = await createSession(server.ctx, config, { userId: member.userId });
    const legacy = await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId: "user_owner" });
    const headers = (session) => ({ authorization: `Bearer ${session.raw}` });
    const created = await server.app.inject({ method: "POST", url: "/api/v1/channels", headers: headers(owner),
      payload: { project_id: "proj_artoo", name: `native-${suite}`, description: "Session lifetime regression" } });
    assert.equal(created.statusCode, 201, created.body);
    const roomPath = `/api/v1/rooms/${created.json().channel.id}/messages`;
    const read = (session) => server.app.inject({ method: "GET", url: roomPath, ...(session ? { headers: headers(session) } : {}) });
    assert.equal((await read()).statusCode, 401);

    clock.advance(nativeUISuiteTimeouts(suite).aggregate);
    for (const session of [owner, memberSession]) {
      const response = await read(session);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().messages, []);
    }
    if (["core", "correction"].includes(suite)) {
      assert.ok(clock.now().getTime() - started > 3_600_000);
      assert.equal((await read(legacy)).statusCode, 401, "The old one-hour session reproduces the post-XCTest failure");
    }

    assert.deepEqual(await revokeSession(server.ctx, memberSession.sessionId), { revoked: true });
    assert.equal((await read(memberSession)).statusCode, 401);
    assert.equal((await read(owner)).statusCode, 200);
    clock.set(new Date(Date.parse(owner.expiresAt) - 1));
    assert.equal((await read(owner)).statusCode, 200);
    clock.advance(1);
    assert.equal((await read(owner)).statusCode, 401, "Fixture sessions remain finite and expire at the exact boundary");
  });
}
