import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { AcceptedProductInputsSchema, ProductResearchReportSchema, ProductDesignSchema, ProductValidationReportSchema, productDevelopmentContext,
  validateProductDevelopmentHandoff, type ContextPack } from "@artoo/domain";
import type { ArtifactDescriptor } from "@artoo/protocol";
import { readResearchReceipt, type ResearchOptions } from "./research.js";
import { workspaceCasesForMeasurementPlan } from "./measurement-plan-realization.js";
import { readImportedDesignResearch } from "./product-source-runtime.js";
import { inspectProductDesignRevision, readProductDesignRevision } from "./product-design-revision.js";

/** Fixed paths and real file observations, rather than artifact metadata, gate stage handoffs. */
export function readProductFile(root: string, path: string, maxBytes = 1024 * 1024): Buffer {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes(":") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid product handoff path");
  const physical = realpathSync.native(root); let absolute = physical;
  for (const component of path.split("/")) {
    absolute = resolve(absolute, component);
    if (lstatSync(absolute).isSymbolicLink()) throw new Error("Product handoffs cannot use symbolic links");
  }
  const suffix = relative(physical, absolute);
  if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error("Product handoff leaves workspace");
  const before = lstatSync(absolute);
  if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes || before.size === 0) throw new Error("Product handoff must be a nonempty bounded regular file");
  const bytes = readFileSync(absolute), after = lstatSync(absolute);
  const sameContentFacts = (left: typeof before, right: typeof before) => left.ino === right.ino && left.dev === right.dev && left.mtimeMs === right.mtimeMs && left.size === right.size && right.nlink === 1 && right.isFile() && !right.isSymbolicLink();
  if (!sameContentFacts(before, after) || bytes.length !== after.size) throw new Error("Product handoff changed while reading");
  if (before.ctimeMs !== after.ctimeMs) {
    // Windows scanners can change metadata on first open. Re-read identical bytes
    // and require a stable second observation; never ignore an observed content change.
    const repeated = readFileSync(absolute), stable = lstatSync(absolute);
    if (!sameContentFacts(after, stable) || after.ctimeMs !== stable.ctimeMs || !repeated.equals(bytes)) throw new Error("Product handoff changed while reading");
  }
  return bytes;
}

/** Old contexts omit this versioned extension. New contexts pin the complete accepted input set. */
export function assertAcceptedProductInputs(root: string, context: ContextPack | undefined,
  measured?: ReadonlyMap<string, { path: string; checksum: string; size: number }>): void {
  const development = context?.product_development;
  if (development?.accepted_inputs === undefined) return;
  const parsed = AcceptedProductInputsSchema.safeParse(development.accepted_inputs);
  if (!parsed.success) throw new Error(`Accepted product input pins are invalid: ${parsed.error.issues[0]?.message ?? "invalid shape"}`);
  const expected = development.stage === "research" ? [] : development.stage === "design" ? [".artoo/product/research.json"]
    : development.stage === "implementation" || development.stage === "validation" ? [".artoo/product/research.json", ".artoo/product/design.json"] : undefined;
  if (!expected) throw new Error("Accepted product input pins require a supported development stage");
  if (parsed.data.files.length !== expected.length || expected.some((path) => !parsed.data.files.some((file) => file.path === path))) {
    throw new Error(`Accepted product input pins for ${development.stage} must contain exactly ${expected.join(", ") || "no files"}`);
  }
  for (const pin of parsed.data.files) {
    let actual = measured?.get(pin.path);
    if (!measured) {
      try {
        const bytes = readProductFile(root, pin.path);
        actual = { path: pin.path, checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, size: bytes.length };
      } catch (error) { throw new Error(`Accepted product input ${pin.path} cannot be read safely: ${error instanceof Error ? error.message : "unavailable"}`); }
    }
    if (!actual) throw new Error(`Accepted product input ${pin.path} is absent from the measured source`);
    if (actual.checksum !== pin.checksum || actual.size !== pin.size) throw new Error(`Accepted product input ${pin.path} changed; restore the accepted file or obtain a reviewed plan revision`);
  }
}

