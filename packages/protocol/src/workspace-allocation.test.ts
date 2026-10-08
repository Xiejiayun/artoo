import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { test } from "vitest";
import {
  allocateWorkspaceRoot,
  validateWorktreeBaseConfiguration,
  WorkspaceAllocationError,
  type AllocationInput,
} from "./workspace-allocation.js";

const input = (overrides: Partial<AllocationInput> = {}): AllocationInput => ({
  workspaceRoot: "/existing/Exact Checkout",
  branchBacked: true,
  targetComputerOs: "darwin",
  agentInstanceId: "ai_A",
  runId: "run_B",
  worktreeBase: { version: 1, strategy: "per-run", basePath: "/Approved/Runs" },
  ...overrides,
});

function rejects(value: AllocationInput, code: string): void {
  assert.throws(() => allocateWorkspaceRoot(value), (error: unknown) =>
    error instanceof WorkspaceAllocationError && error.code === code);
}

test("ordinary assignments keep the exact root even when opt-in config is present or malformed", () => {
  for (const workspaceRoot of [null, "relative legacy", "C:\\Legacy\\Case\\", "/Exact//Unicode-é/"]) {
    assert.equal(allocateWorkspaceRoot(input({ workspaceRoot, branchBacked: false })), workspaceRoot);
    assert.equal(allocateWorkspaceRoot(input({ workspaceRoot, branchBacked: false, worktreeBase: null,
      targetComputerOs: "unsupported", runId: "../unsafe" })), workspaceRoot);
  }
});

test("omitting the setting keeps legacy exact roots without new OS or identifier validation", () => {
  for (const workspaceRoot of [null, "C:legacy", "/Exact//Root/"]) {
    assert.equal(allocateWorkspaceRoot(input({ workspaceRoot, worktreeBase: undefined,
      targetComputerOs: "unknown", runId: "legacy" })), workspaceRoot);
  }
});

test("explicit new mode allocates under the selected base, independent of the ordinary root", () => {
  assert.equal(allocateWorkspaceRoot(input()), "/Approved/Runs/artoo-runs/i-61695f41/r-72756e5f42");
  assert.equal(allocateWorkspaceRoot(input({ workspaceRoot: null })), allocateWorkspaceRoot(input()));
});

test("configuration never infers omitted strategy/version and rejects unsupported or extra fields", () => {
  for (const worktreeBase of [null, false, "/base", [], {}, { basePath: "/base" },
    { version: 1, basePath: "/base" }, { strategy: "per-run", basePath: "/base" },
    { version: 2, strategy: "per-run", basePath: "/base" },
    { version: 1, strategy: "legacy", basePath: "/base" },
    { version: 1, strategy: "per-run", basePath: 1 },
    { version: 1, strategy: "per-run", basePath: "/base", root: "/override" }]) {
    rejects(input({ worktreeBase }), "invalid_configuration");
  }
});

test("configuration validation is usable at the administrator route and preserves the value", () => {
  const value = { version: 1, strategy: "per-run", basePath: "/Case/Ru\u0301ns//" };
  assert.deepEqual(validateWorktreeBaseConfiguration(value, "linux"), value);
  assert.throws(() => validateWorktreeBaseConfiguration(value, "other"), WorkspaceAllocationError);
});

test("POSIX allocation preserves case, Unicode normalization, spaces, repeated and trailing separators", () => {
  for (const targetComputerOs of ["darwin", "macos", "linux"]) {
    for (const basePath of ["/", "/Work/Runs", "/Work//Runs/", "/Équipe/草稿", "/E\u0301quipe/Run space "]) {
      const root = allocateWorkspaceRoot(input({ targetComputerOs,
        worktreeBase: { version: 1, strategy: "per-run", basePath } }))!;
      assert.equal(root, `${basePath}${basePath.endsWith("/") ? "" : "/"}artoo-runs/i-61695f41/r-72756e5f42`);
      assert.equal(posix.relative(basePath, root), "artoo-runs/i-61695f41/r-72756e5f42");
    }
  }
});

test("Windows drive/UNC allocation uses target semantics on any host and preserves base spelling", () => {
  for (const targetComputerOs of ["win32", "windows"]) {
    for (const basePath of ["C:\\", "d:\\Case\\草稿", "C:/Run space/", "C:/Mixed\\Runs",
      "\\\\Server\\Share", "\\\\Server\\Share\\Runs\\", "//Server/Share/Runs"]) {
      const root = allocateWorkspaceRoot(input({ targetComputerOs,
        worktreeBase: { version: 1, strategy: "per-run", basePath } }))!;
      assert.ok(root.startsWith(basePath));
      assert.equal(win32.relative(basePath, root), "artoo-runs\\i-61695f41\\r-72756e5f42");
    }
  }
});

