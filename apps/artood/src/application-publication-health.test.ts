// Actual bounded loopback HTTP, with controlled original-profile/process seams.
// This suite does not prove a native service, database, candidate or publication.
import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applicationPublicationRequestFixture } from "./test-fixtures/application-publication-request.js";
import type { PreparedApplicationPublicationExecution } from "./application-publication-acceptance.js";
import type { ApplicationPublicationService } from "./application-publication-process.js";
const controlled = vi.hoisted(() => ({ read: vi.fn(), profile: vi.fn() }));
vi.mock("./application-publication-acceptance.js", () => ({ readApplicationPublicationExecution: controlled.read }));
vi.mock("./application-publication-profile.js", () => ({ readApplicationPublicationProfile: controlled.profile }));
import { inspectApplicationPublicationHealth } from "./application-publication-health.js";

const sha = (bytes: string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
let server: Server | undefined;
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
  vi.resetAllMocks();
});

async function fixture(respond?: (path: string, response: ServerResponse) => void) {
  const paths: string[] = [], methods: string[] = [], probes: unknown[] = [], client = "<!doctype html><title>Reviewed application</title>";
  const headers = { "x-artoo-publication-identity": sha("original-service"), "x-artoo-publication-probe": "original-probe" };
  server = createServer((request, response) => {
    paths.push(request.url!); methods.push(request.method!); probes.push(request.headers["x-artoo-publication-probe"]);
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    if (respond) { respond(request.url!, response); return; }
    response.setHeader("content-type", request.url === "/" ? "text/html" : "application/json");
    response.end(request.url === "/" ? client : '{"items":[]}');
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, request = applicationPublicationRequestFixture();
  const facts = { publicationProfile: {}, request, definition: { persistence: { read: { path: "/api/items?limit=1" } } } };
  controlled.read.mockReturnValue(facts); controlled.profile.mockReturnValue({ config: { origin, limits: { health_timeout_ms: 1000 } } });
  const identity = { publication_id: request.publication_id, lease_id: "lease", owner_id: "owner", generation: 2 as const,
    deployment_generation: "deployment", reopen_pin_digest: sha("descriptor"), database_identity: { device: "1", inode: "2" },
    schema_digest: request.author.candidate.schema_digest, scope_digest: sha("scope"), artifact_digest: request.author.candidate.artifact_digest, origin };
  const service = { identity, origin, generation: 2, probe: { requestHeaders: { "x-artoo-publication-probe": "original-probe" }, responseHeaders: headers },
    preflight: { existing_database: true, process_exit_confirmed: true },
    quiesce: vi.fn(async () => {}),
    runProbe: vi.fn(async <T>(_path: string, work: (headers: Readonly<Record<string, string>>) => Promise<T>) => work({})),
    waitForRequestCounters: vi.fn(async () => ({ observed_at: new Date().toISOString(), requests_used: 2, in_flight: 0, closed_transports: 2 })),
    observe: vi.fn(async () => ({ service: identity, requests_used: 0, in_flight: 0 })) } as unknown as ApplicationPublicationService;
  const execution = Object.freeze({}) as PreparedApplicationPublicationExecution;
  const run = (signal = new AbortController().signal) => inspectApplicationPublicationHealth(execution, service,
    { deadline: performance.now() + 2000, signal, clientEntryDigest: sha(client) });
  return { service, run, paths, methods, probes, client, headers, facts };
}

describe("independent application readiness observer", () => {
  it("reads exact client bytes and the captured read-only API without replaying business fixtures", async () => {
    const f = await fixture(), result = await f.run();
    expect(f.paths).toEqual(["/", "/api/items?limit=1"]); expect(f.methods).toEqual(["GET", "GET"]);
    expect(f.probes).toEqual(["original-probe", "original-probe"]);
    expect(f.service.waitForRequestCounters).toHaveBeenCalledWith(2, { deadline: expect.any(Number), signal: expect.any(AbortSignal) });
    expect(result).toMatchObject({ scope: "application-readiness-point-in-time", client: { body_digest: sha(f.client) },
      persistence_read: { path: "/api/items?limit=1", status_code: 200, body_digest: sha('{"items":[]}') } });
  });
  it("rejects a responder with another service identity even if the body matches", async () => {
    const f = await fixture((_path, response) => { response.setHeader("x-artoo-publication-identity", sha("other")); response.end("same"); });
    await expect(f.run()).rejects.toThrow(/identity/); expect(f.paths).toEqual(["/"]);
  });
  it("does not follow a redirect or probe an unconfigured endpoint", async () => {
    const f = await fixture((_path, response) => { response.writeHead(302, { location: "/other" }); response.end(); });
    await expect(f.run()).rejects.toThrow(/framing/); expect(f.paths).toEqual(["/"]);
  });
  it("rejects changed client content before touching the deployment API", async () => {
    const f = await fixture((_path, response) => { response.end("changed application"); });
    await expect(f.run()).rejects.toThrow(/client bytes/); expect(f.paths).toEqual(["/"]);
  });
  it("fails closed before HTTP on revoked original execution or an exhausted request budget", async () => {
    const f = await fixture();
    controlled.read.mockImplementation(() => { throw Error("original execution revoked"); });
    await expect(f.run()).rejects.toThrow(/revoked/); expect(f.paths).toEqual([]);
    controlled.read.mockReturnValue(f.facts);
    vi.mocked(f.service.observe).mockResolvedValue({ service: f.service.identity, requests_used: 254, in_flight: 0 } as never);
    await expect(f.run()).rejects.toThrow(/capacity/); expect(f.paths).toEqual([]);
  });
  it("rejects incomplete HTTP framing and joins cancellation rather than recording readiness", async () => {
    const f = await fixture((_path, response) => { response.setHeader("content-length", "100"); response.write("partial"); response.destroy(); });
    await expect(f.run()).rejects.toThrow();
  });
  it("requires actual existing-database preflight closure before making readiness requests", async () => {
    const f = await fixture();
    Object.assign(f.service.preflight, { process_exit_confirmed: false });
    await expect(f.run()).rejects.toThrow(/preflight/); expect(f.paths).toEqual([]);
  });
  it("includes the initial protected authority audit in the original health timeout", async () => {
    const f = await fixture(), readProfile = controlled.profile.getMockImplementation()!; let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    controlled.profile.mockImplementation((...args) => { const result = readProfile(...args); now = 1000; return result; });
    try { await expect(f.run()).rejects.toThrow(/deadline/); expect(f.paths).toEqual([]); }
    finally { clock.mockRestore(); }
  });
  it.each(["deadline", "abort"])("rechecks %s after the final protected profile audit", async change => {
    const f = await fixture(), controller = new AbortController(), readProfile = controlled.profile.getMockImplementation()!; let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    controlled.profile.mockImplementation((...args) => {
      const result = readProfile(...args);
      if (f.paths.length === 2) { if (change === "deadline") now = 1000; else controller.abort(Error("Controlled audit cancellation")); }
      return result;
    });
    try {
      await expect(f.run(controller.signal)).rejects.toThrow(change === "deadline" ? /deadline/ : /audit cancellation/);
      expect(f.paths).toEqual(["/", "/api/items?limit=1"]); expect(f.service.waitForRequestCounters).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
  it("waits for original stdout counters after both HTTP requests have actually closed", async () => {
    const f = await fixture(); let release!: () => void, settled = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.service.waitForRequestCounters).mockImplementation(async () => { await gate;
      return { observed_at: new Date().toISOString(), requests_used: 2, in_flight: 0, closed_transports: 2 }; });
    const pending = f.run().then(value => { settled = true; return value; });
    try {
      await vi.waitFor(() => expect(f.service.waitForRequestCounters).toHaveBeenCalledOnce());
      expect(f.paths).toEqual(["/", "/api/items?limit=1"]); expect(settled).toBe(false);
    } finally { release(); }
    await expect(pending).resolves.toMatchObject({ scope: "application-readiness-point-in-time" });
    expect(f.paths).toHaveLength(2);
  });
  it.each(["original counter deadline elapsed", "original service closed before progress"])("does not fabricate readiness after %s", async failure => {
    const f = await fixture(); vi.mocked(f.service.waitForRequestCounters).mockRejectedValue(Error(failure));
    await expect(f.run()).rejects.toThrow(failure); expect(f.paths).toHaveLength(2);
  });
});
