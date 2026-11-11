import { z } from "zod";
import { ApplicationPublicationMeasurementPlanV1Schema, ApplicationPublicationDesignCoverageV1Schema } from "./application-publication-measurement.js";
import { ProductBrowserStepSchema, ProductBrowserProgramV2Schema } from "./browser-program.js";
import { ProductBrowserProgramV3Schema } from "./browser-program-v3.js";
import { ProductStorageChecksV1Schema, validateProductStorageChecksV1 } from "./storage-fault.js";
import { ProductStoragePreconditionV1Schema, validateProductStoragePreconditionV1 } from "./storage-precondition.js";
import { ProductMeasurementPlanV1Schema, ProductMeasurementPlanV2Schema } from "./measurement-plan.js";
import { CriterionRefSchema, ReleaseCapabilityBindingV1Schema, CONFIGURED_STATIC_PUBLICATION_CLAIM,
  CONFIGURED_STATIC_PUBLICATION_STATEMENT, CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST,
  canonicalReleaseJson, criterionRefKey, type CriterionRef, type ReleaseCapabilitiesV1 } from "./release-capabilities.js";
import type { VerificationCapabilitiesContext } from "./verification-capabilities.js";
export { ProductBrowserStepSchema } from "./browser-program.js";
export type { ProductBrowserStep } from "./browser-program.js";

/** Versioned handoffs describe product work; they never authorize execution or prove that tests passed. */
export const DevelopmentStageSchema = z.enum(["research", "design", "implementation", "validation"]);
export type DevelopmentStage = z.infer<typeof DevelopmentStageSchema>;
const text = z.string().trim().min(1).max(10000);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const relativePath = z.string().min(1).max(1024).refine((value) =>
  !value.includes("\\") && !value.includes(":") && !/[\u0000-\u001f]/u.test(value)
  && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "Expected a relative workspace path");
const strings = z.array(text).min(1).max(100);
const references = z.array(identifier).min(1).max(100);
const sourceUrl = z.string().url().max(4096).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
}, "Research sources must use HTTPS without embedded credentials");

const ProductResearchBaseSchema = z.object({
  version: z.literal(1),
  objective: text,
  assumptions: z.array(text).max(100),
  requirements: z.array(z.object({
    id: identifier, description: text, priority: z.enum(["must", "should"]), acceptance_criteria: strings,
  })).min(1).max(100),
  sources: z.array(z.object({
    id: identifier, url: sourceUrl, title: text, retrieved_at: z.string().datetime({ offset: true }), content_digest: digest,
  })).min(1).max(100),
  findings: z.array(z.object({ summary: text, source_ids: references })).min(1).max(100),
  decisions: z.array(z.object({ question: text, decision: text, rationale: text, source_ids: z.array(identifier).max(100) })).max(100),
  measurement_plan: ProductMeasurementPlanV1Schema.optional(),
  application_publication_plan: ApplicationPublicationMeasurementPlanV1Schema.optional(),
});
function validateResearch(report: z.infer<typeof ProductResearchBaseSchema>, ctx: z.RefinementCtx): void {
  for (const key of ["requirements", "sources"] as const) {
    if (new Set(report[key].map((item) => item.id)).size !== report[key].length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `Duplicate ${key} IDs` });
    }
  }
  if (!report.requirements.some((item) => item.priority === "must")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requirements"], message: "At least one required outcome is needed" });
  }
  const sources = new Set(report.sources.map((item) => item.id));
  for (const key of ["findings", "decisions"] as const) report[key].forEach((item, index) => {
    if (item.source_ids.some((id) => !sources.has(id))) ctx.addIssue({
      code: z.ZodIssueCode.custom, path: [key, index, "source_ids"], message: "Unknown source reference",
    });
  });
}
export const ProductResearchReportV1Schema = ProductResearchBaseSchema.superRefine(validateResearch);
export type ProductResearchReportV1 = z.infer<typeof ProductResearchReportV1Schema>;
// V2 measurement declarations preserve criterion bytes for exact release-statement matching.
export const ProductResearchReportV2Schema = ProductResearchBaseSchema.extend({
  requirements: z.array(z.object({ id: identifier, description: text, priority: z.enum(["must", "should"]),
    acceptance_criteria: z.array(z.string().min(1).max(10000).refine(value => value.trim().length > 0, "Empty criterion")).min(1).max(100),
  })).min(1).max(100), measurement_plan: ProductMeasurementPlanV2Schema,
}).superRefine((report, ctx) => validateResearch({ ...report, measurement_plan: undefined }, ctx));
export type ProductResearchReportV2 = z.infer<typeof ProductResearchReportV2Schema>;
export const ProductResearchReportSchema = z.union([ProductResearchReportV1Schema, ProductResearchReportV2Schema]);
export type ProductResearchReport = z.infer<typeof ProductResearchReportSchema>;

