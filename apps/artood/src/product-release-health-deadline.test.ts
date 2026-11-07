import { createServer } from "node:net";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import type { ProductReleaseRequest, RunVerificationPayload } from "@artoo/domain";

// Controlled timing regression: the execution gate, clock and verification input are explicit test controls.
// The HTTP server, source bytes, digests, response headers and rollback remain real.
// Native verification/storage/process recovery are qualified by the separate native fixtures.
import * as verification from "./verification.js";
import { prepareVerificationProfiles, subjectManifest } from "./verification.js";
import { createProductReleaseExecutor, prepareReleaseProfiles } from "./product-release.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each([false, true])("checks the original deadline after response identity validation (expired=%s)", async (expired) => {
  // Install the timing fixture's gate after module initialization. importActual
  // in a partial mock can load the release executor through the source-runtime
  // cycle before the replacement export exists, leaving it on the native gate.
  vi.spyOn(verification, "verificationSupported").mockReturnValue(true);
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, "artoo-health-deadline-")));
  const workspace = join(root, "workspace"), storage = join(root, "storage"), script = join(root, "verify.mjs");
  mkdirSync(workspace); mkdirSync(join(workspace, "web")); mkdirSync(storage);
  writeFileSync(join(workspace, "web/index.html"), "<h1>Healthy exact content</h1>"); writeFileSync(script, "process.exit(0)");
  const [verifier] = prepareVerificationProfiles([{ id: "verify", project_id: "project", workspace_root: workspace,
    commands: [{ id: "check", argv: [process.execPath, script], timeout_ms: 5000 }], required_files: ["web/index.html"], subject_paths: ["web"] }]);
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  const [profile] = prepareReleaseProfiles([{ id: "site", project_id: "project", verification_profile_id: "verify", storage_root: storage,
    output_path: "web", public_url: `http://127.0.0.1:${port}`, listen_host: "127.0.0.1", listen_port: port,
    health_checks: [{ path: "/", expect_text: "Healthy" }], health_timeout_ms: 2000 }], [verifier!]);
  const executor = createProductReleaseExecutor([profile!]);
  try {
    const digest = subjectManifest(verifier!).digest;
    const evidence: RunVerificationPayload = { version: 1, request_id: "verification-run", profile_id: "verify", profile_digest: verifier!.digest,
      subject_digest: digest, outcome: "passed", checks: [{ id: "controlled-input", exit_code: 0, duration_ms: 1, output_digest: digest }], required_files: [] };
    // Controlled node-owned verification input, not a claim that the verifier command was run here.
    executor.recordVerification("run", "project", workspace, evidence);
    const request: ProductReleaseRequest = { version: 1, release_id: "release", goal_id: "goal", project_id: "project", run_id: "run",
      release_profile_id: "site", verification_request_id: evidence.request_id, verification_profile_id: "verify",
      verification_profile_digest: verifier!.digest, subject_digest: digest };
    let now = 0, identityMeasured = false;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const actualFetch = globalThis.fetch;
    const observedFetch = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const response = await actualFetch(...args), actualGet = response.headers.get.bind(response.headers);
      vi.spyOn(response.headers, "get").mockImplementation((name: string) => {
        const value = actualGet(name);
        if (name === "x-artoo-artifact-digest") { identityMeasured = true; if (expired) now = profile!.health_timeout_ms + 1; }
        return value;
      });
      return response;
    }); vi.stubGlobal("fetch", observedFetch);
    const receipt = await executor.release(request);
    expect(identityMeasured).toBe(true); expect(observedFetch).toHaveBeenCalledTimes(1);
    expect(receipt.health_checks).toEqual([expect.objectContaining({ status_code: 200, body_digest: expect.stringMatching(/^sha256:/), passed: !expired })]);
    // The existing state machine reports successful restoration of an empty prior pointer as rolled_back.
    expect(receipt.outcome).toBe(expired ? "rolled_back" : "published");
    if (expired) {
      expect(receipt.endpoint).toBeNull(); expect(receipt.previous_release_id).toBeNull();
      expect((await actualFetch(profile!.public_url, { signal: AbortSignal.timeout(2000) })).status).toBe(503);
    }
  } finally {
    await executor.stop();
    expect(realpathSync.native(root)).toBe(root); expect(root.startsWith(join(parent, "artoo-health-deadline-"))).toBe(true);
    const writable = (path: string): void => { chmodSync(path, 0o700); for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name); if (entry.isDirectory()) writable(child); else chmodSync(child, 0o600);
    } };
    writable(root); rmSync(root, { recursive: true, force: true });
  }
});
