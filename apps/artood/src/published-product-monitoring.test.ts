import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, isAbsolute } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProductReleaseRequest, RunVerificationPayload } from "@artoo/domain";
import * as installation from "./windows-process-installation.js";
import * as nativeProcess from "./owned/windows-owned-process.js";
import * as nativeStorage from "./windows-release-storage.js";
import { prepareVerificationProfiles, attachWindowsVerificationBackend, subjectManifest } from "./verification.js";
import { createProductReleaseExecutor, prepareReleaseProfiles, type ReleaseProfile } from "./product-release.js";
import { acquirePublishedProductOwnership, createPublishedProduct, type PublishedProduct, type PublishedProductOptions } from "./published-product.js";

// Controlled native installation/backend/ACL admission, verification input and
// original node-closure records. No verifier command, model or old node runs.
// The prepared profiles, publisher executor, immutable artifacts, journal state,
// HTTP failure/withdrawal and listener closure are real. This is not native
// installation qualification or a live-provider product acceptance run.
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const parent = realpathSync.native(tmpdir());
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
interface FixtureLifetime { root: string; port?: number; original?: ReturnType<typeof createProductReleaseExecutor>; reopened?: PublishedProduct }
const lifetimes: FixtureLifetime[] = [];

async function assertPortClosed(port: number): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
}
afterEach(async () => {
  try {
    for (const lifetime of lifetimes.splice(0)) {
      // Reopened stop intentionally rejects after withdrawal. Independently bind
      // the original port before deleting this fixture, proving listener closure.
      await lifetime.reopened?.stop().catch(() => {}); await lifetime.original?.stop();
      if (lifetime.port !== undefined) await assertPortClosed(lifetime.port);
      expect(realpathSync.native(lifetime.root)).toBe(lifetime.root);
      const suffix = relative(parent, lifetime.root);
      expect(isAbsolute(suffix) || suffix.startsWith("..")).toBe(false);
      expect(suffix.startsWith("artoo-published-monitoring-")).toBe(true);
      const writable = (directory: string): void => {
        chmodSync(directory, 0o700);
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          expect(entry.isSymbolicLink()).toBe(false);
          const path = join(directory, entry.name);
          if (entry.isDirectory()) writable(path); else chmodSync(path, 0o600);
        }
      };
      writable(lifetime.root); rmSync(lifetime.root, { recursive: true });
    }
  } finally { Object.defineProperty(process, "platform", platform); vi.restoreAllMocks(); }
});

