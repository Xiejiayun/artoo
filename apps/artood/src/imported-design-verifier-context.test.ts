import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importedDesignContinuationRequestDigestV1, type ContextPack } from "@artoo/domain";
import { importedDesignRequestFixture } from "./test-fixtures/imported-design-request.js";
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
import { bindImportedDesignVerifierContext, readImportedDesignVerifierResearch } from "./imported-design-verifier-context.js";

const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function fixture() {
  const { request, bytes } = importedDesignRequestFixture(), start = request.run_start;
  const destination = request.review_request.operation.intent.request.byte_request.destination;
  const check = destination.capabilities.checks[0]!;
  const backend = Object.freeze({}) as PreparedWindowsProcessBackend; native.backends.add(backend);
  const envelope = { version: 1, request, request_digest: importedDesignContinuationRequestDigestV1(request, sha),
    run_id: start.run_id, verification_request_id: start.verification!.request_id, scope: "final", subject_digest: sha("New design subject") };
  return { request, bytes, input: { envelope, root: start.workspace.root, context: start.context_pack.payload,
    researchBytes: bytes, requestId: envelope.verification_request_id, scope: envelope.scope, profileId: destination.profile_id,
    profileDigest: destination.capabilities.profile_digest, subjectDigest: envelope.subject_digest,
    binding: { version: 1 as const, profile_digest: destination.capabilities.profile_digest,
      command_id: check.command_id, config_digest: check.config_digest, contract_digest: check.contract_digest }, backend } };
}
beforeEach(() => { native.ino = 2; });
describe("imported design verifier projection with controlled filesystem and Job authority", () => {
  it("projects the exact accepted research for only the bound context and returns isolated copies", () => {
    const { input, bytes } = fixture(), originalBytes = bytes.slice();
    const echo = bindImportedDesignVerifierContext(input);
    const research = readImportedDesignVerifierResearch(input.root, input.context, bytes)!;
    expect(research.measurement_plan?.profile_digest).toBe(input.profileDigest);
    expect(echo.subject_digest).toBe(input.subjectDigest); expect(bytes).toEqual(originalBytes);
    research.objective = "Changed caller copy";
    expect(readImportedDesignVerifierResearch(input.root, input.context, bytes)?.objective).not.toBe(research.objective);
    expect(readImportedDesignVerifierResearch(input.root, structuredClone(input.context), bytes)).toBeUndefined();
    expect(() => bindImportedDesignVerifierContext(input)).toThrow(/already bound/);
  });
  it.each(["subject", "profile", "command", "scope", "request", "root", "context", "backend"])("rejects changed protected %s before installing a projection", change => {
    const { input, bytes } = fixture();
    if (change === "subject") input.subjectDigest = sha("different");
    if (change === "profile") input.profileId += "-different";
    if (change === "command") input.binding.config_digest = sha("different");
    if (change === "scope") input.scope = "preview";
    if (change === "request") input.requestId = "different";
    if (change === "root") input.root += "-different";
    if (change === "context") input.context = { ...input.context, task: { ...input.context.task, title: "different" } };
    if (change === "backend") input.backend = Object.freeze({}) as PreparedWindowsProcessBackend;
    expect(() => bindImportedDesignVerifierContext(input)).toThrow();
    expect(readImportedDesignVerifierResearch(input.root, input.context, bytes)).toBeUndefined();
  });
  it.each(["bytes", "context", "root-identity", "backend"])("rejects %s drift after binding instead of falling back", change => {
    const { input, bytes } = fixture(); bindImportedDesignVerifierContext(input);
    if (change === "bytes") bytes[0] = bytes[0]! ^ 1;
    if (change === "context") (input.context as ContextPack).task.title = "changed";
    if (change === "root-identity") native.ino = 3;
    if (change === "backend") native.backends.delete(input.backend);
    expect(() => readImportedDesignVerifierResearch(input.root, input.context, bytes)).toThrow();
  });
});