const ProductDesignBaseSchema = z.object({
  version: z.literal(1),
  application_publication_coverage: ApplicationPublicationDesignCoverageV1Schema.optional(),
  requirement_ids: references,
  information_architecture: strings,
  user_flows: z.array(z.object({ id: identifier, name: text, requirement_ids: references, steps: strings })).min(1).max(100),
  screens: z.array(z.object({ id: identifier, name: text, purpose: text, states: strings, accessibility: strings, responsive: strings })).min(1).max(100),
  // A local, inspectable prototype is required, rather than a prose claim that a design exists.
  prototype: z.object({ entrypoint: relativePath, description: text }),
  data_model: z.array(z.object({ name: text, fields: strings, relationships: z.array(text).max(100) })).max(100),
  api_contracts: z.array(z.object({ name: text, request: text, response: text, error_cases: strings })).max(100),
  decisions: z.array(z.object({ decision: text, rationale: text })).min(1).max(100),
  validation_cases: z.array(z.object({ id: identifier, requirement_ids: references, procedure: strings, expected_result: text,
    browser_steps: z.array(ProductBrowserStepSchema).min(2).max(100).optional(),
    browser_program: z.union([ProductBrowserProgramV2Schema, ProductBrowserProgramV3Schema]).optional(),
    storage_checks: ProductStorageChecksV1Schema.optional(),
    storage_precondition: z.never().optional(),
  })).min(1).max(200),
});
// Each version owns its checks; V2 must not inherit V1-only validation-case rules.
export const ProductDesignV1Schema = ProductDesignBaseSchema.superRefine((design, ctx) => {
  design.validation_cases.forEach((item, index) => {
    if (item.browser_steps !== undefined && item.browser_program !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom,
      path: ["validation_cases", index], message: "Choose browser_steps v1 or one explicitly versioned browser_program, never both" });
    if (item.storage_checks !== undefined) {
      if (item.browser_steps !== undefined || item.browser_program?.version !== 3) ctx.addIssue({ code: z.ZodIssueCode.custom,
        path: ["validation_cases", index, "storage_checks"], message: "Storage checks require an explicit browser_program v3" });
      else try { validateProductStorageChecksV1(item.browser_program.steps, item.storage_checks, item.requirement_ids); }
      catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["validation_cases", index, "storage_checks"], message: (error as Error).message }); }
    }
  });
  const requirements = new Set(design.requirement_ids);
  if (requirements.size !== design.requirement_ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requirement_ids"], message: "Duplicate requirement IDs" });
  for (const key of ["user_flows", "screens", "validation_cases"] as const) {
    if (new Set(design[key].map((item) => item.id)).size !== design[key].length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `Duplicate ${key} IDs` });
  }
  for (const key of ["user_flows", "validation_cases"] as const) design[key].forEach((item, index) => {
    if (item.requirement_ids.some((id) => !requirements.has(id))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key, index, "requirement_ids"], message: "Unknown requirement reference" });
  });
  for (const id of requirements) {
    if (!design.validation_cases.some((item) => item.requirement_ids.includes(id))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["validation_cases"], message: `Missing validation case for ${id}` });
  }
});
export type ProductDesignV1 = z.infer<typeof ProductDesignV1Schema>;

const criterionRefs = z.array(CriterionRefSchema).min(1).max(10000)
  .refine(refs => new Set(refs.map(criterionRefKey)).size === refs.length, "Duplicate criterion references");
const releaseCaseBinding = {
  release_binding: ReleaseCapabilityBindingV1Schema,
  claim_id: z.literal(CONFIGURED_STATIC_PUBLICATION_CLAIM), statement_digest: z.literal(CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST),
};
const designCaseBase = { id: identifier, requirement_ids: references, procedure: strings, expected_result: text };
export const WorkspaceValidationCaseV2Schema = z.object({ ...designCaseBase, method: z.literal("workspace-check"),
  requirement_criteria: criterionRefs, browser_program: ProductBrowserProgramV3Schema, storage_checks: ProductStorageChecksV1Schema.optional(),
  storage_precondition: ProductStoragePreconditionV1Schema.optional(),
  browser_steps: z.never().optional(),
}).strict();
export const ReleaseValidationCaseV2Schema = z.object({ ...designCaseBase, method: z.literal("configured-static-release"),
  requirement_criteria: z.tuple([CriterionRefSchema]), ...releaseCaseBinding,
  browser_steps: z.never().optional(), browser_program: z.never().optional(), storage_checks: z.never().optional(),
  storage_precondition: z.never().optional(),
}).strict();
export const ProductDesignV2Schema = ProductDesignBaseSchema.omit({ version: true, validation_cases: true }).extend({
  version: z.literal(2), validation_cases: z.array(z.discriminatedUnion("method", [WorkspaceValidationCaseV2Schema, ReleaseValidationCaseV2Schema])).min(1).max(200),
}).strict().superRefine((design, ctx) => {
  const requirements = new Set(design.requirement_ids);
  if (requirements.size !== design.requirement_ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["requirement_ids"], message: "Duplicate requirement IDs" });
  for (const key of ["user_flows", "screens", "validation_cases"] as const) {
    if (new Set(design[key].map(item => item.id)).size !== design[key].length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `Duplicate ${key} IDs` });
  }
  for (const key of ["user_flows", "validation_cases"] as const) design[key].forEach((item, index) => {
    if (item.requirement_ids.some(id => !requirements.has(id))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key, index, "requirement_ids"], message: "Unknown requirement reference" });
  });
  design.validation_cases.forEach((item, index) => {
    const ids = new Set(item.requirement_criteria.map(ref => ref.requirement_id));
    if (ids.size !== item.requirement_ids.length || item.requirement_ids.some(id => !ids.has(id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["validation_cases", index, "requirement_criteria"], message: "Criterion references must exactly cover the case requirement IDs" });
    }
    if (item.method === "workspace-check" && item.storage_checks) {
      try {
        validateProductStorageChecksV1(item.browser_program.steps, item.storage_checks, item.requirement_ids);
        const refs = new Set(item.requirement_criteria.map(criterionRefKey));
        if (item.storage_checks.windows.some(window => window.requirement_criteria.some(ref => !refs.has(criterionRefKey(ref))))) throw new Error("Storage criteria must belong to this workspace case");
      } catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["validation_cases", index, "storage_checks"], message: (error as Error).message }); }
    }
    if (item.method === "workspace-check" && item.storage_precondition) {
      try { validateProductStoragePreconditionV1(item.browser_program.steps, item.storage_precondition, item.requirement_ids, item.requirement_criteria); }
      catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["validation_cases", index, "storage_precondition"], message: (error as Error).message }); }
    }
  });
  for (const id of requirements) {
    if (!design.validation_cases.some(item => item.requirement_ids.includes(id))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["validation_cases"], message: `Missing validation case for ${id}` });
  }
});
export type ProductDesignV2 = z.infer<typeof ProductDesignV2Schema>;
export const ProductDesignSchema = z.union([ProductDesignV1Schema, ProductDesignV2Schema]);
export type ProductDesign = z.infer<typeof ProductDesignSchema>;
export function isWorkspaceValidationCase(value: ProductDesignV2["validation_cases"][number]): value is Extract<ProductDesignV2["validation_cases"][number], { method: "workspace-check" }> {
  return value.method === "workspace-check";
}