async function fixture() {
  const root = realpathSync.native(mkdtempSync(join(parent, "artoo-published-monitoring-")));
  const lifetime: FixtureLifetime = { root }; lifetimes.push(lifetime);
  const destination = join(root, "destination"), workspace = join(destination, "workspace"), storage = join(destination, "release"), config = join(destination, "config");
  for (const path of [destination, workspace, storage, config, join(workspace, "product")]) mkdirSync(path);
  writeFileSync(join(workspace, "product", "index.html"), "<!doctype html><h1>Healthy original product</h1>");
  const script = join(root, "verify.mjs"); writeFileSync(script, "// Controlled verifier input; this command is never executed.\n");
  const backend = Object.freeze({}) as nativeProcess.PreparedWindowsProcessBackend;
  const storageAuthority = Object.freeze({}) as nativeStorage.PreparedWindowsReleaseStorage;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.spyOn(installation, "prepareWindowsProcessInstallation").mockReturnValue(backend);
  vi.spyOn(nativeProcess, "assertWindowsProcessBackend").mockImplementation(value => { expect(value).toBe(backend); });
  vi.spyOn(nativeStorage, "prepareWindowsReleaseStorage").mockImplementation(input => {
    expect(input).toEqual({ directory: storage, writableWorkspaceRoots: [workspace] }); return storageAuthority;
  });
  const checkStorage = (value: nativeStorage.PreparedWindowsReleaseStorage, directory: string) => {
    expect(value).toBe(storageAuthority); expect(directory).toBe(storage);
  };
  vi.spyOn(nativeStorage, "assertWindowsReleaseStorage").mockImplementation(checkStorage);
  vi.spyOn(nativeStorage, "auditWindowsReleaseStorage").mockImplementation(checkStorage);
  vi.spyOn(nativeStorage, "auditWindowsReleaseStorageBatch").mockImplementation(entries => {
    for (const { storage: value, directory } of entries) checkStorage(value, directory);
  });
  const rawVerifier = { id: "verify", project_id: "project", workspace_root: workspace, subject_paths: ["product"], required_files: ["product/index.html"],
    commands: [{ id: "controlled-input", argv: [process.execPath, script], timeout_ms: 5000 }] };
  const [verifier] = prepareVerificationProfiles([rawVerifier], [workspace]); attachWindowsVerificationBackend(verifier!, backend);
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port; lifetime.port = port;
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const url = `http://127.0.0.1:${port}`;
  const rawProfile: ReleaseProfile = { id: "site", project_id: "project", verification_profile_id: "verify", storage_root: storage,
    output_path: "product", public_url: url, listen_host: "127.0.0.1", listen_port: port,
    health_checks: [{ path: "/", expect_text: "Healthy" }], health_timeout_ms: 5000,
    monitoring: { interval_ms: 3600000, failure_threshold: 1 } };
  const [profile] = prepareReleaseProfiles([rawProfile], [verifier!], { windowsStorage: new Map([[storage, storageAuthority]]), writableRoots: [workspace] });
  const originalOwner = acquirePublishedProductOwnership({ sessionRoot: root, mode: "daily" });
  const executor = createProductReleaseExecutor([profile!]); lifetime.original = executor;
  const digest = subjectManifest(verifier!).digest;
  const evidence: RunVerificationPayload = { version: 1, request_id: "verification-run", profile_id: "verify", profile_digest: verifier!.digest,
    subject_digest: digest, outcome: "passed", checks: [{ id: "controlled-verifier-input", exit_code: 0, duration_ms: 1, output_digest: digest }], required_files: [] };
  executor.recordVerification("run", "project", workspace, evidence);
  const request: ProductReleaseRequest = { version: 1, release_id: "release", goal_id: "goal", project_id: "project", run_id: "run", release_profile_id: "site",
    verification_request_id: evidence.request_id, verification_profile_id: "verify", verification_profile_digest: verifier!.digest, subject_digest: digest };
  const receipt = await executor.release(request); expect(receipt.outcome).toBe("published"); expect(receipt.previous_release_id).toBeNull();
  await executor.checkHealth(); await executor.stop(); await assertPortClosed(port);
  const originalOwnership = originalOwner.release();
  const node = (role: string) => ({ role, registry_disconnected: true, cli: { spawned: true, shutdown_written: true, forced_root_kill: false,
    stdout_eof: true, stderr_eof: true, stopped: { kind: "artoo.supervised.stopped", cleanupConfirmed: true },
    exit: { code: 0, signal: null }, close: { code: 0, signal: null } } });
  const publication = { release_id: request.release_id, run_id: request.run_id, evidence_id: "controlled-evidence", artifact_digest: digest, url,
    request_sha256: sha(JSON.stringify(request)), receipt_sha256: sha(JSON.stringify(receipt)), request, receipt };
  const resultPath = join(root, "RESULT.json");
  writeFileSync(resultPath, JSON.stringify({ version: 1, scope: "windows-local-single-goal", output: root, status: "stopped-after-publication", product_published: true,
    shutdown_confirmed: true, server_closed: true, inputs_unchanged: true, errors: [], logical_goals_created: 1, goal_id: "goal", publication,
    shutdown_control: { version: 1, mode: "stdin", commands: 1, complete: true }, publisher_ownership: originalOwnership, nodes: [node("source"), node("destination")] }));
  const verificationPath = join(config, "verifiers.json"), releasePath = join(config, "releases.json");
  writeFileSync(verificationPath, JSON.stringify([rawVerifier])); writeFileSync(releasePath, JSON.stringify([rawProfile]));
  const originalBytes = readFileSync(resultPath), owner = acquirePublishedProductOwnership({ sessionRoot: root, mode: "reopen" });
  const options: PublishedProductOptions = { version: 1, closedSessionResult: { path: resultPath, bytes: originalBytes.length, sha256: sha(originalBytes) },
    verificationProfilesFile: verificationPath, releaseProfilesFile: releasePath, releaseProfileId: "site",
    windowsProcessInstallation: { directory: root, manifestSha256: `sha256:${"a".repeat(64)}`, writableWorkspaceRoots: [workspace] }, publication, exclusive: owner };
  const product = createPublishedProduct(options); lifetime.reopened = product;
  const artifact = join(storage, "artifacts", digest.slice(7)), artifactFile = join(artifact, "content", "product", "index.html");
  const operationPath = join(storage, "operations", `${sha(request.release_id)}.json`), healthPath = join(storage, "health", `${sha(request.release_id)}.json`);
  return { root, port, url, storage, artifact, artifactFile, operationPath, healthPath, resultPath, verificationPath, releasePath,
    owner, product, request, receipt, verifier: verifier!, digest, profile: profile! };
}

