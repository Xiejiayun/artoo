import { afterEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

describe("desktop CORS", () => {
  let server: TestServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("answers packaged renderer preflight requests when the desktop origin is allowed", async () => {
    server = await buildTestServer({ desktopCors: { allowedOrigins: ["null"] } });

    const res = await server.app.inject({
      method: "OPTIONS",
      url: "/api/v1/tasks",
      headers: {
        origin: "null",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,idempotency-key",
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("null");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-headers"]).toBe("content-type,idempotency-key");
  });

  it("does not add CORS headers for unconfigured origins", async () => {
    server = await buildTestServer({ desktopCors: { allowedOrigins: ["null"] } });

    const res = await server.app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: { origin: "https://example.invalid" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