/** Agent-authored test notes accompany independent node verification; outcomes alone cannot pass a gate. */
export const ProductValidationReportV1Schema = z.object({
  version: z.literal(1),
  cases: z.array(z.object({
    case_id: identifier, requirement_ids: references, outcome: z.enum(["passed", "failed", "blocked"]),
    observations: text, evidence_paths: z.array(relativePath).min(1).max(100),
  })).min(1).max(200),
  known_limitations: z.array(text).max(100),
}).superRefine((report, ctx) => {
  if (new Set(report.cases.map((item) => item.case_id)).size !== report.cases.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cases"], message: "Duplicate validation case IDs" });
  }
});
export type ProductValidationReportV1 = z.infer<typeof ProductValidationReportV1Schema>;
const validationCaseBase = { case_id: identifier, requirement_ids: references, observations: text };
export const ProductValidationReportV2Schema = z.object({ version: z.literal(2),
  cases: z.array(z.discriminatedUnion("method", [
    z.object({ ...validationCaseBase, method: z.literal("workspace-check"), requirement_criteria: criterionRefs,
      outcome: z.enum(["passed", "failed", "blocked"]), evidence_paths: z.array(relativePath).min(1).max(100) }).strict(),
    z.object({ ...validationCaseBase, method: z.literal("configured-static-release"), requirement_criteria: z.tuple([CriterionRefSchema]),
      ...releaseCaseBinding, outcome: z.literal("pending-release"), evidence_paths: z.tuple([]) }).strict(),
  ])).min(1).max(200), known_limitations: z.array(text).max(100),
}).strict().superRefine((report, ctx) => {
  if (new Set(report.cases.map(item => item.case_id)).size !== report.cases.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cases"], message: "Duplicate validation case IDs" });
  }
  report.cases.forEach((item, index) => {
    const ids = new Set(item.requirement_criteria.map(ref => ref.requirement_id));
    if (ids.size !== item.requirement_ids.length || item.requirement_ids.some(id => !ids.has(id))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cases", index, "requirement_criteria"], message: "Criterion references must exactly cover the case requirement IDs" });
    }
  });
});
export type ProductValidationReportV2 = z.infer<typeof ProductValidationReportV2Schema>;
export const ProductValidationReportSchema = z.union([ProductValidationReportV1Schema, ProductValidationReportV2Schema]);
export type ProductValidationReport = z.infer<typeof ProductValidationReportSchema>;

/** Fixed stage inputs measured by the node for an already accepted execution. */
export const AcceptedProductInputsSchema = z.object({
  version: z.literal(1),
  files: z.array(z.object({
    path: z.enum([".artoo/product/research.json", ".artoo/product/design.json"]),
    checksum: digest, size: z.number().int().positive(),
    source_task_id: identifier, source_run_id: identifier, evidence_id: identifier,
  }).strict()).max(2),
}).strict().refine((value) => new Set(value.files.map((file) => file.path)).size === value.files.length, "Duplicate accepted product inputs");

export const ProductDevelopmentContextSchema = z.object({
  version: z.literal(1),
  stage: DevelopmentStageSchema,
  accepted_inputs: AcceptedProductInputsSchema.optional(),
  deliverables: z.array(z.object({ path: relativePath, format: z.enum(["json", "markdown"]), purpose: text })).min(1).max(10),
  instructions: z.array(text).min(1).max(20),
});
export type ProductDevelopmentContext = z.infer<typeof ProductDevelopmentContextSchema>;

/** Fixed cumulative evidence inventory for author and peer verification of each stage. */
export function productStageHandoffPaths(stage: DevelopmentStage): string[] {
  const paths = [".artoo/product/research.json", ".artoo/product/design.json", ".artoo/product/implementation.md", ".artoo/product/validation.json"];
  return paths.slice(0, DevelopmentStageSchema.options.indexOf(stage) + 1);
}

