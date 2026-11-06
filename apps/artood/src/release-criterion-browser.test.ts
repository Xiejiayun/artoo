import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIGURED_STATIC_PUBLICATION_CLAIM, CONFIGURED_STATIC_PUBLICATION_STATEMENT,
  CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST, ContextPackSchema, ProductDesignV2Schema,
  ProductResearchReportSchema, productDevelopmentContext } from "@artoo/domain";
import { deriveExpectedWebAcceptanceV3, prepareStaticWebCapabilities } from "./web-acceptance.js";

const roots: string[] = [], digest = `sha256:${"a".repeat(64)}`;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "artoo-release-case-")); roots.push(root);
  const workspace = join(root, "workspace"), evidence = join(root, "evidence");
  mkdirSync(join(workspace, ".artoo/product"), { recursive: true }); mkdirSync(join(workspace, "product")); mkdirSync(evidence);
  const prepared = prepareStaticWebCapabilities({ browser_program: { version: 3,
    viewports: [{ id: "compact", width: 390, height: 900 }] }, evidence_root: evidence, design_capture_cases: true, storage_fault: { version: 1 } });
  const binding = { version: 1 as const, command_id: "browser", profile_digest: digest,
    config_digest: prepared.config_digest, contract_digest: prepared.contract_digest };
  // Public fixture descriptions alone do not install node release authority.
  const releaseBinding = { version: 1 as const, release_profile_id: "publish", release_profile_digest: digest,
    contract_digest: digest, project_id: "project", workspace_root: workspace,
    verification_profile_id: "default", verification_profile_digest: digest };
  const route = { release_binding: releaseBinding, claim_id: CONFIGURED_STATIC_PUBLICATION_CLAIM,
    statement_digest: CONFIGURED_STATIC_PUBLICATION_STATEMENT_DIGEST };
  const policy = { version: 2, coverage: "every-must-criterion", methods: ["workspace-check", "configured-static-release"] };
  const context = ContextPackSchema.parse({ task: { id: "task", title: "Design", description: "", acceptance_criteria: [] },
    project: { id: "project", name: "Fixture", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    product_development: productDevelopmentContext("design"), verification_capabilities: { version: 1, profile_id: "default",
      profile_digest: digest, measurement_plan_policy: policy, checks: [{ command_id: binding.command_id,
        config_digest: binding.config_digest, contract_digest: binding.contract_digest, contract: prepared.contract }] } });
  const research = ProductResearchReportSchema.parse({ version: 1, objective: "Save and publish a journal", assumptions: [],
    requirements: [{ id: "save", description: "Save a note", priority: "must", acceptance_criteria: ["Save shows confirmation"] },
      { id: "publish", description: "Publish the verified version", priority: "must", acceptance_criteria: [CONFIGURED_STATIC_PUBLICATION_STATEMENT] }],
    sources: [{ id: "fixture", url: "https://example.com", title: "Controlled schema fixture", retrieved_at: "2026-11-05T00:00:00Z", content_digest: digest }],
    findings: [{ summary: "Controlled data, no live research", source_ids: ["fixture"] }], decisions: [],
    measurement_plan: { version: 2, profile_digest: digest, entries: [
      { method: "workspace-check", requirement_id: "save", criterion_index: 0, command_id: binding.command_id,
        config_digest: binding.config_digest, contract_digest: binding.contract_digest, actions: ["navigate", "click", "assert_text"],
        keys: [], viewports: [{ id: "compact", width: 390, height: 900 }], needs: [] },
      { method: "configured-static-release", requirement_id: "publish", criterion_index: 0, ...route },
    ] } });
  const design = ProductDesignV2Schema.parse({ version: 2, requirement_ids: ["save", "publish"], information_architecture: ["Journal"],
    user_flows: [{ id: "save", name: "Save", requirement_ids: ["save"], steps: ["Save a note"] }],
    screens: [{ id: "journal", name: "Journal", purpose: "Write", states: ["Saved"], accessibility: ["Labelled button"], responsive: ["Phone"] }],
    prototype: { entrypoint: "product/index.html", description: "Inspectable prototype" }, data_model: [], api_contracts: [],
    decisions: [{ decision: "Configured publisher", rationale: "Real receipt after acceptance" }], validation_cases: [
      { id: "save", method: "workspace-check", requirement_ids: ["save"], requirement_criteria: [{ requirement_id: "save", criterion_index: 0 }],
        procedure: ["Click Save"], expected_result: "Saved", browser_program: { version: 3, contract_digest: binding.contract_digest,
          steps: [{ action: "navigate", page: "main", path: "/" }, { action: "click", page: "main", selector: "#save" },
            { action: "assert_text", page: "main", selector: "#status", text: "Saved" }] } },
      { id: "publish", method: "configured-static-release", requirement_ids: ["publish"], requirement_criteria: [{ requirement_id: "publish", criterion_index: 0 }],
        procedure: ["Wait for the trusted publisher"], expected_result: CONFIGURED_STATIC_PUBLICATION_STATEMENT, ...route },
    ] });
  const write = (path: string, value: unknown) => writeFileSync(join(workspace, path), typeof value === "string" ? value : JSON.stringify(value));
  const save = () => { write(".artoo/product/research.json", research); write(".artoo/product/design.json", design); };
  save(); write("product/index.html", "<title>Journal</title><button id=save>Save</button><p id=status>Saved</p>");
  const derive = () => deriveExpectedWebAcceptanceV3(workspace, context, prepared.options, binding);
  const workspaceCase = design.validation_cases.find(item => item.method === "workspace-check")!;
  if (workspaceCase.method !== "workspace-check") throw new Error("Missing fixture workspace case");
  return { research, design, context, binding, workspaceCase, route, workspace, evidence, prepared, write, save, derive };
}

