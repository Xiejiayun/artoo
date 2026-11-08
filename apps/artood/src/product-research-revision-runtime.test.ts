// Real sealed files/journal/fingerprints. Native ACL, prepared profile and actual-process
// admission are controlled here; this is not live-provider or native-process acceptance.
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalProductSourceTransferValueV1 as canonical, productSourceExportDigestV2, type ContextPack,
  type ProductResearchRevisionContextV1, type ProductSourceExportV2, type RunStartPayload } from "@artoo/domain";
import type { PreparedVerificationProfile } from "./verification.js";
import type { PreparedReleaseProfile } from "./product-release.js";
import type { WindowsVerifiedExecutionAdmission } from "./process-adapter.js";
import type { AgentInstanceHandle } from "@artoo/protocol";
const control = vi.hoisted(() => ({ release: undefined as unknown, subject: vi.fn(), closure: vi.fn() }));
vi.mock("./verification.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./verification.js")>(); control.subject.mockImplementation(actual.subjectManifest);
  return { ...actual, assertFinalVerificationExportBinding: vi.fn(), assertLocallyPreparedVerificationProfile: vi.fn(), assertLocallyPreparedVerificationProfiles: vi.fn(),
    prepareVerificationProfiles: vi.fn(value => value), subjectManifest: control.subject, selectVerificationProfile: vi.fn(), runTransferredResearchVerification: vi.fn() };
});
vi.mock("./product-release.js", () => ({ prepareReleaseCapabilityReader: () => ({ capabilities: control.release, readCapabilities: () => control.release }),
  prepareReleaseCapabilityReaders: (profiles: readonly object[]) => profiles.map(() => ({ capabilities: control.release, readCapabilities: () => control.release })),
  readReleaseCapabilitiesBatch: (profiles: readonly object[]) => profiles.map(() => control.release) }));
vi.mock("./windows-code-installation.js", () => ({ prepareWindowsCodeInstallation: vi.fn(() => ({})), assertWindowsCodeInstallation: vi.fn() }));
vi.mock("./windows-release-storage.js", () => ({ prepareWindowsReleaseStorage: vi.fn(() => ({})), assertWindowsReleaseStorage: vi.fn(), auditWindowsReleaseStorage: vi.fn() }));
vi.mock("./owned/windows-owned-process.js", () => ({ assertWindowsProcessBackend: vi.fn() }));
vi.mock("./protected-command.js", () => ({ runProtectedCommand: vi.fn(() => { throw Error("No subprocess is permitted in this controlled suite"); }) }));
vi.mock("./process-adapter.js", () => ({ assertWindowsVerifiedExecutionExportBinding: control.closure }));
vi.mock("./research.js", () => ({ prepareResearchOptions: vi.fn(value => value), readResearchReceipt: vi.fn() }));
import { prepareProductSourceRuntime, claimProductSourceRun, releaseProductSourceRun, claimProductResearchRevisionRun,
  closeProductResearchRevisionRun, assertProductSourceWorkspaceBoundary, readProductSourceRuntimeCapabilities } from "./product-source-runtime.js";
import { captureProductSourceSnapshot, describeProductSourceSnapshot, encodeProductSourceSnapshot } from "./product-source-snapshot.js";

