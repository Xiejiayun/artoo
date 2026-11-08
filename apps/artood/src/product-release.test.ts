import { createServer } from "node:net";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProductReleaseRequest, RunVerificationPayload } from "@artoo/domain";
import { createProductReleaseExecutor, prepareReleaseProfiles, loadReleaseProfilesFile, type ReleaseProfile } from "./product-release.js";
import { prepareVerificationProfiles, subjectManifest, verificationSupported } from "./verification.js";

async function unusedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "artoo-publication-")), workspace = join(root, "workspace"), storage = join(root, "releases");
  mkdirSync(workspace); mkdirSync(storage); mkdirSync(join(workspace, "web"));
  writeFileSync(join(workspace, "web", "index.html"), "<h1>Healthy v1</h1>");
  const script = join(root, "verify.mjs"); writeFileSync(script, "process.exit(0)");
  const rawVerifier = { id: "verify", project_id: "project", workspace_root: workspace,
    commands: [{ id: "acceptance", argv: [process.execPath, script], timeout_ms: 5000 }], required_files: ["web/index.html"], subject_paths: ["web"] };
  const [verifier] = prepareVerificationProfiles([rawVerifier]);
  const port = await unusedPort();
  const rawProfile: ReleaseProfile = { id: "site", project_id: "project", verification_profile_id: "verify", storage_root: storage,
    output_path: "web", public_url: `http://127.0.0.1:${port}`, listen_host: "127.0.0.1", listen_port: port,
    health_checks: [{ path: "/", expect_text: "Healthy" }], health_timeout_ms: 2000 };
  const profiles = prepareReleaseProfiles([rawProfile], [verifier!]);
  let executor = createProductReleaseExecutor(profiles);
  const attest = (runId: string): ProductReleaseRequest => {
    const digest = subjectManifest(verifier!).digest;
    const evidence: RunVerificationPayload = { version: 1, request_id: `verification-${runId}`, profile_id: "verify", profile_digest: verifier!.digest,
      subject_digest: digest, outcome: "passed", checks: [{ id: "fixture", exit_code: 0, duration_ms: 1, output_digest: digest }], required_files: [] };
    // The release tests inject measured-verification input. POSIX fixture executes the actual acceptance subprocess.
    executor.recordVerification(runId, "project", workspace, evidence);
    return { version: 1, release_id: `release-${runId}`, goal_id: "goal", project_id: "project", run_id: runId,
      release_profile_id: "site", verification_request_id: evidence.request_id, verification_profile_id: "verify",
      verification_profile_digest: verifier!.digest, subject_digest: digest };
  };
  return { root, workspace, storage, rawVerifier, rawProfile, verifier: verifier!, profiles, attest, get executor() { return executor; },
    async restart() { await executor.stop(); executor = createProductReleaseExecutor(profiles); await executor.start(); },
    async close() {
      await executor.stop();
      const writable = (path: string) => { chmodSync(path, 0o700); for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name); if (entry.isDirectory()) writable(child); else chmodSync(child, 0o600);
      } };
      writable(root); rmSync(root, { recursive: true, force: true });
    } };
}

