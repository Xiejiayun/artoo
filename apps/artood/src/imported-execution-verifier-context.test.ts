// Real H5 child inspectors and plan reconstruction; filesystem and original Job identity are controlled seams.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importedExecutionRequestDigestV1, canonicalProductSourceTransferValueV1 as canonical } from "@artoo/domain";
import { importedExecutionRequestFixture, executionFixtureSha as sha } from "./test-fixtures/imported-execution-request.js";
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
  const bytes = native.files.get(path); if (!bytes) throw Error("Controlled product file missing"); return bytes;
} }));
vi.mock("./product-source-runtime.js", () => ({ readImportedDesignResearch: () => { throw Error("No original in-process H5 author authority in this child test"); } }));
import { bindImportedExecutionVerifierContext as bind, readImportedExecutionVerifierResearch as read,
  recheckImportedExecutionVerifierContext as recheck } from "./imported-execution-verifier-context.js";
import { deriveWebAcceptanceV3Plan } from "./web-acceptance-plan-v3.js";
function fixture(scope: "preview" | "final" = "final") {
  const { request, bytes, designBytes } = importedExecutionRequestFixture(), start = request.run_start;
  const destination = request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  const check = destination.capabilities.checks[0]!;
  const backend = Object.freeze({}) as PreparedWindowsProcessBackend; native.backends.add(backend);
  const envelope = { version: 1, request, request_digest: importedExecutionRequestDigestV1(request, sha), scope,
    run_id: start.run_id, verification_request_id: scope === "final" ? start.verification!.request_id : "controlled-preview-request", subject_digest: sha("new H5 subject") };
  const input: Parameters<typeof bind>[0] = { envelope, root: start.workspace.root, context: start.context_pack.payload,
    researchBytes: bytes, designBytes, requestId: envelope.verification_request_id, scope, profileId: destination.profile_id,
    profileDigest: destination.capabilities.profile_digest, subjectDigest: envelope.subject_digest,
    binding: { version: 1, profile_digest: destination.capabilities.profile_digest, command_id: check.command_id,
      config_digest: check.config_digest, contract_digest: check.contract_digest },
    options: { windows_browser_process: { version: 1 }, design_capture_cases: true,
      browser_program: { version: 3, viewports: [{ id: "compact", width: 390, height: 844 }] } }, backend };
  native.files.set(".artoo/product/research.json", Buffer.from(bytes)); native.files.set(".artoo/product/design.json", designBytes);
  native.files.set("product/index.html", Buffer.from("<h1>Preserved product</h1>"));
  return { request, bytes, designBytes, envelope, input };
}
beforeEach(() => { native.ino = 2; native.files.clear(); });
describe("H5 private child mapping and independently reconstructed implementation cases", () => {
  it.each(["preview", "final"] as const)("binds only its original %s child context and retained bytes", scope => {
    const { input, envelope } = fixture(scope), echo = bind(input), raw = input.researchBytes.slice();
    expect(echo).toMatchObject({ stage: "implementation", scope, run_id: envelope.run_id, verification_request_id: input.requestId });
    const research = read(input.root, input.context, input.researchBytes)!;
    expect(research.measurement_plan!.profile_digest).toBe(input.profileDigest); expect(input.researchBytes).toEqual(raw);
    research.objective = "caller mutation"; expect(read(input.root, input.context, raw)!.objective).not.toBe(research.objective);
    expect(read(input.root, structuredClone(input.context), raw)).toBeUndefined(); expect(recheck(input.root, input.context, raw, input.designBytes)).toEqual(echo);
    expect(() => bind(input)).toThrow("already bound");
  });
  it("reconstructs all implementation programs from the fixed design rather than report-selected cases", () => {
    const { input, request } = fixture(); bind(input);
    const plan = deriveWebAcceptanceV3Plan(input.root, input.context, input.options as Parameters<typeof deriveWebAcceptanceV3Plan>[2], input.binding);
    expect(plan.stage).toBe("implementation"); expect(plan.casePrograms.length).toBeGreaterThan(1);
    if (request.review_result.outcome !== "reviewed") throw Error("Controlled H4 required");
    const observation = request.review_result.after.verification.checks[0]!.observation;
    if (observation?.version !== 3) throw Error("Controlled v3 required");
    const projection = (item: { case_id: string; viewport: unknown; program_digest: string }) => canonical({ case_id: item.case_id, viewport: item.viewport, program_digest: item.program_digest });
    expect(plan.programs.map(projection).sort()).toEqual(observation.cases.map(projection).sort());
    native.files.set(".artoo/product/design.json", Buffer.concat([input.designBytes, Buffer.from(" ")]));
    expect(() => deriveWebAcceptanceV3Plan(input.root, input.context, input.options as Parameters<typeof deriveWebAcceptanceV3Plan>[2], input.binding)).toThrow("design bytes changed");
  });
  it.each(["subject", "profile", "profile-digest", "command", "config", "contract", "scope", "request", "run", "root", "context", "backend", "design", "research", "prototype-only", "v2", "posix"])(
    "rejects wrong %s before installing a projection", change => {
      const { input, envelope } = fixture();
      if (change === "subject") input.subjectDigest = sha("other");
      if (change === "profile") input.profileId = "other";
      if (change === "profile-digest") input.profileDigest = sha("other");
      if (change === "command") input.binding.command_id = "other";
      if (change === "config") input.binding.config_digest = sha("other");
      if (change === "contract") input.binding.contract_digest = sha("other");
      if (change === "scope") input.scope = envelope.scope = "preview";
      if (change === "request") input.requestId = "other";
      if (change === "run") envelope.run_id = "other";
      if (change === "root") input.root += "-other";
      if (change === "context") input.context = { ...input.context, task: { ...input.context.task, title: "other" } };
      if (change === "backend") input.backend = Object.freeze({}) as PreparedWindowsProcessBackend;
      if (change === "design") input.designBytes = Buffer.from("changed design bytes");
      if (change === "research") input.researchBytes = Buffer.concat([input.researchBytes, Buffer.from(" ")]);
      if (change === "prototype-only") input.options.design_capture_cases = false;
      if (change === "v2") input.options = { browser_program: { version: 2, viewports: [{ id: "compact", width: 390, height: 844 }] } };
      if (change === "posix") delete input.options.windows_browser_process;
      expect(() => bind(input)).toThrow(); expect(read(input.root, input.context, input.researchBytes)).toBeUndefined();
    });
  it.each(["research", "design", "context", "root-identity", "backend-revoked", "backend-replaced", "scope", "profile", "command", "options", "root"])(
    "rejects %s drift after the private binding", change => {
      const { input, envelope } = fixture(); bind(input);
      if (change === "research") input.researchBytes = Buffer.concat([input.researchBytes, Buffer.from(" ")]);
      if (change === "design") input.designBytes = Buffer.concat([input.designBytes, Buffer.from(" ")]);
      if (change === "context") input.context.task.title = "changed";
      if (change === "root-identity") native.ino = 3;
      if (change === "backend-revoked") native.backends.delete(input.backend);
      if (change === "backend-replaced") { input.backend = Object.freeze({}) as PreparedWindowsProcessBackend; native.backends.add(input.backend); }
      if (change === "scope") envelope.scope = "preview";
      if (change === "profile") input.profileId = "changed";
      if (change === "command") input.binding.command_id = "changed";
      if (change === "options") input.options.design_capture_cases = false;
      if (change === "root") input.root += "-changed";
      expect(() => recheck(input.root, input.context, input.researchBytes, input.designBytes)).toThrow();
    });
});
