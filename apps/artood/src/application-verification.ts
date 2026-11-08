import { request } from "node:http";
import { win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ApplicationVerificationObservationV1Schema, type ApplicationVerificationObservationV1, type RunStartPayload } from "@artoo/domain";
import { readApplicationRuntimePin } from "./application-runtime-installation.js";
import { readApplicationVerificationProfile, type PreparedApplicationVerificationProfile } from "./application-verification-profile.js";
import { readApplicationVerificationDefinition } from "./application-verification-definition.js";
import { createApplicationVerificationCandidate, readApplicationVerificationCandidate, type PreparedApplicationVerificationCandidate } from "./application-verification-candidate.js";
import { initializeApplicationVerificationStore, readApplicationVerificationStore, startApplicationVerificationService } from "./application-verification-bootstrap-process.js";
import { type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { launchOwnedBrowser, type OwnedBrowser } from "./owned-browser.js";
import { executeBrowserProgramV3 } from "./web-acceptance-pages.js";
import { inspectPage } from "./web-acceptance.js";
import { canonicalWebAcceptance as canonical, webAcceptanceDigest as sha } from "./web-acceptance-identity.js";
import { VerificationCleanupError } from "./verification-cleanup-error.js";

const candidates = new WeakMap<PreparedApplicationVerificationProfile, Map<string, PreparedApplicationVerificationCandidate>>();
type Subject = { digest: string; files: ReadonlyMap<string, { checksum: string; size: number }> };
export interface ApplicationVerificationRun { readonly nodeId: string; readonly runStart: RunStartPayload }

/** Fixed same-origin API request. No redirects, pool, forwarded credentials or
 * body-selected method; response end and the original request close are awaited. */
async function api(origin: string, method: "POST" | "GET", path: string, body: unknown, deadline: number, signal: AbortSignal) {
  signal.throwIfAborted(); if (performance.now() >= deadline) throw Error("Application API deadline elapsed");
  const bytes = method === "POST" ? Buffer.from(canonical(body)) : undefined;
  return await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    let response: { status: number; body: unknown } | undefined, failure: unknown, ended = false, size = 0;
    const chunks: Buffer[] = [];
    const original = request(origin + path, { method, agent: false, headers: { origin, connection: "close",
      ...(bytes ? { "content-type": "application/json", "content-length": bytes.length } : {}) } });
    const fail = (error: unknown) => { failure ??= error; original.destroy(error instanceof Error ? error : Error("Application API failed")); };
    const abort = () => fail(Error("Application API cancelled"));
    const timer = setTimeout(() => fail(Error("Application API deadline elapsed")), Math.max(1, deadline - performance.now()));
    original.on("error", error => { failure ??= error; });
    original.on("response", incoming => {
      incoming.on("error", fail);
      incoming.on("data", (value: Buffer) => { size += value.length;
        if (size > 65_536) fail(Error("Application API response exceeds bound")); else chunks.push(Buffer.from(value)); });
      incoming.on("end", () => {
        try {
          if (!incoming.complete || incoming.rawTrailers.length || !/^application\/json(?:\s*;|$)/iu.test(String(incoming.headers["content-type"]))) throw Error("Application API response framing differs");
          const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
          const value: unknown = JSON.parse(text, (_key, value: unknown) => { if (typeof value === "number" && !Number.isFinite(value)) throw Error("Nonfinite application reply"); return value; });
          response = { status: incoming.statusCode!, body: value }; ended = true;
        } catch (error) { fail(error); }
      });
    });
    original.once("close", () => { clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (failure || !ended || !response) reject(failure ?? Error("Application API closed before a complete response")); else resolve(response); });
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    original.end(bytes);
  });
}

/** Actual opt-in application work for ordinary run.start only. Local opaque
 * candidates survive between author/reviewer runs in this daemon; no remote JSON
 * or restart can reconstruct their compiler and installation authority. */
