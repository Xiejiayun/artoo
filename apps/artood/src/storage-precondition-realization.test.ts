import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProductDesignV2Schema, ProductResearchReportSchema, VerificationCapabilitiesContextSchema, productDevelopmentContext,
  type ContextPack, type StaticWebCapabilityBinding } from "@artoo/domain";
import { prepareStaticWebCapabilities } from "./web-acceptance.js";
import { isV3WebAcceptanceOptions } from "./web-acceptance-config.js";
import { deriveWebAcceptanceV3Plan } from "./web-acceptance-plan-v3.js";
import { workspaceCasesForMeasurementPlan } from "./measurement-plan-realization.js";
import { prepareResearchOptions } from "./research.js";
import { assertAcceptedProductInputs, validateProductStage } from "./product-stage.js";
import { canonicalWebAcceptance as canonical } from "./web-acceptance-identity.js";
import { nativeStorageSnapshotV1 } from "./web-acceptance-storage-source.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Real bounded handoff files and controlled retrieval receipts; no model, browser or product server is started. */
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-precondition-realization-"))); roots.push(root);
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  mkdirSync(join(workspace, ".artoo", "product"), { recursive: true }); mkdirSync(join(workspace, "product"));
  const prepared = prepareStaticWebCapabilities({ browser_program: { version: 3, viewports: [{ id: "compact", width: 320, height: 240 }] },
    design_capture_cases: true, storage_precondition: { version: 1 } });
  if (!isV3WebAcceptanceOptions(prepared.options) || prepared.contract.version !== 3) throw new Error("Expected v3 fixture configuration");
  const options = structuredClone(prepared.options);
  const binding: StaticWebCapabilityBinding = { version: 1, profile_digest: sha("profile"), command_id: "browser",
    config_digest: prepared.config_digest, contract_digest: prepared.contract_digest };
  const capabilities = VerificationCapabilitiesContextSchema.parse({ version: 1, profile_id: "profile", profile_digest: binding.profile_digest,
    measurement_plan_policy: { version: 2, coverage: "every-must-criterion", methods: ["workspace-check", "configured-static-release"] },
    checks: [{ command_id: binding.command_id, config_digest: binding.config_digest, contract_digest: binding.contract_digest, contract: prepared.contract }] });
  const context: ContextPack = { task: { id: "task", title: "Design", description: "Design journal recovery", acceptance_criteria: [] },
    project: { id: "project", name: "Product", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { requires_approval: [], filesystem_write_scope: [workspace] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    goal_context: { version: 1, goal_id: "goal", objective: "Journal recovery", acceptance_criteria: [], plan: null },
    product_development: productDevelopmentContext("design", capabilities), verification_capabilities: capabilities };
  const researchOptions = prepareResearchOptions({ receiptDirectory: join(root, "receipts") }, [workspace]);
  const source = { id: `source_${"a".repeat(32)}`, url: "https://example.com/", title: "Storage reference",
    retrieved_at: "2026-11-05T00:00:00.000Z", content_digest: sha("reference") };
  writeFileSync(join(researchOptions.receiptDirectory, `${source.id}.json`), JSON.stringify({ version: 1, ...source,
    binding: { runId: "research_run", taskId: "research_task", projectId: "project", goalId: "goal", workspaceRoot: workspace },
    content_base64: Buffer.from("reference").toString("base64") }));
  const ref = { requirement_id: "storage", criterion_index: 0 };
  const research = ProductResearchReportSchema.parse({ version: 1, objective: "Journal recovery", assumptions: [],
    requirements: [{ id: "storage", description: "Malformed data recovery", priority: "must", acceptance_criteria: ["Cancelled reset retains malformed data"] }],
    sources: [source], findings: [{ summary: "Malformed stored data needs a recoverable error", source_ids: [source.id] }], decisions: [],
    measurement_plan: { version: 2, profile_digest: binding.profile_digest, entries: [{ method: "workspace-check", ...ref,
      command_id: binding.command_id, config_digest: binding.config_digest, contract_digest: binding.contract_digest,
      actions: ["navigate", "click", "assert_text", "assert_value"], keys: [], viewports: options.browser_program.viewports,
      needs: [{ kind: "storage-precondition", version: 1, input: "raw-local-document", phase: "before-first-product-script",
        page_scope: "main-seed-same-origin-pages", preservation: "seeded-sampled-equal" }] }] } });
  const design = ProductDesignV2Schema.parse({ version: 2, requirement_ids: ["storage"], information_architecture: ["Editor"],
    user_flows: [{ id: "reset", name: "Cancel reset", requirement_ids: ["storage"], steps: ["Cancel a reset"] }],
    screens: [{ id: "editor", name: "Editor", purpose: "Write", states: ["Error"], accessibility: ["Labels"], responsive: ["Compact"] }],
    prototype: { entrypoint: "product/index.html", description: "Journal editor" }, data_model: [], api_contracts: [],
    decisions: [{ decision: "Local storage", rationale: "Offline" }], validation_cases: [{ id: "malformed", method: "workspace-check",
      requirement_ids: ["storage"], requirement_criteria: [ref], procedure: ["Cancel a reset"], expected_result: "Original data retained",
      browser_program: { version: 3, contract_digest: binding.contract_digest, steps: [
        { action: "navigate", page: "main", path: "/" }, { action: "assert_text", page: "main", selector: "#error", text: "Invalid saved data" },
        { action: "click", page: "main", selector: "#cancel" }, { action: "assert_value", page: "main", selector: "#draft", value: "Unsaved draft" },
      ] }, storage_precondition: { version: 1, local_storage: { key: "journal", value: "{" }, requirement_criteria: [ref], ui_assertion_steps: [1, 3],
        preservation_checks: [{ after_step: 3, requirement_criteria: [ref], ui_assertion_steps: [3] }] } }] });
  const test = design.validation_cases[0]!; if (test.method !== "workspace-check") throw new Error("Expected workspace fixture case");
  const researchPath = join(workspace, ".artoo/product/research.json"), designPath = join(workspace, ".artoo/product/design.json");
  const save = () => { writeFileSync(researchPath, JSON.stringify(research)); writeFileSync(designPath, JSON.stringify(design)); };
  writeFileSync(join(workspace, "product/index.html"), "<!doctype html><title>Controlled prototype fixture</title>"); save();
  return { root, workspace, context, capabilities, research, design, test, options, binding, researchOptions, researchPath, designPath, save,
    realize: () => workspaceCasesForMeasurementPlan(research, design, context, binding, options.browser_program.viewports),
    derive: () => deriveWebAcceptanceV3Plan(workspace, context, options, binding),
    stage: () => validateProductStage(workspace, context, researchOptions) };
}

describe("raw storage precondition source and policy realization", () => {
  it("derives exact raw-file, descriptor, program, initializer and native snapshots without claiming execution", () => {
    const f = fixture(), plan = f.derive(), bytes = readFileSync(f.designPath), expected = plan.programs[0]!.storage_precondition!;
    expect(f.realize()).toEqual([f.test]); expect(f.stage()).toHaveLength(1);
    expect(expected.source).toEqual({ path: ".artoo/product/design.json", checksum: sha(bytes), size: bytes.length, case_id: f.test.id });
    expect(expected.descriptor_digest).toBe(sha(canonical(f.test.storage_precondition)));
    expect(expected.program_digest).toBe(sha(canonical(f.test.browser_program)));
    expect(expected.native_storage.before).toEqual(nativeStorageSnapshotV1([]).summary);
    expect(expected.native_storage.seeded).toEqual(nativeStorageSnapshotV1([["journal", "{"]]).summary);
    expect(expected.preservation_checks[0]).toMatchObject({ after_step: 3, document_epoch: 1,
      step_digest: sha(canonical(f.test.browser_program.steps[3])), requirement_criteria: [{ requirement_id: "storage", criterion_index: 0 }] });
    expect(expected).not.toHaveProperty("origin"); expect(expected).not.toHaveProperty("sequence");
  });

  it("binds changed fixture bytes even when case labels and product programs are unchanged", () => {
    const f = fixture(), original = f.derive().programs[0]!.storage_precondition!;
    f.test.storage_precondition!.local_storage.value = "["; f.save();
    const changed = f.derive().programs[0]!.storage_precondition!;
    expect(changed.source.case_id).toBe(original.source.case_id); expect(changed.program_digest).toBe(original.program_digest);
    expect(changed.source.checksum).not.toBe(original.source.checksum);
    expect(changed.descriptor_digest).not.toBe(original.descriptor_digest);
    expect(changed.native_storage.seeded.digest).not.toBe(original.native_storage.seeded.digest);
    writeFileSync(f.designPath, Buffer.concat([readFileSync(f.designPath), Buffer.from("\n")]));
    const whitespace = f.derive().programs[0]!.storage_precondition!;
    expect(whitespace.source.checksum).not.toBe(changed.source.checksum);
    expect(whitespace.descriptor_digest).toBe(changed.descriptor_digest);
  });

  it("rejects missing capability and an undeclared new need before any program can claim realization", () => {
    const f = fixture(), contract = f.capabilities.checks[0]!.contract;
    if (contract.version !== 3) throw new Error("Expected v3");
    delete contract.storage_precondition;
    expect(() => f.realize()).toThrow(/configured capability/); expect(() => f.stage()).toThrow(/configured capability/);
    const g = fixture(); if (g.research.measurement_plan?.version !== 2) throw new Error("Expected v2");
    const entry = g.research.measurement_plan.entries[0]!; if (entry.method !== "workspace-check") throw new Error("Expected workspace need");
    entry.needs = []; g.save();
    expect(() => g.realize()).toThrow(/empty needs/); expect(() => g.derive()).toThrow(/no exact accepted/);
    const h = fixture(), { storage_precondition: _ignored, ...unoptedOptions } = h.options;
    expect(() => deriveWebAcceptanceV3Plan(h.workspace, h.context, unoptedOptions, h.binding)).toThrow(/protected opt-in/);
  });

  it.each(["missing-sidecar", "missing-checkpoint", "wrong-criterion", "nonassertion", "viewport", "profile", "config"])(
    "rejects incomplete or mismatched measurement realization: %s", mode => {
      const f = fixture();
      if (mode === "missing-sidecar") delete f.test.storage_precondition;
      if (mode === "missing-checkpoint") f.test.storage_precondition!.preservation_checks = [];
      if (mode === "wrong-criterion") f.test.storage_precondition!.requirement_criteria[0]!.criterion_index = 1;
      if (mode === "nonassertion") f.test.storage_precondition!.ui_assertion_steps = [2];
      if (mode === "viewport") f.options.browser_program.viewports[0]!.height++;
      if (mode === "profile") f.binding.profile_digest = sha("other");
      if (mode === "config") f.binding.config_digest = sha("other");
      expect(() => f.realize()).toThrow();
    });

  it("keeps each declared criterion's preservation checkpoint separate", () => {
    const f = fixture(); if (f.research.measurement_plan?.version !== 2) throw new Error("Expected v2");
    const entry = f.research.measurement_plan.entries[0]!; if (entry.method !== "workspace-check") throw new Error("Expected workspace entry");
    f.research.requirements[0]!.acceptance_criteria.push("Original malformed bytes remain after cancellation");
    f.research.measurement_plan.entries.push({ ...structuredClone(entry), criterion_index: 1 });
    const ref = { requirement_id: "storage", criterion_index: 1 };
    f.test.requirement_criteria.push(ref); f.test.storage_precondition!.requirement_criteria.push(ref);
    expect(() => f.realize()).toThrow(/no matching native checkpoint/);
    f.test.storage_precondition!.preservation_checks![0]!.requirement_criteria.push(ref);
    expect(f.realize()).toEqual([f.test]);
  });

  it("permits a real controlled peer UI route while counting only main document epochs", () => {
    const f = fixture(); if (f.research.measurement_plan?.version !== 2) throw new Error("Expected v2");
    const entry = f.research.measurement_plan.entries[0]!; if (entry.method !== "workspace-check") throw new Error("Expected workspace entry");
    entry.actions.push("open_page", "reload"); entry.needs.push({ kind: "pages", max_created: 2, same_origin: true, same_browser_context: true });
    f.test.browser_program.steps.push({ action: "open_page", page: "peer", path: "/" }, { action: "reload", page: "peer" },
      { action: "assert_text", page: "peer", selector: "#error", text: "Invalid saved data" });
    f.test.storage_precondition!.ui_assertion_steps.push(6);
    f.test.storage_precondition!.preservation_checks!.push({ after_step: 6, requirement_criteria: [{ requirement_id: "storage", criterion_index: 0 }], ui_assertion_steps: [6] });
    f.save(); expect(f.realize()).toEqual([f.test]);
    const expected = f.derive().programs[0]!.storage_precondition!;
    expect(expected.seed_apply_count).toBe(1); expect(expected.preservation_checks.map(check => check.document_epoch)).toEqual([1, 1]);
  });

  it("rejects malformed UTF-8 instead of silently replacing raw fixture input, and does not strip a BOM", () => {
    const f = fixture(), bytes = readFileSync(f.designPath), prefix = Buffer.from('"value":"');
    const offset = bytes.indexOf(Buffer.from('"value":"{"')) + prefix.length;
    expect(offset).toBeGreaterThan(prefix.length);
    writeFileSync(f.designPath, Buffer.concat([bytes.subarray(0, offset), Buffer.from([0x80]), bytes.subarray(offset + 1)]));
    expect(() => f.derive()).toThrow(); expect(() => f.stage()).toThrow();
    writeFileSync(f.designPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]));
    expect(() => f.derive()).toThrow(); expect(() => f.stage()).toThrow();
  });

  it("cannot reuse accepted design source pins after a seed revision", () => {
    const f = fixture(); f.context.product_development = productDevelopmentContext("implementation", f.capabilities);
    f.context.product_development.accepted_inputs = { version: 1, files: [f.researchPath, f.designPath].map((path, index) => {
      const bytes = readFileSync(path); return { path: index === 0 ? ".artoo/product/research.json" as const : ".artoo/product/design.json" as const,
        checksum: sha(bytes), size: bytes.length, source_task_id: "accepted_task", source_run_id: "accepted_run", evidence_id: "accepted_evidence" };
    }) };
    expect(() => assertAcceptedProductInputs(f.workspace, f.context)).not.toThrow();
    f.test.storage_precondition!.local_storage.value = "["; f.save();
    expect(() => assertAcceptedProductInputs(f.workspace, f.context)).toThrow(/changed/);
  });
});
