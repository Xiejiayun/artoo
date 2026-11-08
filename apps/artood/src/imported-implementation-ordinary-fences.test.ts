// Controlled directory/profile preparation only. No materialization, Git or verifier process runs.
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importedExecutionReviewRequestFixture } from "./test-fixtures/imported-execution-review-request.js";
const boundary = vi.hoisted(() => ({ materialize: vi.fn(async () => { throw Error("Controlled materialization boundary"); }) }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, lstatSync: () => ({ dev: 1n, ino: 2n, uid: 7n, mode: 0o700n, isDirectory: () => true, isSymbolicLink: () => false }),
    realpathSync: Object.assign((path: string) => path, { native: (path: string) => path }) };
});
vi.mock("./verification.js", () => ({ verificationSupported: () => true,
  prepareVerificationProfiles: (profiles: object[]) => profiles.map(profile => ({ ...profile, digest: "sha256:" + "a".repeat(64), trustedFiles: [] })),
  runVerification: vi.fn(), subjectManifest: vi.fn(), VerificationCleanupError: class extends Error {} }));
import { prepareOwnedWorktreeVerificationTemplate, verifyOwnedWorktreeResult } from "./owned-worktree-verification.js";
import { readProductDesignRevision } from "./product-design-revision.js";
import { designRevisionFixture } from "./test-fixtures/design-revision.js";
const uid = Object.getOwnPropertyDescriptor(process, "getuid");
beforeEach(() => { vi.clearAllMocks(); Object.defineProperty(process, "getuid", { value: () => 7, configurable: true }); });
afterEach(() => { if (uid) Object.defineProperty(process, "getuid", uid); else delete (process as { getuid?: unknown }).getuid; });
function fixture(descriptor?: "imported_execution_review_subject" | "imported_execution_repair") {
  const f = importedExecutionReviewRequestFixture(), base = resolve(tmpdir(), "artoo-controlled-template-fence");
  const allocation = resolve(base, "checks"), root = resolve(allocation, "one");
  const template = prepareOwnedWorktreeVerificationTemplate({ version: 1, id: "template", node_id: "node", project_id: "project",
    results_profile_id: "results", results_profile_digest: "sha256:" + "b".repeat(64),
    repository_root: resolve(base, "repo"), allocation_base: allocation,
    commands: [{ id: "check", argv: [resolve(base, "never-executed")], timeout_ms: 1000 }], subject_paths: ["product"], required_files: [] });
  const context = structuredClone(f.request.review_start.context_pack.payload);
  context.project.id = "project"; context.workspace.root = root; delete context.policy.execution_mode;
  delete context.verification_capabilities; delete context.release_capabilities; delete context.transferred_product_input;
  delete context.imported_execution_review_subject;
  if (descriptor === "imported_execution_review_subject") context.imported_execution_review_subject = f.request.review_start.context_pack.payload.imported_execution_review_subject;
  if (descriptor === "imported_execution_repair") context.imported_execution_repair = f.repair.run_start.context_pack.payload.imported_execution_repair;
  const input = { store: { materializeForVerification: boundary.materialize }, request_id: "verify", materialization_request_id: "materialize",
    reference: { result_id: "result", receipt_digest: "sha256:" + "c".repeat(64) }, root, branch: "controlled/verify", context, signal: new AbortController().signal };
  return { template, input };
}
describe("new implementation descriptors cannot enter ordinary materialization or local design revision", () => {
  it.each(["imported_execution_review_subject", "imported_execution_repair"] as const)("rejects isolated %s before materializing", async descriptor => {
    const f = fixture(descriptor);
    await expect(verifyOwnedWorktreeResult(f.template, f.input)).rejects.toThrow("not enabled for result templates");
    expect(boundary.materialize).not.toHaveBeenCalled();
  });
  it("preserves the existing ordinary template materialization route", async () => {
    const f = fixture();
    await expect(verifyOwnedWorktreeResult(f.template, f.input)).rejects.toThrow("Controlled materialization boundary");
    expect(boundary.materialize).toHaveBeenCalledTimes(1);
  });
  it("rejects mixed H6 descriptors in the independent local design revision helper", () => {
    const f = importedExecutionReviewRequestFixture(), local = designRevisionFixture();
    for (const descriptor of ["imported_execution_review_subject", "imported_execution_repair"] as const) {
      const context = structuredClone(local.context);
      if (descriptor === "imported_execution_review_subject") context.imported_execution_review_subject = f.request.review_start.context_pack.payload.imported_execution_review_subject;
      else context.imported_execution_repair = f.repair.run_start.context_pack.payload.imported_execution_repair;
      expect(() => readProductDesignRevision(context)).toThrow("imported source histories");
    }
  });
});