export async function executeApplicationVerification(profile: PreparedApplicationVerificationProfile, input: {
  run: ApplicationVerificationRun; requestId: string; workspace: string; stage: "implementation" | "validation";
  subject: Subject; assertSubject(): void; backend: PreparedWindowsProcessBackend; signal: AbortSignal;
}): Promise<ApplicationVerificationObservationV1> {
  const configured = readApplicationVerificationProfile(profile), original = input.run.runStart;
  const context = original.context_pack.payload, requirement = original.verification?.application;
  if (!context?.app_delivery || !requirement || original.verification?.request_id !== input.requestId
    || context.task.id !== original.task_id || context.workspace.root !== input.workspace || original.workspace.root !== input.workspace
    || requirement.config_digest !== configured.capabilities.config_digest || requirement.contract_digest !== configured.capabilities.contract_digest) throw Error("Application run/profile binding differs");
  const identity = JSON.stringify(original), controller = new AbortController(), signal = AbortSignal.any([input.signal, controller.signal]);
  const deadline = performance.now() + configured.config.timeout_ms;
  const timer = setTimeout(() => controller.abort(), configured.config.timeout_ms);
  const current = () => { signal.throwIfAborted(); if (performance.now() >= deadline) throw Error("Application verification deadline elapsed");
    if (JSON.stringify(original) !== identity) throw Error("Original application run mutated"); };
  const check = () => { current(); readApplicationVerificationProfile(profile); input.assertSubject(); current(); };
  const read = (path: string): string => {
    const fact = input.subject.files.get(path); if (!fact) throw Error("Application source absent from the original subject");
    if (fact.size < 1) throw Error(`Application package requires a nonempty file: ${path}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(readApplicationRuntimePin({ path: win32.join(input.workspace, ...path.split("/")), bytes: fact.size, sha256: fact.checksum }));
  };
  let owned: OwnedBrowser | undefined, service: Awaited<ReturnType<typeof startApplicationVerificationService>> | undefined;
  let failed = false, originalFailure: unknown;
  let completed: ApplicationVerificationObservationV1 | undefined, register: (() => void) | undefined;
  try {
    check();
    const definition = readApplicationVerificationDefinition(read(".artoo/product/application.json"), read(".artoo/product/design.json"), configured.capabilities.contract_digest);
    const key = `${original.run_id}\0${input.requestId}`, known = candidates.get(profile) ?? new Map<string, PreparedApplicationVerificationCandidate>();
    if (!candidates.has(profile)) candidates.set(profile, known);
    let candidate: PreparedApplicationVerificationCandidate;
    if (requirement.expected_candidate) {
      const expected = requirement.expected_candidate;
      const saved = known.get(`${expected.origin_run_id}\0${expected.origin_request_id}`);
      if (!saved) throw Error("Original immutable application candidate unavailable; cross-node recovery is unsupported");
      const measured = readApplicationVerificationCandidate(saved);
      if (!isDeepStrictEqual(expected.candidate, measured.identity) || measured.identity.subject_digest !== input.subject.digest
        || expected.origin_run_id !== measured.originRunId || expected.origin_request_id !== measured.originRequestId
        || context.review_subject?.run_id !== measured.originRunId) throw Error("Application reviewer candidate differs from the original package");
      candidate = saved;
    } else {
      if (context.review_subject || known.has(key) || known.size >= 256) throw Error("Application candidate registry cannot admit this author run");
      const source = [...input.subject.files.keys()].filter(path => path.startsWith("product/client/") || path.startsWith("product/server/"))
        .sort().map(path => ({ path, text: read(path) }));
      candidate = await createApplicationVerificationCandidate(profile, { nodeId: input.run.nodeId, projectId: context.project.id,
        runId: original.run_id, requestId: input.requestId, subjectDigest: input.subject.digest, source, definition, backend: input.backend, deadline, signal });
    }
    check(); const selected = readApplicationVerificationCandidate(candidate);
    if (selected.identity.schema_digest !== definition.schemaDigest) throw Error("Application schema differs from the original candidate");
    const store = await initializeApplicationVerificationStore(profile, candidate, input.run.nodeId, input.backend, deadline, signal);
    check(); service = await startApplicationVerificationService(store, deadline, signal);
    check();
    owned = await launchOwnedBrowser({ workspace: input.workspace, executablePath: configured.config.browser.path,
      signal, windowsProcessBackend: input.backend });
    const browser = owned.browser, cases: ApplicationVerificationObservationV1["acceptance"]["cases"] = [];
    const runProgram = async (program: Parameters<typeof executeBrowserProgramV3>[2]) => {
      check(); const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1,
        serviceWorkers: "block", acceptDownloads: false });
      return await executeBrowserProgramV3(context, configured.config.origin, program, configured.config.action_timeout_ms, inspectPage);
    };
    for (const test of definition.cases) {
      const actual = await runProgram(test.program);
      const assertions = actual.operations.filter(item => item.action.startsWith("assert_")).length;
      if (!assertions) throw Error("Application design case lacks measured assertions");
      cases.push({ case_id: test.id, program_digest: sha(canonical(test.program)), trace_digest: sha(canonical(actual.operations)), assertions,
        capture_digests: actual.captures.map(capture => { const bytes = actual.screenshots.get(capture.page_id);
          if (!bytes || sha(bytes) !== capture.screenshot_digest) throw Error("Original application capture is absent"); return capture.screenshot_digest; }) });
    }
    const measure = async (method: "POST" | "GET") => {
      check(); const expected = method === "POST" ? definition.persistence.write : definition.persistence.read;
      const response = await api(configured.config.origin, method, expected.path, definition.persistence.write.body,
        Math.min(deadline, performance.now() + configured.config.operation_timeout_ms), signal);
      if (response.status !== expected.expected_status || !isDeepStrictEqual(response.body, expected.expected_json)) throw Error(`Application ${method} business assertion failed`);
      return sha(canonical(response));
    };
    const write = await measure("POST"), before = await measure("GET");
    await service.close(); if (service.invocations() < 2) throw Error("Application service did not own its API calls"); service = undefined;
    check(); service = await startApplicationVerificationService(store, deadline, signal);
    const after = await measure("GET"), replay = await measure("POST"), afterReplay = await measure("GET");
    if (write !== replay || before !== after || before !== afterReplay) throw Error("Application persistence or idempotent replay differs");
    const reopened = await runProgram(definition.persistence.after_restart_browser_program);
    await service.close(); if (service.invocations() < 3) throw Error("Reopened application did not own its API calls"); service = undefined;
    await owned.close(); owned = undefined;
    check(); readApplicationVerificationCandidate(candidate);
    completed = ApplicationVerificationObservationV1Schema.parse({ version: 1, scope: "local-development-api-browser-reopen", stage: input.stage,
      run_id: original.run_id, request_id: input.requestId, origin_run_id: selected.originRunId, origin_request_id: selected.originRequestId,
      candidate: selected.identity, acceptance: { version: 1, cases, persistence: {
        request_digest: sha(canonical({ method: "POST", path: definition.persistence.write.path, body: definition.persistence.write.body })),
        before_read_digest: before, after_read_digest: after, replay_response_digest: replay, after_replay_read_digest: afterReplay,
        browser_trace_digest: sha(canonical(reopened.operations)) }, closures: { compiler: true, initialize: true, services: 2, browser: true },
        test_store_id: readApplicationVerificationStore(store).testStoreId }, qualified_for_product: false });
    current();
    if (!requirement.expected_candidate) register = () => { known.set(key, candidate); };
  } catch (error) { failed = true; originalFailure = error; throw error; }
  finally {
    let closures: PromiseSettledResult<void>[];
    try { closures = await Promise.allSettled([Promise.resolve().then(() => service?.close()), Promise.resolve().then(() => owned?.close())]); }
    finally { clearTimeout(timer); }
    const errors = closures.flatMap(value => value.status === "rejected" ? [value.reason] : []);
    if (errors.length) throw new VerificationCleanupError("Application verification original-owner cleanup is unconfirmed", {
      cause: new AggregateError([...(failed ? [originalFailure] : []), ...errors], "Application verification cleanup failed") });
    if (!failed) current();
  }
  current(); register?.(); return completed!;
}
