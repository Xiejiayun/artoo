import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductReleaseReceiptSchema, type ProductReleaseRequest, type ProductReleaseReceipt } from "@artoo/domain";
import type { PreparedVerificationProfile } from "./verification.js";
import type { PreparedReleaseProfile, ProductReleaseExecutorOptions } from "./product-release.js";

// Controlled native admission/executor, real private files and HTTP. These tests
// do not claim native installation qualification or a live-provider product run.
const controlled = vi.hoisted(() => ({ qualify: vi.fn(), storage: vi.fn(), verifiers: [] as unknown[], releases: [] as unknown[],
  prepared: undefined as unknown, create: vi.fn() }));
vi.mock("./windows-process-installation.js", () => ({ prepareWindowsProcessInstallation: controlled.qualify }));
vi.mock("./windows-release-storage.js", () => ({ prepareWindowsReleaseStorage: controlled.storage }));
vi.mock("./verification.js", async original => ({ ...await original<typeof import("./verification.js")>(),
  loadVerificationProfilesFile: () => controlled.verifiers, prepareVerificationProfiles: () => controlled.verifiers,
  attachWindowsVerificationBackend: vi.fn() }));
vi.mock("./product-release.js", async original => ({ ...await original<typeof import("./product-release.js")>(),
  loadReleaseProfilesFile: () => controlled.releases, prepareReleaseProfiles: () => [controlled.prepared],
  createProductReleaseExecutor: controlled.create }));
