// Real append-only filesystem records; native closure callbacks are explicitly controlled.
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextPack, ProductResearchRevisionContextV1, RunStartPayload } from "@artoo/domain";
import { admitProductResearchRevision, assertProductResearchRevisionRun, assertResearchRevisionWorkspaceClosed,
  closeProductResearchRevision, readProductResearchRevision } from "./product-research-revision.js";

const digest = (letter = "a") => `sha256:${letter.repeat(64)}`, roots: string[] = [];
afterEach(() => {
  const parent = `${realpathSync.native(tmpdir())}${sep}artoo-research-revision-`;
  for (const root of roots.splice(0)) {
    if (!root.startsWith(parent)) throw Error("Unexpected revision test cleanup target");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-research-revision-"))); roots.push(root);
  const store = join(root, "store"), workspace = join(root, "workspace");
  mkdirSync(join(store, "attestations"), { recursive: true }); mkdirSync(workspace);
  const revision: ProductResearchRevisionContextV1 = { version: 1, revision_id: "revision", intent_digest: digest(), author_run_id: "author-1",
    original_research_task_id: "original-task", goal_id: "goal", plan_id: "plan",
    parent_review: { review_id: "imported-review", request_digest: digest("b"), result_digest: digest("c") },
    baseline: { version: 1, source_task_id: "original-task", source_run_id: "original-run", evidence_id: "evidence", computer_id: "node",
      workspace_root: workspace, profile_id: "profile", profile_digest: digest(), subject_digest: digest(), capsule_digest: digest(),
      capsule_bytes: 20, export_digest: digest(), provenance_digest: digest(), research: { path: ".artoo/product/research.json", checksum: digest(), size: 20 } } };
  const context = { task: { id: "aux-task" }, project: { id: "project" }, workspace: { root: workspace },
    goal_context: { goal_id: "goal", plan: { id: "plan" } }, policy: { filesystem_write_scope: [workspace] },
    product_development: { stage: "research" }, product_research_revision: revision } as unknown as ContextPack;
  const author = (id = "author-1") => ({ run_id: id, task_id: "aux-task", workspace: { root: workspace },
    context_pack: { id: id + "-context", payload: { ...structuredClone(context), product_research_revision: { ...structuredClone(revision), author_run_id: id } } },
    policy_snapshot: { filesystem_write_scope: [workspace] }, verification: { version: 1, request_id: id + "-verify", profile_id: "profile" } }) as RunStartPayload;
  const reviewer = (authorId = "author-1", subject = digest("b"), id = "review-1") => {
    const start = author(authorId); start.run_id = id; start.task_id = "review-task";
    const context = start.context_pack.payload!; context.task.id = start.task_id; delete context.product_development;
    context.policy = { ...context.policy, execution_mode: "discussion", filesystem_write_scope: [] };
    context.review_subject = { task_id: "aux-task", run_id: authorId, development_stage: "research" } as ContextPack["review_subject"];
    start.policy_snapshot.filesystem_write_scope = []; start.verification!.expected_subject_digest = subject; return start;
  };
  const baseline = vi.fn();
  const admit = (start = author(), subject = digest()) => admitProductResearchRevision({ store, start, subjectDigest: subject, assertBaseline: baseline });
  const close = (start = author(), subject = digest("b"), verified = false, assertClosed = () => {}) =>
    closeProductResearchRevision({ store, start, subjectDigest: subject, authorVerified: verified, assertClosed });
  return { store, workspace, author, reviewer, baseline, admit, close };
}

describe("research revision node context and retained checkpoints", () => {
  it("preserves payloads without the extension", () => {
    const f = fixture(), start = f.author(); delete start.context_pack.payload!.product_research_revision;
    expect(readProductResearchRevision(start.context_pack.payload)).toBeUndefined();
    expect(() => assertProductResearchRevisionRun(start, undefined)).not.toThrow();
  });
  it.each(["node", "run", "profile", "expected-old-final", "foreign", "write-root", "task", "plan"])("rejects changed %s binding before invocation", change => {
    const f = fixture(), start = f.author(), context = start.context_pack.payload!;
    if (change === "run") start.run_id = "other";
    if (change === "profile") start.verification!.profile_id = "other";
    if (change === "expected-old-final") start.verification!.expected_subject_digest = digest();
    if (change === "foreign") context.transferred_product_input = {} as ContextPack["transferred_product_input"];
    if (change === "write-root") context.policy.filesystem_write_scope.push("other");
    if (change === "task") context.task.id = "other";
    if (change === "plan") context.goal_context!.plan!.id = "other";
    expect(() => assertProductResearchRevisionRun(start, change === "node" ? "other" : "node")).toThrow();
  });
  it("admits a first author only after the supplied retained-export baseline check", () => {
    const f = fixture(); f.baseline.mockImplementation(() => { throw Error("Changed baseline"); });
    expect(() => f.admit()).toThrow("Changed baseline"); expect(() => assertResearchRevisionWorkspaceClosed(f.store, f.workspace)).not.toThrow();
    f.baseline.mockReset(); f.admit(); expect(f.baseline).toHaveBeenCalledOnce();
    expect(() => assertResearchRevisionWorkspaceClosed(f.store, f.workspace)).toThrow("no confirmed closure");
  });
  it("retains partial writes from a failed, actually closed author and binds a new retry to that checkpoint", () => {
    const f = fixture(); f.admit(); const closed = vi.fn(); f.close(f.author(), digest("b"), false, closed);
    expect(closed).toHaveBeenCalledOnce(); f.admit(f.author("author-2"), digest("b"));
    expect(f.baseline).toHaveBeenCalledOnce();
    expect(() => assertResearchRevisionWorkspaceClosed(f.store, f.workspace)).toThrow("no confirmed closure");
  });
  it("cannot checkpoint an adapter exit when native/tool closure is unknown", () => {
    const f = fixture(); f.admit();
    expect(() => f.close(f.author(), digest("b"), false, () => { throw Error("Native tools remain open"); })).toThrow("Native tools remain open");
    expect(() => f.admit(f.author("author-2"), digest("b"))).toThrow("no confirmed closure");
    expect(() => assertResearchRevisionWorkspaceClosed(f.store, f.workspace)).toThrow("no confirmed closure");
  });
  it("detects external bytes changed between closed author and retry", () => {
    const f = fixture(); f.admit(); f.close();
    expect(() => f.admit(f.author("author-2"), digest("c"))).toThrow("retained closed subject changed");
  });
  it.each(["intent", "aux", "parent", "baseline"])("does not let same revision ID rebind %s", change => {
    const f = fixture(); f.admit(); f.close(); const start = f.author("author-2"), context = start.context_pack.payload!;
    if (change === "intent") context.product_research_revision!.intent_digest = digest("e");
    if (change === "aux") context.task.id = "different-aux";
    if (change === "parent") context.product_research_revision!.parent_review.result_digest = digest("e");
    if (change === "baseline") context.product_research_revision!.baseline.subject_digest = digest("e");
    expect(() => f.admit(start, digest("b"))).toThrow("ownership");
  });
  it("reviews the new verified author subject and preserves that author identity after a reviewer closes", () => {
    const f = fixture(); f.admit(); f.close(f.author(), digest("b"), true);
    const review = f.reviewer(); assertProductResearchRevisionRun(review, "node");
    f.admit(review, digest("b")); f.close(review, digest("b"));
    f.admit(f.reviewer("author-1", digest("b"), "review-2"), digest("b"));
    expect(f.baseline).toHaveBeenCalledOnce();
  });
  it("allows author retry after peer changes_requested without reapplying old baseline bytes", () => {
    const f = fixture(); f.admit(); f.close(f.author(), digest("b"), true);
    const review = f.reviewer(); f.admit(review, digest("b")); f.close(review, digest("b"));
    f.admit(f.author("author-2"), digest("b")); f.close(f.author("author-2"), digest("c"), true);
    expect(() => f.admit(f.reviewer("author-1", digest("c"), "stale-review"), digest("c"))).toThrow("last verified closed author");
    f.admit(f.reviewer("author-2", digest("c"), "review-2"), digest("c"));
  });
  it("rejects review of a closed but unverified failed author", () => {
    const f = fixture(); f.admit(); f.close(); expect(() => f.admit(f.reviewer(), digest("b"))).toThrow("last verified closed author");
  });
  it("retains a reviewer that changed the workspace despite read-only policy", () => {
    const f = fixture(); f.admit(); f.close(f.author(), digest("b"), true); const review = f.reviewer(); f.admit(review, digest("b"));
    expect(() => f.close(review, digest("c"))).toThrow("read-only reviewer changed");
    expect(() => f.admit(f.author("author-2"), digest("c"))).toThrow("no confirmed closure");
  });
  it("rechecks the baseline for a new generation whose source is the predecessor auxiliary task", () => {
    const f = fixture(); f.admit(); f.close(f.author(), digest("b"), true);
    const start = f.author("next-author"), context = start.context_pack.payload!;
    context.task.id = "next-aux"; start.task_id = "next-aux";
    Object.assign(context.product_research_revision!, { revision_id: "next-revision", intent_digest: digest("c") });
    Object.assign(context.product_research_revision!.baseline, { source_task_id: "aux-task", source_run_id: "author-1", subject_digest: digest("b") });
    assertProductResearchRevisionRun(start, "node"); f.admit(start, digest("b")); expect(f.baseline).toHaveBeenCalledTimes(2);
  });
  it("rejects journal gaps after restart-style rereading", () => {
    const f = fixture(); f.admit(); f.close();
    const directory = join(f.store, "attestations", readdirSync(join(f.store, "attestations"))[0]!);
    writeFileSync(join(directory, "0002.admitted.json"), "{}");
    expect(() => assertResearchRevisionWorkspaceClosed(f.store, f.workspace)).toThrow("sequence changed");
  });
});
