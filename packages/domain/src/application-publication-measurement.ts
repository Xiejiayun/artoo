import { z } from "zod";
import { ProductBrowserProgramV3Schema } from "./browser-program-v3.js";
import { canonicalReleaseJson } from "./release-capabilities.js";
import type { ApplicationPublicationAuthorizationV1, ApplicationPublicationCapabilitiesV1 } from "./application-publication.js";
import type { ApplicationVerificationObservationV1 } from "./application-development.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const claim = "bounded-local-application-publication" as const;
const ref = z.object({ requirement_id: id, criterion_index: z.number().int().min(0).max(99) }).strict();
const key = (value: { requirement_id: string; criterion_index: number }): string => `${value.requirement_id}:${value.criterion_index}`;
const unique = <T>(values: T[]): boolean => new Set(values).size === values.length;
export const APPLICATION_PUBLICATION_STATEMENT_V1 = "Publish the reviewed application on this computer within the configured lease and request limits, verify one normal reopen at the same URL with the same database, and keep the second service running within those limits. Continuous hosting and failure recovery are unsupported." as const;

/** An explicit application measurement plan; no static measurement policy is implied. */
export const ApplicationPublicationMeasurementPlanV1Schema = z.object({
  version: z.literal(1), authorization_event_id: id, publication_contract_digest: hash,
  entries: z.array(z.discriminatedUnion("method", [
    ref.extend({ method: z.literal("application-case") }).strict(),
    ref.extend({ method: z.literal(claim), claim: z.literal(claim) }).strict(),
  ])).min(1).max(10_000).refine(values => unique(values.map(key)), "Duplicate application publication criterion"),
}).strict();
export type ApplicationPublicationMeasurementPlanV1 = z.infer<typeof ApplicationPublicationMeasurementPlanV1Schema>;
export const ApplicationPublicationDesignCoverageV1Schema = z.object({ version: z.literal(1),
  entries: z.array(ref.extend({ case_ids: z.array(id).min(1).max(400).refine(unique, "Duplicate application case ID") }).strict())
    .min(1).max(10_000).refine(values => unique(values.map(key)), "Duplicate design criterion"),
}).strict();
export type ApplicationPublicationDesignCoverageV1 = z.infer<typeof ApplicationPublicationDesignCoverageV1Schema>;
const measuredCriterion = ref.extend({ criterion_digest: hash }).strict();
export const ApplicationPublicationMeasurementV1Schema = z.object({
  version: z.literal(1), authorization_event_id: id, publication_contract_digest: hash,
  research_digest: hash, design_digest: hash, measurement_plan_digest: hash, application_definition_digest: hash,
  development_criteria: z.array(measuredCriterion.extend({ case_ids: z.array(id).min(1).max(400).refine(unique, "Duplicate case ID") }).strict()).min(1).max(10_000),
  publication_criteria: z.array(measuredCriterion.extend({ claim: z.literal(claim) }).strict()).min(1).max(10_000),
  unmet_criteria: z.array(measuredCriterion).max(0),
}).strict().superRefine((value, ctx) => {
  const all = [...value.development_criteria, ...value.publication_criteria];
  if (!unique(all.map(key))) ctx.addIssue({ code: "custom", path: ["publication_criteria"], message: "Each criterion must retain exactly one measurement method" });
});
export type ApplicationPublicationMeasurementV1 = z.infer<typeof ApplicationPublicationMeasurementV1Schema>;