import { subjectManifest } from "./verification.js";
import { acquirePublishedProductOwnership, createPublishedProduct, type PublishedProductOptions } from "./published-product.js";

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [], listeners: Server[] = [];
async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
}
afterEach(async () => {
  vi.useRealTimers();
  for (const listener of listeners.splice(0)) await close(listener);
  for (const root of roots.splice(0)) {
    expect(realpathSync.native(root)).toBe(root);
    expect(root.startsWith(join(realpathSync.native(tmpdir()), "artoo-published-product-"))).toBe(true);
    rmSync(root, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});
function directory(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-published-product-"))); roots.push(root); return root;
}
async function fixture() {
  const root = directory(), destination = join(root, "destination"), storage = join(destination, "release"), workspace = join(destination, "workspace"), config = join(destination, "config");
  for (const path of [destination, storage, workspace, config, join(storage, "operations"), join(storage, "health"), join(storage, "attestations"), join(storage, "artifacts")]) mkdirSync(path);
  const originalOwner = acquirePublishedProductOwnership({ sessionRoot: root, mode: "daily" });
  const originalReceipt = originalOwner.release();
  const body = "<!doctype html><title>Saved product</title><p>original content</p>";
  const prepared = join(root, "prepared"), content = join(prepared, "content"); mkdirSync(prepared); mkdirSync(content); mkdirSync(join(content, "product"));
  writeFileSync(join(content, "product", "index.html"), body);
  const verifier = { id: "verify", project_id: "project", workspace_root: workspace, subject_paths: ["product"], required_files: [], commands: [],
    digest: `sha256:${"a".repeat(64)}`, trustedFiles: [] } as unknown as PreparedVerificationProfile;
  const manifest = subjectManifest({ ...verifier, workspace_root: content });
  const artifact = join(storage, "artifacts", manifest.digest.slice(7)); mkdirSync(artifact); mkdirSync(join(artifact, "content")); mkdirSync(join(artifact, "content", "product"));
  writeFileSync(join(artifact, "content", "product", "index.html"), body);
  writeFileSync(join(artifact, "manifest.json"), JSON.stringify({ digest: manifest.digest, files: [...manifest.files.values()], directories: manifest.directories }));
  const reservation = createServer(); listeners.push(reservation);
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port; await close(reservation);
  const url = `http://127.0.0.1:${port}`;
  const profile: PreparedReleaseProfile = { id: "site", project_id: "project", verification_profile_id: "verify", storage_root: storage,
    output_path: "product", public_url: url, listen_host: "127.0.0.1", listen_port: port,
    health_checks: [{ path: "/", expect_text: "original content" }], health_timeout_ms: 2000, verifier, digest: `sha256:${"b".repeat(64)}` };
  const request: ProductReleaseRequest = { version: 1, release_id: "release", goal_id: "goal", project_id: "project", run_id: "run",
    release_profile_id: "site", verification_profile_id: "verify", verification_profile_digest: verifier.digest,
    verification_request_id: "verification", subject_digest: manifest.digest };
  const receipt: ProductReleaseReceipt = ProductReleaseReceiptSchema.parse({ request, release_profile_digest: profile.digest,
    artifact_digest: manifest.digest, outcome: "published", endpoint: url, previous_release_id: null,
    health_checks: [{ path: "/", status_code: 200, body_digest: `sha256:${sha(body)}`, passed: true, checked_at: new Date().toISOString() }] });
  const operationPath = join(storage, "operations", `${sha(request.release_id)}.json`);
  writeFileSync(operationPath, JSON.stringify({ request, previous: null, phase: "terminal", receipt }));
  writeFileSync(join(storage, "current.json"), JSON.stringify({ release_id: request.release_id, artifact_digest: manifest.digest, release_profile_digest: profile.digest }));
  const publication = { release_id: request.release_id, run_id: request.run_id, evidence_id: "evidence", artifact_digest: manifest.digest, url,
    request_sha256: sha(JSON.stringify(request)), receipt_sha256: sha(JSON.stringify(receipt)), request, receipt };
  const node = (role: string) => ({ role, registry_disconnected: true, cli: { spawned: true, shutdown_written: true, forced_root_kill: false,
    stdout_eof: true, stderr_eof: true, stopped: { kind: "artoo.supervised.stopped", cleanupConfirmed: true },
    exit: { code: 0, signal: null }, close: { code: 0, signal: null } } });
  const result = { version: 1, scope: "windows-local-single-goal", output: root, status: "stopped-after-publication", product_published: true,
    shutdown_confirmed: true, server_closed: true, inputs_unchanged: true, errors: [], logical_goals_created: 1, goal_id: "goal", publication,
    shutdown_control: { version: 1, mode: "stdin", commands: 1, complete: true }, publisher_ownership: originalReceipt, nodes: [node("source"), node("destination")] };
  const resultPath = join(root, "RESULT.json"); writeFileSync(resultPath, JSON.stringify(result));
  for (const name of ["verifiers.json", "releases.json"]) writeFileSync(join(config, name), "[]");
  const owner = acquirePublishedProductOwnership({ sessionRoot: root, mode: "reopen" });
  const bytes = readFileSync(resultPath);
  const options: PublishedProductOptions = { version: 1, closedSessionResult: { path: resultPath, bytes: bytes.length, sha256: sha(bytes) },
    verificationProfilesFile: join(config, "verifiers.json"), releaseProfilesFile: join(config, "releases.json"), releaseProfileId: "site",
    windowsProcessInstallation: { directory: root, manifestSha256: `sha256:${"c".repeat(64)}`, writableWorkspaceRoots: [workspace] }, publication, exclusive: owner };
  let outputBody = body, outputRelease = request.release_id, hold: (() => Promise<void>) | undefined, requested: (() => void) | undefined;
  const server = createServer(async (_request, response) => {
    requested?.(); if (hold) await hold();
    response.writeHead(200, { "x-artoo-release-id": outputRelease, "x-artoo-artifact-digest": manifest.digest }).end(outputBody);
  }); listeners.push(server);
  const executor = {
    start: vi.fn(async () => { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); }),
    checkHealth: vi.fn(async () => {}), getPublicationReceipts: vi.fn(() => [receipt]), getHealthReports: vi.fn(() => []),
    getHealthFaults: vi.fn(() => []), requestStop: vi.fn(), stop: vi.fn(async () => { await close(server); }),
  };
  controlled.qualify.mockReturnValue({}); controlled.storage.mockReturnValue({}); controlled.verifiers = [verifier]; controlled.releases = [profile]; controlled.prepared = profile;
  let executorOptions: ProductReleaseExecutorOptions | undefined;
  controlled.create.mockImplementation((_profiles, setup: ProductReleaseExecutorOptions) => { executorOptions = setup; return executor; });
  return { root, storage, artifact, result, resultPath, owner, options, receipt, operationPath, executor, server,
    changeBody(value: string) { outputBody = value; }, changeRelease(value: string) { outputRelease = value; },
    fault(error: Error) { executorOptions!.onError!(error); },
    holdNextRequest() {
      let observed!: () => void, finish!: () => void;
      const observedPromise = new Promise<void>(resolve => { observed = resolve; }), gate = new Promise<void>(resolve => { finish = resolve; });
      requested = observed; hold = () => gate; return { observed: observedPromise, finish };
    },
    repin() { writeFileSync(resultPath, JSON.stringify(result)); const value = readFileSync(resultPath);
      return { ...options, closedSessionResult: { path: resultPath, bytes: value.length, sha256: sha(value) } }; },
  };
}

describe("published product ownership (real local filesystem)", () => {
  it("keeps an unchanged owner valid across repeated physical and byte checks", () => {
    const owner = acquirePublishedProductOwnership({ sessionRoot: directory(), mode: "daily" });
    owner.assertHeld(); owner.assertHeld(); owner.assertHeld();
    expect(owner.release().lock_removed).toBe(true);
  });
  it("excludes a second daily or reopen owner and permits a new owner only after exact release", () => {
    const root = directory(), daily = acquirePublishedProductOwnership({ sessionRoot: root, mode: "daily" });
    expect(() => acquirePublishedProductOwnership({ sessionRoot: root, mode: "reopen" })).toThrow();
    const receipt = daily.release(); expect(receipt).toMatchObject({ version: 1, mode: "daily", session_root: root, lock_removed: true });
    expect(() => daily.assertHeld()).toThrow("ended");
    const next = acquirePublishedProductOwnership({ sessionRoot: root, mode: "reopen" });
    expect(next.descriptor.owner_id).not.toBe(daily.descriptor.owner_id); next.release();
  });
  it.each(["changed owner", "extra file"])("retains an uncertain %s instead of deleting it", kind => {
    const root = directory(), owner = acquirePublishedProductOwnership({ sessionRoot: root, mode: "daily" }), lock = join(root, ".published-product-owner");
    writeFileSync(join(lock, kind === "changed owner" ? "owner.json" : "extra"), "not the original owner");
    expect(() => owner.release()).toThrow("identity changed"); expect(existsSync(lock)).toBe(true);
    expect(() => acquirePublishedProductOwnership({ sessionRoot: root, mode: "reopen" })).toThrow();
  });
  it("does not rebind owner metadata after a later write of the same bytes", () => {
    const root = directory(), owner = acquirePublishedProductOwnership({ sessionRoot: root, mode: "daily" });
    const file = join(root, ".published-product-owner", "owner.json"), bytes = readFileSync(file);
    owner.assertHeld(); writeFileSync(file, bytes);
    expect(() => owner.assertHeld()).toThrow("ownership identity changed");
    expect(() => owner.release()).toThrow("ownership identity changed"); expect(existsSync(file)).toBe(true);
  });
  it("does not recover a leftover directory from a nonexistent PID or fabricate an ownership handle", () => {
    const root = directory(); mkdirSync(join(root, ".published-product-owner")); writeFileSync(join(root, ".published-product-owner", "owner.json"), '{"pid":999999999}');
    expect(() => acquirePublishedProductOwnership({ sessionRoot: root, mode: "reopen" })).toThrow();
    expect(() => createPublishedProduct({ version: 1, exclusive: { assertHeld() {} } } as never)).toThrow("original local reopen ownership");
  });
});

describe("saved product reopening (controlled native admission/executor, actual HTTP)", () => {
  it("serves the same bytes and identity, retains ownership until close, and exposes no publication API", async () => {
    const f = await fixture(), product = createPublishedProduct(f.options);
    expect(Object.keys(product).sort()).toEqual(["observe", "start", "stop"]);
    expect(() => f.owner.release()).toThrow("closure");
    const observed = await product.start();
    expect(observed).toMatchObject({ release_id: "release", artifact_digest: f.receipt.artifact_digest, url: f.receipt.endpoint });
    expect(observed.health_checks).toEqual([expect.objectContaining({ passed: true, body_digest: f.receipt.health_checks[0]!.body_digest })]);
    await expect(product.observe()).resolves.toMatchObject({ release_id: "release" });
    await expect(product.stop()).resolves.toEqual({ cleanupConfirmed: true });
    expect(f.server.listening).toBe(false); expect(f.executor.stop).toHaveBeenCalledTimes(1);
    f.owner.release(); expect(existsSync(join(f.root, ".published-product-owner"))).toBe(false);
  });
  it("reuses an admitted start but rejects cached startup once stopping or after its owner ends", async () => {
    const f = await fixture(), product = createPublishedProduct(f.options), gate = f.holdNextRequest();
    const startup = product.start(); expect(product.start()).toBe(startup); await gate.observed;
    const stopping = product.stop(); await expect(product.start()).rejects.toThrow("cannot start a stopped product");
    gate.finish(); await startup; await stopping;
    await expect(product.start()).rejects.toThrow("cannot start a stopped product");
    f.owner.release();
    const next = acquirePublishedProductOwnership({ sessionRoot: f.root, mode: "reopen" });
    await expect(product.start()).rejects.toThrow("cannot start a stopped product");
    expect(f.executor.start).toHaveBeenCalledTimes(1); next.release();
  });
  it("checks original ownership before returning an already successful start", async () => {
    const f = await fixture(), product = createPublishedProduct(f.options), startup = product.start(); await startup;
    expect(product.start()).toBe(startup);
    writeFileSync(join(f.root, ".published-product-owner", "owner.json"), "changed ownership");
    await expect(product.start()).rejects.toThrow("ownership identity changed");
    expect(f.executor.start).toHaveBeenCalledTimes(1);
    await expect(product.stop()).rejects.toThrow("ownership identity changed");
    expect(() => f.owner.release()).toThrow("ownership identity changed");
  });
  it.each(["legacy ownership", "unconfirmed child", "non-stdin stop"])("rejects %s before native admission", async kind => {
    const f = await fixture();
    if (kind === "legacy ownership") (f.result as unknown as Record<string, unknown>).publisher_ownership = undefined;
    else if (kind === "unconfirmed child") f.result.nodes[0]!.cli.stopped.cleanupConfirmed = false;
    else f.result.shutdown_control.mode = "signal";
    expect(() => createPublishedProduct(f.repin())).toThrow(); expect(controlled.qualify).not.toHaveBeenCalled();
  });
  it("compares equivalent journal values without guessing the server's JSON key order", async () => {
    const f = await fixture();
    const request = Object.fromEntries(Object.entries(f.receipt.request).reverse()) as ProductReleaseRequest;
    const receipt = Object.fromEntries(Object.entries({ ...f.receipt, request }).reverse()) as ProductReleaseReceipt;
    Object.assign(f.result.publication, { request, receipt, request_sha256: sha(JSON.stringify(request)), receipt_sha256: sha(JSON.stringify(receipt)) });
    const product = createPublishedProduct(f.repin());
    await expect(product.start()).resolves.toMatchObject({ release_id: "release" });
    await product.stop(); f.owner.release();
  });
  it("retains ownership when original profile bytes change after startup", async () => {
    const f = await fixture(), product = createPublishedProduct(f.options); await product.start();
    writeFileSync(f.options.releaseProfilesFile, "[{}]");
    await expect(product.observe()).rejects.toThrow("pinned local file");
    await expect(product.stop()).rejects.toThrow("pinned local file"); expect(() => f.owner.release()).toThrow("closure");
  });
  it.each(["pending operation", "pending health", "recovery fence", "clean fence", "wrong pointer", "changed artifact"])("rejects %s before starting the listener", async kind => {
    const f = await fixture();
    if (kind === "pending operation") writeFileSync(f.operationPath, JSON.stringify({ phase: "activated" }));
    else if (kind === "pending health") writeFileSync(join(f.storage, "health", `${sha("release")}.json`), JSON.stringify({ phase: "recovering" }));
    else if (kind === "recovery fence" || kind === "clean fence") writeFileSync(join(f.storage, kind === "recovery fence" ? "source-recovery.json" : "source-clean-restart.json"), "{}");
    else if (kind === "wrong pointer") writeFileSync(join(f.storage, "current.json"), "null");
    else writeFileSync(join(f.artifact, "content", "product", "index.html"), "tampered");
    const product = createPublishedProduct(f.options); await expect(product.start()).rejects.toThrow();
    expect(f.executor.start).not.toHaveBeenCalled(); expect(() => f.owner.release()).toThrow("closure");
  });
  it.each(["body", "release header"])("rejects actual HTTP %s mismatches and never grants cleanup after an observation fault", async kind => {
    const f = await fixture(), product = createPublishedProduct(f.options); await product.start();
    if (kind === "body") f.changeBody("different content"); else f.changeRelease("some-other-release");
    await expect(product.observe()).rejects.toThrow("actual published content");
    await expect(product.stop()).rejects.toThrow("actual published content");
    expect(f.server.listening).toBe(false); expect(() => f.owner.release()).toThrow("closure");
  });
  it("waits for an admitted HTTP observation before closing its listener", async () => {
    const f = await fixture(), product = createPublishedProduct(f.options); await product.start();
    const gate = f.holdNextRequest(), observation = product.observe(); await gate.observed;
    const stopping = product.stop(); expect(f.executor.stop).not.toHaveBeenCalled();
    gate.finish(); await observation; await expect(stopping).resolves.toEqual({ cleanupConfirmed: true }); f.owner.release();
  });
  it("keeps ownership when an executor fault removed a listener before stop resolved", async () => {
    const f = await fixture(), product = createPublishedProduct(f.options); await product.start();
    const fault = new Error("controlled storage audit fault"); f.fault(fault); await close(f.server);
    await expect(product.stop()).rejects.toBe(fault); expect(() => f.owner.release()).toThrow("closure");
  });
  it("keeps ownership after a failed stop", async () => {
    const f = await fixture(), product = createPublishedProduct(f.options); await product.start();
    f.executor.stop.mockRejectedValueOnce(new Error("controlled close failure"));
    await expect(product.stop()).rejects.toThrow("controlled close failure"); expect(() => f.owner.release()).toThrow("closure");
  });
  it("does not release ownership when a late stop resolves after its original deadline", async () => {
    const f = await fixture(), product = createPublishedProduct(f.options); await product.start();
    let finish!: () => void; f.executor.stop.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stopping = product.stop(), observed = expect(stopping).rejects.toThrow("closure remains unconfirmed");
    await vi.advanceTimersByTimeAsync(30001); await observed; finish(); await Promise.resolve();
    expect(() => f.owner.release()).toThrow("closure");
  });
  it("keeps the original endpoint and fails a port collision without serving a substitute", async () => {
    const f = await fixture(), occupied = createServer(); listeners.push(occupied);
    await new Promise<void>(resolve => occupied.listen(Number(new URL(f.options.publication.url).port), "127.0.0.1", resolve));
    const product = createPublishedProduct(f.options); await expect(product.start()).rejects.toThrow();
    await expect(product.stop()).rejects.toThrow(); expect(() => f.owner.release()).toThrow("closure");
    expect(readdirSync(f.storage, { withFileTypes: true }).some(entry => entry.name.includes("replacement"))).toBe(false);
  });
});