/** These format/provenance checks supplement, never replace, the node-local acceptance program. */
export function validateProductStage(root: string, context: ContextPack, researchOptions?: ResearchOptions): ArtifactDescriptor[] {
  const development = context.product_development;
  if (context.imported_execution_review_subject || context.imported_validation_review_subject || context.imported_recovery_validation_review_subject) throw new Error("Product review is not an author stage");
  if (context.imported_recovery_validation && (!context.transferred_product_input || development?.stage !== "validation"
    || context.imported_validation || context.review_subject || context.imported_review_subject || context.imported_design_review_subject
    || context.imported_execution || context.imported_execution_repair || context.product_design_revision || context.policy.execution_mode !== undefined))
    throw Error("Recovery author requires its exclusive fresh validation context");
  if (context.imported_validation && (!context.transferred_product_input || development?.stage !== "validation"
    || context.review_subject || context.imported_review_subject || context.imported_design_review_subject || context.imported_execution
    || context.imported_execution_repair || context.product_design_revision || context.policy.execution_mode !== undefined))
    throw Error("H7 requires its exclusive imported validation context");
  if (context.imported_execution_repair && (!context.transferred_product_input || development?.stage !== "implementation"
    || context.review_subject || context.imported_review_subject || context.imported_design_review_subject || context.imported_execution || context.product_design_revision)) {
    throw new Error("Repair requires its exclusive imported implementation context");
  }
  if (context.imported_execution && (!context.transferred_product_input || development?.stage !== "implementation"
    || context.review_subject || context.imported_review_subject || context.imported_design_review_subject || context.product_design_revision)) {
    throw new Error("H5 requires its exclusive imported implementation context");
  }
  if (context.transferred_product_input && ((!context.imported_execution && !context.imported_execution_repair && !context.imported_validation && !context.imported_recovery_validation && development?.stage !== "design") || context.policy.execution_mode === "discussion")) {
    throw new Error("Transferred research requires its dedicated admitted design execution");
  }
  if (!development || context.policy.execution_mode === "discussion") return [];
  assertAcceptedProductInputs(root, context);
  readProductDesignRevision(context);
  const stage = development.stage;
  const json = (path: string): unknown => JSON.parse(readProductFile(root, path).toString("utf8"));
  const researchBytes = readProductFile(root, ".artoo/product/research.json");
  // Only the original node-owned continuation may project an accepted foreign
  // measurement plan. Research bytes and retrieval provenance remain unchanged.
  const research = context.transferred_product_input
    ? readImportedDesignResearch(root, context, researchBytes)
    : ProductResearchReportSchema.parse(JSON.parse(researchBytes.toString("utf8")));
  if (!context.transferred_product_input) {
    if (!researchOptions || !context.goal_context) throw new Error("Product research requires a configured receipt store and goal binding");
    for (const source of research.sources) {
      const receipt = readResearchReceipt(researchOptions, source.id, { projectId: context.project.id, goalId: context.goal_context.goal_id, workspaceRoot: realpathSync.native(root) });
      if (source.url !== receipt.url || source.retrieved_at !== receipt.retrieved_at || source.content_digest !== receipt.content_digest || source.title !== receipt.title) throw new Error(`Research source ${source.id} does not match the node's retrieval receipt`);
    }
  }
  if (stage !== "research") {
    const designBytes = readProductFile(root, ".artoo/product/design.json");
    inspectProductDesignRevision(context, researchBytes, designBytes);
    const design = ProductDesignSchema.parse(JSON.parse(designBytes.toString("utf8")));
    if (design.version === 2 && design.validation_cases.some(item => item.method === "workspace-check" && item.storage_precondition !== undefined)) {
      // Strict decoding applies only to the new raw-data extension. Preserve legacy decoding and reject replacement of malformed UTF-8.
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(designBytes);
      const capabilities = context.verification_capabilities;
      if (!capabilities || capabilities.measurement_plan_policy?.version !== 2) throw new Error("Storage preconditions require configured policy-v2 verification capabilities");
      let checked = false;
      for (const check of capabilities.checks) if (check.contract.version === 3) {
        workspaceCasesForMeasurementPlan(research, design, context, { version: 1, profile_digest: capabilities.profile_digest,
          command_id: check.command_id, config_digest: check.config_digest, contract_digest: check.contract_digest }, check.contract.viewports);
        checked = true;
      }
      if (!checked) throw new Error("Storage preconditions require a configured v3 verification check");
    }
    if (!design.prototype.entrypoint.startsWith("product/")) throw new Error("Design prototype must be inside the measured product directory");
    readProductFile(root, design.prototype.entrypoint, 10 * 1024 * 1024);
    const validation = stage === "validation" ? ProductValidationReportSchema.parse(json(".artoo/product/validation.json")) : undefined;
    const errors = validateProductDevelopmentHandoff(research, design, validation);
    if (errors.length) throw new Error(errors.join(" ").slice(0, 2000));
    if (stage === "implementation" || stage === "validation") readProductFile(root, ".artoo/product/implementation.md");
    if (validation) for (const result of validation.cases) for (const evidence of result.evidence_paths) {
      if (!evidence.startsWith("product/")) throw new Error("Validation evidence must be inside the measured product directory");
      readProductFile(root, evidence, 10 * 1024 * 1024);
    }
  }
  return productDevelopmentContext(stage).deliverables.map(({ path }) => {
    const bytes = readProductFile(root, path);
    return { localPath: resolve(root, path), payload: { type: "report", uri: pathToFileURL(resolve(root, path)).href,
      checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, metadata: { path, development_stage: stage } } };
  });
}