const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hash = (value: unknown) => sha(canonical(value));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!, roots: string[] = [];
beforeEach(() => { vi.clearAllMocks(); Object.defineProperty(process, "platform", { ...platform, value: "win32" }); });
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  const parent = `${realpathSync.native(tmpdir())}${sep}artoo-revision-runtime-`;
  for (const root of roots.splice(0)) {
    if (!root.startsWith(parent)) throw Error("Unexpected revision runtime cleanup target");
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-revision-runtime-"))); roots.push(root);
  const workspace = join(root, "workspace"), store = join(root, "store"), receipts = join(root, "receipts"), programs = join(root, "programs");
  for (const path of [workspace, store, receipts, programs, join(workspace, "product"), join(workspace, ".artoo"), join(workspace, ".artoo", "product")]) mkdirSync(path);
  const git = join(programs, "git.exe"); writeFileSync(git, "controlled bytes, never executed");
  const data = JSON.parse(readFileSync(new URL("../../../packages/domain/test-fixtures/product-source-operation.json", import.meta.url), "utf8"));
  const oldRoot = data.admission.request.byte_request.source.workspace_root;
  const replaceRoot = (value: unknown): unknown => value === oldRoot ? workspace : Array.isArray(value) ? value.map(replaceRoot)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceRoot(child)])) : value;
  const proof = replaceRoot(data.admission.request.source_export) as ProductSourceExportV2;
  const research = Buffer.from(JSON.stringify(replaceRoot(JSON.parse(data.research))));
  const researchPath = join(workspace, ".artoo", "product", "research.json"); writeFileSync(researchPath, research);
  const productPath = join(workspace, "product", "index.html"); writeFileSync(productPath, "original product");
  const profile = { id: proof.byte_export.profile_id, project_id: "project", workspace_root: workspace, digest: proof.byte_export.profile_digest,
    subject_paths: ["product", ".artoo/product"], commands: [], required_files: [], trustedFiles: [], capabilities: proof.source_capabilities } as unknown as PreparedVerificationProfile;
  const release = proof.measurement_v2!.source_release; control.release = release;
  const prepared = { id: release.binding.release_profile_id, digest: release.binding.release_profile_digest, project_id: "project", verifier: profile } as PreparedReleaseProfile;
  const runtime = prepareProductSourceRuntime({ nodeId: proof.byte_export.node_id, storeRoot: store, profiles: [profile], allowedRoots: [workspace],
    gitExecutable: git, windowsBackend: {} as never, sourceResearch: { receiptDirectory: receipts }, measurementV2: { version: 1, releaseProfiles: [prepared] } });
  const subject = control.subject(profile).digest;
  const snapshot = captureProductSourceSnapshot({ profile, expectedProfileDigest: profile.digest, expectedSubjectDigest: subject });
  const capsule = encodeProductSourceSnapshot(snapshot), descriptor = describeProductSourceSnapshot(snapshot);
  Object.assign(proof.byte_export, { subject_digest: subject, capsule_digest: descriptor.capsule_digest, manifest_digest: descriptor.manifest_digest, capsule_bytes: capsule.length });
  proof.byte_export.export_id = hash({ run_id: proof.byte_export.run_id, request_id: proof.byte_export.verification_request_id, capsule_digest: descriptor.capsule_digest });
  proof.research_provenance.research = { path: ".artoo/product/research.json", checksum: sha(research), size: research.length };
  proof.research_provenance_digest = hash(proof.research_provenance);
  const exportDigest = productSourceExportDigestV2(proof, sha);
  const semanticPath = join(store, "attestations", `semantic-export-${exportDigest.slice(7)}.json`);
  const bytePath = join(store, "attestations", `export-${proof.byte_export.export_id.slice(7)}.json`);
  const capsulePath = join(store, "artifacts", `${descriptor.capsule_digest.slice(7)}.json`);
  writeFileSync(semanticPath, canonical(proof)); writeFileSync(bytePath, canonical(proof.byte_export)); writeFileSync(capsulePath, capsule);
  const revision: ProductResearchRevisionContextV1 = { version: 1, revision_id: "revision", intent_digest: sha("intent"), author_run_id: "author-1",
    original_research_task_id: proof.byte_export.task_id, goal_id: proof.byte_export.goal_id, plan_id: proof.byte_export.plan_id,
    parent_review: { review_id: "imported-review", request_digest: sha("request"), result_digest: sha("result") },
    baseline: { version: 1, source_task_id: proof.byte_export.task_id, source_run_id: proof.byte_export.run_id, evidence_id: "server-evidence",
      computer_id: proof.byte_export.node_id, workspace_root: workspace, profile_id: profile.id, profile_digest: profile.digest,
      subject_digest: subject, capsule_digest: descriptor.capsule_digest, capsule_bytes: capsule.length, export_digest: exportDigest,
      provenance_digest: proof.research_provenance_digest, research: proof.research_provenance.research } };
  const start = (id = "author-1") => ({ run_id: id, task_id: "aux-task", workspace: { root: workspace },
    context_pack: { id: "context-" + id, payload: { task: { id: "aux-task" }, project: { id: "project" }, workspace: { root: workspace },
      goal_context: { goal_id: revision.goal_id, plan: { id: revision.plan_id } }, policy: { filesystem_write_scope: [workspace] }, product_development: { stage: "research" },
      product_research_revision: { ...structuredClone(revision), author_run_id: id } } as unknown as ContextPack },
    policy_snapshot: { filesystem_write_scope: [workspace] },
    verification: { version: 1, request_id: "verify-" + id, profile_id: profile.id } }) as RunStartPayload;
  const execution = (run: RunStartPayload, closed = true) => {
    const admission = {} as WindowsVerifiedExecutionAdmission, handle = { runId: run.run_id } as AgentInstanceHandle;
    control.closure.mockImplementation((actualAdmission, actualHandle, actualProfile, actualRun) => {
      if (!closed || actualAdmission !== admission || actualHandle !== handle || actualProfile !== profile || actualRun !== run) throw Error("Native job/tool closure is unconfirmed");
    });
    return { admission, handle };
  };
  return { runtime, profile, workspace, store, start, execution, proof, semanticPath, bytePath, capsulePath, researchPath, productPath };
}

