import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "../test-support.js";
import type { FakeIdentity } from "./fake-oidc.js";

interface InjectedResponse {
  statusCode: number;
  headers: Record<string, unknown>;
  cookies: Array<{ name: string; value: string }>;
  json: () => { user?: { id: string; email: string; name: string } };
}

function cookie(res: InjectedResponse, name: string): string | undefined {
  return res.cookies.find((c) => c.name === name)?.value;
}

async function startFlow(server: TestServer): Promise<{ state: string; nonce: string; flowBinding: string }> {
  const res = (await server.app.inject({
    method: "GET",
    url: "/auth/google/start?return_to=/board",
  })) as unknown as InjectedResponse;
  expect(res.statusCode).toBe(302);
  const authz = new URL(res.headers.location as string);
  return {
    state: authz.searchParams.get("state") ?? "",
    nonce: authz.searchParams.get("nonce") ?? "",
    flowBinding: cookie(res, "artoo_auth_flow") ?? "",
  };
}

async function login(
  server: TestServer,
  identity: FakeIdentity,
  code = "code-1",
): Promise<{ res: InjectedResponse; session: string | undefined }> {
  const { state, nonce, flowBinding } = await startFlow(server);
  server.fakeOidc.stageCode(code, identity, nonce);
  const res = (await server.app.inject({
    method: "GET",
    url: `/auth/google/callback?code=${code}&state=${encodeURIComponent(state)}`,
    cookies: { artoo_auth_flow: flowBinding },
  })) as unknown as InjectedResponse;
  return { res, session: cookie(res, "artoo_session") };
}

describe("auth routes (e2e via fake OIDC)", () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await buildTestServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it("runs the full start -> callback -> session -> logout flow", async () => {
    const { res, session } = await login(server, {
      sub: "g-1",
      email: "alice@example.com",
      email_verified: true,
      name: "Alice",
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/board");
    expect(session).toBeTruthy();

    const authed = (await server.app.inject({
      method: "GET",
      url: "/auth/session",
      cookies: { artoo_session: session ?? "" },
    })) as unknown as InjectedResponse;
    expect(authed.statusCode).toBe(200);
    expect(authed.json().user).toMatchObject({ email: "alice@example.com", name: "Alice" });

    const anon = (await server.app.inject({ method: "GET", url: "/auth/session" })) as unknown as InjectedResponse;
    expect(anon.statusCode).toBe(401);

    const out = (await server.app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { artoo_session: session ?? "" },
    })) as unknown as InjectedResponse;
    expect(out.statusCode).toBe(204);

    const afterLogout = (await server.app.inject({
      method: "GET",
      url: "/auth/session",
      cookies: { artoo_session: session ?? "" },
    })) as unknown as InjectedResponse;
    expect(afterLogout.statusCode).toBe(401);
  });

  it("rejects a callback with a mismatched flow-binding cookie (no session)", async () => {
    const { state, nonce } = await startFlow(server);
    server.fakeOidc.stageCode("c", { sub: "g-2", email: "b@example.com", email_verified: true }, nonce);
    const res = (await server.app.inject({
      method: "GET",
      url: `/auth/google/callback?code=c&state=${encodeURIComponent(state)}`,
      cookies: { artoo_auth_flow: "wrong-binding" },
    })) as unknown as InjectedResponse;
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/?auth_error=1");
    expect(cookie(res, "artoo_session")).toBeUndefined();
  });

  it("rejects an unverified email at the callback (no session)", async () => {
    const { res, session } = await login(server, {
      sub: "g-3",
      email: "c@example.com",
      email_verified: false,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/?auth_error=1");
    expect(session).toBeUndefined();
  });
});

describe("protected-API guard (enforceApiAuth)", () => {
  let server: TestServer;
  afterEach(async () => {
    await server.close();
  });

  it("returns 401 for a protected API without a session and allows it with one", async () => {
    server = await buildTestServer({ authConfig: { enforceApiAuth: true } });
    const unauth = (await server.app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
    })) as unknown as InjectedResponse;
    expect(unauth.statusCode).toBe(401);

    const { session } = await login(server, { sub: "g-9", email: "d@example.com", email_verified: true });
    const authed = (await server.app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      cookies: { artoo_session: session ?? "" },
    })) as unknown as InjectedResponse;
    expect(authed.statusCode).toBe(200);
  });
});