/** Caller supplies original pinned UTF-8 bytes and actual node-owned case observations. JSON is evidence, not authority. */
export function inspectApplicationPublicationMeasurementV1(input: {
  research_json: string; design_json: string; application_definition_digest: string;
  authorization: ApplicationPublicationAuthorizationV1; capabilities: ApplicationPublicationCapabilitiesV1;
  cases: ApplicationVerificationObservationV1["acceptance"]["cases"]; digest: (text: string) => string;
}): ApplicationPublicationMeasurementV1 {
  function fail(message: string): never { throw Error(`Application publication measurement: ${message}`); }
  if (input.research_json.length > 1_048_576 || input.design_json.length > 1_048_576) fail("accepted handoff exceeds bound");
  const research = z.object({ version: z.literal(1), measurement_plan: z.never().optional(),
    requirements: z.array(z.object({ id, description: z.string().min(1), priority: z.enum(["must", "should"]),
      acceptance_criteria: z.array(z.string().min(1).max(10000)).min(1).max(100) })).min(1).max(100),
    application_publication_plan: ApplicationPublicationMeasurementPlanV1Schema,
  }).parse(JSON.parse(input.research_json));
  const design = z.object({ version: z.literal(1), application_publication_coverage: ApplicationPublicationDesignCoverageV1Schema,
    validation_cases: z.array(z.object({ id, requirement_ids: z.array(id).min(1).max(100),
      browser_program: ProductBrowserProgramV3Schema })).min(1).max(400),
  }).parse(JSON.parse(input.design_json));
  const plan = research.application_publication_plan;
  if (plan.authorization_event_id !== input.authorization.event_id
    || input.authorization.grant.publication_profile_id !== input.capabilities.binding.publication_profile_id
    || plan.publication_contract_digest !== input.capabilities.binding.publication_contract_digest) fail("original user grant or protected contract differs");
  if (!unique(research.requirements.map(value => value.id)) || !unique(design.validation_cases.map(value => value.id))
    || !unique(input.cases.map(value => value.case_id))) fail("duplicate accepted requirement or actual case identity");
  const expected = new Map(research.requirements.filter(value => value.priority === "must").flatMap(requirement =>
    requirement.acceptance_criteria.map((criterion, criterion_index) => [key({ requirement_id: requirement.id, criterion_index }), { requirement, criterion, criterion_index }] as const)));
  if (!expected.size || expected.size !== plan.entries.length || plan.entries.some(entry => !expected.has(key(entry)))) fail("plan must cover every original must criterion exactly once");
  const coverage = new Map(design.application_publication_coverage.entries.map(entry => [key(entry), entry]));
  const development: ApplicationPublicationMeasurementV1["development_criteria"] = [], publication: ApplicationPublicationMeasurementV1["publication_criteria"] = [];
  for (const entry of plan.entries) {
    const original = expected.get(key(entry))!;
    const criterion = { requirement_id: entry.requirement_id, criterion_index: entry.criterion_index,
      criterion_digest: input.digest(canonicalReleaseJson({ requirement_id: original.requirement.id, description: original.requirement.description,
        priority: original.requirement.priority, criterion_index: original.criterion_index, criterion: original.criterion })) };
    if (entry.method === claim) {
      if (original.criterion !== APPLICATION_PUBLICATION_STATEMENT_V1 || coverage.has(key(entry))) fail("publication can settle only the exact authorized bounded claim, never a business case or stronger availability requirement");
      publication.push({ ...criterion, claim }); continue;
    }
    const mapping = coverage.get(key(entry));
    if (!mapping) fail("business criterion has no accepted application case mapping");
    for (const caseId of mapping.case_ids) {
      const planned = design.validation_cases.find(value => value.id === caseId), actual = input.cases.find(value => value.case_id === caseId);
      if (!planned || !actual || !planned.requirement_ids.includes(entry.requirement_id)
        || planned.browser_program.contract_digest !== input.capabilities.binding.application_contract_digest
        || actual.program_digest !== input.digest(canonicalReleaseJson(planned.browser_program))
        || actual.assertions < 1 || actual.capture_digests.length < 1) fail("criterion lacks its exact executed accepted browser program and captures");
    }
    development.push({ ...criterion, case_ids: [...mapping.case_ids].sort() }); coverage.delete(key(entry));
  }
  if (coverage.size) fail("design contains undeclared or publication-only criterion mappings");
  if (design.validation_cases.length !== input.cases.length || design.validation_cases.some(value => !input.cases.some(actual => actual.case_id === value.id)))
    fail("actual cases must cover the complete accepted application design");
  const order = (a: { requirement_id: string; criterion_index: number }, b: { requirement_id: string; criterion_index: number }) =>
    a.requirement_id < b.requirement_id ? -1 : a.requirement_id > b.requirement_id ? 1 : a.criterion_index - b.criterion_index;
  return ApplicationPublicationMeasurementV1Schema.parse({ version: 1, authorization_event_id: input.authorization.event_id,
    publication_contract_digest: input.capabilities.binding.publication_contract_digest, research_digest: input.digest(input.research_json),
    design_digest: input.digest(input.design_json), measurement_plan_digest: input.digest(canonicalReleaseJson(plan)),
    application_definition_digest: input.application_definition_digest, development_criteria: development.sort(order),
    publication_criteria: publication.sort(order), unmet_criteria: [] });
}