const deliverables: Record<DevelopmentStage, ProductDevelopmentContext["deliverables"]> = {
  research: [{ path: ".artoo/product/research.json", format: "json", purpose: "Requirements, assumptions and research findings linked to retrieved source receipts" }],
  design: [{ path: ".artoo/product/design.json", format: "json", purpose: "User flows, prototype, screen states, data/API contracts and requirement-linked validation cases" }],
  implementation: [{ path: ".artoo/product/implementation.md", format: "markdown", purpose: "Implemented requirements, run instructions, decisions, changed files and remaining gaps" }],
  validation: [{ path: ".artoo/product/validation.json", format: "json", purpose: "Observed behavior for every designed validation case with evidence paths and known limitations" }],
};
/** Shared by node prompts and server context; reports are part of the measured source. */
export const PRODUCT_VERIFICATION_LIFECYCLE_GUIDANCE =
  "Workspace reports are author-session notes written before the author exits. Cite only observations actually available to that session, with their actual stage, scope, request, subject and evidence references. " +
  "A report may truthfully record preview measurements and state that final verification is pending at author exit. After author closure, the node separately verifies the complete current source, including these reports, and produces its final receipt outside the measured workspace. " +
  "Planning must not add a requirement for source files to embed their own future final subject digest or evidence bundle: that receipt is unavailable during authoring, and adding its references would change the measured source. " +
  "During independent review, obtain current final measurements from the node-bound review context (review_subject.verification for ordinary team review), check its source/request/profile binding and every required case and acceptance criterion, and inspect relevant granted evidence. Do not request report edits solely because an accurately scoped author report lacks its own future final identifiers or records final verification as pending at author exit. " +
  "This lifecycle distinction does not waive explicit user requirements or other required report content. Missing or failed current final evidence, incorrect bindings, unsupported claims, incomplete required coverage and genuine product defects remain blocking. Never relabel preview or historical evidence as current final acceptance; both fresh node verification and independent review remain required.";

const stageInstructions: Record<DevelopmentStage, string[]> = {
  research: [
    "Initialize product/ for product source, prototypes, assets and test evidence. Keep these files under product/ and stage handoffs under .artoo/product/ so the configured verifier measures the complete delivered version.",
    "Use the configured research tools to retrieve sources. Record the tool's actual URL, retrieval time and content digest; never invent citations or receipts.",
    'Write research.json with version:1, objective, assumptions:[], requirements:[{id,description,priority:"must"|"should",acceptance_criteria:[]}], sources:[{id,url,title,retrieved_at,content_digest}], findings:[{summary,source_ids:[]}], decisions:[{question,decision,rationale,source_ids:[]}]. Each source id must equal the actual research tool receipt id. Resolve reversible choices and record their rationale.',
  ],
  design: [
    "Read .artoo/product/research.json and preserve all must-have requirements. Create an inspectable local prototype, including loading, empty and error states, responsive behavior and accessibility.",
    "The accepted_inputs files are fixed to previously accepted node measurements. Do not edit them; a changed accepted requirement fails verification and requires a separately reviewed plan revision.",
    "Write design.json with version:1, requirement_ids:[], information_architecture:[], user_flows:[{id,name,requirement_ids:[],steps:[]}], screens:[{id,name,purpose,states:[],accessibility:[],responsive:[]}], prototype:{entrypoint,description}, data_model:[{name,fields:[],relationships:[]}], api_contracts:[{name,request,response,error_cases:[]}], decisions:[{decision,rationale}], validation_cases:[{id,requirement_ids:[],procedure:[],expected_result}]. Each requirement needs a validation case.",
    'For a static web product, select the browser program from verification_capabilities.checks[].contract.version. Version 1 (or legacy context without a capability contract) uses browser_steps with {action:"navigate",path:"/"}, {action:"reload"}, {action:"click",selector}, {action:"fill",selector,value}, {action:"check",selector,checked}, {action:"assert_visible",selector}, {action:"assert_hidden",selector}, {action:"assert_text",selector,text}, {action:"assert_value",selector,value}, {action:"assert_count",selector,count}. Start with navigate and include a substantive content, value or count assertion. Selectors identify the intended user interface. No remote URL or JavaScript is accepted.',
    'When the configured static-web contract version is 2, every validation case must instead contain browser_program:{version:2,contract_digest,steps:[]} and omit browser_steps. Copy contract_digest from that configured check. Every step has page:"main". The original actions above remain available with that page field, plus {action:"press",page:"main",key}, {action:"type_text",page:"main",text}, {action:"focus",page:"main",selector}, {action:"assert_focused",page:"main",selector}, {action:"assert_focus_within",page:"main",selector}. Use only configured keys and at most 1000 UTF-16 text units. Start with navigate and include a content, value, count or focus assertion. focus is programmatic setup and cannot prove Tab traversal; use actual press steps followed by focus assertions for that. Focus targets are unique CSS elements in the main document; iframe and shadow DOM focus are unsupported. The protected verifier uses the configured width/height viewports, and does not execute legacy browser_steps on a version-2 profile. Never provide both formats or infer native screen-reader or browser-zoom evidence.',
    'When the configured static-web contract version is 3, use only browser_program:{version:3,contract_digest,steps:[]} with the exact configured digest; v1 steps and v2 programs are rejected by that profile. Reuse the version-2 actions, keys and focus constraints with an explicit bounded ASCII page ID on every step. main exists initially: start with {action:"navigate",page:"main",path:"/"}. Create another page with {action:"open_page",page:"peer",path:"/"}; close it with {action:"close_page",page:"peer"}. At most three pages may be created in total, including main; closing does not restore the budget. Never reuse names, close main or operate on unknown or closed pages. Pages share one browser context per case and viewport and the same protected local product origin. Include a substantive content, value, count or focus assertion. Verify shared browser state through real user actions and peer-page assertions; arbitrary scripts, direct storage writes and synthetic StorageEvents are unavailable. Every created page is captured once, immediately before its close or at case end, and captures are ordered by page creation. These measurements do not prove backend synchronization, multi-device collaboration, storage exceptions, native screen-reader behavior or browser zoom.',
  ],
  implementation: [
    "Read the accepted research and design handoffs. Continue from the accepted prototype and existing product/ source, reusing working behavior and the accepted validation cases while implementing remaining requirements and repairing defects. Preserve the declared interfaces; a stage transition alone does not require rebuilding the product. Update the implementation notes with actual instructions and remaining gaps.",
    "Do not edit accepted_inputs files or weaken their requirements or browser assertions. Their checksums are checked by the node before and after execution.",
    "Run relevant checks and capture their actual results. Do not remove assertions, fabricate passing output or alter the protected acceptance program.",
  ],
  validation: [
    "Reuse the implemented product and exact accepted case definitions in .artoo/product/design.json. Exercise every case and review coverage of every acceptance criterion. Inspect the prototype and implemented UI where applicable. Record actual observed failures and limitations; do not infer success from compilation alone.",
    "Preserve the accepted_inputs files exactly, including all accepted requirements and browser assertions. A failed requirement must be repaired in the product, not removed from its specification.",
    'Write validation.json with version:1, cases:[{case_id,requirement_ids:[],outcome:"passed"|"failed"|"blocked",observations,evidence_paths:[]}], known_limitations:[]. Every evidence_path must identify an existing workspace file. Your report does not replace node-run acceptance tests or independent review.',
  ],
};

