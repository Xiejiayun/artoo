// Controlled ownership envelopes and self-consistent content only. Mock spawn
// never executes fixture EXEs or claims native/QuickJS/compiler provenance.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
const mocked = vi.hoisted(() => ({ spawn: vi.fn(), load: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
vi.mock("./application-compiler-installation.js", () => ({ loadApplicationCompilerConfiguration: mocked.load }));
import { prepareApplicationCompilerProcess, startApplicationCompilerProcess, type ApplicationCompilerInstallation } from "./application-compiler-process.js";
import { APPLICATION_COMPILER_PROCESS_LIMITS as limits } from "./application-compiler-process-protocol.js";
import { APPLICATION_BUILD_EXECUTION_STATUS } from "./application-build-kernel.js";
import { APPLICATION_SDK_V1_SOURCE } from "./application-sdk-v1.js";
import type { CapturedApplicationCompilerContent } from "./application-compiler-capture.js";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const sha = (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex");
const source = [
  { path: "product/client/index.html", text: "<!doctype html><title>controlled 😀</title>" },
  { path: "product/server/handler.ts", text: "export const handle = () => ({ status: 200 });" },
];
const libraries = [{ path: "lib.es2023.d.ts", text: "// Controlled content expectation only" }];
const request = (extra = {}) => Buffer.from(JSON.stringify({ version: 1, kind: "compile", request_id: "controlled-1", source, ...extra }));
function response() {
  const pins = (files: { path: string; text: string }[]) => [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(file => ({ path: file.path, bytes: Buffer.byteLength(file.text), sha256: sha(file.text) }));
  const files = [{ path: "client/index.html", text: source[0]!.text },
    { path: "server/handler.js", text: "// Self-consistent controlled fixture, not a compiler result\nexport const handle = () => ({ status: 200 });" }];
  const source_files = pins(source), compiler_lib_files = pins(libraries), artifact_files = pins(files);
  return { version: 1, kind: "compile-result", request_id: "controlled-1", qualified_for_product: false,
    result: { status: "compiled", diagnostics: [], files, manifest: { version: 1, format: "artoo.application-build-draft.v1",
      compiler_version: "5.9.3", compiler_lib_digest: sha(JSON.stringify(compiler_lib_files)), sdk_digest: sha(APPLICATION_SDK_V1_SOURCE),
      source_digest: sha(JSON.stringify(source_files)), artifact_digest: sha(JSON.stringify(artifact_files)),
      source_files, compiler_lib_files, artifact_files, execution: APPLICATION_BUILD_EXECUTION_STATUS } } };
}
class Helper extends EventEmitter {
  readonly pid = 12345; readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly writes: Record<string, unknown>[] = [];
  readonly stdin = new Writable({ write: (chunk, _encoding, done) => { this.writes.push(JSON.parse(String(chunk))); done(); } });
  sequence = 0; closed = false;
  frame(kind: string, payload: unknown) { return JSON.stringify({ version: 1, sequence: this.sequence++, kind, payload }) + "\n"; }
  send(kind: string, payload: unknown) { this.stdout.write(this.frame(kind, payload)); }
  output(bytes = Buffer.from(JSON.stringify(response()) + "\n"), stream = "stdout") {
    for (let offset = 0; offset < bytes.length; offset += 8192)
      this.send("output", { stream, data: bytes.subarray(offset, offset + 8192).toString("base64") });
  }
  started(node: string) { this.send("started", { pid: 12346, creationTime: "100", image: node, jobAssigned: true, jobLimitsReadBack: true,
    processCommitLimitBytes: 1610612736, activeProcessLimit: 1 }); }
  admitted() { this.send("admitted", { bytes: 100, remainingMs: 1000 }); }
  written(command = this.writes.at(-1)!, delta = 0, nonce = command.nonce) {
    this.send("input-written", { nonce, bytes: Buffer.from(command.data as string, "base64").length + delta });
  }
  terminal(normal = true, overrides = {}) { this.send("terminal", { pid: 12346, originalExitObserved: true, exitCode: normal ? 0 : 1,
    jobAssigned: true, jobLimitsReadBack: true, jobEmptyObserved: true, inputSettled: true, inputClosed: true,
    stdoutEof: true, stderrEof: true, outputTasksSettled: true, terminationRequested: !normal, terminationSucceeded: !normal,
    inputsUnchanged: true, failure: normal ? null : "cancelled", ...overrides }); }
  async finish(code = 1, omit: "exit" | "stdout" | "stderr" | undefined = undefined) {
    if (this.closed) return; this.closed = true;
    if (omit !== "exit") this.emit("exit", code, null);
    if (omit !== "stdout") this.stdout.end(); if (omit !== "stderr") this.stderr.end();
    await tick(); this.emit("close", code, null);
  }
  kill() { void this.finish(1); return true; }
}
const folders: string[] = [], helpers: Helper[] = [];
let platform: PropertyDescriptor | undefined, arch: PropertyDescriptor | undefined, previousRoot: string | undefined;
beforeEach(() => {
  mocked.spawn.mockClear(); mocked.load.mockReset();
  platform = Object.getOwnPropertyDescriptor(process, "platform"); arch = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", { value: "win32" }); Object.defineProperty(process, "arch", { value: "x64" });
  previousRoot = process.env.SystemRoot;
  mocked.spawn.mockImplementation(() => { const helper = new Helper(); helpers.push(helper); queueMicrotask(() => helper.emit("spawn")); return helper; });
});
afterEach(async () => {
  for (const helper of helpers.splice(0)) await helper.finish();
  await tick();
  if (platform) Object.defineProperty(process, "platform", platform); if (arch) Object.defineProperty(process, "arch", arch);
  if (previousRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previousRoot;
  vi.restoreAllMocks();
  for (const folder of folders.splice(0)) {
    if (dirname(folder) !== realpathSync.native(tmpdir()) || !basename(folder).startsWith("artoo-compiler-owner-")) throw Error("unsafe fixture cleanup path");
    rmSync(folder, { recursive: true, force: true });
  }
});
function installation(): ApplicationCompilerInstallation {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-compiler-owner-"))); folders.push(folder);
  if (previousRoot === undefined) process.env.SystemRoot = folder;
  for (const member of ["native", "compiler", "toolchain"]) mkdirSync(join(folder, member));
  const pin = (member: string, text: string) => {
    const path = join(folder, member); writeFileSync(path, text); const bytes = readFileSync(path);
    return { path: realpathSync.native(path), bytes: bytes.length, sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
  };
  const helper = pin("native/artoo-quickjs-process-host.exe", "controlled helper"), dependency = pin("native/coreclr.dll", "controlled dependency");
  const helperManifest = pin("native/quickjs-native-manifest.json", JSON.stringify({ version: 1, format: "artoo.quickjs-native-host.v1", platform: "win32", arch: "x64",
    entry: basename(helper.path), files: [helper, dependency].map(file => ({ path: basename(file.path), bytes: file.bytes, sha256: file.sha256 })) }));
  const node = pin("node.exe", "controlled node"), entry = pin("compiler/application-compiler-process.mjs", "controlled entry");
  const configuration = pin("compiler/application-compiler-process.json", "controlled configuration");
  const toolchain = pin("toolchain/content.bin", "controlled toolchain");
  mocked.load.mockReturnValue({ files: [toolchain], compilerInputs: { compilerVersion: "5.9.3", libraries } });
  return { helper, helperManifest, node, entry, configuration, assertLocalAdmission() {} };
}
function begin(config = installation(), bytes = request(), deadline = performance.now() + 10_000) {
  const token = prepareApplicationCompilerProcess(config), owner = startApplicationCompilerProcess(token, bytes, deadline), helper = helpers.at(-1)!;
  helper.started(config.node.path); return { config, token, owner, helper };
}
async function writeRequest(helper: Helper) {
  helper.admitted(); await tick();
  for (let guard = 0; helper.writes.at(-1)!.kind === "write"; guard++) {
    if (guard >= limits.nativeWrites) throw Error("fixture write guard");
    helper.written(); await tick();
  }
  const last = helper.writes.at(-1)!; expect(last.kind).toBe("close-input");
  helper.send("input-closed", { nonce: last.nonce }); await tick();
}
async function complete(helper: Helper) { await writeRequest(helper); helper.output(); helper.terminal(); await helper.finish(0); }

describe("fixed compiler owner controlled closure", () => {
  it("uses only the fixed compiler selector and pinned installation, copying source data before spawn", async () => {
    const bytes = request(), original = Buffer.from(bytes), { owner, helper, config, token } = begin(undefined, bytes);
    bytes.fill(0);
    expect(mocked.spawn).toHaveBeenCalledWith(config.helper.path, ["--application-quickjs-compiler-owner-v1"], expect.objectContaining({
      shell: false, windowsHide: true, detached: false, env: { SystemRoot: realpathSync.native(process.env.SystemRoot!), WINDIR: realpathSync.native(process.env.SystemRoot!) } }));
    expect(Object.keys(helper.writes[0]!).sort()).toEqual(["version", "kind", "node", "entry", "configuration", "runtimeFiles", "cwd", "lifetimeMs"].sort());
    expect(() => startApplicationCompilerProcess(token, original, performance.now() + 1000)).toThrow("unused");
    await complete(helper); const captured = await owner.completed;
    expect(Buffer.concat(helper.writes.filter(value => value.kind === "write").map(value => Buffer.from(value.data as string, "base64")))).toEqual(original);
    expect(owner.read(captured)).toMatchObject({ scope: "compiler-response-content-only", qualified_for_product: false, request_id: "controlled-1" });
    expect(Object.keys(owner).sort()).toEqual(["cancel", "closed", "completed", "read"]);
    await expect(owner.closed).resolves.toMatchObject({ normalShutdown: true, closureConfirmed: true, contentValidated: true, inputBytesWritten: original.length });
  });
  it.each(["mode", "argv", "budget", "hostPath", "verification"])("rejects request-controlled %s before spawn", field => {
    const config = installation(), token = prepareApplicationCompilerProcess(config);
    expect(() => startApplicationCompilerProcess(token, request({ [field]: "untrusted" }), performance.now() + 1000)).toThrow();
    expect(mocked.spawn).not.toHaveBeenCalled();
    expect(() => startApplicationCompilerProcess(token, request(), performance.now() + 1000)).toThrow("unused");
  });
  it("rejects extra installation fields, unsupported platform and asynchronous local admission", () => {
    const config = installation();
    expect(() => prepareApplicationCompilerProcess({ ...config, argv: [] } as ApplicationCompilerInstallation)).toThrow("Fixed");
    expect(() => prepareApplicationCompilerProcess({ ...config, assertLocalAdmission: async () => {} })).toThrow("synchronously");
    Object.defineProperty(process, "platform", { value: "linux" });
    expect(() => prepareApplicationCompilerProcess(config)).toThrow("Windows"); expect(mocked.spawn).not.toHaveBeenCalled();
  });
  it("retains the original admission callback and consumes a rejected start", () => {
    let reject = false;
    const config = { ...installation(), assertLocalAdmission: () => { if (reject) throw Error("original-admission"); } };
    const token = prepareApplicationCompilerProcess(config); config.assertLocalAdmission = () => {}; reject = true;
    expect(() => startApplicationCompilerProcess(token, request(), performance.now() + 1000)).toThrow("original-admission");
    expect(mocked.spawn).not.toHaveBeenCalled();
    expect(() => startApplicationCompilerProcess(token, request(), performance.now() + 1000)).toThrow("unused");
  });
  it("requires the complete native dependency inventory", () => {
    const config = installation(); writeFileSync(join(dirname(config.helper.path), "unlisted.dll"), "not admitted");
    expect(() => prepareApplicationCompilerProcess(config)).toThrow("inventory"); expect(mocked.spawn).not.toHaveBeenCalled();
  });
  it("cannot deliver valid content or a terminal before original helper closure", async () => {
    const { owner, helper } = begin(); let settled = false;
    void owner.completed.then(() => { settled = true; }, () => { settled = true; });
    await writeRequest(helper); helper.output(); helper.terminal(); await tick();
    expect(settled).toBe(false); expect(() => owner.read({} as CapturedApplicationCompilerContent)).toThrow();
    helper.emit("exit", 0, null); helper.stdout.end(); helper.stderr.end(); await tick(); expect(settled).toBe(false);
    await helper.finish(0); await owner.completed; expect(settled).toBe(true);
  });
  it.each(["count", "nonce"])("rejects a wrong exact input ACK %s while retaining original closure", async kind => {
    const { owner, helper } = begin(); helper.admitted(); await tick();
    helper.written(undefined, kind === "count" ? 1 : 0, kind === "nonce" ? randomUUID() : helper.writes.at(-1)!.nonce);
    await tick(); expect(helper.writes.some(value => value.kind === "cancel")).toBe(true);
    helper.terminal(false); await helper.finish();
    await expect(owner.completed).rejects.toThrow();
    await expect(owner.closed).resolves.toMatchObject({ normalShutdown: false, closureConfirmed: true });
  });
  it("retains an ordered terminal after a bad ACK in the same original stream chunk", async () => {
    const { owner, helper } = begin(); helper.admitted(); await tick();
    const ack = helper.frame("input-written", { nonce: helper.writes.at(-1)!.nonce, bytes: 1 });
    const terminal = { pid: 12346, originalExitObserved: true, exitCode: 1, jobAssigned: true, jobLimitsReadBack: true,
      jobEmptyObserved: true, inputSettled: true, inputClosed: true, stdoutEof: true, stderrEof: true, outputTasksSettled: true,
      terminationRequested: true, terminationSucceeded: true, inputsUnchanged: true, failure: "cancelled" };
    helper.stdout.write(ack + helper.frame("terminal", terminal)); await helper.finish();
    await expect(owner.closed).resolves.toMatchObject({ normalShutdown: false, closureConfirmed: true, terminal });
  });
  it.each(["originalExitObserved", "jobAssigned", "jobLimitsReadBack", "jobEmptyObserved", "inputSettled", "inputClosed", "stdoutEof", "stderrEof", "outputTasksSettled"])(
    "does not infer missing original target %s", async field => {
      const { owner, helper } = begin(); await writeRequest(helper); helper.output(); helper.terminal(true, { [field]: false }); await helper.finish(0);
      await expect(owner.completed).rejects.toThrow(); await expect(owner.closed).resolves.toMatchObject({ closureConfirmed: false, normalShutdown: false });
    });
  it.each(["exit", "stdout", "stderr"] as const)("does not infer missing original helper %s", async missing => {
    const { owner, helper } = begin(); await writeRequest(helper); helper.output(); helper.terminal(); await helper.finish(0, missing);
    await expect(owner.completed).rejects.toThrow(); await expect(owner.closed).resolves.toMatchObject({ closureConfirmed: false, normalShutdown: false });
  });
  it("requires input close ACK even with complete content and terminal claims", async () => {
    const { owner, helper } = begin(); helper.admitted(); await tick(); helper.written(); await tick();
    helper.output(); helper.terminal(); await helper.finish(0);
    await expect(owner.completed).rejects.toThrow(); await expect(owner.closed).resolves.toMatchObject({ normalShutdown: false, failure: "compiler-input-unsettled" });
  });
  it.each(["helper", "toolchain", "admission"])("revalidates %s after actual closure and withholds content", async changed => {
    const config = installation(); let deny = false;
    const { owner, helper } = begin({ ...config, assertLocalAdmission() { if (deny) throw Error("ctime-or-admission"); } });
    await writeRequest(helper); helper.output(); helper.terminal();
    if (changed === "helper") writeFileSync(join(dirname(config.helper.path), "coreclr.dll"), "changed dependency");
    else if (changed === "toolchain") writeFileSync(join(dirname(dirname(config.entry.path)), "toolchain/content.bin"), "changed toolchain");
    else deny = true;
    await helper.finish(0); await expect(owner.completed).rejects.toThrow();
    await expect(owner.closed).resolves.toMatchObject({ normalShutdown: false, inputsUnchanged: false, failure: "compiler-installation-changed" });
  });
  it("rejects synchronous final admission work that crosses the original deadline", async () => {
    let now = 100, postClose = false; vi.spyOn(performance, "now").mockImplementation(() => now);
    const { owner, helper } = begin({ ...installation(), assertLocalAdmission() { if (postClose) now = 2101; } }, request(), 2100);
    await writeRequest(helper); helper.output(); helper.terminal(); postClose = true; await helper.finish(0);
    await expect(owner.completed).rejects.toThrow("deadline"); await expect(owner.closed).resolves.toMatchObject({ normalShutdown: false, failure: "compiler-deadline" });
  });
  it.each(["json", "utf8", "mismatch", "trailing", "target-stderr", "helper-stderr", "nonzero"])("rejects %s and never exposes a content token", async bad => {
    const { owner, helper } = begin(); await writeRequest(helper);
    if (bad === "json") helper.output(Buffer.from("{"));
    else if (bad === "utf8") helper.output(Buffer.from([0xff]));
    else if (bad === "mismatch") helper.output(Buffer.from(JSON.stringify({ ...response(), request_id: "other" })));
    else if (bad === "trailing") helper.output(Buffer.from(JSON.stringify(response()) + "\n{}"));
    else { helper.output(); if (bad === "target-stderr") helper.output(Buffer.from("error"), "stderr"); if (bad === "helper-stderr") helper.stderr.write("error"); }
    helper.terminal(); await helper.finish(bad === "nonzero" ? 1 : 0);
    await expect(owner.completed).rejects.toThrow(); expect(() => owner.read({} as CapturedApplicationCompilerContent)).toThrow();
    await expect(owner.closed).resolves.toMatchObject({ normalShutdown: false, contentValidated: false });
  });
  it("bounds queued output even when many frames arrive without consumer progress", async () => {
    const { owner, helper } = begin(); await writeRequest(helper);
    const chunk = Buffer.alloc(8192, 32);
    for (let count = 0; count <= limits.queuedOutputBytes / chunk.length + 1; count++) helper.output(chunk);
    helper.terminal(false); await helper.finish(); await expect(owner.completed).rejects.toThrow();
    expect(helper.writes.some(value => value.kind === "cancel")).toBe(true);
  });
  it("measures actual request storage and rejects shared or oversized buffers before spawn", () => {
    const config = installation();
    const shared = new Uint8Array(new SharedArrayBuffer(1));
    expect(() => startApplicationCompilerProcess(prepareApplicationCompilerProcess(config), shared, performance.now() + 1000)).toThrow("storage");
    const oversized = new Uint8Array(limits.requestBytes + 1); Object.defineProperty(oversized, "byteLength", { value: 1 });
    expect(() => startApplicationCompilerProcess(prepareApplicationCompilerProcess(config), oversized, performance.now() + 1000)).toThrow("storage");
    expect(mocked.spawn).not.toHaveBeenCalled();
  });
  it("waits for actual owner close after cancellation and revokes a previously delivered token", async () => {
    const first = begin(); let settled = false; void first.owner.completed.catch(() => { settled = true; });
    void first.owner.cancel(); await tick(); expect(settled).toBe(false);
    first.helper.terminal(false); await first.helper.finish(); await expect(first.owner.completed).rejects.toThrow("cancelled");
    const second = begin(); await complete(second.helper); const token = await second.owner.completed;
    expect(second.owner.read(token).qualified_for_product).toBe(false);
    await second.owner.cancel(); expect(() => second.owner.read(token)).toThrow();
  });
});