function dualCheckFixture(sameContract = false) {
  const f = fixture();
  const second = sameContract ? f.prepared : prepareStaticWebCapabilities({ browser_program: { version: 3,
    viewports: [{ id: "wide", width: 1280, height: 900 }] }, evidence_root: f.evidence, design_capture_cases: true, storage_fault: { version: 1 } });
  const secondBinding = { ...f.binding, command_id: "browser-wide", config_digest: second.config_digest, contract_digest: second.contract_digest };
  const plan = f.research.measurement_plan;
  if (plan?.version !== 2) throw new Error("Missing fixture measurement plan");
  const firstEntry = plan.entries[0];
  if (!firstEntry || firstEntry.method !== "workspace-check") throw new Error("Missing fixture workspace declaration");
  f.research.requirements.push({ id: "read", description: "Read the saved note", priority: "must", acceptance_criteria: ["Saved confirmation is visible"] });
  plan.entries.push({ ...structuredClone(firstEntry), requirement_id: "read", command_id: secondBinding.command_id,
    config_digest: secondBinding.config_digest, contract_digest: secondBinding.contract_digest, viewports: second.contract.viewports });
  f.context.verification_capabilities!.checks.push({ command_id: secondBinding.command_id, config_digest: secondBinding.config_digest,
    contract_digest: secondBinding.contract_digest, contract: second.contract });
  f.design.requirement_ids.push("read");
  const secondCase = { ...structuredClone(f.workspaceCase), id: "read", requirement_ids: ["read"], requirement_criteria: [{ requirement_id: "read", criterion_index: 0 }],
    browser_program: { ...structuredClone(f.workspaceCase.browser_program), contract_digest: second.contract_digest } };
  f.design.validation_cases.push(secondCase);
  f.save();
  return { ...f, second, secondBinding, secondCase, deriveSecond: () => deriveExpectedWebAcceptanceV3(f.workspace, f.context, second.options, secondBinding) };
}