export function productDevelopmentContext(stage: DevelopmentStage,
  capabilities?: Pick<VerificationCapabilitiesContext, "checks" | "measurement_plan_policy">,
  releaseCapabilities?: ReleaseCapabilitiesV1): ProductDevelopmentContext {
  const storageFaultEnabled = capabilities?.checks.some(({ contract }) => contract.version === 3 && contract.storage_fault?.version === 1) ?? false;
  const measurementV2 = capabilities?.measurement_plan_policy?.version === 2;
  const storagePreconditionEnabled = measurementV2 && (capabilities?.checks.some(({ contract }) => contract.version === 3 && contract.storage_precondition?.version === 1) ?? false);
  let instructions = storageFaultEnabled
    ? stageInstructions[stage].map((instruction) => instruction.replace("multi-device collaboration, storage exceptions, native screen-reader", "multi-device collaboration, native screen-reader"))
    : stageInstructions[stage];
  if (measurementV2) instructions = instructions.filter(instruction =>
    !instruction.startsWith("For a static web product, select") && !instruction.startsWith("When the configured static-web contract version is 2"))
    .map(instruction => {
      if (instruction.startsWith("Write design.json with version:1")) return instruction.replace("version:1", "version:2")
        .replace("validation_cases:[{id,requirement_ids:[],procedure:[],expected_result}]", 'validation_cases:[{id,requirement_ids:[],procedure:[],expected_result,method:"workspace-check",requirement_criteria:[{requirement_id,criterion_index}],browser_program:{version:3,contract_digest,steps:[]}}]');
      if (instruction.startsWith("Write validation.json with version:1")) return 'Write validation.json with version:2, cases:[{case_id,requirement_ids:[],method:"workspace-check",requirement_criteria:[{requirement_id,criterion_index}],outcome:"passed"|"failed"|"blocked",observations,evidence_paths:[]}], known_limitations:[]. Every workspace evidence_path must identify an existing workspace file. Match each accepted design case exactly. Your report does not replace node-run acceptance tests or independent review.';
      return instruction;
    });
  return ProductDevelopmentContextSchema.parse({ version: 1, stage, deliverables: deliverables[stage], instructions: [...instructions,
    PRODUCT_VERIFICATION_LIFECYCLE_GUIDANCE,
    "When verification_capabilities is present, use its configured actions, viewport sizes, stage policy and unavailable measurements when planning acceptance checks. Configured capability is not evidence that a check ran or passed. Preserve explicit user requirements; an unavailable required measurement remains unmet. For reversible choices the user did not specify, choose verifiable criteria within this contract and record the rationale. Never add unsupported mandatory measurements or use product-authored simulation buttons as trusted browser evidence. Missing capability context means measurement scope is unknown, not unlimited.",
    "Protected verification screenshots are delivered as node-sealed evidence references outside the measured workspace. Start with available node-bound check outcomes, measured scope, case entries and viewport outcomes. Review every acceptance criterion against source, accepted cases and observed execution; use read_evidence to inspect relevant raw traces and screenshots for concrete semantic, visual, failure or coverage questions, following the tool's integrity and pagination requirements for each selected reference. Do not enumerate every trace by default or claim visual inspection of unseen screenshots. Do not describe sealed evidence as product files or require copying PNGs into the measured tree. For validation evidence_paths, write a factual text record under product/ citing the request, measured scope and evidence references. Reused source and cases still require node measurement of the current exact source; earlier-stage or preview results do not replace required final verification or independent review. A prototype-only observation does not prove functional cases; unknown scope or an unrun required check is not a pass.",
    ...(capabilities?.measurement_plan_policy ? [
      measurementV2
        ? 'The configured measurement_plan_policy version 2 requires research.measurement_plan:{version:2,profile_digest,entries:[{method:"workspace-check",requirement_id,criterion_index,command_id,config_digest,contract_digest,actions:[],keys:[],viewports:[{id,width,height}],needs:[]}]}. Declare every must acceptance criterion exactly once by its zero-based index, no should criteria. Copy exact configured profile/check bindings and viewport dimensions; declare substantive assertions and only supported actions. press needs configured keys and keyboard-events; type_text needs keyboard-events; focus actions need a focus scope; open/close_page need cumulative pages limits. Design and validation use version:2 and explicit requirement_criteria per case. Workspace cases require browser_program v3 and must realize their assigned actions, keys and needs; several workspace cases may cover the same criterion. Later stages preserve and re-evaluate the accepted research mapping.'
        : 'The configured measurement_plan_policy requires research.measurement_plan:{version:1,profile_digest,entries:[{requirement_id,criterion_index,command_id,config_digest,contract_digest,actions:[],keys:[],viewports:[{id,width,height}],needs:[]}]}. Declare every must acceptance criterion exactly once by its zero-based index, no should criteria. Copy the exact configured profile/check bindings and complete viewport dimensions; declare substantive assertions and only supported actions. press requires configured keys and keyboard-events; type_text requires keyboard-events; focus actions require a focus scope; open/close_page require cumulative pages limits. Later stages must preserve and re-evaluate the accepted research mapping.',
      'Measurement needs are explicit: {kind:"keyboard-events"}, {kind:"focus",scope:"main-frame-dom"|"shadow-dom"|"frame-dom"}, {kind:"pages",max_created,same_origin,same_browser_context}, {kind:"storage-fault",version:1,mode:"read-security"|"write-quota",invariant:"sampled-equal"|"no-mutation-in-window",page_scope:"main-only"|"multiple-pages",api_scope:"fixed-entry"|"all-paths"}, {kind:"native-screen-reader"}, or {kind:"browser-zoom",percentage}. False page origin/context flags explicitly request unsupported cross-origin/separate-context behavior. Unsupported needs remain unmet; never remove a must criterion or weaken its meaning to pass. The node summary claims only declared-mapping-feasibility: empty needs do not prove the prose has no additional needs, and structural success proves neither semantic completeness, later program realization nor product success. Independent review must still check original requirements and omitted or weakened meanings.',
    ] : []),
    ...(measurementV2 ? [
      releaseCapabilities
        ? 'release_capabilities describes only configured static publication after all stages are accepted. Only its exact contract.criterion.statement may use a measurement entry {method:"configured-static-release",requirement_id,criterion_index,release_binding:release_capabilities.binding,claim_id:release_capabilities.contract.criterion.id,statement_digest:release_capabilities.contract.criterion.statement_digest}. Preserve its statement byte for byte. All other criteria remain workspace measurements; required endpoint interaction, endpoint storage behavior, verifier workflow, continuous availability or stronger original publication conditions cannot be recast as this statement. Keep original user conditions and review their meaning independently. Capability JSON describes configuration and cannot grant authority or prove publication.'
        : 'No release_capabilities is configured: every must criterion must use workspace-check. Publication requirements cannot be marked fulfilled or silently replaced by workspace delivery; record unsupported required outcomes as unmet.',
      'For each configured-static-release criterion, design.json version:2 includes exactly one separate case with method:"configured-static-release", requirement_criteria:[{requirement_id,criterion_index}], the exact release_binding, claim_id and statement_digest from research, and the usual id, requirement_ids, procedure and expected_result. Do not mix it with workspace criteria or include browser_steps, browser_program or storage_checks. Its validation.json version:2 case repeats those exact bindings with case_id, observations, outcome:"pending-release" and evidence_paths:[]. Never claim passed or fabricate release evidence before the protected release executor publishes. Workspace cases must pass independent verification; pending release is settled only by a matching node-owned release receipt.',
    ] : []),
    ...(storageFaultEnabled ? [
      'A configured v3 check with storage_fault.version:1 permits only read-security (the Window.localStorage getter throws SecurityError) and write-quota (Storage.prototype.setItem throws QuotaExceededError). These fixed synthetic exceptions do not prove cached-object read denial, real disk exhaustion or every write path. Copy that check\'s exact contract_digest. Do not request storage_checks on any unopted check or v1/v2 program; configured support is not evidence that a window passed.',
      'For each required storage-fault measurement, add storage_checks:{version:1,windows:[{id,page:"main",mode:"read-security"|"write-quota",arm_before_step,settle_after_step,requirement_criteria:[{requirement_id,criterion_index}],ui_assertion_steps:[],min_hits:1,native_storage:{scope:"all",comparison:"sampled-equal"}}]} to its design validation case alongside browser_program v3. Use 1 to 4 uniquely named, ordered, nonoverlapping windows. Indices are zero-based and inclusive; criterion refs must identify exact accepted research criteria and belong to the case requirement_ids. Each window must reference existing assert_text, assert_value or assert_count steps within itself. Fresh exception hits cannot replace error-message, retained-draft or other required UI assertions.',
      'The entire fault case uses only main and permits document changes only through explicit navigate/reload steps; extra pages, iframe/popup realms and spontaneous navigation are rejected even outside windows. Each window measures one product document and may navigate/reload only at its first step. Step0 uses an actual baseline at the first product-document pause before scripts; later navigation/reload uses the preceding document\'s native baseline before the action. Establish existing values through normal product UI, preserve a normal case without injection, and verify recovery with later normal UI actions. Separate windows do not prove continuous fault coverage between them.',
      'Native storage checks compare all localStorage entries at two samples, bounded to 512 keys and 1MiB of key/value UTF-8 bytes; the verifier keeps raw values private. Every observed mutation fails a fault window, but event coverage is observed-only. Equal samples and zero observed events do not prove no-mutation-in-window or absence of write-then-restore. Preserve stronger original requirements as unmet when this configured measurement cannot establish them; never weaken criteria or claim multipage fault coverage. Review the sealed actual trace and UI evidence, including fresh hits, exact criterion refs and sampled-equal scope, before accepting a requirement.',
    ] : []),
    ...(storagePreconditionEnabled ? [
      'An opted-in v3 check with storage_precondition.version:1 can establish one raw localStorage document before the first main product script in a new isolated context. Declare the exact required policy-v2 workspace need {kind:"storage-precondition",version:1,input:"raw-local-document",phase:"before-first-product-script",page_scope:"main-seed-same-origin-pages",preservation:"seeded-sampled-equal"|"not-requested"}. Empty needs do not declare this capability. Copy the selected check bindings. This configuration does not prove execution or classify a fixture as malformed.',
      'Only a workspace-check case in design.json version:2 may add storage_precondition:{version:1,local_storage:{key,value},requirement_criteria:[{requirement_id,criterion_index}],ui_assertion_steps:[],preservation_checks:[{after_step,ui_assertion_steps:[],requirement_criteria:[{requirement_id,criterion_index}]}]}. The raw key is nonempty and at most 512 UTF-8 bytes; raw value is at most 65536 UTF-8 bytes. Both must contain valid Unicode scalars. Do not trim, JSON-normalize or place code, origins or paths around the raw data. Criterion refs must have an accepted storage-precondition need and belong to the exact case; named steps must be actual assert_text/assert_value/assert_count after initial navigate/main. Optional preservation_checks has at most four ordered distinct checkpoints, each immediately after its last named substantive assertion and using only precondition refs and assertions. The node seeds only main once and never replays for open_page, navigate or reload. Main document navigations require explicit navigate/reload steps. Seed-only cases may use existing controlled same-origin v3 pages and their real UI assertions; declare their page needs. Controlled peers retain the existing v3 same-origin navigation rules. Uncontrolled pages/realms remain rejected. A combined storage-fault case retains its stricter main-only rule. Native preservation samples cover the shared protected origin and report main-document epochs only. Release cases and legacy designs cannot use this sidecar. Browser actions still cannot write storage or execute arbitrary JavaScript.',
      'The seed receipt proves actual native bytes before product code; independent review must compare each invalid-JSON, invalid-schema or invalid-record fixture with the real parser. Healthy Retry cannot prove malformed input handling. Assert actual error UI, retained unsaved fields, cancellation, failed Reset and successful Reset plus reload where required. Preservation checkpoints prove equality with seeded native bytes only at their named samples, not continuous preservation. A combined storage-fault window starts from the seeded baseline and still needs an actual supported exception hit plus separate UI assertions; seeding is never a substitute for either outcome.',
    ] : []),
  ] });
}