describe("target-product static publication", () => {
  it.runIf(verificationSupported())("publishes a measured immutable snapshot, serves actual bytes and replays after restart", async () => {
    const f = await fixture();
    try {
      const request = f.attest("run-1"), receipt = await f.executor.release(request);
      expect(receipt).toMatchObject({ outcome: "published", endpoint: f.rawProfile.public_url, artifact_digest: request.subject_digest });
      expect(receipt.health_checks).toEqual([expect.objectContaining({ passed: true, status_code: 200 })]);
      const response = await fetch(f.rawProfile.public_url); expect(await response.text()).toContain("Healthy v1");
      expect(response.headers.get("x-artoo-artifact-digest")).toBe(request.subject_digest);
      writeFileSync(join(f.workspace, "web", "index.html"), "unverified working copy");
      expect(await (await fetch(f.rawProfile.public_url)).text()).toContain("Healthy v1");
      await f.restart();
      expect(await f.executor.release(request)).toEqual(receipt);
      expect(await (await fetch(f.rawProfile.public_url)).text()).toContain("Healthy v1");
      await expect(f.executor.release({ ...request, subject_digest: `sha256:${"a".repeat(64)}` })).rejects.toThrow(/different immutable request/);
    } finally { await f.close(); }
  });
  it.runIf(verificationSupported())("rolls back a newly published version when actual HTTP health fails and keeps the previous version available", async () => {
    const f = await fixture();
    try {
      const first = f.attest("first"); expect((await f.executor.release(first)).outcome).toBe("published");
      writeFileSync(join(f.workspace, "web", "index.html"), "<h1>Broken v2</h1>");
      const second = f.attest("second"), receipt = await f.executor.release(second);
      expect(receipt).toMatchObject({ outcome: "rolled_back", endpoint: null, previous_release_id: first.release_id });
      expect(receipt.health_checks[0]).toMatchObject({ status_code: 200, passed: false });
      expect(await (await fetch(f.rawProfile.public_url)).text()).toContain("Healthy v1");
      await f.restart(); expect(await f.executor.release(second)).toEqual(receipt);
    } finally { await f.close(); }
  });
  it.runIf(verificationSupported())("refuses changed source and remote-only verification claims before activating a version", async () => {
    const f = await fixture();
    try {
      const request = f.attest("source"); writeFileSync(join(f.workspace, "web", "index.html"), "changed");
      expect(await f.executor.release(request)).toMatchObject({ outcome: "failed", artifact_digest: null, reason: expect.stringContaining("changed since verified") });
      const forged = { ...request, release_id: "forged", run_id: "unknown" };
      expect(await f.executor.release(forged)).toMatchObject({ outcome: "failed", reason: expect.stringContaining("no matching local") });
      expect((await fetch(f.rawProfile.public_url)).status).toBe(503);
    } finally { await f.close(); }
  });
  it("blocks release storage as coding workspace and refuses profile/config scope widening", async () => {
    const f = await fixture();
    try {
      expect(() => prepareReleaseProfiles([{ ...f.rawProfile, storage_root: f.workspace }], [f.verifier])).toThrow(/outside/);
      expect(() => prepareReleaseProfiles([{ ...f.rawProfile, output_path: "unverified" }], [f.verifier])).toThrow(/covered/);
      expect(() => prepareReleaseProfiles([{ ...f.rawProfile, health_checks: [{ path: "/%2e%2e/secret" }] }], [f.verifier])).toThrow(/invalid public/);
      for (const monitoring of [{ interval_ms: 999, failure_threshold: 2 }, { interval_ms: 3600001, failure_threshold: 2 },
        { interval_ms: 1000, failure_threshold: 0 }, { interval_ms: 1000, failure_threshold: 11 },
        { interval_ms: 1000, failure_threshold: 2, command: "untrusted" }]) {
        expect(() => prepareReleaseProfiles([{ ...f.rawProfile, monitoring }], [f.verifier])).toThrow(/invalid monitoring/);
      }
      const monitored = prepareReleaseProfiles([{ ...f.rawProfile, monitoring: { interval_ms: 1000, failure_threshold: 2 } }], [f.verifier]);
      expect(monitored[0]!.digest).not.toBe(f.profiles[0]!.digest);
      expect(Object.isFrozen(monitored[0]!.monitoring)).toBe(true);
      expect(() => f.executor.assertWorkspaceBoundary({ workspace: { root: join(f.storage, "missing-child") } } as never)).toThrow(/protected/);
      const path = join(f.workspace, "release.json"); writeFileSync(path, JSON.stringify([f.rawProfile]));
      expect(() => loadReleaseProfilesFile(path, [f.rawVerifier])).toThrow(/outside every/);
    } finally { await f.close(); }
  });
  it.runIf(verificationSupported())("detects stored artifact tampering when serving and when a later release references the same source", async () => {
    const f = await fixture();
    try {
      const request = f.attest("original"); await f.executor.release(request);
      const path = join(f.storage, "artifacts", request.subject_digest.slice(7), "content", "web", "index.html");
      chmodSync(path, 0o600); writeFileSync(path, "modified artifact");
      expect((await fetch(f.rawProfile.public_url)).status).toBe(404);
      const second = f.attest("later");
      expect(await f.executor.release(second)).toMatchObject({ outcome: "failed", reason: expect.stringContaining("stored release artifact changed") });
      expect(readFileSync(join(f.workspace, "web", "index.html"), "utf8")).toContain("Healthy v1");
    } finally { await f.close(); }
  });
  it.runIf(!verificationSupported())("rejects execution on an unsupported worker before publication", async () => {
    const f = await fixture();
    try { await expect(f.executor.release({} as never)).rejects.toThrow(/Linux or macOS/); }
    finally { await f.close(); }
  });
});
