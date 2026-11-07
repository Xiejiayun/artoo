import { ProductResearchReportSchema, ProductDesignSchema, ProductValidationReportSchema, ProductBrowserProgramV3Schema,
  deriveBrowserPageLifecycleV3, validateProductDevelopmentHandoff, ProductStorageChecksV1Schema, validateProductStorageChecksV1,
  ProductStoragePreconditionBindingV1Schema, validateProductStoragePreconditionV1,
  type ContextPack, type DevelopmentStage, type ProductBrowserProgramV3, type ProductBrowserStepV3,
  type ProductStorageChecksV1, type ProductStoragePreconditionBindingV1, type StaticWebCapabilityBinding } from "@artoo/domain";
import type { ExpectedBrowserProgramV3 } from "./browser-evidence.js";
import type { NormalizedWebAcceptanceOptionsV3 } from "./web-acceptance-config.js";
import { STATIC_WEB_MAX_CASES } from "./web-acceptance-config.js";
import { canonicalWebAcceptance as canonical, webAcceptanceDigest as sha } from "./web-acceptance-identity.js";
import { readProductFile } from "./product-stage.js";
import { STORAGE_FAULT_INITIALIZER_DIGEST } from "./web-acceptance-storage-source.js";
import { workspaceCasesForMeasurementPlan } from "./measurement-plan-realization.js";
import { deriveStoragePreconditionExpectation, type ExpectedStoragePreconditionV1 } from "./web-acceptance-precondition.js";
import { readImportedDesignResearch } from "./product-source-runtime.js";
import { readImportedDesignVerifierResearch } from "./imported-design-verifier-context.js";
import { inspectProductDesignRevision, readProductDesignRevision } from "./product-design-revision.js";

export interface ExpectedWebAcceptanceV3 {
  stage: DevelopmentStage;
  requirements: number;
  programs: (ExpectedBrowserProgramV3 & { storage_precondition?: ExpectedStoragePreconditionV1 })[];
  casePrograms: { case_id: string; program: ProductBrowserProgramV3; storage_checks?: ProductStorageChecksV1;
    storage_precondition?: ProductStoragePreconditionBindingV1 }[];
}
const substantive = new Set(["assert_text", "assert_value", "assert_count", "assert_focused", "assert_focus_within"]);
function expectedObservation(step: ProductBrowserStepV3): ExpectedBrowserProgramV3["steps"][number]["expected_observation"] {
  switch (step.action) {
    case "navigate": case "reload": return { kind: "navigation" };
    case "click": case "fill": case "check": return { kind: "action-completed" };
    case "press": return { kind: "key-press", key: step.key };
    case "type_text": return { kind: "keyboard-input", text_length: step.text.length };
    case "focus": return { kind: "programmatic-focus", focused: true };
    case "assert_focused": case "assert_focus_within": return { kind: "focus-assertion", passed: true };
    case "assert_visible": case "assert_hidden": case "assert_text": case "assert_value": case "assert_count": return { kind: "assertion", passed: true };
    case "open_page": return { kind: "page-opened" };
    case "close_page": return { kind: "page-closed", closed: true };
  }
}

