import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

const HTML = "<!doctype html><title>artoo</title><div id=\"root\"></div>";
const HTML_ACCEPT = { accept: "text/html,application/xhtml+xml" };
const NESTED_CSS = "body { color: #123456; }\n";
const NESTED_JS = "console.log('nested');";
const GUIDE_HTML = "<!doctype html><title>nested guide</title>";
const OUTSIDE_SECRET = "PRIVATE_OUTSIDE_STATIC_ROOT_467";

interface Res {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
}

describe("web static SPA serving (#34)", () => {
  let server: TestServer;
  let fixtureRoot: string;
  let distDir: string;

  beforeEach(async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "artoo-web-dist-"));
    distDir = join(fixtureRoot, "public");
    mkdirSync(distDir);
    writeFileSync(join(distDir, "index.html"), HTML);
    mkdirSync(join(distDir, "assets"));
    writeFileSync(join(distDir, "assets", "app.js"), "console.log('app');");
    mkdirSync(join(distDir, "assets", "deep dir"));
    writeFileSync(join(distDir, "assets", "deep dir", "nested.css"), NESTED_CSS);
    writeFileSync(join(distDir, "assets", "deep dir", "模块[1].js"), NESTED_JS);
    mkdirSync(join(distDir, "docs"));
    writeFileSync(join(distDir, "docs", "index.html"), GUIDE_HTML);
    writeFileSync(join(fixtureRoot, "private.txt"), OUTSIDE_SECRET);
    server = await buildTestServer({ webDistDir: distDir });
  });
  afterEach(async () => {
    await server.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
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

  it("enumerates real nested files and escaped names when wildcard serving is disabled", async () => {
    const css = await get("/assets/deep%20dir/nested.css");
    expect(css.statusCode).toBe(200); expect(css.body).toBe(NESTED_CSS);
    expect(String(css.headers["content-type"])).toMatch(/^text\/css\b/);
    const script = await get("/assets/deep%20dir/" + encodeURIComponent("模块[1].js"));
    expect(script.statusCode).toBe(200); expect(script.body).toBe(NESTED_JS);
    expect(String(script.headers["content-type"])).toMatch(/^(?:application|text)\/javascript\b/);
    const guide = await get("/docs/index.html", HTML_ACCEPT);
    expect(guide.statusCode).toBe(200); expect(guide.body).toBe(GUIDE_HTML);
    expect(String(guide.headers["content-type"])).toMatch(/^text\/html\b/);
    const directory = await get("/docs/", HTML_ACCEPT);
    expect(directory.statusCode).toBe(200); expect(directory.body).toBe(GUIDE_HTML);
  });

  it("serves HEAD metadata for a discovered nested asset without its body", async () => {
    const reply = await server.app.inject({ method: "HEAD", url: "/assets/deep%20dir/nested.css" });
    expect(reply.statusCode).toBe(200); expect(reply.body).toBe("");
    expect(Number(reply.headers["content-length"])).toBe(Buffer.byteLength(NESTED_CSS));
    expect(String(reply.headers["content-type"])).toMatch(/^text\/css\b/);
  });

  it("keeps missing asset and non-navigation directory requests as JSON 404s", async () => {
    for (const url of ["/assets/missing.js", "/assets/deep%20dir/missing.css", "/missing-directory/"]) {
      const reply = await get(url, { accept: "application/json" });
      expect(reply.statusCode).toBe(404);
      expect(JSON.parse(reply.body).error.code).toBe("not_found");
      expect(reply.body).not.toContain("<!doctype html>");
    }
  });

  it("never serves a real file outside the static root through traversal encodings", async () => {
    for (const url of ["/../private.txt", "/assets/../../private.txt",
      "/assets/%2e%2e/%2e%2e/private.txt", "/assets/..%2f..%2fprivate.txt",
      "/assets/..%5c..%5cprivate.txt", "/assets/%252e%252e%252fprivate.txt"]) {
      const reply = await get(url, { accept: "application/octet-stream" });
      expect([400, 403, 404]).toContain(reply.statusCode);
      expect(reply.body).not.toContain(OUTSIDE_SECRET);
    }
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
    // exact namespace ROOTS (no trailing slash) must NOT fall through to the SPA
    for (const root of ["/api", "/auth"]) {
      const res = await get(root, HTML_ACCEPT);
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain("artoo");
      expect(JSON.parse(res.body).error.code).toBe("not_found");
    }
  });

  it("lets a real API route win over the SPA fallback even for html-accepting requests", async () => {
    const boot = await get("/api/v1/bootstrap", HTML_ACCEPT);
    expect(boot.statusCode).toBe(200);
    expect(boot.body).not.toContain("<!doctype html>");
    expect(JSON.parse(boot.body).actor).toBeDefined();
  });
});
