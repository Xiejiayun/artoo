import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunStartPayload } from "@artoo/domain";
import { attachWindowsVerificationBackend, readWindowsVerificationBackend, prepareVerificationProfiles, selectVerificationProfile,
  runVerification, runVerificationPreview, subjectManifest, verificationSupported, VerificationCleanupError,
  type PreparedVerificationProfile, type VerificationProfile } from "./verification.js";
import { ProtectedCommandError, runProtectedCommand } from "./protected-command.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";

const bridge = vi.hoisted(() => ({ backends: new WeakSet<object>(), invalidated: false }));
vi.mock("./owned/windows-owned-process.js", () => ({
  assertWindowsProcessBackend: (value: object) => { if (!bridge.backends.has(value) || bridge.invalidated) throw new Error("Unprepared or changed backend"); },
  startWindowsOwnedProcess: vi.fn(), isWindowsOwnedClosureReceipt: vi.fn(),
}));
vi.mock("./protected-command.js", async load => ({ ...await load<typeof import("./protected-command.js")>(), runProtectedCommand: vi.fn() }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!, roots: string[] = [], contextDirectories: string[] = [];
afterEach(() => {
  Object.defineProperty(process, "platform", platform); bridge.invalidated = false; vi.resetAllMocks();
  // These are controlled mocks: no helper or target was ever started in these fixtures.
  for (const root of [...contextDirectories.splice(0), ...roots.splice(0)]) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-windows-verification-routing-"))); roots.push(root);
  const workspace = join(root, "workspace"), script = join(root, "check.mjs"); mkdirSync(workspace);
  writeFileSync(script, "// controlled protected verifier"); readFileSync(script);
  writeFileSync(join(workspace, "index.txt"), "source"); readFileSync(join(workspace, "index.txt"));
  const raw: VerificationProfile = { id: "profile", project_id: "project", workspace_root: workspace,
    commands: [{ id: "check", argv: [process.execPath, script], timeout_ms: 1234 }], required_files: ["index.txt"], subject_paths: ["index.txt"] };
  const profile = prepareVerificationProfiles([raw])[0]!;
  const backend = Object.freeze({}) as PreparedWindowsProcessBackend; bridge.backends.add(backend);
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  return { root, workspace, script, raw, profile, backend };
}
function payload(profile: PreparedVerificationProfile): RunStartPayload {
  return { run_id: "run", task_id: "task", agent_instance_id: "agent", runtime: "fixture", workspace: { root: profile.workspace_root },
    context_pack: { id: "context", payload: { task: { id: "task", title: "Task", description: "", acceptance_criteria: [] },
      project: { id: "project", name: "Product", default_workspace: profile.workspace_root }, workspace: { root: profile.workspace_root, file_scope: [] },
      policy: { filesystem_write_scope: [profile.workspace_root], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] } } },
    policy_snapshot: { filesystem_write_scope: [profile.workspace_root], requires_approval: [] }, artifact_rules: { paths: [] },
    verification: { version: 1, profile_id: profile.id, request_id: "request" } };
}
const success = { status: 0, stdout: Buffer.from("verified"), stderr: Buffer.alloc(0), elapsedMs: 42 };

describe("Windows verification local routing (controlled mocks, not native qualification)", () => {
  it("keeps advertisement disabled and rejects unbound Windows verification", async () => {
    const f = fixture(); expect(verificationSupported()).toBe(false);
    expect(() => selectVerificationProfile(payload(f.profile), [f.profile], false)).toThrow(/explicitly bound Windows/);
    expect((await runVerification(f.profile, "request", new AbortController().signal)).outcome).toBe("failed");
    expect(runProtectedCommand).not.toHaveBeenCalled();
  });
  it("attaches authority only to the actual local profile and genuine backend", () => {
    const f = fixture(), serialized = structuredClone(f.profile);
    expect(() => attachWindowsVerificationBackend(serialized, f.backend)).toThrow(/locally prepared/);
    expect(() => attachWindowsVerificationBackend(f.profile, {} as PreparedWindowsProcessBackend)).toThrow(/Unprepared/);
    attachWindowsVerificationBackend(f.profile, f.backend);
    expect(readWindowsVerificationBackend(f.profile)).toBe(f.backend);
    expect(readWindowsVerificationBackend(serialized)).toBeUndefined();
    expect(prepareVerificationProfiles([f.profile])[0]).toBe(f.profile);
    expect(readWindowsVerificationBackend(prepareVerificationProfiles([serialized])[0]!)).toBeUndefined();
    const second = Object.freeze({}) as PreparedWindowsProcessBackend; bridge.backends.add(second);
    expect(() => attachWindowsVerificationBackend(f.profile, second)).toThrow(/already bound/);
    attachWindowsVerificationBackend(f.profile, f.backend);
    expect(JSON.stringify(f.profile)).not.toContain("backend");
  });
  it("revalidates both protected files and backend on every local read", () => {
    const f = fixture(); attachWindowsVerificationBackend(f.profile, f.backend);
    bridge.invalidated = true; expect(() => readWindowsVerificationBackend(f.profile)).toThrow(/changed backend/);
    bridge.invalidated = false; writeFileSync(f.script, "changed script");
    expect(() => readWindowsVerificationBackend(f.profile)).toThrow(/verifier changed/);
  });
  it("retains exact workspace, subject and ordinary-workspace admission for Windows", () => {
    const f = fixture(); attachWindowsVerificationBackend(f.profile, f.backend); const start = payload(f.profile);
    expect(selectVerificationProfile(start, [f.profile], false)).toBe(f.profile);
    expect(() => selectVerificationProfile(start, [f.profile], true)).toThrow(/ordinary/);
    expect(() => selectVerificationProfile({ ...start, workspace: { ...start.workspace, branch: "main" } }, [f.profile], false)).toThrow(/ordinary/);
    const wrongWorkspace = structuredClone(start); wrongWorkspace.workspace.root = join(f.workspace, ".");
    // A genuinely different spelling is required because path.join normalizes dot segments.
    wrongWorkspace.workspace.root += "/"; wrongWorkspace.context_pack.payload!.workspace.root = wrongWorkspace.workspace.root;
    expect(() => selectVerificationProfile(wrongWorkspace, [f.profile], false)).toThrow(/workspace mismatch/);
    start.context_pack.payload!.policy.execution_mode = "discussion";
    expect(() => selectVerificationProfile(start, [f.profile], false)).toThrow(/exact source digest/);
    start.verification!.expected_subject_digest = subjectManifest(f.profile).digest;
    expect(selectVerificationProfile(start, [f.profile], false)).toBe(f.profile);
    writeFileSync(join(f.workspace, "index.txt"), "changed subject");
    expect(() => selectVerificationProfile(start, [f.profile], false)).toThrow(/source changed/);
    expect(runProtectedCommand).not.toHaveBeenCalled();
  });
  it("routes final and preview checks with the exact backend, stripped environment and original budgets", async () => {
    const f = fixture(); attachWindowsVerificationBackend(f.profile, f.backend);
    vi.mocked(runProtectedCommand).mockImplementation(async (_request, options, backend) => {
      expect(backend).toBe(f.backend); expect(options).toMatchObject({ materializeTimeoutMs: 1234, readTimeoutMs: 1234, maxOutputBytes: 1024 * 1024, guardParent: true });
      const env = options.environment!;
      expect(Object.keys(env).sort()).toEqual(["ARTOO_VERIFICATION_CONTEXT_FILE", "LANG", "PATH", "TEMP", "TMP", "TMPDIR"]);
      const directory = dirname(env.ARTOO_VERIFICATION_CONTEXT_FILE!); contextDirectories.push(directory);
      expect(existsSync(directory)).toBe(true); return success;
    });
    const final = await runVerification(f.profile, "request", new AbortController().signal);
    expect(final.outcome).toBe("passed"); expect(final.checks[0]).toMatchObject({ exit_code: 0, duration_ms: 42 });
    const preview = await runVerificationPreview(f.profile, "preview", new AbortController().signal);
    expect(preview.verification.outcome).toBe("passed"); expect(preview.diagnostics.commands[0]!.stdout_excerpt).toBe("verified");
    for (const directory of contextDirectories) expect(existsSync(directory)).toBe(false);
  });
  it.each([["aborted", "cancelled"], ["timeout", "timed_out"], ["lingering_processes", "failed"]] as const)(
    "maps cleaned Windows %s to %s without marking the check passed", async (code, outcome) => {
      const f = fixture(); attachWindowsVerificationBackend(f.profile, f.backend);
      vi.mocked(runProtectedCommand).mockRejectedValue(new ProtectedCommandError(code, 0, 7, Buffer.from("output"), Buffer.alloc(0)));
      const result = await runVerification(f.profile, "request", new AbortController().signal);
      expect(result.outcome).toBe(outcome); expect(result.reason).toContain(code); expect(result.checks[0]!.duration_ms).toBe(7);
    });
  it("retains invocation context on unconfirmed cleanup and exposes no terminal verification", async () => {
    const f = fixture(); attachWindowsVerificationBackend(f.profile, f.backend);
    vi.mocked(runProtectedCommand).mockImplementation(async (_request, options) => {
      contextDirectories.push(dirname(options.environment!.ARTOO_VERIFICATION_CONTEXT_FILE!));
      throw new VerificationCleanupError("controlled unknown helper closure");
    });
    await expect(runVerification(f.profile, "request", new AbortController().signal)).rejects.toBeInstanceOf(VerificationCleanupError);
    expect(contextDirectories).toHaveLength(1); expect(existsSync(contextDirectories[0]!)).toBe(true);
  });
});