/** Fixed source and protected configuration determine page names/lifetimes; reports cannot select their own expected scope. */
export function deriveWebAcceptanceV3Plan(workspace: string, context: ContextPack, options: NormalizedWebAcceptanceOptionsV3,
  binding: StaticWebCapabilityBinding): ExpectedWebAcceptanceV3 {
  const stage = context.product_development?.stage ?? context.review_subject?.development_stage;
  if (!stage) throw new Error("Static web acceptance requires a product stage or an explicitly bound review subject");
  if (readProductDesignRevision(context) && (!options.design_capture_cases || !options.windows_browser_process)) {
    throw new Error("Design revision requires protected native Job verification of every declared design case");
  }
  const json = (path: string) => JSON.parse(readProductFile(workspace, path).toString("utf8")) as unknown;
  const researchBytes = readProductFile(workspace, ".artoo/product/research.json");
  if (context.transferred_product_input && stage !== "design") throw new Error("Transferred research verification requires its admitted design stage");
  const research = context.transferred_product_input
    ? readImportedDesignVerifierResearch(workspace, context, researchBytes) ?? readImportedDesignResearch(workspace, context, researchBytes)
    : ProductResearchReportSchema.parse(JSON.parse(researchBytes.toString("utf8")));
  if (stage === "research") return { stage, requirements: research.requirements.length, programs: [], casePrograms: [] };
  const designBytes = readProductFile(workspace, ".artoo/product/design.json");
  inspectProductDesignRevision(context, researchBytes, designBytes);
  const designText = options.storage_precondition
    ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(designBytes) : designBytes.toString("utf8");
  const design = ProductDesignSchema.parse(JSON.parse(designText));
  const validation = stage === "validation" ? ProductValidationReportSchema.parse(json(".artoo/product/validation.json")) : undefined;
  const missing = validateProductDevelopmentHandoff(research, design, validation);
  if (missing.length) throw new Error(missing.join(" "));
  const browserCases = design.version === 2
    ? workspaceCasesForMeasurementPlan(research, design, context, binding, options.browser_program.viewports)
    : design.validation_cases;
  if (browserCases.length > STATIC_WEB_MAX_CASES) throw new Error("Browser acceptance supports at most 50 cases");
  const declared = browserCases.map((test) => {
    if (test.browser_steps !== undefined || test.browser_program?.version !== 3) throw new Error(`Validation case ${test.id} requires an explicit browser_program v3; other program versions are rejected`);
    const program = ProductBrowserProgramV3Schema.parse(test.browser_program);
    if (program.contract_digest !== binding.contract_digest) throw new Error(`Validation case ${test.id} has a different capability contract digest`);
    if (!program.steps.some((step) => substantive.has(step.action))) throw new Error(`Validation case ${test.id} needs a content, value, count or focus assertion`);
    const checks = test.storage_checks === undefined ? undefined : ProductStorageChecksV1Schema.parse(test.storage_checks);
    if (checks) {
      if (!options.storage_fault) throw new Error(`Validation case ${test.id} requires the protected storage_fault opt-in`);
      validateProductStorageChecksV1(program.steps, checks, test.requirement_ids);
      for (const window of checks.windows) for (const criterion of window.requirement_criteria) {
        const requirement = research.requirements.find(item => item.id === criterion.requirement_id);
        if (!requirement || criterion.criterion_index >= requirement.acceptance_criteria.length) throw new Error(`Validation case ${test.id} references an absent accepted requirement criterion`);
      }
    }
    let precondition: ProductStoragePreconditionBindingV1 | undefined;
    const declaredPrecondition = "storage_precondition" in test ? test.storage_precondition : undefined;
    if (declaredPrecondition !== undefined) {
      if (!options.storage_precondition || design.version !== 2 || research.measurement_plan?.version !== 2
        || !("requirement_criteria" in test)) throw new Error("Storage preconditions require the protected opt-in and exact v2 research/design bindings");
      precondition = ProductStoragePreconditionBindingV1Schema.parse({
        source: { path: ".artoo/product/design.json", checksum: sha(designBytes), size: designBytes.length, case_id: test.id },
        precondition: declaredPrecondition });
      validateProductStoragePreconditionV1(program.steps, precondition.precondition, test.requirement_ids, test.requirement_criteria);
      for (const ref of precondition.precondition.requirement_criteria) {
        const requirement = research.requirements.find(item => item.id === ref.requirement_id);
        if (!requirement || ref.criterion_index >= requirement.acceptance_criteria.length) throw new Error("Storage precondition references an absent accepted research criterion");
      }
    }
    return { case_id: test.id, program, ...(checks ? { storage_checks: checks } : {}),
      ...(precondition ? { storage_precondition: precondition } : {}) };
  });
  if (!design.prototype.entrypoint.startsWith("product/")) throw new Error("Web prototype must be inside product/");
  readProductFile(workspace, design.prototype.entrypoint);
  const casePrograms: ExpectedWebAcceptanceV3["casePrograms"] = stage === "design" && !options.design_capture_cases
    ? [{ case_id: "prototype", program: ProductBrowserProgramV3Schema.parse({ version: 3, contract_digest: binding.contract_digest,
      steps: [{ action: "navigate", page: "main", path: `/${design.prototype.entrypoint.slice("product/".length)}` }] }) }]
    : declared;
  const programs = options.browser_program.viewports.flatMap((viewport) => casePrograms.map(({ case_id, program, storage_checks, storage_precondition }): ExpectedWebAcceptanceV3["programs"][number] => ({
    case_id, viewport: { ...viewport }, program_digest: sha(canonical(program)), captures: deriveBrowserPageLifecycleV3(program.steps).captures,
    steps: program.steps.map((step, index) => ({ index, action: step.action, page_id: step.page, planned_step_digest: sha(canonical(step)),
      expected_observation: expectedObservation(step) })),
    ...(storage_checks ? { storage_fault: {
      version: 1 as const, checks_digest: sha(canonical(storage_checks)), installation_script_digest: STORAGE_FAULT_INITIALIZER_DIGEST,
      windows: storage_checks.windows.map(window => ({ id: window.id, page_id: "main" as const, mode: window.mode,
        arm_before_step: window.arm_before_step, settle_after_step: window.settle_after_step,
        start_step_digest: sha(canonical(program.steps[window.arm_before_step])), end_step_digest: sha(canonical(program.steps[window.settle_after_step])),
        requirement_criteria: window.requirement_criteria, ui_assertion_steps: window.ui_assertion_steps,
        min_hits: window.min_hits, native_storage: window.native_storage,
        baseline_phase: window.arm_before_step === 0 ? "first-document-paused" as const : "before-step" as const,
        document_epoch: program.steps.slice(0, window.arm_before_step + 1).filter(step => step.action === "navigate" || step.action === "reload").length,
      })),
    } } : {}),
    ...(storage_precondition ? { storage_precondition: deriveStoragePreconditionExpectation(storage_precondition, program) } : {}),
  })));
  return { stage, requirements: research.requirements.length, programs, casePrograms };
}
