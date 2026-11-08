// Real import journals, content decoding/materialization and Git metadata movement.
// Native authority and Git execution are controlled boundaries; no subprocess runs.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductSourceTransferRequestV1Schema,
  productSourceTransferRequestDigestV1 } from "@artoo/domain";
import type { PreparedVerificationProfile } from "./verification.js";
import type { OwnedGitRequest } from "./owned/owned-git.js";
import type { ProtectedCommandResult } from "./protected-command.js";

const control = vi.hoisted(() => ({ command: vi.fn(), subject: vi.fn() }));
vi.mock("./windows-code-installation.js", () => ({ prepareWindowsCodeInstallation: vi.fn(() => ({})), assertWindowsCodeInstallation: vi.fn() }));
vi.mock("./windows-release-storage.js", () => ({ prepareWindowsReleaseStorage: vi.fn(() => ({})),
  assertWindowsReleaseStorage: vi.fn(), auditWindowsReleaseStorage: vi.fn() }));
vi.mock("./owned/windows-owned-process.js", () => ({ assertWindowsProcessBackend: vi.fn() }));
vi.mock("./verification.js", () => ({ assertFinalVerificationExportBinding: vi.fn(), assertLocallyPreparedVerificationProfile: vi.fn(), assertLocallyPreparedVerificationProfiles: vi.fn(),
  prepareVerificationProfiles: vi.fn(value => value), subjectManifest: control.subject,
  selectVerificationProfile: vi.fn(), runTransferredResearchVerification: vi.fn() }));
vi.mock("./protected-command.js", () => ({ runProtectedCommand: control.command }));
import { importProductSourceTransfer, prepareProductSourceRuntime } from "./product-source-runtime.js";

const data = JSON.parse(readFileSync(new URL("../../../packages/domain/test-fixtures/product-source-operation.json", import.meta.url), "utf8"));
const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const platform = Object.getOwnPropertyDescriptor(process, "platform")!, roots: string[] = [];
beforeEach(() => { vi.clearAllMocks(); Object.defineProperty(process, "platform", { ...platform, value: "win32" }); });
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  const prefix = `${realpathSync.native(tmpdir())}${sep}artoo-import-git-`;
  for (const root of roots.splice(0)) {
    if (!root.startsWith(prefix) || realpathSync.native(root) !== root || lstatSync(root).isSymbolicLink()) throw Error("Unexpected import fixture cleanup path");
    // Both command outcomes are mocks: no uncertain native process is being inferred closed.
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-import-git-"))); roots.push(root);
  const workspace = join(root, "workspace"), store = join(root, "store"), programs = join(root, "programs");
  for (const path of [workspace, store, programs]) mkdirSync(path);
  const git = join(programs, "git.exe"); writeFileSync(git, "controlled trust file; never executed");
  const request = ProductSourceTransferRequestV1Schema.parse(structuredClone(data.admission.request.byte_request));
  request.destination.workspace_root = workspace;
  const product = Buffer.from("<h1>Imported product bytes</h1>\n");
  const manifest = { entries: [{ path: ".artoo/product", kind: "directory" }, { path: "product", kind: "directory" },
    { path: "product/index.html", kind: "file", checksum: sha(product), size: product.length }] };
  const capsule = Buffer.from(JSON.stringify({ version: 1, kind: "artoo.product-source.v1",
    source: { project_id: request.project_id, profile_id: request.source.profile_id,
      profile_digest: request.source.profile_digest, subject_digest: request.source.subject_digest },
    manifest, manifest_digest: sha(JSON.stringify(manifest)), files: [{ path: "product/index.html", base64: product.toString("base64") }] }));
  Object.assign(request.source, { capsule_digest: sha(capsule), capsule_bytes: capsule.length, manifest_digest: sha(JSON.stringify(manifest)) });
  const profile: PreparedVerificationProfile = { id: request.destination.profile_id, project_id: request.project_id,
    workspace_root: workspace, digest: request.destination.capabilities.profile_digest, capabilities: request.destination.capabilities,
    commands: [], required_files: [], subject_paths: ["product", ".artoo/product"], trustedFiles: [] };
  control.subject.mockImplementation((selected: PreparedVerificationProfile) => {
    const bytes = readFileSync(join(selected.workspace_root, "product/index.html"));
    return { digest: sha("controlled destination measurement"), directories: [".artoo/product", "product"],
      files: new Map([["product/index.html", { path: "product/index.html", checksum: sha(bytes), size: bytes.length }]]) };
  });
  const backend = {} as never;
  const runtime = prepareProductSourceRuntime({ nodeId: request.destination.node_id, storeRoot: store, gitExecutable: git,
    allowedRoots: [workspace], profiles: [profile], windowsBackend: backend });
  const requestDigest = productSourceTransferRequestDigestV1(request, sha);
  const operation = join(store, "operations", sha(request.transfer_id).slice(7)), staging = join(operation, "git-staging");
  const claim = join(store, "attestations", `claim-${sha(workspace).slice(7)}.json`);
  const journal = () => readdirSync(operation).filter(name => /^\d{4}\.json$/.test(name)).sort()
    .map(name => JSON.parse(readFileSync(join(operation, name), "utf8")));
  const run = () => importProductSourceTransfer(runtime, request, requestDigest, capsule);
  return { workspace, staging, operation, claim, git, backend, product, request, requestDigest, capsule, journal, run };
}