it.each(["startup", "observation"] as const)("keeps real publisher withdrawal policy and rejects a withdrawn product during %s", async phase => {
  const f = await fixture();
  if (phase === "observation") await expect(f.product.start()).resolves.toMatchObject({ release_id: f.request.release_id });
  const pointerPath = join(f.storage, "current.json"), ownerPath = join(f.root, ".published-product-owner", "owner.json");
  const unchangedPaths = [f.resultPath, f.verificationPath, f.releasePath, f.operationPath, join(f.artifact, "manifest.json"), ownerPath];
  const before = unchangedPaths.map(path => ({ path, bytes: readFileSync(path) }));
  const pointerBefore = JSON.parse(readFileSync(pointerPath, "utf8"));
  expect(pointerBefore).toEqual({ release_id: f.request.release_id, artifact_digest: f.digest, release_profile_digest: f.profile.digest });
  expect(JSON.parse(readFileSync(f.healthPath, "utf8"))).toMatchObject({ phase: "monitoring", report: { state: "healthy" } });

  // The actual monitor has already read its expected immutable bytes when it
  // invokes fetch. Hide just this fixture file for that real HTTP GET, then
  // restore it before the state machine evaluates the actual 404 response.
  // Reopening may first reuse a stale socket from the closed daily publisher.
  // Keep the fault armed through the transport's one permitted pre-response
  // retry, and consume it only after an actual Response was delivered.
  const actualFetch = globalThis.fetch; let delivered = 0;
  const attempts: { status?: number; error_code?: unknown }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (delivered || url.origin !== f.url || url.pathname !== "/" || init?.method !== "GET") return actualFetch(input, init);
    const attempt: typeof attempts[number] = {}; attempts.push(attempt);
    expect(attempts.length).toBeLessThanOrEqual(2);
    const directory = dirname(f.artifactFile), mode = statSync(directory).mode & 0o777, hidden = join(f.root, "held-index.html");
    chmodSync(directory, 0o700);
    try {
      renameSync(f.artifactFile, hidden);
      try { const response = await actualFetch(input, init); attempt.status = response.status; delivered++; return response; }
      catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        attempt.error_code = cause && typeof cause === "object" && "code" in cause ? cause.code : "unexpected transport failure";
        throw error;
      }
      finally { renameSync(hidden, f.artifactFile); }
    } finally { chmodSync(directory, mode); }
  });
  const outcome = await (phase === "startup" ? f.product.start() : f.product.observe()).then(
    value => ({ succeeded: true as const, value }), error => ({ succeeded: false as const, error: error as unknown }));
  // These assertions precede the wrapper result so a missing fault cannot be
  // misdiagnosed as the publisher accepting a genuinely withdrawn product.
  expect(attempts.filter(attempt => attempt.status !== undefined)).toEqual([{ status: 404 }]);
  expect(delivered).toBe(1); expect(attempts.length).toBeGreaterThanOrEqual(1); expect(attempts.length).toBeLessThanOrEqual(2);
  if (attempts.length === 2) expect(["ECONNRESET", "UND_ERR_SOCKET"]).toContain(attempts[0]!.error_code);
  expect(outcome.succeeded).toBe(false);
  if (outcome.succeeded) throw new Error("A product with one delivered health failure unexpectedly succeeded");
  expect(outcome.error).toBeInstanceOf(Error); expect((outcome.error as Error).message).toContain("active product version changed");
  expect(JSON.parse(readFileSync(pointerPath, "utf8"))).toBeNull();
  expect(JSON.parse(readFileSync(f.healthPath, "utf8"))).toMatchObject({ phase: "terminal", report: {
    request: f.request, state: "unavailable", active_release_id: null, active_artifact_digest: null, consecutive_failures: 1,
    health_checks: [{ path: "/", status_code: 404, passed: false }],
  } });
  await expect(f.product.stop()).rejects.toThrow("active product version changed"); await assertPortClosed(f.port);
  expect(() => f.owner.release()).toThrow("publisher closure has not been confirmed"); expect(existsSync(ownerPath)).toBe(true);
  for (const file of before) expect(readFileSync(file.path)).toEqual(file.bytes);
  expect(subjectManifest({ ...f.verifier, workspace_root: join(f.artifact, "content") }).digest).toBe(f.digest);
  expect(JSON.parse(readFileSync(f.operationPath, "utf8")).receipt).toEqual(f.receipt);
  expect(JSON.parse(readFileSync(f.releasePath, "utf8"))[0].monitoring).toEqual(f.profile.monitoring);
}, 60000);
