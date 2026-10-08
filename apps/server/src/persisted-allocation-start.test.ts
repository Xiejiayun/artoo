import { describe, expect, it } from "vitest";

import { AppError } from "./errors.js";
import { validatePersistedAllocationStart, type AllocatedStartContext, type AllocatedStartRun } from "./persisted-allocation-start.js";

function fixture() {
  const root = "/Approved//Cafe\u0301/artoo-runs/i-61695f41/r-72756e5f41";
  const run: AllocatedStartRun = { id: "run_A", organizationId: "org_A", taskId: "task_A", computerId: "computer_A",
    agentInstanceId: "ai_A", contextPackId: "ctx_A", workspaceRoot: root, workspaceBranch: "Feature/Exact",
    workspaceAllocation: { version: 1, strategy: "per-run", base_path: "/Approved//Cafe\u0301/" } };
  const stored: AllocatedStartContext = { id: "ctx_A", organizationId: "org_A", taskId: "task_A", runId: "run_A", payload: {
    task: { id: "task_A", title: "Original instruction", description: "", acceptance_criteria: ["Keep exact values"] },
    project: { id: "proj_A", name: "Original project", default_workspace: "/legacy" },
    workspace: { root, file_scope: [] }, policy: { filesystem_write_scope: ["Src/Exact"], requires_approval: ["git.push", "external.post"] },
    memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
  } };
  return { run, stored, metadata: { computerOs: "linux", projectId: "proj_A" } };
}
const validate = (f: ReturnType<typeof fixture>) => validatePersistedAllocationStart(f.run, f.stored, f.metadata);

function expectBlocked(f: ReturnType<typeof fixture>, reason: string) {
  let error: unknown;
  try { validate(f); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).toEnvelope()).toMatchObject({ error: { code: "conflict",
    details: { run_id: f.run.id, dispatch: "blocked", reason } } });
}

