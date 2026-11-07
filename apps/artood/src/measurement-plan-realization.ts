import { criterionRefKey, isWorkspaceValidationCase, validateProductStoragePreconditionV1, type ContextPack, type ProductDesignV2, type ProductResearchReport,
  type StaticWebCapabilityBinding, type BrowserViewportV2 } from "@artoo/domain";

type WorkspaceCase = Extract<ProductDesignV2["validation_cases"][number], { method: "workspace-check" }>;
const sameCriterion = (left: { requirement_id: string; criterion_index: number }, right: { requirement_id: string; criterion_index: number }) =>
  left.requirement_id === right.requirement_id && left.criterion_index === right.criterion_index;

/**
 * Check the declared methods against the programs the protected browser will run.
 * This establishes structural coverage, not the meaning of natural-language requirements.
 * The caller must validate the complete handoff partition before selecting browser cases.
 */
export function workspaceCasesForMeasurementPlan(research: ProductResearchReport, design: ProductDesignV2,
  context: ContextPack, binding: StaticWebCapabilityBinding, viewports: readonly BrowserViewportV2[]): WorkspaceCase[] {
  const plan = research.measurement_plan, capabilities = context.verification_capabilities;
  if (plan?.version !== 2 || capabilities?.measurement_plan_policy?.version !== 2
    || plan.profile_digest !== binding.profile_digest || capabilities.profile_digest !== binding.profile_digest) {
    throw new Error("Version 2 design requires its protected version 2 measurement-plan policy and profile");
  }
  const cases = design.validation_cases.filter(isWorkspaceValidationCase);
  if (!cases.length) throw new Error("Version 2 product acceptance requires executable workspace cases");
  const checks = new Map(capabilities.checks.map(check => [check.command_id, check]));
  const current = checks.get(binding.command_id);
  if (!current || current.contract.version !== 3 || current.config_digest !== binding.config_digest
    || current.contract_digest !== binding.contract_digest) throw new Error("Measurement realization requires the exact configured v3 check binding");
  const entries = new Map(plan.entries.map(entry => [criterionRefKey(entry), entry]));
  const requirements = new Map(research.requirements.map(requirement => [requirement.id, requirement]));
  // Validate every case before selecting this check's partition, so an unmapped or
  // incompatible case cannot disappear merely because a different command is running.
  const assigned = new Map<string, Set<string>>();
  for (const test of cases) {
    const commands = new Set<string>(), contracts = new Set<string>();
    const fail = (reason: string): never => { throw new Error(`Measurement realization case ${test.id}: ${reason}`); };
    for (const ref of test.requirement_criteria) {
      const requirement = requirements.get(ref.requirement_id), entry = entries.get(criterionRefKey(ref));
      if (!requirement || requirement.acceptance_criteria[ref.criterion_index] === undefined) return fail("unknown accepted criterion");
      if (!entry) {
        if (requirement.priority === "must") return fail("required workspace criterion has no accepted measurement declaration");
        continue;
      }
      if (entry.method !== "workspace-check") return fail("workspace case contains a release criterion");
      if (requirement.priority !== "must") return fail("optional criteria cannot acquire mandatory measurement declarations");
      const check = checks.get(entry.command_id);
      if (!check || check.contract.version !== 3 || check.config_digest !== entry.config_digest
        || check.contract_digest !== entry.contract_digest) fail("criterion has no exact configured v3 command/config/contract binding");
      commands.add(entry.command_id); contracts.add(entry.contract_digest);
    }
    if (contracts.size > 1) fail("one case cannot combine incompatible check contracts; split its criteria into separate cases");
    if (contracts.size && !contracts.has(test.browser_program.contract_digest)) fail("browser program differs from its accepted criterion contract");
    if (!commands.size) {
      // Optional-only cases still execute. Their explicit program contract routes
      // them to compatible installed checks without inventing a must-plan entry.
      for (const check of checks.values()) if (check.contract.version === 3 && check.contract_digest === test.browser_program.contract_digest) commands.add(check.command_id);
      if (!commands.size) fail("optional workspace case has no compatible configured check");
    }
    if (test.storage_precondition) {
      validateProductStoragePreconditionV1(test.browser_program.steps, test.storage_precondition, test.requirement_ids, test.requirement_criteria);
      for (const command of commands) {
        const contract = checks.get(command)!.contract;
        if (contract.version !== 3 || !contract.storage_precondition) fail("storage precondition has no protected configured capability");
      }
      for (const ref of test.storage_precondition.requirement_criteria) {
        const entry = entries.get(criterionRefKey(ref));
        if (!entry || entry.method !== "workspace-check" || !commands.has(entry.command_id)
          || !entry.needs.some(need => need.kind === "storage-precondition")) {
          fail("storage precondition has no exact accepted criterion need; empty needs cannot authorize seeding");
        }
      }
    }
    assigned.set(test.id, commands);
  }
  const currentCases = cases.filter(test => assigned.get(test.id)!.has(binding.command_id));
  for (const entry of plan.entries) {
    if (entry.method !== "workspace-check" || entry.command_id !== binding.command_id) continue;
    const fail = (reason: string): never => { throw new Error(`Measurement realization ${entry.requirement_id}:${entry.criterion_index}: ${reason}`); };
    if (entry.config_digest !== binding.config_digest || entry.contract_digest !== binding.contract_digest) {
      fail("the declared command/config/contract differs from this protected check");
    }
    if (entry.viewports.some(wanted => !viewports.some(actual => actual.id === wanted.id
      && actual.width === wanted.width && actual.height === wanted.height))) {
      fail("declared viewports will not execute with their exact dimensions");
    }
    const selected = currentCases.filter(test => test.requirement_criteria.some(ref => sameCriterion(ref, entry)));
    if (!selected.length) fail("no workspace program covers the exact accepted criterion");
    const steps = selected.flatMap(test => test.browser_program.steps);
    const actions = new Set(steps.map(step => step.action));
    if (entry.actions.some(action => !actions.has(action))) fail("declared actions are absent from the criterion's executable programs");
    const keys = new Set(steps.flatMap(step => step.action === "press" ? [step.key] : []));
    if (entry.keys.some(key => !keys.has(key))) fail("declared keys are absent from the criterion's executable programs");
    for (const need of entry.needs) {
      if (need.kind === "pages" && need.max_created > 1 && !selected.some(test => test.browser_program.steps.some(step => step.action === "open_page"))) {
        fail("the declared multiple-page measurement has no page creation");
      }
      if (need.kind === "storage-precondition") {
        if (!current.contract.storage_precondition) fail("the declared storage precondition is not configured on this check");
        const seeded = selected.flatMap(test => {
          const precondition = test.storage_precondition;
          return precondition?.requirement_criteria.some(ref => sameCriterion(ref, entry)) ? [precondition] : [];
        });
        if (!seeded.length) fail("the declared storage precondition has no matching case, raw fixture and UI assertions");
        // All referenced assertions were checked against the exact programs above. Preserve criterion-specific checkpoint mapping.
        if (need.preservation === "seeded-sampled-equal" && !seeded.some(precondition =>
          precondition.preservation_checks?.some(check => check.requirement_criteria.some(ref => sameCriterion(ref, entry))))) {
          fail("the declared seeded preservation has no matching native checkpoint and UI assertions");
        }
        continue;
      }
      if (need.kind !== "storage-fault") continue;
      const windows = selected.flatMap(test => test.storage_checks?.windows ?? [])
        .filter(window => window.requirement_criteria.some(ref => sameCriterion(ref, entry)) && window.mode === need.mode);
      if (!windows.some(window => window.native_storage.scope === "all" && window.native_storage.comparison === need.invariant)) {
        fail("the declared storage fault has no matching mode, criterion and native-storage window");
      }
    }
  }
  return currentCases;
}
