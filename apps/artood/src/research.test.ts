import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { productDevelopmentContext, type ContextPack } from "@artoo/domain";
import { createResearchSession, isPublicResearchAddress, prepareResearchOptions, readResearchReceipt, researchUrl } from "./research.js";
import { validateProductStage } from "./product-stage.js";
import { VerificationCleanupError } from "./verification-cleanup-error.js";

const transport = vi.hoisted(() => ({ sourceUrl: "", addresses: [{ address: "93.184.216.34", family: 4 }], lookups: [] as string[],
  afterResponseEnd: undefined as ((signal: AbortSignal) => void) | undefined }));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => transport.addresses) }));
// Test-only routing connects a genuine HTTP source fixture. Production has no private-address bypass.
vi.mock("node:https", async () => {
  const http = await import("node:http");
  return { request: (url: URL, options: { signal: AbortSignal; headers: Record<string, string>; lookup: Function }, callback: Parameters<typeof http.request>[2]) => {
    options.lookup(url.hostname, {}, (_err: Error | null, address: string) => transport.lookups.push(address));
    return http.request(new URL(url.pathname + url.search, transport.sourceUrl), { signal: options.signal, headers: options.headers }, response => {
      callback!(response);
      // Register after download's own end listener. Its full response promise is
      // already resolved when this test-only scheduling seam closes the broker.
      const afterEnd = transport.afterResponseEnd;
      if (afterEnd) response.once("end", () => afterEnd(options.signal));
    });
  } };
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); transport.addresses = [{ address: "93.184.216.34", family: 4 }]; transport.lookups = []; transport.afterResponseEnd = undefined; });
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(realpathSync.native(tmpdir()), "artoo-research-test-"))); roots.push(root);
  const workspace = join(root, "workspace"), receipts = join(root, "receipts"); mkdirSync(workspace);
  const options = prepareResearchOptions({ receiptDirectory: receipts }, [workspace]);
  const binding = { projectId: "project_1", goalId: "goal_1", runId: "run_1", taskId: "task_1", workspaceRoot: workspace };
  return { root, workspace, options, binding };
}
function context(workspace: string): ContextPack {
  return { task: { id: "task_1", title: "Research", description: "Research", acceptance_criteria: ["valid source"] },
    project: { id: "project_1", name: "Product", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    goal_context: { version: 1, goal_id: "goal_1", objective: "Journal", acceptance_criteria: [], plan: null }, product_development: productDevelopmentContext("research") };
}

describe("public research boundary", () => {
  it("rejects private, mapped, metadata, multicast and special-purpose IP ranges", () => {
    for (const value of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.19.1.1", "192.0.2.1", "203.0.113.1", "224.0.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::1"]) expect(isPublicResearchAddress(value), value).toBe(false);
    expect(isPublicResearchAddress("93.184.216.34")).toBe(true);
    expect(isPublicResearchAddress("2606:4700:4700::1111")).toBe(true);
    for (const url of ["http://example.com", "https://127.0.0.1/", "https://user:pass@example.com/", "https://example.com:8443", "https://metadata.google.internal", "https://localhost"]) expect(() => researchUrl(url)).toThrow();
  });
  it("requires protected receipt storage, including a nonexistent child beneath a writable root", () => {
    const f = fixture();
    expect(() => prepareResearchOptions({ receiptDirectory: join(f.workspace, "new", "receipts") }, [f.workspace])).toThrow(/outside/);
    expect(() => prepareResearchOptions({ receiptDirectory: f.root }, [f.workspace])).toThrow(/outside/);
  });
  it("retrieves actual source bytes through its authenticated broker and preserves receipts for later stages", async () => {
    const f = fixture(), content = "<html><title>Journal reference</title><body>Store entries locally.</body></html>";
    const source = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(content));
    await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
    transport.sourceUrl = `http://127.0.0.1:${(source.address() as { port: number }).port}`;
    const session = await createResearchSession(f.options, f.binding);
    try {
      const config = JSON.parse(readFileSync(session.configPath, "utf8")) as { url: string; token: string };
      const denied = await fetch(config.url, { method: "POST", body: "{}" }); expect(denied.status).toBe(403);
      const fetchSource = () => fetch(config.url, { method: "POST", headers: { authorization: `Bearer ${config.token}` }, body: JSON.stringify({ tool: "fetch", url: "https://docs.artoo.dev/article" }) });
      transport.addresses = [{ address: "127.0.0.1", family: 4 }];
      expect((await fetchSource()).status).toBe(400); expect(session.receipts()).toHaveLength(0);
      transport.addresses = [{ address: "93.184.216.34", family: 4 }];
      const response = await fetchSource(); expect(response.status).toBe(200);
      const receipt = await response.json() as { id: string; url: string; title: string; retrieved_at: string; content_digest: string; content_base64?: string };
      expect(receipt.title).toBe("Journal reference"); expect(receipt.content_base64).toBeUndefined();
      expect(receipt.content_digest).toBe(`sha256:${createHash("sha256").update(content).digest("hex")}`);
      expect(transport.lookups).toEqual(["93.184.216.34"]);
      await session.close();
      expect(readResearchReceipt(f.options, receipt.id, f.binding).text).toContain("Store entries locally");
      expect(() => readResearchReceipt(f.options, receipt.id, { ...f.binding, goalId: "different" })).toThrow(/different/);
      mkdirSync(join(f.workspace, ".artoo", "product"), { recursive: true });
      const report = { version: 1, objective: "Journal", assumptions: [], requirements: [{ id: "entries", description: "Persist entries", priority: "must", acceptance_criteria: ["after restart"] }],
        sources: [receipt], findings: [{ summary: "Use local storage", source_ids: [receipt.id] }], decisions: [] };
      writeFileSync(join(f.workspace, ".artoo", "product", "research.json"), JSON.stringify(report));
      expect(validateProductStage(f.workspace, context(f.workspace), f.options)).toHaveLength(1);
      report.sources[0]!.content_digest = `sha256:${"0".repeat(64)}`;
      writeFileSync(join(f.workspace, ".artoo", "product", "research.json"), JSON.stringify(report));
      expect(() => validateProductStage(f.workspace, context(f.workspace), f.options)).toThrow(/receipt/);
    } finally { await session.close(); await new Promise<void>((resolve) => source.close(() => resolve())); }
  });
  it("reports missing local search credentials without fabricating search results", async () => {
    const f = fixture(), session = await createResearchSession(f.options, f.binding);
    try {
      const config = JSON.parse(readFileSync(session.configPath, "utf8")) as { url: string; token: string };
      const response = await fetch(config.url, { method: "POST", headers: { authorization: `Bearer ${config.token}` }, body: JSON.stringify({ tool: "search", query: "local journal" }) });
      expect(response.status).toBe(400); expect(await response.text()).toContain("locally configured Brave");
    } finally { await session.close(); }
  });
  it("bounds close while DNS ignores abort and retains files after DNS finally returns", async () => {
    const f = fixture();
    let entered!: () => void, finish!: (value: Array<{ address: string; family: number }>) => void;
    const pending = new Promise<Array<{ address: string; family: number }>>(done => { finish = done; });
    const started = new Promise<void>(done => { entered = done; });
    // Controlled DNS only; production still pins and validates real public DNS.
    // This controlled replacement implements the all-addresses overload used by
    // download; Node also declares single-address overloads on the same function.
    vi.mocked(lookup).mockImplementationOnce((async (_hostname: string, options: { all?: boolean }) => {
      expect(options.all).toBe(true); entered(); return pending;
    }) as unknown as typeof lookup);
    const session = await createResearchSession(f.options, f.binding); roots.push(dirname(session.configPath));
    const config = JSON.parse(readFileSync(session.configPath, "utf8")) as { url: string; token: string };
    const request = fetch(config.url, { method: "POST", headers: { authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ tool: "fetch", url: "https://docs.artoo.dev/pending" }) }).catch(() => undefined);
    await started;
    try {
      const closing = session.close(); expect(session.close()).toBe(closing);
      const error = await closing.catch(cause => cause as unknown);
      expect(error).toBeInstanceOf(VerificationCleanupError); expect((error as Error).message).toContain("5000ms");
      expect(existsSync(session.configPath)).toBe(true);
      finish([{ address: "93.184.216.34", family: 4 }]); await request; await new Promise<void>(done => setImmediate(done));
      await expect(session.close({ retainFiles: false })).rejects.toBe(error);
      expect(existsSync(session.configPath)).toBe(true); expect(session.receipts()).toEqual([]); expect(transport.lookups).toEqual([]);
    } finally {
      finish([{ address: "93.184.216.34", family: 4 }]); await request; await new Promise<void>(done => setImmediate(done));
      await session.close({ retainFiles: true }).catch(() => undefined);
    }
  }, 10_000);

  it("does not write a receipt when session close aborts after a complete download response", async () => {
    const f = fixture(), content = "<title>Complete controlled source</title><p>All source bytes arrived.</p>";
    let sourceRequests = 0;
    const source = createServer((_req, res) => {
      sourceRequests += 1; res.writeHead(200, { "content-type": "text/html" }).end(content);
    });
    await new Promise<void>(done => source.listen(0, "127.0.0.1", done));
    transport.sourceUrl = `http://127.0.0.1:${(source.address() as { port: number }).port}`;
    const session = await createResearchSession(f.options, f.binding);
    let responseEnded!: () => void, closing: Promise<void> | undefined, signalAtEnd: AbortSignal | undefined, wasAbortedAtEnd: boolean | undefined;
    const ended = new Promise<void>(done => { responseEnded = done; });
    transport.afterResponseEnd = signal => {
      signalAtEnd = signal; wasAbortedAtEnd = signal.aborted;
      // download's end listener has queued its successful continuation. close
      // aborts immediately, before the broker's await-download continuation.
      closing = session.close(); void closing.catch(() => undefined); responseEnded();
    };
    const config = JSON.parse(readFileSync(session.configPath, "utf8")) as { url: string; token: string };
    const request = fetch(config.url, { method: "POST", headers: { authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ tool: "fetch", url: "https://docs.artoo.dev/complete-before-close" }) }).catch(() => undefined);
    try {
      await ended; await closing; await request;
      expect(sourceRequests).toBe(1); expect(transport.lookups).toEqual(["93.184.216.34"]);
      expect(wasAbortedAtEnd).toBe(false); expect(signalAtEnd?.aborted).toBe(true);
      expect(session.receipts()).toEqual([]); expect(readdirSync(f.options.receiptDirectory)).toEqual([]);
      // The admitted handler really finished, so this timely close may remove
      // the session config; no timeout or retained uncertainty is fabricated.
      expect(existsSync(dirname(session.configPath))).toBe(false);
    } finally {
      transport.afterResponseEnd = undefined;
      await session.close(); await request; await new Promise<void>(done => source.close(() => done()));
    }
  }, 10_000);
  it("uses the retrieved URL when an HTML title contains only whitespace or entities", async () => {
    const f = fixture();
    const source = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<title> &nbsp; </title><p>Document content</p>"));
    await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
    transport.sourceUrl = `http://127.0.0.1:${(source.address() as { port: number }).port}`;
    const session = await createResearchSession(f.options, f.binding);
    try {
      const config = JSON.parse(readFileSync(session.configPath, "utf8")) as { url: string; token: string };
      const response = await fetch(config.url, { method: "POST", headers: { authorization: `Bearer ${config.token}` }, body: JSON.stringify({ tool: "fetch", url: "https://docs.artoo.dev/untitled" }) });
      expect(response.status).toBe(200);
      const receipt = await response.json() as { id: string; title: string; url: string };
      expect(receipt.title).toBe(receipt.url);
      expect(readResearchReceipt(f.options, receipt.id, f.binding).title).toBe(receipt.url);
    } finally { await session.close(); await new Promise<void>((resolve) => source.close(() => resolve())); }
  });
});