test("same immutable pair is stable; different run, instance or ID case remains distinct on case-folding filesystems", () => {
  const values = [input(), input({ runId: "run_b" }), input({ runId: "run_C" }),
    input({ agentInstanceId: "ai_a" }), input({ agentInstanceId: "ai_C" })];
  const roots = values.map(allocateWorkspaceRoot);
  assert.equal(allocateWorkspaceRoot(input()), roots[0]);
  assert.equal(new Set(roots.map((root) => root!.toLowerCase())).size, values.length);
  assert.equal(allocateWorkspaceRoot(Object.freeze(input())), roots[0]);
});

test("POSIX rejects relative, cross-OS, double-root, traversal, dot and transport-delimiter paths", () => {
  for (const basePath of ["", "runs", "~/runs", "C:\\runs", "C:/runs", "\\\\Server\\Share", "//server/share",
    "/run/../escape", "/run/./child", "/run\\child", "/runs;other", "/runs,other", "/runs\0", "/runs\n", "/\ud800"]) {
    rejects(input({ worktreeBase: { version: 1, strategy: "per-run", basePath } }), "invalid_base_path");
  }
});

test("Windows rejects drive/root relative, incomplete UNC, device namespaces, traversal and unsafe components", () => {
  for (const basePath of ["runs", "C:runs", "C:", "/runs", "\\runs", "\\\\Server", "\\\\Server\\",
    "\\\\?\\C:\\runs", "\\\\.\\C:\\runs", "C:\\runs\\..\\escape", "C:\\runs\\.\\child",
    "C:\\runs;other", "C:\\runs,other", "C:\\bad:name", "C:\\bad?name", "C:\\bad*name", "C:\\bad|name",
    "C:\\bad<name", 'C:\\bad"name', "C:\\trail.", "C:\\trail ", "C:\\CON", "C:\\nul.txt",
    "C:\\LPT9", "C:\\COM¹", "C:\\CONOUT$", "C:\\runs\n", "C:\\\udfff"]) {
    rejects(input({ targetComputerOs: "win32", worktreeBase: { version: 1, strategy: "per-run", basePath } }), "invalid_base_path");
  }
});

test("new allocation rejects unknown computer OS and malformed branch-backed input", () => {
  for (const targetComputerOs of ["", "freebsd", "Windows", "wsl", "unknown"]) {
    rejects(input({ targetComputerOs }), "unsupported_os");
  }
  rejects(input({ branchBacked: undefined as unknown as boolean }), "invalid_assignment");
});

test("only bounded prefixed ASCII immutable IDs are accepted as suffix inputs", () => {
  for (const runId of ["", "task_A", "run_", "run_../escape", "run_a/b", "run_a\\b", "run_a:b",
    "run_title space", "run_é", "run_a;other", "run_\0", `run_${"A".repeat(61)}`]) {
    rejects(input({ runId }), "invalid_identifier");
  }
  for (const agentInstanceId of ["", "agent_A", "ai_", "ai_..", "ai_a/b", `ai_${"A".repeat(62)}`]) {
    rejects(input({ agentInstanceId }), "invalid_identifier");
  }
  assert.ok(allocateWorkspaceRoot(input({ runId: `run_${"A".repeat(60)}`, agentInstanceId: `ai_${"B".repeat(61)}` })));
});

test("oversized components and allocated paths fail instead of truncating or hashing identifiers", () => {
  rejects(input({ worktreeBase: { version: 1, strategy: "per-run", basePath: `/${"é".repeat(128)}` } }), "invalid_base_path");
  rejects(input({ worktreeBase: { version: 1, strategy: "per-run", basePath: `/${("A".repeat(250) + "/").repeat(17)}` } }), "invalid_base_path");
  rejects(input({ worktreeBase: { version: 1, strategy: "per-run", basePath: "/" + ("A".repeat(250) + "/").repeat(16) },
    runId: `run_${"A".repeat(60)}`, agentInstanceId: `ai_${"B".repeat(61)}` }), "path_too_long");
  rejects(input({ targetComputerOs: "win32", worktreeBase: { version: 1, strategy: "per-run", basePath: `C:\\${"A".repeat(256)}` } }), "invalid_base_path");
  rejects(input({ targetComputerOs: "win32", worktreeBase: { version: 1, strategy: "per-run", basePath: `C:\\${"A".repeat(230)}` } }), "path_too_long");
});

test("pure allocation does not mutate configuration or append entropy on repeated calls", () => {
  const worktreeBase = Object.freeze({ version: 1, strategy: "per-run", basePath: "/does-not-need-to-exist" });
  const value = Object.freeze(input({ worktreeBase }));
  const expected = allocateWorkspaceRoot(value);
  for (let i = 0; i < 10; i++) assert.equal(allocateWorkspaceRoot(value), expected);
  assert.equal(worktreeBase.basePath, "/does-not-need-to-exist");
});
