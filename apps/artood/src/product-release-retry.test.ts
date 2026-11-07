// Controlled verification admission only. HTTP publication, failure, rollback and listener closure are real.
// This suite does not qualify the native verifier or manufacture an H7 author/review owner.
import { createHash } from "node:crypto";
import { createServer, request as httpRequest, type ClientRequest } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalProductReleaseRequest, canonicalReleaseJson, type ProductReleaseReceipt, type ProductReleaseRequest, type RunVerificationPayload } from "@artoo/domain";
import * as verification from "./verification.js";
import { prepareVerificationProfiles, subjectManifest } from "./verification.js";
import { createProductReleaseExecutor, prepareReleaseProfiles, readPreparedProductReleaseRetry } from "./product-release.js";

const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
afterEach(() => vi.restoreAllMocks());
function retryRequest(receipt: ProductReleaseReceipt, id = "retry-1"): ProductReleaseRequest {
  if (!receipt.retry_source) throw Error("Expected an original closed failure projection");
  return { ...receipt.request, release_id: id, retry: { version: 1, root_release_id: receipt.request.retry?.root_release_id ?? receipt.request.release_id,
    previous_release_id: receipt.request.release_id, generation: (receipt.request.retry?.generation ?? 0) + 1, source_id: receipt.retry_source.source_id,
    previous_request_digest: sha(canonicalProductReleaseRequest(receipt.request)), previous_receipt_digest: sha(canonicalReleaseJson(receipt)),
    authorization: { event_id: id + "-authorized", actor_user_id: "user", goal_id: receipt.request.goal_id,
      attempt_index: (receipt.request.retry?.authorization.attempt_index ?? 0) + 1 } } };
}
async function fixture() {
  vi.spyOn(verification, "verificationSupported").mockReturnValue(true);
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, "artoo-release-retry-")));
  const workspace = join(root, "workspace"), storage = join(root, "storage"), verifierScript = join(root, "verify.mjs");
  mkdirSync(workspace); mkdirSync(join(workspace, "web")); mkdirSync(storage);
  writeFileSync(join(workspace, "web/index.html"), "<h1>Healthy v1</h1>"); writeFileSync(verifierScript, "process.exit(0)");
  const temporary = createServer(); await new Promise<void>(resolve => temporary.listen(0, "127.0.0.1", resolve));
  const backendPort = (temporary.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => temporary.close(error => error ? reject(error) : resolve()));
  let rejectNext = false, hangNext = false, session: object | undefined = Object.freeze({});
  let heldResolve!: () => void; const held = new Promise<void>(resolve => { heldResolve = resolve; });
  const outgoing = new Set<ClientRequest>();
  const proxy = createServer((request, response) => {
    if (rejectNext) { rejectNext = false; response.writeHead(503).end("Controlled transient publication failure"); return; }
    if (hangNext) { hangNext = false; heldResolve(); return; }
    const forwarding = httpRequest({ hostname: "127.0.0.1", port: backendPort, path: request.url, method: "GET" }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response);
    });
    outgoing.add(forwarding); forwarding.once("close", () => outgoing.delete(forwarding));
    forwarding.once("error", () => { if (!response.destroyed) response.writeHead(502).end("Backend unavailable"); }); forwarding.end();
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const publicUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const [verifier] = prepareVerificationProfiles([{ id: "verify", project_id: "project", workspace_root: workspace,
    commands: [{ id: "check", argv: [process.execPath, verifierScript], timeout_ms: 5000 }], required_files: ["web/index.html"], subject_paths: ["web"] }]);
  const profiles = prepareReleaseProfiles([{ id: "site", project_id: "project", verification_profile_id: "verify", storage_root: storage,
    output_path: "web", public_url: publicUrl, listen_host: "127.0.0.1", listen_port: backendPort,
    health_checks: [{ path: "/", expect_text: "Healthy" }], health_timeout_ms: 1000 }], [verifier!]);
  let executor = createProductReleaseExecutor(profiles, { retrySession: () => session });
  const peers: ReturnType<typeof createProductReleaseExecutor>[] = [];
  function attest(id: string): ProductReleaseRequest {
    const subject = subjectManifest(verifier!).digest;
    const evidence: RunVerificationPayload = { version: 1, request_id: id + "-verification", profile_id: verifier!.id, profile_digest: verifier!.digest,
      subject_digest: subject, outcome: "passed", checks: [{ id: "controlled-verifier-input", exit_code: 0, duration_ms: 1, output_digest: subject }], required_files: [] };
    executor.recordVerification(id, "project", workspace, evidence);
    return { version: 1, release_id: id + "-release", goal_id: "goal", project_id: "project", run_id: id, release_profile_id: profiles[0]!.id,
      verification_request_id: evidence.request_id, verification_profile_id: verifier!.id, verification_profile_digest: verifier!.digest, subject_digest: subject };
  }
  return { get executor() { return executor; }, publicUrl, workspace, attest,
    failNext() { rejectNext = true; }, timeoutNext() { hangNext = true; }, waitUntilHeld: () => held, newSession() { session = Object.freeze({}); },
    writeSource(text: string) { writeFileSync(join(workspace, "web/index.html"), text); },
    async replaceExecutor() { await executor.stop(); executor = createProductReleaseExecutor(profiles, { retrySession: () => session }); },
    createPeerExecutor() { const peer = createProductReleaseExecutor(profiles, { retrySession: () => session }); peers.push(peer); return peer; },
    async assertBackendClosed() {
      const probe = createServer(); await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(backendPort, "127.0.0.1", resolve); });
      await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    },
    async close() {
      for (const peer of peers) await peer.stop();
      await executor.stop();
      for (const request of outgoing) request.destroy();
      await new Promise<void>((resolve, reject) => { proxy.close(error => error ? reject(error) : resolve()); proxy.closeAllConnections(); });
      const descendant = relative(parent, realpathSync.native(root));
      if (isAbsolute(descendant) || descendant.startsWith("..") || !descendant.startsWith("artoo-release-retry-")) throw Error("Unsafe fixture cleanup path");
      function writable(directory: string): void {
        chmodSync(directory, 0o700);
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const file = join(directory, entry.name); if (entry.isSymbolicLink()) throw Error("Unexpected fixture link");
          if (entry.isDirectory()) writable(file); else chmodSync(file, 0o600);
        }
      }
      writable(root); rmSync(root, { recursive: true });
    },
  };
}

