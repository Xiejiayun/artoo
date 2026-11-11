import { ProductResearchReportSchema, ProductDesignSchema, ProductValidationReportSchema, ProductBrowserProgramV2Schema,
  type ContextPack, type DevelopmentStage, type ProductBrowserProgramV2, type ProductBrowserStepV2, type StaticWebCapabilityBinding, type VerificationObservation } from "@artoo/domain";
import type { ExpectedBrowserProgramV2 } from "./browser-evidence.js";
import type { NormalizedWebAcceptanceOptionsV2 } from "./web-acceptance-config.js";
import { STATIC_WEB_MAX_CASES } from "./web-acceptance-config.js";
import { canonicalWebAcceptance as canonical, webAcceptanceDigest as sha } from "./web-acceptance-identity.js";
import { readProductFile } from "./product-stage.js";
import { validateWebAcceptanceHandoff } from "./web-acceptance-handoff.js";

export interface ExpectedWebAcceptanceV2 {
  stage: DevelopmentStage;
  requirements: number;
  programs: ExpectedBrowserProgramV2[];
  casePrograms: { case_id: string; program: ProductBrowserProgramV2 }[];
}
const substantive = new Set(["assert_text", "assert_value", "assert_count", "assert_focused", "assert_focus_within"]);

function expectedObservation(step: ProductBrowserStepV2): ExpectedBrowserProgramV2["steps"][number]["expected_observation"] {
  switch (step.action) {
    case "navigate": case "reload": return { kind: "navigation" };
    case "click": case "fill": case "check": return { kind: "action-completed" };
    case "press": return { kind: "key-press", key: step.key };
    case "type_text": return { kind: "keyboard-input", text_length: step.text.length };
    case "focus": return { kind: "programmatic-focus", focused: true };
    case "assert_focused": case "assert_focus_within": return { kind: "focus-assertion", passed: true };
    case "assert_visible": case "assert_hidden": case "assert_text": case "assert_value": case "assert_count": return { kind: "assertion", passed: true };
  }
}

/** Caller first validates the protected capability snapshot; no report-supplied program identity is consumed. */
export function deriveWebAcceptanceV2Plan(workspace: string, context: ContextPack, options: NormalizedWebAcceptanceOptionsV2,
  binding: StaticWebCapabilityBinding, scope: VerificationObservation["scope"] = "final"): ExpectedWebAcceptanceV2 {
  const stage = context.product_development?.stage ?? context.review_subject?.development_stage;
  if (!stage) throw new Error("Static web acceptance requires a product stage or an explicitly bound review subject");
  const json = (path: string) => JSON.parse(readProductFile(workspace, path).toString("utf8")) as unknown;
  const research = ProductResearchReportSchema.parse(json(".artoo/product/research.json"));
  if (stage === "research") return { stage, requirements: research.requirements.length, programs: [], casePrograms: [] };
  const design = ProductDesignSchema.parse(json(".artoo/product/design.json"));
  if (design.version !== 1) throw new Error("Version 2 product design requires a protected browser program v3 check");
  const validation = stage === "validation" ? ProductValidationReportSchema.parse(json(".artoo/product/validation.json")) : undefined;
  const missing = validateWebAcceptanceHandoff(context, research, design, validation, scope);
  if (missing.length) throw new Error(missing.join(" "));
  if (design.validation_cases.length > STATIC_WEB_MAX_CASES) throw new Error("Browser acceptance supports at most 50 cases");
  for (const test of design.validation_cases) {
    if (test.browser_steps !== undefined || !test.browser_program || test.browser_program.version !== 2) throw new Error(`Validation case ${test.id} requires an explicit browser_program v2; legacy browser_steps and other program versions are rejected`);
    const program = test.browser_program;
    if (program.contract_digest !== binding.contract_digest) throw new Error(`Validation case ${test.id} has a different capability contract digest`);
    if (program.steps[0]?.action !== "navigate" || !program.steps.some((step) => substantive.has(step.action))) {
      throw new Error(`Validation case ${test.id} needs a local navigation and a content, value, count or focus assertion`);
    }
  }
  if (!design.prototype.entrypoint.startsWith("product/")) throw new Error("Web prototype must be inside product/");
  readProductFile(workspace, design.prototype.entrypoint);
  const casePrograms: ExpectedWebAcceptanceV2["casePrograms"] = stage === "design" && !options.design_capture_cases
    ? [{ case_id: "prototype", program: { version: 2, contract_digest: binding.contract_digest,
      steps: [{ action: "navigate", page: "main", path: `/${design.prototype.entrypoint.slice("product/".length)}` }] } }]
    : design.validation_cases.map((test) => ({ case_id: test.id, program: ProductBrowserProgramV2Schema.parse(test.browser_program) }));
  const programs = options.browser_program.viewports.flatMap((viewport) => casePrograms.map(({ case_id, program }): ExpectedBrowserProgramV2 => ({
    case_id, viewport: { ...viewport }, program_digest: sha(canonical(program)), captures: [{ page_id: "main" }],
    steps: program.steps.map((step, index) => ({ index, action: step.action, page_id: "main", planned_step_digest: sha(canonical(step)),
      expected_observation: expectedObservation(step) })),
  })));
  return { stage, requirements: research.requirements.length, programs, casePrograms };
}
