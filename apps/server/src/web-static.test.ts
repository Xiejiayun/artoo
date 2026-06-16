import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

const HTML = "<!doctype html><title>artoo</title><div id=\"root\"></div>";
const HTML_ACCEPT = { accept: "text/html,application/xhtml+xml" };

interface Res {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
}

describe("web static SPA serving (#34)", () => {
  let server: TestServer;
  let distDir: string;

  beforeEach(async () => {
    distDir = mkdtempSync(join(tmpdir(), "artoo-web-dist-"));
    writeFileSync(join(distDir, "index.html"), HTML);
    mkdirSync(join(distDir, "assets"));
    writeFileSync(join(distDir, "assets", "app.js"), "console.log('app');");
    server = await buildTestServer({ webDistDir: distDir });
  });
  afterEach(async () => {
    await server.close();
    rmSync(distDir, { recursive: true, force: true });
  });

  async function get(url: string, headers?: Record<string, string>): Promise<Res> {
    return (await server.app.inject({ method: "GET", url, headers })) as unknown as Res;
  }

  it("serves index.html at root and a built asset", async () => {
    const root = await get("/", HTML_ACCEPT);
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("artoo");
    const asset = await get("/assets/app.js");
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain("console.log");
  });

  it("falls back to index.html for a deep-linked SPA route (navigation)", async () => {
    const deep = await get("/board/runs", HTML_ACCEPT);
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain("artoo");
  });

  it("keeps API/auth 404s as JSON and never serves index.html for them", async () => {
    // unknown API path (html-accepting browser) -> JSON 404, not the SPA
    const unknownApi = await get("/api/v1/does-not-exist", HTML_ACCEPT);
    expect(unknownApi.statusCode).toBe(404);
    expect(unknownApi.body).not.toContain("artoo");
    expect(JSON.parse(unknownApi.body).error.code).toBe("not_found");
    // unknown /auth path -> JSON 404
    const unknownAuth = await get("/auth/nope", HTML_ACCEPT);
    expect(unknownAuth.statusCode).toBe(404);
    expect(unknownAuth.body).not.toContain("artoo");
  });

  it("lets a real API route win over the SPA fallback even for html-accepting requests", async () => {
    const boot = await get("/api/v1/bootstrap", HTML_ACCEPT);
    expect(boot.statusCode).toBe(200);
    expect(boot.body).not.toContain("<!doctype html>");
    expect(JSON.parse(boot.body).actor).toBeDefined();
  });
});