describe("original executor publication retry authority", () => {
  it("closes a failed first listener, publishes a new immutable attempt, and replays both receipts", async () => {
    const f = await fixture();
    try {
      f.failNext(); const first = f.attest("first"), failed = await f.executor.release(first);
      expect(failed).toMatchObject({ outcome: "rolled_back", previous_release_id: null, retry_source: { closure: "local-release-settled.v1", recovery: { kind: "listener-closed" } } });
      expect(f.executor.isAttemptSettled(first)).toBe(true); await f.assertBackendClosed();
      const next = retryRequest(failed), permit = f.executor.prepareRetry(next);
      expect(f.executor.prepareRetry(structuredClone(next))).toBe(permit);
      expect(() => readPreparedProductReleaseRetry(structuredClone(permit))).toThrow("original exact");
      await expect(f.executor.release(next)).rejects.toThrow("original local permit");
      const published = await f.executor.release(next, { retry: permit });
      expect(published.outcome).toBe("published"); expect(published.retry_source).toBeUndefined();
      expect(await (await fetch(f.publicUrl)).text()).toContain("Healthy v1");
      expect(await f.executor.release(first)).toEqual(failed);
      expect(await f.executor.release(next)).toEqual(published);
    } finally { await f.close(); }
  });
  it("keeps the restored previous version serving while preparing and executing a retry", async () => {
    const f = await fixture();
    try {
      const old = f.attest("old"); expect((await f.executor.release(old)).outcome).toBe("published");
      f.writeSource("<h1>Healthy v2</h1>"); f.failNext();
      const candidate = f.attest("candidate"), failed = await f.executor.release(candidate);
      expect(failed.retry_source?.recovery).toEqual({ kind: "previous-restored", active_release_id: old.release_id, active_artifact_digest: old.subject_digest });
      expect(failed.previous_release_id).toBe(old.release_id);
      const next = retryRequest(failed), permit = f.executor.prepareRetry(next);
      expect(await (await fetch(f.publicUrl)).text()).toContain("Healthy v1");
      expect((await f.executor.release(next, { retry: permit })).outcome).toBe("published");
      expect(await (await fetch(f.publicUrl)).text()).toContain("Healthy v2");
      expect(f.executor.replayReceipt(candidate)).toEqual(failed);
    } finally { await f.close(); }
  });
  it("rejects a changed request, a second successor, changed source and another session", async () => {
    const f = await fixture();
    try {
      f.failNext(); const failed = await f.executor.release(f.attest("first")), next = retryRequest(failed);
      expect(() => f.executor.prepareRetry({ ...next, run_id: "other" })).toThrow("immutable predecessor");
      expect(() => f.executor.prepareRetry({ ...next, retry: { ...next.retry!, previous_receipt_digest: sha("wrong") } })).toThrow("immutable predecessor");
      f.executor.prepareRetry(next);
      expect(() => f.executor.prepareRetry({ ...next, release_id: "competing" })).toThrow("original exact");
      f.writeSource("<h1>Changed after validation</h1>"); expect(() => f.executor.prepareRetry(next)).toThrow("source changed");
      f.writeSource("<h1>Healthy v1</h1>"); f.newSession(); expect(() => f.executor.prepareRetry(next)).toThrow("original live authenticated session");
    } finally { await f.close(); }
  });
  it("does not rebuild an original retry source from terminal JSON after replacing the executor", async () => {
    const f = await fixture();
    try {
      f.failNext(); const request = f.attest("first"), failed = await f.executor.release(request), next = retryRequest(failed);
      await f.replaceExecutor();
      expect(f.executor.replayReceipt(request)).toEqual(failed);
      expect(() => f.executor.prepareRetry(next)).toThrow("original live publication retry source is unavailable");
      await f.assertBackendClosed();
    } finally { await f.close(); }
  });
  it("does not accept a live permit from a different executor sharing the same profile and session", async () => {
    const f = await fixture();
    try {
      f.failNext(); const failed = await f.executor.release(f.attest("first")), next = retryRequest(failed);
      const permit = f.executor.prepareRetry(next), peer = f.createPeerExecutor();
      await expect(peer.release(next, { retry: permit })).rejects.toThrow("this original executor");
      expect(f.executor.prepareRetry(next)).toBe(permit);
      expect((await f.executor.release(next, { retry: permit })).outcome).toBe("published");
    } finally { await f.close(); }
  });
  it("keeps the returned permit record immutable and rejects request or session bypasses", async () => {
    const f = await fixture();
    try {
      f.failNext(); const failed = await f.executor.release(f.attest("first")), next = retryRequest(failed);
      const permit = f.executor.prepareRetry(next), saved = readPreparedProductReleaseRetry(permit, next);
      const changed = { ...next, release_id: "replaced-retry" };
      expect(Object.isFrozen(saved)).toBe(true);
      expect(Reflect.set(saved, "request", changed)).toBe(false);
      expect(Reflect.set(saved, "previousRequest", { ...saved.previousRequest, release_id: "replaced-predecessor" })).toBe(false);
      expect(Reflect.set(saved, "previousReceipt", { ...saved.previousReceipt, outcome: "published" })).toBe(false);
      expect(Reflect.set(saved, "assertCurrent", () => {})).toBe(false);
      expect(readPreparedProductReleaseRetry(permit, next)).toBe(saved);
      expect(saved.request).toEqual(next);
      expect(() => readPreparedProductReleaseRetry(permit, changed)).toThrow("original exact");
      await expect(f.executor.release(changed, { retry: permit })).rejects.toThrow("original exact");
      await f.assertBackendClosed();
      f.newSession();
      expect(() => readPreparedProductReleaseRetry(permit, next)).toThrow("original live authenticated session");
      await expect(f.executor.release(next, { retry: permit })).rejects.toThrow("original live authenticated session");
      await f.assertBackendClosed();
    } finally { await f.close(); }
  });
  it("does not mint retry authority or release an uncertain attempt after an HTTP deadline", async () => {
    const f = await fixture();
    try {
      f.timeoutNext(); const request = f.attest("first"), failed = await f.executor.release(request);
      expect(failed.outcome).not.toBe("published"); expect(failed.retry_source).toBeUndefined();
      expect(f.executor.isAttemptSettled(request)).toBe(false);
    } finally { await f.close(); }
  });
  it("does not turn a cancelled publication into automatic retry authority", async () => {
    const f = await fixture();
    try {
      f.timeoutNext(); const request = f.attest("first"), publishing = f.executor.release(request);
      await Promise.race([f.waitUntilHeld(), publishing.then(() => { throw Error("Publication ended before the controlled health hold"); })]);
      const cancelled = await f.executor.cancel(request);
      expect(await publishing).toEqual(cancelled); expect(cancelled.outcome).not.toBe("published");
      expect(cancelled.retry_source).toBeUndefined();
    } finally { await f.close(); }
  });
});
