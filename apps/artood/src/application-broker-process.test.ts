import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
// Controlled native transport only. Real helper ownership is separately exercised
// by application-broker-process-real.test.mjs; these mocks certify no OS facts.
vi.mock("./owned/windows-owned-process.js", () => ({ prepareWindowsProcessBackend: (binding: { assertLocalInstallation(): void }) => {
  binding.assertLocalInstallation(); return { binding };
}, assertWindowsProcessBackend: (backend: { binding: { assertLocalInstallation(): void } }) => backend.binding.assertLocalInstallation() }));
import { prepareApplicationBrokerProcess, startApplicationBrokerProcess, type ApplicationBrokerInstallation, type ApplicationBrokerProcess } from "./application-broker-process.js";
const digest = `sha256:${"a".repeat(64)}`, sid = "S-1-5-21-1";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
class Helper extends EventEmitter {
  readonly pid = 12345;
  readonly stdout = new PassThrough(); readonly stderr = new PassThrough();
  readonly writes: Record<string, unknown>[] = [];
  readonly stdin = new Writable({ write: (chunk, _encoding, done) => { this.writes.push(JSON.parse(String(chunk))); done(); } });
  sequence = 0; closed = false; kills = 0; batch: string[] | undefined;
  nativeImage = ""; nodeImage = "";
  readonly root = { pid: 12346, creationTime: "101", image: "", sid };
  send(kind: string, payload: unknown) { const line = JSON.stringify({ version: 1, sequence: this.sequence++, kind, payload }) + "\n";
    if (this.batch) this.batch.push(line); else this.stdout.write(line); }
  broker(value: unknown) { this.send("daemon_output", { generation: 0, stream: "stdout", data: Buffer.from(JSON.stringify(value) + "\n").toString("base64") }); }
  ready(beforeStarted = false) {
    this.send("supervisor_ready", { capability: "artoo.windows-daemon-supervisor.v1", supervisor: { pid: this.pid, creationTime: "100", image: this.nativeImage, sid },
      launchIdentityDigest: digest, lifetimeOwnership: { version: 1, capability: "artoo.windows-daemon-supervisor-lifetime.v1", cleanupTimeoutMs: 15000, gracefulStopMs: 15000, sharedJob: true } });
    if (beforeStarted) this.brokerReady();
    this.root.image = this.nodeImage;
    this.send("daemon_started", { generation: 0, daemon: this.root, launchIdentityDigest: digest, atomicJobMember: true });
    if (!beforeStarted) this.brokerReady();
  }
  brokerReady() { this.broker({ version: 1, kind: "ready", protocol: "artoo.application-broker.v1", maximumAccess: "write" }); }
  ack(command = this.writes.at(-1)!) { this.send("command_ack", { nonce: command.nonce, kind: command.kind, generation: 0 }); }
  written(command = this.writes.at(-1)!, delta = 0) { this.send("daemon_input_written", { generation: 0, bytes: Buffer.from(command.data as string, "base64").length + delta }); }
  result(sequence = 0, stopped = false) { this.broker({ version: 1, sequence, kind: "result", frames: [], responses: [], terminated: [], stopped }); }
  terminal(normal = false) {
    for (const stream of ["stdout", "stderr"]) this.send("daemon_pipe_eof", { generation: 0, stream });
    this.send("daemon_exit", { generation: 0, daemon: this.root, rootWaitObserved: true, exitCode: normal ? 0 : 1, exitTime: "102", stdoutEof: true, stderrEof: true });
    this.send(normal ? "supervisor_stopped" : "supervisor_failed", { reason: normal ? "stopped" : "cancelled", facts: { launchIdentityDigest: digest,
      incarnations: [{ generation: 0, daemon: this.root, rootWaitObserved: true, exitCode: normal ? 0 : 1, stdoutEof: true, stderrEof: true, atomicJobMember: true }],
      lifetimeClosure: { version: 1, capability: "artoo.windows-daemon-supervisor-lifetime.v1", jobCreated: true, allRootsWaitObserved: true, jobEmptyObserved: true,
        allStdoutEof: true, allStderrEof: true, cleanupConfirmed: true, gracefulStopArmed: normal, gracefulStopTimedOut: false, forcedJobTermination: !normal } } });
  }
  async finish(code = 1) {
    if (this.closed) return; this.closed = true; this.emit("exit", code, null); this.stdout.end(); this.stderr.end();
    await tick(); this.emit("close", code, null);
  }
  kill() { this.kills++; void this.finish(1); return true; }
}
const directories: string[] = [], helpers: Helper[] = [];
let platform: PropertyDescriptor | undefined, previousRoot: string | undefined;
beforeEach(() => {
  mocked.spawn.mockClear();
  platform = Object.getOwnPropertyDescriptor(process, "platform"); Object.defineProperty(process, "platform", { value: "win32" });
  previousRoot = process.env.SystemRoot;
  mocked.spawn.mockImplementation((image: string) => {
    const helper = new Helper(); helper.nativeImage = image; helpers.push(helper); queueMicrotask(() => helper.emit("spawn")); return helper;
  });
});
afterEach(async () => {
  for (const helper of helpers.splice(0)) await helper.finish();
  if (platform) Object.defineProperty(process, "platform", platform);
  if (previousRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = previousRoot;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function installation(): ApplicationBrokerInstallation {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-broker-owner-"))); directories.push(directory);
  const native = join(directory, "native"); mkdirSync(native);
  // On actual Windows, OpenSSL entropy also depends on the real system root.
  // The fake path is only a parser fixture on non-Windows test hosts.
  if (previousRoot === undefined) process.env.SystemRoot = directory;
  const pin = (name: string, content: string) => { const path = join(directory, name); writeFileSync(path, content); const bytes = readFileSync(path);
    return { path: realpathSync.native(path), bytes: bytes.length, sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex") }; };
  writeFileSync(join(native, "helper.exe"), "controlled"); writeFileSync(join(native, "manifest.json"), JSON.stringify({ executable: "helper.exe", capabilities: ["artoo.windows-daemon-supervisor-lifetime.v1"] }));
  return { native: { directory: native, manifestSha256: digest, assertLocalInstallation: () => {} }, node: pin("node.exe", "controlled"),
    entry: pin("application-broker.mjs", "controlled"), configuration: pin("configuration.json", JSON.stringify({ version: 1, protocol: "artoo.application-broker.v1",
      databasePath: join(directory, "data.sqlite"), schemaJson: "{}", scope: { product_id: "p", data_generation: "d", service_generation: 1, artifact_digest: digest }, mode: "create", maximumAccess: "write" })),
    assertLocalAdmission: () => {} };
}
function begin() {
  const config = installation(), token = prepareApplicationBrokerProcess(config), owner = startApplicationBrokerProcess(token), helper = helpers.at(-1)!;
  helper.nodeImage = config.node.path; return { config, token, owner, helper };
}
async function poll(owner: ApplicationBrokerProcess) { return await owner.command({ kind: "poll" }); }
describe("original native broker owner control", () => {
  it("captures the original admission callback instead of a mutable caller property", () => {
    const config = installation(); let reject = false; const original = vi.fn(() => { if (reject) throw Error("original-admission"); });
    const mutable = { ...config, assertLocalAdmission: original as () => void }, prepared = prepareApplicationBrokerProcess(mutable);
    mutable.assertLocalAdmission = () => {}; reject = true;
    expect(() => startApplicationBrokerProcess(prepared)).toThrow("original-admission"); expect(mocked.spawn).not.toHaveBeenCalled();
  });
  it("rejects copied or reused original preparations", () => {
    const { owner, token, helper } = begin();
    expect(() => startApplicationBrokerProcess(structuredClone(token))).toThrow("unused");
    expect(() => startApplicationBrokerProcess(token)).toThrow("unused"); void owner.cancel(); void helper.finish();
  });
  it("never admits an unfinished async or thenable authority check", () => {
    for (const result of [Promise.resolve(), { then: (resolve: () => void) => resolve() }]) {
      const config = installation(); expect(() => prepareApplicationBrokerProcess({ ...config, assertLocalAdmission: () => result })).toThrow("synchronously");
    }
    expect(mocked.spawn).not.toHaveBeenCalled();
    const config = installation(); expect(() => prepareApplicationBrokerProcess({ ...config,
      native: { ...config.native, assertLocalInstallation: async () => {} } })).toThrow("synchronously");
  });
  it("accepts bounded target ready output before its native started frame", async () => {
    const { owner, helper } = begin(); helper.ready(true); await owner.ready;
    void owner.cancel(); helper.terminal(); await helper.finish(); expect((await owner.closed).normalShutdown).toBe(false);
  });
  it("does not equate enqueued ACK or a broker reply with actual stdin write completion", async () => {
    const { owner, helper } = begin(); helper.ready(); await owner.ready;
    const pending = poll(owner); await tick(); let done = false; void pending.then(() => { done = true; });
    helper.ack(); helper.result(); await tick(); expect(done).toBe(false);
    helper.written(); await pending; expect(done).toBe(true);
    void owner.cancel(); helper.terminal(); await helper.finish();
  });
  it("requires exact bytes and rejects mismatched write confirmation", async () => {
    const { owner, helper } = begin(); helper.ready(); await owner.ready;
    const pending = poll(owner); await tick(); helper.ack(); helper.written(helper.writes.at(-1)!, 1);
    await expect(pending).rejects.toThrow(); helper.terminal(); await helper.finish();
    expect((await owner.closed).normalShutdown).toBe(false);
  });
  it("rejects a second command instead of buffering it behind a held native write", async () => {
    const { owner, helper } = begin(); helper.ready(); await owner.ready;
    const pending = poll(owner); await tick(); await expect(poll(owner)).rejects.toThrow("unavailable");
    const cancelled = owner.cancel(); await expect(pending).rejects.toThrow(); helper.terminal(); await helper.finish();
    expect((await cancelled).failure).toBe("cancelled"); expect(helper.writes.filter(command => command.kind === "daemon-input")).toHaveLength(1);
  });
  it("retains a terminal after a rejected late ACK in the same native read", async () => {
    const { owner, helper } = begin(); helper.ready(); await owner.ready;
    const pending = poll(owner); await tick(); const cancelled = owner.cancel(); await expect(pending).rejects.toThrow();
    helper.batch = []; helper.ack({ kind: "daemon-input", nonce: "00000000-0000-4000-8000-000000000001" }); helper.terminal();
    helper.stdout.write(helper.batch.join("")); helper.batch = undefined;
    await helper.finish(); const receipt = await cancelled;
    expect(receipt.terminal?.facts?.lifetimeClosure.cleanupConfirmed).toBe(true); expect(receipt.normalShutdown).toBe(false);
  });
  it("suppresses a resolved reply when cancellation wins before asynchronous delivery", async () => {
    const { owner, helper } = begin(); helper.ready(); await owner.ready;
    const pending = poll(owner); await tick(); const command = helper.writes.at(-1)!;
    helper.result(); helper.ack(command); helper.written(command); const cancelled = owner.cancel();
    await expect(pending).rejects.toThrow(); helper.terminal(); await helper.finish();
    expect((await cancelled).normalShutdown).toBe(false);
  });
  it("accepts the bounded 33-frame reply admitted by a real multi-invocation batch", async () => {
    const { owner, helper } = begin(); helper.ready(); await owner.ready;
    const pending = poll(owner); await tick(); const command = helper.writes.at(-1)!;
    helper.ack(command); helper.written(command);
    helper.broker({ version: 1, sequence: 0, kind: "result", frames: Array.from({ length: 33 }, () => Buffer.from("controlled wire bytes").toString("base64")),
      responses: [], terminated: [], stopped: false });
    expect((await pending).frames).toHaveLength(33);
    void owner.cancel(); helper.terminal(); await helper.finish();
  });
  it("arms graceful stop before sending shutdown and requires original closure", async () => {
    const { owner, helper } = begin(); helper.ready(); await owner.ready;
    const stopped = owner.stop(); await tick(); expect(helper.writes.at(-1)?.kind).toBe("arm-graceful-stop");
    expect(helper.writes.filter(command => command.kind === "daemon-input")).toHaveLength(0);
    helper.ack(); await tick(); const command = helper.writes.at(-1)!;
    expect(JSON.parse(Buffer.from(command.data as string, "base64").toString()).kind).toBe("shutdown");
    helper.written(command); helper.ack(command); helper.result(0, true); helper.terminal(true);
    let done = false; void stopped.then(() => { done = true; }); await tick(); expect(done).toBe(false);
    await helper.finish(0); expect((await stopped).normalShutdown).toBe(true);
  });
  it("rejects duplicate native frame sequences without promoting copied terminal facts", async () => {
    const { owner, helper } = begin(); helper.ready(); await owner.ready;
    helper.sequence--; helper.send("daemon_input_written", { generation: 0, bytes: 10 });
    helper.terminal(); await helper.finish(); expect((await owner.closed).normalShutdown).toBe(false);
  });
});
