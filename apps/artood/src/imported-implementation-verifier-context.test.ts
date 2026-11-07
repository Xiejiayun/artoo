// Actual private inspectors; original backend and directory facts are controlled test seams.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importedExecutionReviewRequestDigestV1, importedExecutionRepairRequestDigestV1 } from "@artoo/domain";
import { importedExecutionReviewRequestFixture, implementationFixtureSha as sha } from "./test-fixtures/imported-execution-review-request.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
const native = vi.hoisted(() => ({ backends: new WeakSet<object>(), ino: 2, files: new Map<string, Buffer>() }));
vi.mock("./owned/windows-owned-process.js", () => ({ assertWindowsProcessBackend: (value: object) => {
  if (!native.backends.has(value)) throw Error("Controlled unprepared backend");
} }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, lstatSync: () => ({ dev: 1, ino: native.ino, isDirectory: () => true, isSymbolicLink: () => false }),
    realpathSync: Object.assign((value: string) => value, { native: (value: string) => value }) };
});
vi.mock("./product-stage.js", () => ({ readProductFile: (_root: string, path: string) => {
  const bytes = native.files.get(path); if (!bytes) throw Error("Controlled missing product file"); return bytes;
} }));
vi.mock("./product-source-runtime.js", () => ({ readImportedDesignResearch: () => { throw Error("No original node permit in child fixture"); } }));
import { bindImportedExecutionReviewVerifierContext, bindImportedExecutionRepairVerifierContext,
  readImportedImplementationVerifierResearch as read, recheckImportedImplementationVerifierContext as recheck } from "./imported-implementation-verifier-context.js";
import { deriveWebAcceptanceV3Plan } from "./web-acceptance-plan-v3.js";
function fixture(kind: "before" | "after" | "preview" | "final" = "before") {
  const f = importedExecutionReviewRequestFixture(), review = kind === "before" || kind === "after";
  const start = kind === "before" ? f.request.before_start : kind === "after" ? f.request.after_start : f.repair.run_start;
  const destination = f.request.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  const check = destination.capabilities.checks[0]!, scope = review ? "final" : kind;
  const envelope: Record<string, unknown> = { version: 1, request: review ? f.request : f.repair,
    request_digest: review ? importedExecutionReviewRequestDigestV1(f.request, sha) : importedExecutionRepairRequestDigestV1(f.repair, sha),
    run_id: start.run_id, verification_request_id: kind === "preview" ? "preview-diagnostics" : start.verification.request_id,
    subject_digest: review ? f.request.source.subject_digest : sha("repaired subject"), ...(review ? { phase: kind } : { scope }) };
  const backend = Object.freeze({}) as PreparedWindowsProcessBackend; native.backends.add(backend);
  const input: Parameters<typeof bindImportedExecutionReviewVerifierContext>[0] = { envelope, root: start.workspace.root,
    context: start.context_pack.payload, researchBytes: f.bytes, designBytes: f.designBytes, requestId: envelope.verification_request_id as string,
    scope, profileId: destination.profile_id, profileDigest: destination.capabilities.profile_digest, subjectDigest: envelope.subject_digest,
    binding: { version: 1, profile_digest: destination.capabilities.profile_digest, command_id: check.command_id,
      config_digest: check.config_digest, contract_digest: check.contract_digest },
    options: { windows_browser_process: { version: 1 }, design_capture_cases: true,
      browser_program: { version: 3, viewports: [{ id: "compact", width: 390, height: 844 }] } }, backend };
  native.files.set(".artoo/product/research.json", Buffer.from(f.bytes)); native.files.set(".artoo/product/design.json", f.designBytes);
  native.files.set("product/index.html", Buffer.from("<h1>Preserved product</h1>"));
  return { input, envelope, bind: review ? bindImportedExecutionReviewVerifierContext : bindImportedExecutionRepairVerifierContext };
}
beforeEach(() => { native.ino = 2; native.files.clear(); });
describe("H6 and repair original private child phase bindings", () => {
  it.each(["before", "after", "preview", "final"] as const)("binds %s, reconstructs all programs and rechecks raw inputs", kind => {
    const f = fixture(kind), echo = f.bind(f.input);
    expect(echo).toMatchObject({ stage: "implementation", run_id: f.envelope.run_id, verification_request_id: f.input.requestId });
    const research = read(f.input.root, f.input.context, f.input.researchBytes)!;
    expect(research.measurement_plan!.profile_digest).toBe(f.input.profileDigest);
    research.objective = "mutated copy"; expect(read(f.input.root, f.input.context, f.input.researchBytes)!.objective).not.toBe(research.objective);
    expect(read(f.input.root, structuredClone(f.input.context), f.input.researchBytes)).toBeUndefined();
    expect(recheck(f.input.root, f.input.context, f.input.researchBytes, f.input.designBytes)).toEqual(echo);
    const plan = deriveWebAcceptanceV3Plan(f.input.root, f.input.context, f.input.options as Parameters<typeof deriveWebAcceptanceV3Plan>[2], f.input.binding);
    expect(plan.stage).toBe("implementation"); expect(plan.casePrograms.length).toBeGreaterThan(1);
    expect(() => f.bind(f.input)).toThrow("already bound");
  });
  it.each(["run", "request", "phase", "subject", "profile", "command", "config", "context", "research", "design", "backend", "all-cases"])(
    "rejects wrong %s before binding", change => {
      const f = fixture();
      if (change === "run") f.envelope.run_id = "other";
      if (change === "request") f.input.requestId = "other";
      if (change === "phase") f.envelope.phase = "after";
      if (change === "subject") f.input.subjectDigest = sha("other");
      if (change === "profile") f.input.profileId = "other";
      if (change === "command") f.input.binding.command_id = "other";
      if (change === "config") f.input.binding.config_digest = sha("other");
      if (change === "context") f.input.context = { ...f.input.context, task: { ...f.input.context.task, title: "other" } };
      if (change === "research") f.input.researchBytes = Buffer.from("other");
      if (change === "design") f.input.designBytes = Buffer.from("other");
      if (change === "backend") f.input.backend = {} as PreparedWindowsProcessBackend;
      if (change === "all-cases") f.input.options.design_capture_cases = false;
      expect(() => f.bind(f.input)).toThrow(); expect(read(f.input.root, f.input.context, f.input.researchBytes)).toBeUndefined();
    });
  it.each(["research", "design", "context", "directory", "backend-replaced", "backend-revoked", "phase", "scope", "profile", "command", "options"])(
    "rejects %s drift before the final echo", change => {
      const f = fixture(change === "scope" ? "final" : "before"); f.bind(f.input);
      if (change === "research") f.input.researchBytes = Buffer.concat([f.input.researchBytes, Buffer.from(" ")]);
      if (change === "design") f.input.designBytes = Buffer.concat([f.input.designBytes, Buffer.from(" ")]);
      if (change === "context") f.input.context.task.title = "other";
      if (change === "directory") native.ino += 1;
      if (change === "backend-replaced") { f.input.backend = {} as PreparedWindowsProcessBackend; native.backends.add(f.input.backend); }
      if (change === "backend-revoked") native.backends.delete(f.input.backend);
      if (change === "phase") f.envelope.phase = "after";
      if (change === "scope") f.envelope.scope = "preview";
      if (change === "profile") f.input.profileId = "other";
      if (change === "command") f.input.binding.command_id = "other";
      if (change === "options") f.input.options = { ...f.input.options, design_capture_cases: false };
      expect(() => recheck(f.input.root, f.input.context, f.input.researchBytes, f.input.designBytes)).toThrow();
    });
});