interface StagedSpec { development_stage?: DevelopmentStage; dependencies: { ref: string; type: string }[]; expected_artifacts?: { type: string }[] }
/** Team plans must connect complete stage handoffs through blocking dependencies. Legacy plans do not call this gate. */
export function validateProductDevelopmentPlan(specs: readonly StagedSpec[]): string[] {
  const errors: string[] = [];
  const stages = DevelopmentStageSchema.options;
  if (specs.length < 4 || specs.length > 50) errors.push("An agent team plan needs 4 to 50 tasks covering research, design, implementation and validation.");
  specs.forEach((spec, index) => {
    if (!spec.development_stage) errors.push(`Task ${index} has no development_stage.`);
    if (spec.expected_artifacts?.some((artifact) => artifact.type !== "report")) errors.push(`Task ${index} requests an unsupported automatic artifact type; use report and reference other product files in its handoff.`);
  });
  const indexes = (stage: DevelopmentStage) => specs.flatMap((spec, index) => spec.development_stage === stage ? [index] : []);
  for (const stage of stages) if (!indexes(stage).length) errors.push(`The plan is missing the ${stage} stage.`);
  const ancestors = (index: number, found = new Set<number>()): Set<number> => {
    for (const edge of specs[index]?.dependencies ?? []) {
      if (edge.type === "soft_context") continue;
      const previous = Number(edge.ref);
      if (!/^\d+$/.test(edge.ref) || !Number.isSafeInteger(previous) || !specs[previous]) {
        errors.push(`Task ${index} has an invalid dependency ${edge.ref}.`); continue;
      }
      if (found.has(previous)) continue;
      found.add(previous); ancestors(previous, found);
    }
    return found;
  };
  specs.forEach((spec, index) => {
    const predecessors = ancestors(index);
    if (predecessors.has(index)) errors.push(`Task ${index} participates in a dependency cycle.`);
    const stageIndex = stages.indexOf(spec.development_stage!);
    if (stageIndex > 0) for (const required of indexes(stages[stageIndex - 1]!)) {
      if (!predecessors.has(required)) errors.push(`Task ${index} must wait for ${stages[stageIndex - 1]} task ${required}.`);
    }
    for (const predecessor of predecessors) {
      if (stages.indexOf(specs[predecessor]!.development_stage!) > stageIndex) errors.push(`Task ${index} depends on a later development stage.`);
    }
  });
  return [...new Set(errors)];
}

