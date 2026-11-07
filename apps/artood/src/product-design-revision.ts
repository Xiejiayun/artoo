import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonicalProductDesignRevisionContextV1, ProductDesignRevisionContextV1Schema, ProductDesignRevisionEvidenceV1Schema,
  ProductDesignV2Schema, ProductResearchReportV2Schema, validateAdditiveDesignRevision, validateProductDevelopmentHandoff,
  MAX_PRODUCT_DESIGN_REVISION_BYTES, type ContextPack, type ProductDesignRevisionContextV1,
  type ProductDesignRevisionEvidenceV1, type RunStartPayload } from "@artoo/domain";

const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function fail(reason: string): never { throw new Error(`Design revision: ${reason}`); }

/** This checks the authenticated context's binding; it does not create writer authority. */
export function readProductDesignRevision(context: ContextPack | undefined): ProductDesignRevisionContextV1 | undefined {
  if (context?.product_design_revision === undefined) return undefined;
  const parsed = ProductDesignRevisionContextV1Schema.safeParse(context.product_design_revision);
  if (!parsed.success) fail("invalid versioned context");
  const revision = parsed.data, goal = context.goal_context;
  if (context.transferred_product_input || context.imported_review_subject) {
    fail("imported source histories require their own continuation");
  }
  if (context.project.id !== revision.project_id || context.workspace.root !== revision.workspace_root
    || goal?.goal_id !== revision.goal_id || goal.plan?.id !== revision.plan_id
    || revision.author_run_id === revision.baseline.run_id || revision.author_run_id === revision.requesting_review.subject_run_id) {
    fail("project, workspace, goal, plan or execution binding differs");
  }
  if (context.review_subject) {
    if (context.product_development || context.policy.execution_mode !== "discussion" || context.policy.filesystem_write_scope.length
      || context.review_subject.development_stage !== "design" || context.review_subject.task_id !== revision.design_task_id
      || context.review_subject.run_id !== revision.author_run_id || context.task.id === revision.design_task_id) {
      fail("independent review must bind the exact new design author");
    }
  } else {
    if (context.product_development?.stage !== "design" || context.policy.execution_mode === "discussion"
      || context.task.id !== revision.design_task_id || !isDeepStrictEqual(context.policy.filesystem_write_scope, [revision.workspace_root])
      || !isDeepStrictEqual(context.product_development.accepted_inputs, { version: 1, files: [revision.baseline.research] })) {
      fail("author must retain the accepted research and exact design task");
    }
  }
  return revision;
}

/** Checked before the model starts, when design.json may still be the prior accepted version. */
export function assertProductDesignRevisionRun(payload: RunStartPayload, computerId: string | undefined): void {
  const context = payload.context_pack.payload, revision = readProductDesignRevision(context);
  if (!revision) return;
  if (!payload.verification || revision.computer_id !== computerId || context?.task.id !== payload.task_id
    || (context.review_subject ? payload.run_id === revision.author_run_id : payload.run_id !== revision.author_run_id)) {
    fail("current node or author/reviewer run differs from the revision context");
  }
}

function decode(bytes: Buffer, label: string): unknown {
  if (!bytes.length || bytes.length > MAX_PRODUCT_DESIGN_REVISION_BYTES) fail(`${label} exceeds its file bound`);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)) as unknown; }
  catch { fail(`${label} requires exact UTF-8 JSON`); }
}
function baseline(revision: ProductDesignRevisionContextV1, researchBytes: Buffer) {
  const pin = revision.baseline.design, bytes = Buffer.from(pin.text, "utf8");
  if (bytes.toString("utf8") !== pin.text || bytes.length !== pin.size || sha(bytes) !== pin.checksum) fail("retained design bytes differ from their accepted measurement");
  const researchPin = revision.baseline.research;
  if (researchBytes.length !== researchPin.size || sha(researchBytes) !== researchPin.checksum) fail("accepted research bytes changed");
  const original = decode(bytes, "baseline"), research = decode(researchBytes, "research");
  const designResult = ProductDesignV2Schema.safeParse(original), researchResult = ProductResearchReportV2Schema.safeParse(research);
  if (!designResult.success || !researchResult.success || validateProductDevelopmentHandoff(researchResult.data, designResult.data).length) {
    fail("baseline and research must preserve the accepted policy-v2 handoff");
  }
  return { original, research };
}

export function assertProductDesignRevisionBaseline(context: ContextPack | undefined, researchBytes: Buffer): void {
  const revision = readProductDesignRevision(context); if (revision) baseline(revision, researchBytes);
}

/** Candidate evidence only. The verifier may emit it only after measured execution and closure. */
export function inspectProductDesignRevision(context: ContextPack | undefined, researchBytes: Buffer,
  designBytes: Buffer): ProductDesignRevisionEvidenceV1 | undefined {
  const revision = readProductDesignRevision(context); if (!revision) return undefined;
  const { original, research } = baseline(revision, researchBytes), design = decode(designBytes, "revised design");
  const errors = validateAdditiveDesignRevision(original, design, research, revision.request);
  if (errors.length) fail(errors.slice(0, 8).join(" "));
  return ProductDesignRevisionEvidenceV1Schema.parse({ version: 1, revision_id: revision.revision_id,
    scope: "all-declared-workspace-design-cases", descriptor_digest: sha(canonicalProductDesignRevisionContextV1(revision)),
    baseline_checksum: revision.baseline.design.checksum,
    revised_design: { path: ".artoo/product/design.json", checksum: sha(designBytes), size: designBytes.length } });
}
