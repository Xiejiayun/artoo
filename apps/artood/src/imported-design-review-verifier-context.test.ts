// Real H4 inspectors and child projection; filesystem identity and original Job authority are controlled seams.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importedDesignReviewRequestDigestV1 } from "@artoo/domain";
import { importedDesignReviewRequestFixture, fixtureSha as sha } from "./test-fixtures/imported-design-review-request.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
const native = vi.hoisted(() => ({ backends: new WeakSet<object>(), ino: 2 }));
vi.mock("./owned/windows-owned-process.js", () => ({ assertWindowsProcessBackend: (value: object) => {
  if (!native.backends.has(value)) throw Error("Controlled unprepared backend");
} }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, lstatSync: () => ({ dev: 1, ino: native.ino, isDirectory: () => true, isSymbolicLink: () => false }),
    realpathSync: Object.assign((value: string) => value, { native: (value: string) => value }) };
});
import { bindImportedDesignReviewVerifierContext as bind, readImportedDesignReviewVerifierResearch as read,
  recheckImportedDesignReviewVerifierContext as recheck } from "./imported-design-review-verifier-context.js";
function fixture(phase: "before" | "after" = "before") {
  const { request, bytes } = importedDesignReviewRequestFixture(), start = phase === "before" ? request.before_start : request.after_start;
  const destination = request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  const check = destination.capabilities.checks[0]!;
  const backend = Object.freeze({}) as PreparedWindowsProcessBackend; native.backends.add(backend);
  const envelope = { version: 1, request, request_digest: importedDesignReviewRequestDigestV1(request, sha), phase,
    run_id: start.run_id, verification_request_id: start.verification!.request_id, scope: "final", subject_digest: start.verification!.expected_subject_digest! };
  const input: Parameters<typeof bind>[0] = { envelope, root: start.workspace.root, context: start.context_pack.payload!,
    researchBytes: bytes, designBytes: Buffer.from("controlled design bytes"), requestId: envelope.verification_request_id,
    scope: envelope.scope, profileId: destination.profile_id, profileDigest: destination.capabilities.profile_digest,
    subjectDigest: envelope.subject_digest, binding: { version: 1, profile_digest: destination.capabilities.profile_digest,
      command_id: check.command_id, config_digest: check.config_digest, contract_digest: check.contract_digest },
    options: { windows_browser_process: { version: 1 }, design_capture_cases: true,
      browser_program: { version: 3, viewports: [{ id: "compact", width: 390, height: 844 }] } }, backend };
  return { request, bytes, envelope, input };
}
beforeEach(() => { native.ino = 2; });
describe("H4 private child projection with controlled filesystem and Job identity", () => {
  it.each(["before", "after"] as const)("projects retained foreign research for only the %s phase", phase => {
    const { input, envelope } = fixture(phase), raw = input.researchBytes.slice(), echo = bind(input);
    expect(echo).toMatchObject({ phase, run_id: envelope.run_id, verification_request_id: input.requestId, subject_digest: input.subjectDigest });
    const research = read(input.root, input.context, input.researchBytes)!;
    expect(research.measurement_plan!.profile_digest).toBe(input.profileDigest); expect(input.researchBytes).toEqual(raw);
    research.objective = "changed caller copy"; expect(read(input.root, input.context, raw)!.objective).not.toBe(research.objective);
    expect(read(input.root, structuredClone(input.context), raw)).toBeUndefined();
    expect(recheck(input.root, input.context, raw, input.designBytes)).toEqual(echo);
    expect(() => bind(input)).toThrow(/already bound/);
  });
  it.each(["subject", "old-h2-subject", "profile", "profile-digest", "command", "config", "contract", "preview", "request", "phase", "run", "root", "context", "backend", "design", "research", "prototype-only", "v2", "posix"])(
    "rejects wrong %s before installing its projection", change => {
      const { input, envelope, request } = fixture();
      if (change === "subject") input.subjectDigest = sha("other");
      if (change === "old-h2-subject") input.subjectDigest = envelope.subject_digest = request.continuation_request.review_request.operation.intent.request.byte_request.source.subject_digest;
      if (change === "profile") input.profileId = "other";
      if (change === "profile-digest") input.profileDigest = sha("other");
      if (change === "command") input.binding.command_id = "other";
      if (change === "config") input.binding.config_digest = sha("other");
      if (change === "contract") input.binding.contract_digest = sha("other");
      if (change === "preview") input.scope = envelope.scope = "preview";
      if (change === "request") input.requestId = "other";
      if (change === "phase") envelope.phase = "after";
      if (change === "run") envelope.run_id = "other";
      if (change === "root") input.root += "-other";
      if (change === "context") input.context = { ...input.context, task: { ...input.context.task, title: "other" } };
      if (change === "backend") input.backend = Object.freeze({}) as PreparedWindowsProcessBackend;
      if (change === "design") input.designBytes = Buffer.from("changed controlled design bytes");
      if (change === "research") input.researchBytes = Buffer.concat([input.researchBytes, Buffer.from(" ")]);
      if (change === "prototype-only") input.options.design_capture_cases = false;
      if (change === "v2") input.options = { browser_program: { version: 2, viewports: [{ id: "compact", width: 390, height: 844 }] } };
      if (change === "posix") delete input.options.windows_browser_process;
      expect(() => bind(input)).toThrow(); expect(read(input.root, input.context, input.researchBytes)).toBeUndefined();
    });
  it.each(["research", "design", "context", "root-identity", "backend-revoked", "backend-replaced", "phase", "profile", "command", "options", "root"])(
    "rejects %s drift after binding without a fallback", change => {
      const { input, envelope } = fixture(); bind(input);
      if (change === "research") input.researchBytes = Buffer.concat([input.researchBytes, Buffer.from(" ")]);
      if (change === "design") input.designBytes = Buffer.concat([input.designBytes, Buffer.from(" ")]);
      if (change === "context") input.context.task.title = "changed";
      if (change === "root-identity") native.ino = 3;
      if (change === "backend-revoked") native.backends.delete(input.backend);
      if (change === "backend-replaced") { input.backend = Object.freeze({}) as PreparedWindowsProcessBackend; native.backends.add(input.backend); }
      if (change === "phase") envelope.phase = "after";
      if (change === "profile") input.profileId = "changed";
      if (change === "command") input.binding.command_id = "changed";
      if (change === "options") input.options.design_capture_cases = false;
      if (change === "root") input.root += "-changed";
      expect(() => recheck(input.root, input.context, input.researchBytes, input.designBytes)).toThrow();
    });
  it("keeps independent before and after echoes and projections", () => {
    const before = fixture("before"), after = fixture("after"); const a = bind(before.input), b = bind(after.input);
    expect(a.run_id).not.toBe(b.run_id); expect(a.verification_request_id).not.toBe(b.verification_request_id);
    expect(a.completed_design_digest).toBe(b.completed_design_digest); expect(a.mapping_digest).toBe(b.mapping_digest);
    expect(recheck(after.input.root, before.input.context, before.bytes, before.input.designBytes)).toEqual(a);
    expect(recheck(before.input.root, after.input.context, after.bytes, after.input.designBytes)).toEqual(b);
  });
});