describe("source import Git staging under a fixed Guardian workspace", () => {
  it("keeps the workspace empty until Git closes, then imports from the separate node-local staging directory", async () => {
    const f = fixture();
    let entered!: () => void, finish!: () => void;
    const initEntered = new Promise<void>(resolve => { entered = resolve; }), initClosed = new Promise<void>(resolve => { finish = resolve; });
    control.command.mockImplementation(async (request: OwnedGitRequest, options, backend): Promise<ProtectedCommandResult> => {
      // Reproduce the native Guardian's cwd admission, not permission to change that boundary.
      if (request.cwd !== f.workspace) throw Error("Controlled Guardian requires its registered workspace cwd");
      expect(options.gitExecutable).toBe(f.git); expect(backend).toBe(f.backend);
      let output = "";
      if (request.args.includes("init")) {
        const target = request.args.at(-1)!;
        expect(isAbsolute(target)).toBe(true); expect(target).toBe(f.staging);
        expect(relative(f.workspace, target).startsWith(`..${sep}`)).toBe(true);
        expect(readdirSync(f.workspace)).toEqual([]);
        mkdirSync(join(target, ".git")); writeFileSync(join(target, ".git/HEAD"), "ref: refs/heads/main\n");
        entered(); await initClosed;
      } else {
        expect(request.args).toEqual(["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
        output = `${f.workspace}\n${join(f.workspace, ".git")}\n`;
      }
      return { status: 0, stdout: Buffer.from(output), stderr: Buffer.alloc(0), elapsedMs: 1 };
    });
    const pending = f.run();
    // If admission fails, report that failure rather than waiting on an unreachable mock callback.
    await Promise.race([initEntered, pending.then(() => { throw Error("Import settled before controlled Git closure"); })]);
    expect(readdirSync(f.workspace)).toEqual([]);
    expect(f.journal().map(entry => entry.stage)).toEqual(["reserved", "bytes_verified"]);
    finish();
    const receipt = await pending;
    expect(receipt).toMatchObject({ git_processes_closed: true, verification_passed: false, execution_authorized: false,
      capsule_digest: sha(f.capsule), destination: { workspace_root: f.workspace } });
    expect(readFileSync(join(f.workspace, "product/index.html"))).toEqual(f.product);
    expect(readFileSync(join(f.workspace, ".git/HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
    expect(existsSync(join(f.staging, ".git"))).toBe(false); expect(existsSync(f.claim)).toBe(true);
    expect(f.journal().map(entry => entry.stage)).toEqual(["reserved", "bytes_verified", "git_initialized", "materializing", "ready"]);
    expect(await f.run()).toEqual(receipt); expect(control.command).toHaveBeenCalledTimes(2);
  });

  it("retains the original claim and staging after an init failure and never retries the incomplete import", async () => {
    const f = fixture(), failure = Error("Controlled Git init failure");
    control.command.mockImplementation(async (request: OwnedGitRequest) => {
      expect(request.cwd).toBe(f.workspace); expect(request.args.at(-1)).toBe(f.staging); throw failure;
    });
    await expect(f.run()).rejects.toMatchObject({ cause: failure });
    expect(existsSync(f.claim)).toBe(true); expect(readdirSync(f.staging)).toEqual([]); expect(readdirSync(f.workspace)).toEqual([]);
    expect(f.journal().map(entry => entry.stage)).toEqual(["reserved", "bytes_verified", "uncertain"]);
    expect(f.journal().at(-1).details).toEqual({ retained: true, execution_authorized: false });
    await expect(f.run()).rejects.toThrow(); expect(control.command).toHaveBeenCalledTimes(1);
    expect(readdirSync(f.workspace)).toEqual([]);
  });
});