describe("research revision retained source-runtime boundary", () => {
  it("admits the exact retained source export and advertises only the prepared source role", () => {
    const f = fixture(); expect(readProductSourceRuntimeCapabilities(f.runtime).researchRevision).toBe(true);
    expect(() => claimProductResearchRevisionRun(f.runtime, f.start(), f.profile)).not.toThrow();
    expect(() => assertProductSourceWorkspaceBoundary(f.runtime, f.workspace)).toThrow("no confirmed closure");
  });
  it.each(["semantic", "byte", "capsule", "research", "subject", "profile", "source-run"])("rejects changed retained %s before author execution", change => {
    const f = fixture(), start = f.start();
    if (change === "semantic") writeFileSync(f.semanticPath, canonical({ ...f.proof, research_provenance_digest: sha("changed") }));
    if (change === "byte") writeFileSync(f.bytePath, canonical({ ...f.proof.byte_export, verification_digest: sha("changed") }));
    if (change === "capsule") writeFileSync(f.capsulePath, "changed");
    if (change === "research") writeFileSync(f.researchPath, "changed");
    if (change === "subject") writeFileSync(f.productPath, "changed");
    if (change === "profile") start.context_pack.payload!.product_research_revision!.baseline.profile_digest = sha("changed");
    if (change === "source-run") start.context_pack.payload!.product_research_revision!.baseline.source_run_id = "other";
    expect(() => claimProductResearchRevisionRun(f.runtime, start, f.profile)).toThrow();
    expect(control.closure).not.toHaveBeenCalled();
  });
  it("does not infer old author closure from a retained export while its run still owns the workspace", () => {
    const f = fixture(); claimProductSourceRun(f.runtime, f.proof.byte_export.run_id, f.workspace);
    expect(() => claimProductResearchRevisionRun(f.runtime, f.start(), f.profile)).toThrow("exclusively occupied");
  });
  it("records failed author partial bytes only after exact native admission and tool closure, then permits a bound retry", () => {
    const f = fixture(), start = f.start(); claimProductResearchRevisionRun(f.runtime, start, f.profile);
    writeFileSync(f.productPath, "partial failed-author output"); const execution = f.execution(start);
    closeProductResearchRevisionRun(f.runtime, start, f.profile, execution); releaseProductSourceRun(f.runtime, start.run_id);
    expect(control.closure).toHaveBeenCalledTimes(2);
    expect(() => claimProductResearchRevisionRun(f.runtime, f.start("author-2"), f.profile)).not.toThrow();
  });
  it("keeps unknown native/tool closure fenced, including ordinary nested workspace admission", () => {
    const f = fixture(), start = f.start(); claimProductResearchRevisionRun(f.runtime, start, f.profile);
    writeFileSync(f.productPath, "partial output after adapter exit");
    expect(() => closeProductResearchRevisionRun(f.runtime, start, f.profile, f.execution(start, false))).toThrow("closure is unconfirmed");
    expect(() => assertProductSourceWorkspaceBoundary(f.runtime, join(f.workspace, "product"))).toThrow("no confirmed closure");
    expect(() => claimProductResearchRevisionRun(f.runtime, f.start("author-2"), f.profile)).toThrow("no confirmed closure");
  });
  it("does not accept a copied native admission or a different prepared profile as closure", () => {
    const f = fixture(), start = f.start(); claimProductResearchRevisionRun(f.runtime, start, f.profile);
    const execution = f.execution(start);
    expect(() => closeProductResearchRevisionRun(f.runtime, start, f.profile, { ...execution, admission: {} as WindowsVerifiedExecutionAdmission })).toThrow("closure is unconfirmed");
    expect(() => closeProductResearchRevisionRun(f.runtime, start, { ...f.profile }, execution)).toThrow("original workspace claim");
  });
});
