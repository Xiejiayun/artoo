import { describe, expect, it } from "vitest";
import { canonicalProductDesignRevisionContextV1, type ContextPack } from "@artoo/domain";
import { assertProductDesignRevisionBaseline, assertProductDesignRevisionRun, inspectProductDesignRevision, readProductDesignRevision } from "./product-design-revision.js";
import { designRevisionFixture, revisionReviewContext, revisionSha } from "./test-fixtures/design-revision.js";

describe("raw accepted-design revision binding (no server or process authority)", () => {
  it("allows author startup with the old design but requires an appended case for verification", () => {
    const f = designRevisionFixture();
    expect(() => assertProductDesignRevisionRun(f.start, "computer")).not.toThrow();
    expect(() => assertProductDesignRevisionBaseline(f.context, f.researchBytes)).not.toThrow();
    expect(() => inspectProductDesignRevision(f.context, f.researchBytes, f.baselineBytes)).toThrow("append");
    expect(inspectProductDesignRevision(f.context, f.researchBytes, f.revisedBytes)).toEqual({ version: 1, revision_id: "revision",
      scope: "all-declared-workspace-design-cases", descriptor_digest: revisionSha(canonicalProductDesignRevisionContextV1(f.revision)),
      baseline_checksum: revisionSha(f.baselineBytes), revised_design: { path: ".artoo/product/design.json", checksum: revisionSha(f.revisedBytes), size: f.revisedBytes.length } });
  });
  it.each(["checksum", "size", "text", "research-size", "research-checksum"])("rejects a substituted retained raw pin: %s", field => {
    const f = designRevisionFixture();
    if (field === "checksum") f.revision.baseline.design.checksum = revisionSha("substitution");
    if (field === "size") f.revision.baseline.design.size++;
    if (field === "text") f.revision.baseline.design.text += " ";
    if (field === "research-size") f.revision.baseline.research.size++;
    if (field === "research-checksum") f.revision.baseline.research.checksum = revisionSha("substitution");
    // The author must pin the exact descriptor research, including changed provenance.
    f.context.product_development!.accepted_inputs!.files = [f.revision.baseline.research];
    expect(() => assertProductDesignRevisionBaseline(f.context, f.researchBytes)).toThrow(/accepted measurement|research bytes changed/);
  });
  it.each(["old-run", "implementation-run", "new-task", "node", "missing-node", "missing-verifier"])("rejects stale or mismatched author dispatch: %s", field => {
    const f = designRevisionFixture(); let computer: string | undefined = "computer";
    if (field === "old-run") f.start.run_id = f.revision.baseline.run_id;
    if (field === "implementation-run") f.start.run_id = f.revision.requesting_review.subject_run_id;
    if (field === "new-task") f.start.task_id = "other-task";
    if (field === "node") computer = "another-computer";
    if (field === "missing-node") computer = undefined;
    if (field === "missing-verifier") delete f.start.verification;
    expect(() => assertProductDesignRevisionRun(f.start, computer)).toThrow("Design revision:");
  });
  it.each(["project", "workspace", "goal", "plan", "task", "write-root", "research-pin", "design-as-pin", "old-author"])("rejects context substitution: %s", field => {
    const f = designRevisionFixture();
    if (field === "project") f.context.project.id = "other";
    if (field === "workspace") f.context.workspace.root += "-other";
    if (field === "goal") f.context.goal_context!.goal_id = "other";
    if (field === "plan") f.context.goal_context!.plan!.id = "other";
    if (field === "task") f.context.task.id = "other";
    if (field === "write-root") f.context.policy.filesystem_write_scope.push("C:\\other");
    if (field === "research-pin") f.context.product_development!.accepted_inputs = { version: 1, files: [] };
    if (field === "design-as-pin") f.context.product_development!.accepted_inputs!.files.push({ ...f.revision.baseline.research, path: ".artoo/product/design.json" });
    if (field === "old-author") f.revision.author_run_id = f.revision.baseline.run_id;
    expect(() => readProductDesignRevision(f.context)).toThrow("Design revision:");
  });
  it("keeps independent reviewer execution distinct from the current author and old accepted design", () => {
    const f = designRevisionFixture(), review = revisionReviewContext(f.context);
    const start = { ...f.start, task_id: review.task.id, run_id: "new-independent-review-run", context_pack: { id: "review", payload: review } };
    expect(() => assertProductDesignRevisionRun(start, "computer")).not.toThrow();
    expect(inspectProductDesignRevision(review, f.researchBytes, f.revisedBytes)).toEqual(inspectProductDesignRevision(f.context, f.researchBytes, f.revisedBytes));
    start.run_id = f.revision.author_run_id; expect(() => assertProductDesignRevisionRun(start, "computer")).toThrow("reviewer run");
    review.review_subject!.run_id = f.revision.baseline.run_id; expect(() => readProductDesignRevision(review)).toThrow("exact new design author");
  });
  it.each(["write-scope", "author-context", "same-task", "wrong-stage"])("rejects nonindependent review context: %s", field => {
    const f = designRevisionFixture(), review = revisionReviewContext(f.context);
    if (field === "write-scope") review.policy.filesystem_write_scope = [f.workspace];
    if (field === "author-context") review.product_development = f.context.product_development;
    if (field === "same-task") review.task.id = f.revision.design_task_id;
    if (field === "wrong-stage") review.review_subject!.development_stage = "implementation";
    expect(() => readProductDesignRevision(review)).toThrow("independent review");
  });
  it.each(["transferred_product_input", "imported_review_subject"])("rejects mixed imported authority: %s", field => {
    const f = designRevisionFixture(); Object.assign(f.context, { [field]: { controlled: true } });
    expect(() => readProductDesignRevision(f.context)).toThrow("imported source histories");
  });
  it("compares raw unknown nested data and exact whitespace before public schema normalization", () => {
    const f = designRevisionFixture();
    delete (f.revised.screens[0] as unknown as Record<string, unknown>).retained_extension;
    expect(() => inspectProductDesignRevision(f.context, f.researchBytes, Buffer.from(JSON.stringify(f.revised)))).toThrow("non-case field");
    const g = designRevisionFixture(); g.revised.validation_cases[0]!.expected_result += " ";
    expect(() => inspectProductDesignRevision(g.context, g.researchBytes, Buffer.from(JSON.stringify(g.revised)))).toThrow("accepted cases");
  });
  it.each(["research", "candidate", "baseline"])("rejects malformed UTF-8 or nonroundtripping retained text: %s", part => {
    const f = designRevisionFixture(); let research = f.researchBytes, candidate = f.revisedBytes;
    if (part === "research") { research = Buffer.from([0x7b, 0xff, 0x7d]); Object.assign(f.revision.baseline.research, { checksum: revisionSha(research), size: research.length });
      f.context.product_development!.accepted_inputs!.files = [f.revision.baseline.research]; }
    if (part === "candidate") candidate = Buffer.from([0x7b, 0xff, 0x7d]);
    if (part === "baseline") { f.revision.baseline.design.text = "\ud800"; f.revision.baseline.design.size = Buffer.byteLength("\ud800"); f.revision.baseline.design.checksum = revisionSha("\ud800"); }
    expect(() => inspectProductDesignRevision(f.context, research, candidate)).toThrow(/UTF-8|accepted measurement/);
  });
  it("preserves ordinary contexts and does not demand revision data from old payloads", () => {
    const f = designRevisionFixture(); delete f.context.product_design_revision;
    expect(readProductDesignRevision(f.context)).toBeUndefined();
    expect(() => assertProductDesignRevisionRun(f.start, undefined)).not.toThrow();
    expect(inspectProductDesignRevision(f.context, Buffer.alloc(0), Buffer.alloc(0))).toBeUndefined();
    expect(readProductDesignRevision(undefined)).toBeUndefined();
    expect(() => readProductDesignRevision({ ...f.context, product_design_revision: { version: 0 } } as unknown as ContextPack)).toThrow("invalid versioned context");
  });
});
