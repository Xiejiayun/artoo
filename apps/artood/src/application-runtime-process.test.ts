import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
import { prepareApplicationRuntimeProcess, startApplicationRuntimeProcess, type ApplicationRuntimeInstallation } from "./application-runtime-process.js";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class Helper extends EventEmitter {
  readonly pid = 12345; readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly writes: Record<string, unknown>[] = [];
  readonly stdin = new Writable({ write: (chunk, _encoding, done) => { this.writes.push(JSON.parse(String(chunk))); done(); } });
  sequence = 0; targetSequence = 0; closed = false;
  send(kind: string, payload: unknown) { this.stdout.write(JSON.stringify({ version: 1, sequence: this.sequence++, kind, payload }) + "\n"); }
  target(kind: string, payload: unknown) {
    this.send("output", { stream: "stdout", data: Buffer.from(JSON.stringify({ version: 1, sequence: this.targetSequence++, kind, payload }) + "\n").toString("base64") });
  }
  started(node: string) { this.send("started", { pid: 12346, creationTime: "100", image: node, jobAssigned: true, jobLimitsReadBack: true,
    processCommitLimitBytes: 1610612736, activeProcessLimit: 1 }); }
  admitted() { this.send("admitted", { bytes: 100, remainingMs: 1000 }); }
  ready() { this.target("ready", { protocol: "artoo.application-runtime.v1", qualifiedForProduct: false }); }
  written(command = this.writes.at(-1)!, delta = 0) {
    this.send("input-written", { nonce: command.nonce, bytes: Buffer.from(command.data as string, "base64").length + delta });
  }
  terminal(normal = true, overrides = {}) { this.send("terminal", { pid: 12346, originalExitObserved: true, exitCode: normal ? 0 : 1,
    jobAssigned: true, jobLimitsReadBack: true, jobEmptyObserved: true, inputSettled: true, inputClosed: true,
    stdoutEof: true, stderrEof: true, outputTasksSettled: true, terminationRequested: !normal, terminationSucceeded: !normal,
    inputsUnchanged: true, failure: normal ? null : "cancelled", ...overrides }); }
  async finish(code = 1) {
    if (this.closed) return; this.closed = true; this.emit("exit", code, null); this.stdout.end(); this.stderr.end();
    await tick(); this.emit("close", code, null);
  }
  kill() { void this.finish(1); return true; }
}
const folders: string[] = [], helpers: Helper[] = [];
let platform: PropertyDescriptor | undefined, arch: PropertyDescriptor | undefined, previousRoot: string | undefined;
beforeEach(() => {
  mocked.spawn.mockClear(); platform = Object.getOwnPropertyDescriptor(process, "platform"); arch = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", { value: "win32" }); Object.defineProperty(process, "arch", { value: "x64" });
  previousRoot = process.env.SystemRoot;
  mocked.spawn.mockImplementation(() => { const helper = new Helper(); helpers.push(helper); queueMicrotask(() => helper.emit("spawn")); return helper; });
});
afterEach(async () => {
  for (const helper of helpers.splice(0)) await helper.finish();
  if (platform) Object.defineProperty(process, "platform", platform); if (arch) Object.defineProperty(process, "arch", arch);
  if (previousRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previousRoot;
  for (const folder of folders.splice(0)) {
    if (dirname(folder) !== realpathSync.native(tmpdir()) || !basename(folder).startsWith("artoo-runtime-owner-")) throw Error("unsafe fixture cleanup path");
    rmSync(folder, { recursive: true, force: true });
  }
});
function installation(): ApplicationRuntimeInstallation {
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-runtime-owner-"))); folders.push(folder);
  if (previousRoot === undefined) process.env.SystemRoot = folder;
  for (const member of ["native", "runtime", "vendor", "vendor/release-sync", "product"]) mkdirSync(join(folder, member), { recursive: true });
  const pin = (member: string, text: string) => {
    const path = join(folder, member); writeFileSync(path, text); const bytes = readFileSync(path);
    return { path: realpathSync.native(path), bytes: bytes.length, sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
  };
  // Inert byte fixtures only. Mock spawn never executes these files.
  const helper = pin("native/artoo-quickjs-process-host.exe", "controlled helper"), dependency = pin("native/coreclr.dll", "controlled dependency");
  const helperManifest = pin("native/quickjs-native-manifest.json", JSON.stringify({ version: 1, format: "artoo.quickjs-native-host.v1", platform: "win32", arch: "x64",
    entry: basename(helper.path), files: [helper, dependency].map(file => ({ path: basename(file.path), bytes: file.bytes, sha256: file.sha256 })) }));
  const node = pin("node.exe", "controlled node"), entry = pin("runtime/application-runtime.mjs", "controlled entry");
  const vendor = pin("vendor/release-sync/fixture.mjs", "controlled vendor bytes");
  const vendorManifest = pin("vendor/manifest.json", JSON.stringify({ version: 1, format: "artoo.quickjs-runtime-vendor.v1", version_name: "0.32.0",
    variant: "wasmfile-release-sync", qualified_for_product: false, provenance: "controlled metadata", files: [
      { path: "release-sync/fixture.mjs", bytes: vendor.bytes, sha256: vendor.sha256.slice(7), url: "https://example.invalid/fixture", integrity: "controlled" },
    ] }));
  const first = pin("product/first.txt", "controlled first"), second = pin("product/second.txt", "controlled second");
  const members = [{ logicalPath: "first.txt", file: first }, { logicalPath: "second.txt", file: second }];
  const configuration = pin("runtime/application-runtime.json", JSON.stringify({ version: 1, protocol: "artoo.application-runtime.v1",
    vendorManifest, expectation: {}, source: members, artifacts: members, toolchain: [members[0]] }));
  return { helper, helperManifest, node, entry, configuration, assertLocalAdmission() {} };
}
function begin() {
  const config = installation(), token = prepareApplicationRuntimeProcess(config);
  const owner = startApplicationRuntimeProcess(token, performance.now() + 2000), helper = helpers.at(-1)!;
  helper.started(config.node.path); return { config, token, owner, helper };
}
describe("fixed runtime original native client", () => {
  it("requires the complete native dependency manifest and rejects unlisted published files", () => {
    const config = installation(); writeFileSync(join(dirname(config.helper.path), "unlisted.dll"), "not admitted");
    expect(() => prepareApplicationRuntimeProcess(config)).toThrow("inventory"); expect(mocked.spawn).not.toHaveBeenCalled();
  });
  it("captures original local admission and rejects a replaced callback", () => {
    const config = installation(); let rejected = false; const original = () => { if (rejected) throw Error("original-admission"); };
    const mutable = { ...config, assertLocalAdmission: original }, token = prepareApplicationRuntimeProcess(mutable);
    mutable.assertLocalAdmission = () => {}; rejected = true;
    expect(() => startApplicationRuntimeProcess(token, performance.now() + 1000)).toThrow("original-admission"); expect(mocked.spawn).not.toHaveBeenCalled();
  });
  it("requires native admission as well as actual child readiness, without assuming their delivery order", async () => {
    const { owner, helper } = begin(); let ready = false; void owner.ready.then(() => { ready = true; });
    helper.ready(); await tick(); expect(ready).toBe(false); helper.admitted(); await owner.ready; expect(ready).toBe(true);
    void owner.cancel(); helper.terminal(false); await helper.finish();
  });
  it("waits for actual target writes, actual input close and both original owner closures", async () => {
    const { owner, helper } = begin(); helper.admitted(); helper.ready(); await owner.ready;
    const sent = owner.receive(Buffer.from("controlled wire bytes")); let delivered = false; void sent.then(() => { delivered = true; });
    await tick(); expect(delivered).toBe(false); const write = helper.writes.at(-1)!;
    expect(write.kind).toBe("write"); helper.written(write); await sent;
    const closed = owner.close(); let finished = false; void closed.then(() => { finished = true; });
    await tick(); helper.written(); await tick();
    const closeInput = helper.writes.at(-1)!; expect(closeInput.kind).toBe("close-input");
    helper.send("input-closed", { nonce: closeInput.nonce });
    helper.target("closed", { guestDisposed: true, inputEnded: true, discardedOutputBytes: 0, qualifiedForProduct: false });
    helper.terminal(); await tick(); expect(finished).toBe(false);
    await helper.finish(0); await expect(closed).resolves.toMatchObject({ normalShutdown: true, closureConfirmed: true, runtimeDisposed: true });
  });
  it("retains failed ownership when a write acknowledgement has the wrong exact byte count", async () => {
    const { owner, helper } = begin(); helper.admitted(); helper.ready(); await owner.ready;
    const sent = owner.receive(Buffer.from("wire")); void sent.catch(() => {}); await tick(); helper.written(undefined, 1);
    await expect(sent).rejects.toThrow(); expect(helper.writes.some(value => value.kind === "cancel")).toBe(true);
    helper.terminal(false); await helper.finish();
    await expect(owner.closed).resolves.toMatchObject({ normalShutdown: false, closureConfirmed: true });
  });
  it("never promotes missing actual Job emptiness to settled closure", async () => {
    const { owner, helper } = begin(); helper.admitted(); helper.ready(); await owner.ready;
    void owner.cancel(); helper.terminal(false, { jobEmptyObserved: false }); await helper.finish();
    await expect(owner.closed).resolves.toMatchObject({ normalShutdown: false, closureConfirmed: false });
  });
  it("retains an actual terminal behind a rejected ordered ACK in the same original stream chunk", async () => {
    const { owner, helper } = begin(); helper.admitted(); helper.ready(); await owner.ready;
    const sent = owner.receive(Buffer.from("wire")); void sent.catch(() => {}); await tick();
    const command = helper.writes.at(-1)!;
    const frames = [
      { kind: "input-written", payload: { nonce: command.nonce, bytes: Buffer.from(command.data as string, "base64").length + 1 } },
      { kind: "terminal", payload: { pid: 12346, originalExitObserved: true, exitCode: 1, jobAssigned: true, jobLimitsReadBack: true,
        jobEmptyObserved: true, inputSettled: true, inputClosed: true, stdoutEof: true, stderrEof: true, outputTasksSettled: true,
        terminationRequested: true, terminationSucceeded: true, inputsUnchanged: true, failure: "cancelled" } },
    ];
    helper.stdout.write(frames.map(frame => JSON.stringify({ version: 1, sequence: helper.sequence++, ...frame }) + "\n").join(""));
    await expect(sent).rejects.toThrow(); await helper.finish();
    await expect(owner.closed).resolves.toMatchObject({ normalShutdown: false, closureConfirmed: true, terminal: { jobEmptyObserved: true } });
  });
  it("rechecks every native dependency after actual helper closure", async () => {
    const { owner, helper, config } = begin(); helper.admitted(); helper.ready(); await owner.ready;
    writeFileSync(join(dirname(config.helper.path), "coreclr.dll"), "changed dependency");
    void owner.cancel(); helper.terminal(false); await helper.finish();
    await expect(owner.closed).resolves.toMatchObject({ inputsUnchanged: false, normalShutdown: false });
  });
  it("rejects a receipt whose synchronous post-close admission crosses the original deadline", async () => {
    const config = installation(); let now = 100, postClose = false;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const prepared = prepareApplicationRuntimeProcess({ ...config, assertLocalAdmission() { if (postClose) now = 2101; } });
      const owner = startApplicationRuntimeProcess(prepared, 2100), helper = helpers.at(-1)!;
      helper.started(config.node.path); helper.admitted(); helper.ready(); await owner.ready;
      const closed = owner.close(); await tick(); helper.written(); await tick();
      helper.send("input-closed", { nonce: helper.writes.at(-1)!.nonce });
      helper.target("closed", { guestDisposed: true, inputEnded: true, discardedOutputBytes: 0, qualifiedForProduct: false });
      helper.terminal(); postClose = true; await helper.finish(0);
      await expect(closed).resolves.toMatchObject({ normalShutdown: false, failure: "runtime-deadline" });
    } finally { clock.mockRestore(); }
  });
});