describe("persisted new-mode start validation (pure)", () => {
  it("preserves exact stored root/branch/record/inline payload without changing its inputs", () => {
    const f = fixture(), before = structuredClone(f), result = validate(f);
    expect(result).toEqual({ root: f.run.workspaceRoot, branch: f.run.workspaceBranch,
      allocation: f.run.workspaceAllocation, context: { id: f.stored.id, payload: f.stored.payload } });
    expect(f).toEqual(before);
  });

  it("validates a Windows snapshot using the supplied computer OS without normalizing spelling", () => {
    const f = fixture(); f.metadata.computerOs = "windows";
    f.run.workspaceAllocation = { version: 1, strategy: "per-run", base_path: "C:\\MiXeD\\" };
    f.run.workspaceRoot = "C:\\MiXeD\\artoo-runs\\i-61695f41\\r-72756e5f41";
    (f.stored.payload as { workspace: { root: string } }).workspace.root = f.run.workspaceRoot;
    expect(validate(f).root).toBe(f.run.workspaceRoot);
  });

  it.each([null, undefined, [], { version: 2, strategy: "per-run", base_path: "/Approved" },
    { version: 1, strategy: "per-run", base_path: "/Approved", approved: true },
    { version: 1, strategy: "per-run", base_path: "relative" }])("rejects an invalid allocation record: %j", (value) => {
    const f = fixture(); f.run.workspaceAllocation = value;
    expect(() => validate(f)).toThrow(AppError);
  });

  it.each([null, ""])("rejects a missing stored root: %s", (value) => {
    const f = fixture(); f.run.workspaceRoot = value;
    expect(() => validate(f)).toThrow(AppError);
  });
  it.each([null, "", " padded "])("rejects an invalid stored branch: %s", (value) => {
    const f = fixture(); f.run.workspaceBranch = value;
    expect(() => validate(f)).toThrow(AppError);
  });

  it("rejects NUL in the stored root at the shared retention boundary", () => {
    const f = fixture(), root = `${f.run.workspaceRoot}\0`;
    f.run.workspaceRoot = root;
    (f.stored.payload as { workspace: { root: string } }).workspace.root = root;
    expectBlocked(f, "invalid_workspace_root");
  });
  it.each([
    ["NUL", "Feature/a\0b"],
    ["1025 code units", "a".repeat(1025)],
    ["leading newline", "\nFeature/Exact"],
    ["trailing newline", "Feature/Exact\n"],
    ["leading tab", "\tFeature/Exact"],
    ["trailing tab", "Feature/Exact\t"],
  ] as const)("rejects a stored branch with %s using the shared retention schema", (_label, value) => {
    const f = fixture(); f.run.workspaceBranch = value;
    expectBlocked(f, "invalid_workspace_branch");
  });
  it.each([
    ["1024 code units", "a".repeat(1024)],
    ["interior newline", "Feature/a\nb"],
    ["interior tab", "Feature/a\tb"],
  ] as const)("preserves a shared-schema-valid branch with %s exactly", (_label, value) => {
    // Typed retention metadata permits interior newline/tab; this is not Git-ref validation.
    const f = fixture(); f.run.workspaceBranch = value;
    expect(validate(f).branch).toBe(value);
  });
  it.each([
    [4095, null],
    [4096, "invalid_allocation_identity"],
    [4097, "invalid_workspace_root"],
  ] as const)("keeps metadata and POSIX allocation limits separate for an ASCII root of length %i", (length, reason) => {
    const f = fixture(), suffix = "artoo-runs/i-61695f41/r-72756e5f41";
    // Repeated separators keep every path component below the allocator's component limit.
    const base = "/base" + "/".repeat(length - suffix.length - 5);
    f.run.workspaceAllocation = { version: 1, strategy: "per-run", base_path: base };
    f.run.workspaceRoot = base + suffix;
    (f.stored.payload as { workspace: { root: string } }).workspace.root = f.run.workspaceRoot;
    if (reason === null) expect(validate(f).root).toBe(f.run.workspaceRoot);
    else expectBlocked(f, reason);
  });

  it.each(["id", "organizationId", "taskId", "runId"] as const)("rejects a mismatched ContextPack row %s", (field) => {
    const f = fixture(); f.stored[field] = "other";
    expect(() => validate(f)).toThrow(AppError);
  });
  it("requires an existing persisted inline context instead of a generated id/URI fallback", () => {
    const f = fixture();
    expect(() => validatePersistedAllocationStart(f.run, undefined, f.metadata)).toThrow(AppError);
    f.run.contextPackId = null;
    expect(() => validate(f)).toThrow(AppError);
  });
  it.each(["task", "project", "workspace"] as const)("rejects a mismatched ContextPack payload %s", (field) => {
    const f = fixture();
    const payload = f.stored.payload as Record<string, Record<string, unknown>>;
    if (field === "workspace") payload[field]!.root = "/other";
    else payload[field]!.id = "other";
    expect(() => validate(f)).toThrow(AppError);
  });
  it("rejects malformed or silently stripped context content", () => {
    const f = fixture(); f.stored.payload = { ...(f.stored.payload as object), extra_authority: true };
    expect(() => validate(f)).toThrow(AppError);
    f.stored.payload = { uri: "artoo://contextpack/ctx_A" };
    expect(() => validate(f)).toThrow(AppError);
  });

  it.each(["base", "run", "instance"] as const)("rejects a valid-shaped but incoherent %s identity", (field) => {
    const f = fixture();
    if (field === "base") f.run.workspaceAllocation = { version: 1, strategy: "per-run", base_path: "/Different" };
    if (field === "run") { f.run.id = "run_B"; f.stored.runId = "run_B"; }
    if (field === "instance") f.run.agentInstanceId = "ai_B";
    expect(() => validate(f)).toThrow(AppError);
  });
  it("rejects missing or unsupported authoritative metadata", () => {
    const f = fixture();
    expect(() => validatePersistedAllocationStart(f.run, f.stored, { computerOs: undefined, projectId: "proj_A" })).toThrow(AppError);
    expect(() => validatePersistedAllocationStart(f.run, f.stored, { computerOs: "linux", projectId: undefined })).toThrow(AppError);
    f.metadata.computerOs = "unknown";
    expect(() => validate(f)).toThrow(AppError);
  });
  it("returns an observable blocked reason without claiming a stopped process", () => {
    const f = fixture(); f.run.workspaceRoot = null;
    try { validate(f); throw new Error("Expected a blocked dispatch"); }
    catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).toEnvelope()).toMatchObject({ error: { code: "conflict",
        details: { run_id: "run_A", dispatch: "blocked", reason: "missing_workspace_root" } } });
    }
  });
});