describe("publication criteria remain outside browser execution", () => {
  it("executes only the validated workspace partition, with no synthetic release trace", () => {
    const f = fixture(), plan = f.derive();
    expect(plan.casePrograms.map(test => test.case_id)).toEqual(["save"]);
    expect(plan.programs).toHaveLength(1);
    expect(plan.programs[0]!.steps.map(step => step.action)).toEqual(["navigate", "click", "assert_text"]);
  });

  it("does not filter away a missing or misrouted publication obligation", () => {
    const f = fixture(); f.design.validation_cases.pop(); f.save();
    expect(() => f.derive()).toThrow();
    const other = fixture(); other.design.validation_cases[1]!.requirement_criteria[0]!.requirement_id = "save"; other.save();
    expect(() => other.derive()).toThrow();
  });

  it("rejects a page smoke that omits an action declared for the exact criterion", () => {
    const f = fixture(); f.workspaceCase.browser_program.steps.splice(1, 1); f.save();
    expect(() => f.derive()).toThrow("declared actions are absent");
  });

  it("requires declared storage faults to have actual criterion-bound windows", () => {
    const f = fixture();
    if (f.research.measurement_plan?.version !== 2) throw new Error("Missing v2 fixture plan");
    const entry = f.research.measurement_plan.entries[0]!;
    if (entry.method !== "workspace-check") throw new Error("Missing workspace entry");
    entry.needs = [{ kind: "storage-fault", version: 1, mode: "write-quota", invariant: "sampled-equal", page_scope: "main-only", api_scope: "fixed-entry" }];
    f.save(); expect(() => f.derive()).toThrow("no matching mode, criterion and native-storage window");
    f.workspaceCase.storage_checks = { version: 1, windows: [{ id: "failed-save", page: "main", mode: "write-quota", arm_before_step: 1,
      settle_after_step: 2, requirement_criteria: [{ requirement_id: "save", criterion_index: 0 }], ui_assertion_steps: [2], min_hits: 1,
      native_storage: { scope: "all", comparison: "sampled-equal" } }] };
    f.save(); expect(f.derive().casePrograms[0]!.storage_checks?.windows[0]!.mode).toBe("write-quota");
    f.workspaceCase.storage_checks.windows[0]!.mode = "read-security";
    f.save(); expect(() => f.derive()).toThrow("no matching mode, criterion and native-storage window");
  });

  it("rejects declared keys that are absent even when another key is exercised", () => {
    const f = fixture();
    if (f.research.measurement_plan?.version !== 2) throw new Error("Missing fixture plan");
    const entry = f.research.measurement_plan.entries[0]!;
    if (entry.method !== "workspace-check") throw new Error("Missing fixture entry");
    entry.actions.push("press"); entry.keys.push("Enter"); entry.needs.push({ kind: "keyboard-events" });
    f.workspaceCase.browser_program.steps.splice(1, 0, { action: "press", page: "main", key: "Tab" });
    f.save(); expect(() => f.derive()).toThrow("declared keys are absent");
  });

  it("requires exact configured viewports and an explicit v2 policy", () => {
    const f = fixture();
    if (f.research.measurement_plan?.version !== 2 || f.research.measurement_plan.entries[0]!.method !== "workspace-check") throw new Error("Missing fixture entry");
    f.research.measurement_plan.entries[0]!.viewports[0]!.height = 901; f.save();
    expect(() => f.derive()).toThrow("exact dimensions");
    const other = fixture(); delete other.context.verification_capabilities;
    expect(() => other.derive()).toThrow("protected version 2");
  });

  it("allows explicit pending publication in final validation but never authored publication success", () => {
    const f = fixture(); f.context.product_development = productDevelopmentContext("validation");
    const report = { version: 2, cases: [
      { method: "workspace-check", case_id: "save", requirement_ids: ["save"], requirement_criteria: [{ requirement_id: "save", criterion_index: 0 }],
        outcome: "passed", observations: "Controlled report", evidence_paths: ["product/evidence.md"] },
      { method: "configured-static-release", case_id: "publish", requirement_ids: ["publish"], requirement_criteria: [{ requirement_id: "publish", criterion_index: 0 }],
        outcome: "pending-release", observations: "No publication has occurred", evidence_paths: [], ...f.route },
    ], known_limitations: [] };
    f.write(".artoo/product/validation.json", report);
    expect(f.derive().casePrograms.map(test => test.case_id)).toEqual(["save"]);
    report.cases[1]!.outcome = "passed";
    f.write(".artoo/product/validation.json", report);
    expect(() => f.derive()).toThrow();
  });

  it("routes different protected contracts to only their assigned criteria and viewports", () => {
    const f = dualCheckFixture(), first = f.derive(), second = f.deriveSecond();
    expect(first.casePrograms.map(test => test.case_id)).toEqual(["save"]);
    expect(second.casePrograms.map(test => test.case_id)).toEqual(["read"]);
    expect(first.casePrograms[0]!.program.contract_digest).toBe(f.binding.contract_digest);
    expect(second.casePrograms[0]!.program.contract_digest).toBe(f.secondBinding.contract_digest);
    expect(first.programs[0]!.viewport).toEqual({ id: "compact", width: 390, height: 900 });
    expect(second.programs[0]!.viewport).toEqual({ id: "wide", width: 1280, height: 900 });
  });

  it("uses accepted command bindings even when different checks share the same contract", () => {
    const f = dualCheckFixture(true);
    expect(f.binding.contract_digest).toBe(f.secondBinding.contract_digest);
    expect(f.derive().casePrograms.map(test => test.case_id)).toEqual(["save"]);
    expect(f.deriveSecond().casePrograms.map(test => test.case_id)).toEqual(["read"]);
    f.workspaceCase.requirement_ids.push("read");
    f.workspaceCase.requirement_criteria.push({ requirement_id: "read", criterion_index: 0 });
    f.design.validation_cases = f.design.validation_cases.filter(test => test.id !== "read"); f.save();
    expect(f.derive().casePrograms.map(test => test.case_id)).toEqual(["save"]);
    expect(f.deriveSecond().casePrograms.map(test => test.case_id)).toEqual(["save"]);
  });

  it("rejects one case mixing incompatible contracts on both checks before filtering", () => {
    const f = dualCheckFixture();
    f.workspaceCase.requirement_ids.push("read");
    f.workspaceCase.requirement_criteria.push({ requirement_id: "read", criterion_index: 0 }); f.save();
    expect(() => f.derive()).toThrow("cannot combine incompatible check contracts");
    expect(() => f.deriveSecond()).toThrow("cannot combine incompatible check contracts");
  });

  it("rejects a case program that uses another check's contract instead of silently omitting it", () => {
    const f = dualCheckFixture(); f.secondCase.browser_program.contract_digest = f.binding.contract_digest; f.save();
    expect(() => f.derive()).toThrow("differs from its accepted criterion contract");
    expect(() => f.deriveSecond()).toThrow("differs from its accepted criterion contract");
  });

  it("runs optional-only cases on compatible checks and rejects an unassigned optional program", () => {
    const f = dualCheckFixture();
    f.research.requirements.push({ id: "theme", description: "Optional theme", priority: "should", acceptance_criteria: ["Theme label is visible"] });
    f.design.requirement_ids.push("theme");
    const optional = { ...structuredClone(f.secondCase), id: "theme", requirement_ids: ["theme"], requirement_criteria: [{ requirement_id: "theme", criterion_index: 0 }] };
    f.design.validation_cases.push(optional); f.save();
    expect(f.derive().casePrograms.map(test => test.case_id)).toEqual(["save"]);
    expect(f.deriveSecond().casePrograms.map(test => test.case_id)).toEqual(["read", "theme"]);
    optional.browser_program.contract_digest = `sha256:${"f".repeat(64)}`; f.save();
    expect(() => f.derive()).toThrow("optional workspace case has no compatible configured check");
    expect(() => f.deriveSecond()).toThrow("optional workspace case has no compatible configured check");
  });

  it("does not borrow another command's actions to satisfy an incomplete assigned program", () => {
    const f = dualCheckFixture(true); f.secondCase.browser_program.steps.splice(1, 1); f.save();
    expect(f.derive().casePrograms.map(test => test.case_id)).toEqual(["save"]);
    expect(() => f.deriveSecond()).toThrow("declared actions are absent");
  });
});