/** Checks traceability, not the truth of agent-authored claims. IO and measured checks belong to the node.
 * Preview permits honest unfinished outcomes while retaining all coverage checks; acceptance defaults to final. */
export function validateProductDevelopmentHandoff(research: ProductResearchReport, design: ProductDesign, validation?: ProductValidationReport,
  validationScope: "preview" | "final" = "final"): string[] {
  const errors: string[] = [];
  const requirements = new Set(research.requirements.map((item) => item.id));
  for (const id of design.requirement_ids) if (!requirements.has(id)) errors.push(`Design references unknown requirement ${id}.`);
  for (const requirement of research.requirements.filter((item) => item.priority === "must")) {
    if (!design.requirement_ids.includes(requirement.id)) errors.push(`Design omits required outcome ${requirement.id}.`);
  }
  const planV2 = research.measurement_plan?.version === 2 ? research.measurement_plan : undefined;
  if ((design.version === 2) !== Boolean(planV2)) errors.push("Design version must match the accepted research measurement-plan version.");
  if (validation && validation.version !== design.version) errors.push("Validation version must match the accepted design version.");
  if (design.version === 2) {
    if (!planV2) return errors;
    const plannedCriteria = new Map(planV2.entries.map(entry => [criterionRefKey(entry), entry]));
    const coverage = new Map<string, number>();
    for (const item of design.validation_cases) {
      if (item.method === "workspace-check" && item.storage_precondition) {
        for (const ref of item.storage_precondition.requirement_criteria) {
          const entry = plannedCriteria.get(criterionRefKey(ref));
          if (!entry || entry.method !== "workspace-check" || !entry.needs.some(need => need.kind === "storage-precondition")
            || entry.contract_digest !== item.browser_program.contract_digest) {
            errors.push(`Storage precondition in case ${item.id} has no exact accepted workspace need for ${criterionRefKey(ref)}.`);
          }
        }
      }
      for (const ref of item.requirement_criteria) {
        const key = criterionRefKey(ref);
        const requirement = research.requirements.find(candidate => candidate.id === ref.requirement_id);
        if (!requirement || requirement.acceptance_criteria[ref.criterion_index] === undefined) {
          errors.push(`Design case ${item.id} references unknown criterion ${key}.`); continue;
        }
        const entry = plannedCriteria.get(key);
        if (requirement.priority === "must" && !entry) errors.push(`Design criterion ${key} has no accepted measurement declaration.`);
        if (entry && entry.method !== item.method) errors.push(`Design case ${item.id} changes the measurement method for ${key}.`);
        coverage.set(key, (coverage.get(key) ?? 0) + 1);
        if (item.method === "configured-static-release") {
          if (requirement.priority !== "must" || requirement.acceptance_criteria[ref.criterion_index] !== CONFIGURED_STATIC_PUBLICATION_STATEMENT) {
            errors.push(`Release case ${item.id} must reference the exact configured publication criterion.`);
          }
          if (!entry || entry.method !== "configured-static-release" || canonicalReleaseJson(item.release_binding) !== canonicalReleaseJson(entry.release_binding)
            || item.claim_id !== entry.claim_id || item.statement_digest !== entry.statement_digest) {
            errors.push(`Release case ${item.id} differs from its accepted release binding.`);
          }
        }
      }
    }
    for (const requirement of research.requirements.filter(item => item.priority === "must")) requirement.acceptance_criteria.forEach((_, criterion_index) => {
      const key = criterionRefKey({ requirement_id: requirement.id, criterion_index });
      if (!coverage.has(key)) errors.push(`Design omits required criterion ${key}.`);
    });
    for (const entry of planV2.entries) if (entry.method === "configured-static-release" && coverage.get(criterionRefKey(entry)) !== 1) {
      errors.push(`Release criterion ${criterionRefKey(entry)} needs exactly one separate design case.`);
    }
    for (const entry of planV2.entries) if (entry.method === "workspace-check") {
      const need = entry.needs.find(need => need.kind === "storage-precondition");
      if (!need) continue;
      const key = criterionRefKey(entry);
      const seededCases = design.validation_cases.filter(item => item.method === "workspace-check"
        && item.browser_program.contract_digest === entry.contract_digest
        && item.storage_precondition?.requirement_criteria.some(ref => criterionRefKey(ref) === key));
      if (!seededCases.length || need.preservation === "seeded-sampled-equal" && !seededCases.some(item =>
        item.method === "workspace-check" && item.storage_precondition?.preservation_checks?.some(check =>
          check.requirement_criteria.some(ref => criterionRefKey(ref) === key)))) {
        errors.push(`Storage precondition criterion ${key} lacks its declared seed or native preservation checkpoint.`);
      }
    }
    if (validation?.version === 2) {
      const refsEqual = (a: CriterionRef[], b: CriterionRef[]): boolean => canonicalReleaseJson(a.map(criterionRefKey).sort()) === canonicalReleaseJson(b.map(criterionRefKey).sort());
      for (const planned of design.validation_cases) {
        const actual = validation.cases.find(item => item.case_id === planned.id);
        if (!actual) { errors.push(`Missing validation result for ${planned.id}.`); continue; }
        if (actual.method !== planned.method || !refsEqual(actual.requirement_criteria, planned.requirement_criteria)
          || canonicalReleaseJson([...actual.requirement_ids].sort()) !== canonicalReleaseJson([...planned.requirement_ids].sort())) {
          errors.push(`Validation case ${planned.id} changes its accepted method or criterion coverage.`);
        }
        if (validationScope !== "preview" && actual.method === "workspace-check" && actual.outcome !== "passed") errors.push(`Validation case ${planned.id} is ${actual.outcome}.`);
        if (planned.method === "configured-static-release" && actual.method === "configured-static-release"
          && (canonicalReleaseJson(actual.release_binding) !== canonicalReleaseJson(planned.release_binding)
            || actual.claim_id !== planned.claim_id || actual.statement_digest !== planned.statement_digest)) {
          errors.push(`Validation case ${planned.id} changes its accepted release binding.`);
        }
      }
      for (const actual of validation.cases) if (!design.validation_cases.some(item => item.id === actual.case_id)) errors.push(`Unknown validation case ${actual.case_id}.`);
    }
    return errors;
  }
  if (validation) {
    for (const planned of design.validation_cases) {
      const actual = validation.cases.find((item) => item.case_id === planned.id);
      if (!actual) errors.push(`Missing validation result for ${planned.id}.`);
      else {
        if (validationScope !== "preview" && actual.outcome !== "passed") errors.push(`Validation case ${planned.id} is ${actual.outcome}.`);
        if (planned.requirement_ids.some((id) => !actual.requirement_ids.includes(id))) errors.push(`Validation case ${planned.id} omits required coverage.`);
      }
    }
    for (const actual of validation.cases) {
      if (!design.validation_cases.some((item) => item.id === actual.case_id)) errors.push(`Unknown validation case ${actual.case_id}.`);
      if (actual.requirement_ids.some((id) => !requirements.has(id))) errors.push(`Validation case ${actual.case_id} references unknown requirements.`);
    }
  }
  return errors;
}
