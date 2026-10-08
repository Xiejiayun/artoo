import { createRequire } from "node:module";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createConnectionStore } = require("./connection-store.cjs");
const { createManagedProfileStore } = require("./managed-profile-store.cjs");
const { createDesktopController } = require("./desktop-controller.cjs");
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function encryption() {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true, encryptString(text: string) {
    const iv = randomBytes(16), cipher = createCipheriv("aes-256-cbc", key, iv);
    return Buffer.concat([iv, cipher.update(text), cipher.final()]);
  }, decryptString(bytes: Buffer) {
    const decipher = createDecipheriv("aes-256-cbc", key, bytes.subarray(0, 16));
    return Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString();
  } };
}
async function fixture(platform = "darwin") {
  const temporary = await mkdtemp(join(tmpdir(), "artoo-managed-controller-")); roots.push(temporary);
  const root = await realpath(temporary), entry = join(root, "daemon.mjs"); await writeFile(entry, "");
  const secure = encryption(), connection = createConnectionStore(root, secure, "https://team.example");
  await connection.pair("device", "control-fixture-token", "node-fixture-token"); await connection.setComputer("computer");
  const spawned: { child: any; args: string[]; options: any }[] = [];
  const health = { body: undefined as unknown, pending: undefined as Promise<Response> | undefined };
  const request = vi.fn(async (url: string) => {
    if (url.endsWith("/runtimes")) return health.pending ?? new Response(JSON.stringify(health.body ?? { runtimes: [{
      computer_id: "computer", runtime: "codex", last_seen_at: new Date().toISOString(), status: "available",
    }] }));
    return new Response(JSON.stringify({ user: { role: "owner" } }));
  });
  const spawn = vi.fn((_executable: string, args: string[], options: any) => {
    const child = Object.assign(new EventEmitter(), { connected: true, pid: 100 + spawned.length,
      send: vi.fn((_message: unknown, callback?: (error?: Error) => void) => callback?.()), kill: vi.fn() });
    spawned.push({ child, args, options }); return child;
  });
  const options = { directory: root, safeStorage: secure, fetch: request, spawn, executable: "electron", daemonEntry: entry, platform };
  const controller = createDesktopController(options); await controller.initialize();
  const config = { allowedRoots: [root], runtimes: ["codex"], trustedExecution: false };
  await controller.configureDaemon(config);
  return { root, entry, controller, connection, options, spawned, spawn, request, health, config };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function beginPreparation(f: Fixture) {
  const count = f.spawned.length;
  const result = f.controller.prepareManagedWorkspace();
  const outcome = result.then(() => ({ ok: true }), (error: Error) => ({ error }));
  await vi.waitFor(() => expect(f.spawned).toHaveLength(count + 1));
  return { attempt: f.spawned[count]!, outcome };
}
function provisionReply(attempt: Fixture["spawned"][number], namespace = randomUUID()) {
  attempt.child.emit("message", { type: "journal.provisioned", requestId: attempt.options.env.ARTOO_JOURNAL_REQUEST_ID, namespace });
  return namespace;
}
function close(attempt: Fixture["spawned"][number], code = 0) {
  attempt.child.emit("exit", code, null); attempt.child.emit("close", code, null);
}
async function prepare(f: Fixture) {
  const preparation = await beginPreparation(f); const namespace = provisionReply(preparation.attempt);
  close(preparation.attempt); expect(await preparation.outcome).toEqual({ ok: true });
  return { ...preparation.attempt, namespace };
}
function stopped(attempt: Fixture["spawned"][number]) {
  attempt.child.emit("message", { type: "worker.stopped", launchId: attempt.options.env.ARTOO_WORKER_LAUNCH_ID });
  close(attempt);
}
async function stop(f: Fixture) {
  const attempt = f.spawned.at(-1)!; const result = f.controller.stopDaemon();
  await vi.waitFor(() => expect(attempt.child.send).toHaveBeenCalled());
  stopped(attempt); await result;
}

// Mock child lifecycles qualify the controller's decisions, not a journal,
// installed Electron, physical producer, or native client E2E.
describe.skipIf(process.platform === "win32")("desktop prepared worker lifecycle", () => {
  it("persists intent before one credential-free provisioner and waits for reply, exit and close", async () => {
    const f = await fixture();
    vi.stubEnv("OPENAI_API_KEY", "inherited-provider-secret"); vi.stubEnv("ARTOO_NODE_URL", "wss://wrong.example?token=inherited-node-secret");
    vi.stubEnv("ARTOO_CODEX_PROVIDER_KEY", "inherited-codex-secret"); vi.stubEnv("ARTOO_JOURNAL_NAMESPACE", randomUUID());
    const { attempt, outcome } = await beginPreparation(f);
    expect(attempt.args).toEqual([f.entry, "--provision-managed-journal"]);
    const env = attempt.options.env;
    for (const key of ["OPENAI_API_KEY", "ARTOO_NODE_URL", "ARTOO_CODEX_PROVIDER_KEY", "ARTOO_JOURNAL_NAMESPACE", "ARTOO_NODE_ID"]) expect(env[key]).toBeUndefined();
    expect(JSON.stringify(env)).not.toMatch(/control-fixture-token|node-fixture-token|inherited-.*secret/);
    const intent = JSON.parse(await readFile(join(dirname(env.ARTOO_JOURNAL_DIRECTORY), "profile.json"), "utf8"));
    expect(intent).toMatchObject({ status: "incomplete", requestId: env.ARTOO_JOURNAL_REQUEST_ID, controllerScope: env.ARTOO_JOURNAL_CONTROLLER_SCOPE });
    const repeated = f.controller.prepareManagedWorkspace();
    const namespace = provisionReply(attempt);
    attempt.child.emit("exit", 0, null);
    expect(await f.controller.daemonStatus()).toMatchObject({ state: "preparing", configurationLocked: true, managedWorkspace: { state: "preparing" } });
    expect(intent.status).toBe("incomplete");
    attempt.child.emit("close", 0, null);
    expect(await outcome).toEqual({ ok: true }); await repeated;
    expect(f.spawn).toHaveBeenCalledTimes(1);
    const status = await f.controller.daemonStatus();
    expect(status).toMatchObject({ state: "stopped", configurationLocked: false, managedWorkspace: { state: "ready" }, config: { allowNewAllocations: false } });
    expect(JSON.stringify(status)).not.toContain(namespace);
    expect(JSON.stringify(status)).not.toContain(env.ARTOO_JOURNAL_DIRECTORY);
  });

  it.each(["wrong-request", "missing-reply", "nonzero-exit"])("retains incomplete preparation after %s", async (fault) => {
    const f = await fixture(); const { attempt, outcome } = await beginPreparation(f);
    if (fault === "wrong-request") attempt.child.emit("message", { type: "journal.provisioned", requestId: randomUUID(), namespace: randomUUID() });
    if (fault === "nonzero-exit") provisionReply(attempt);
    close(attempt, fault === "nonzero-exit" ? 1 : 0);
    expect(await outcome).toHaveProperty("error");
    expect((await f.controller.daemonStatus()).managedWorkspace.state).toBe("incomplete");
    await f.controller.stopDaemon();
    await expect(f.controller.prepareManagedWorkspace()).rejects.toThrow("incomplete");
    await expect(f.controller.startDaemon()).rejects.toThrow("incomplete");
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it("never enables an abandoned preparation from a late matching reply", async () => {
    const f = await fixture(); const { attempt, outcome } = await beginPreparation(f);
    attempt.child.emit("error", new Error("Provisioner IPC failed"));
    expect(await outcome).toHaveProperty("error");
    expect(await f.controller.daemonStatus()).toMatchObject({ state: "stopping", pid: attempt.child.pid, configurationLocked: true });
    provisionReply(attempt); close(attempt);
    expect((await f.controller.daemonStatus()).managedWorkspace.state).toBe("incomplete");
    const record = JSON.parse(await readFile(join(dirname(attempt.options.env.ARTOO_JOURNAL_DIRECTORY), "profile.json"), "utf8"));
    expect(record.status).toBe("incomplete"); expect(record).not.toHaveProperty("expectedNamespace");
  });

  it("retains the durable intent if process creation throws before a child exists", async () => {
    const f = await fixture();
    const spawn = vi.fn(() => { throw new Error("Cannot create provisioner"); });
    const controller = createDesktopController({ ...f.options, spawn }); await controller.initialize();
    await expect(controller.prepareManagedWorkspace()).rejects.toThrow("Cannot create provisioner");
    expect(await controller.daemonStatus()).toMatchObject({ state: "failed", managedWorkspace: { state: "incomplete" } });
    await controller.stopDaemon();
    await expect(controller.prepareManagedWorkspace()).rejects.toThrow("incomplete");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("reopens the same binding and keeps it supplied when new allocations are disabled", async () => {
    const f = await fixture(); const provision = await prepare(f);
    const repository = await realpath(new URL("../../", import.meta.url));
    const reopened = createDesktopController(f.options); await reopened.initialize();
    await reopened.prepareManagedWorkspace(); expect(f.spawn).toHaveBeenCalledTimes(1);
    f.controller = reopened;
    for (const enabled of [false, true, false]) {
      await reopened.configureDaemon({ ...f.config, allowNewAllocations: enabled, ...(enabled ? { worktreeBaseRepo: repository } : {}) });
      await reopened.startDaemon(); const worker = f.spawned.at(-1)!;
      expect(worker.args).toEqual([f.entry, "--prepared-journal"]);
      expect(worker.options.env).toMatchObject({ ARTOO_MANAGED_EXECUTION: enabled ? "1" : "0", ARTOO_JOURNAL_VERSION: "1",
        ARTOO_JOURNAL_SERVER_ORIGIN: "https://team.example", ARTOO_JOURNAL_NODE_ID: "computer",
        ARTOO_JOURNAL_DIRECTORY: provision.options.env.ARTOO_JOURNAL_DIRECTORY,
        ARTOO_JOURNAL_CONTROLLER_SCOPE: provision.options.env.ARTOO_JOURNAL_CONTROLLER_SCOPE, ARTOO_JOURNAL_NAMESPACE: provision.namespace });
      expect(worker.options.env.ARTOO_WORKTREE_BASE_REPO).toBe(enabled ? repository : "");
      await expect(reopened.prepareManagedWorkspace()).rejects.toThrow("Stop the worker");
      await stop(f);
    }
    expect(new Set(f.spawned.slice(1).map((attempt) => attempt.options.env.ARTOO_WORKER_LAUNCH_ID)).size).toBe(3);
  });

  it("requires a valid repository only when enabling new allocations and preserves rejected settings", async () => {
    const f = await fixture(); const provision = await prepare(f);
    const before = await readFile(join(f.root, "connection.json"), "utf8");
    await expect(f.controller.configureDaemon({ ...f.config, allowNewAllocations: true })).rejects.toThrow("Choose a Git repository");
    expect(await readFile(join(f.root, "connection.json"), "utf8")).toBe(before);
    await expect(f.controller.configureDaemon({ ...f.config, allowNewAllocations: true, worktreeBaseRepo: f.root })).rejects.toThrow();
    expect(await readFile(join(f.root, "connection.json"), "utf8")).toBe(before);
    expect((await f.controller.daemonStatus()).config).toMatchObject({ allowNewAllocations: false });
    await f.controller.startDaemon(); const worker = f.spawned.at(-1)!;
    expect(worker.options.env).toMatchObject({ ARTOO_MANAGED_EXECUTION: "0", ARTOO_WORKTREE_BASE_REPO: "",
      ARTOO_JOURNAL_DIRECTORY: provision.options.env.ARTOO_JOURNAL_DIRECTORY, ARTOO_JOURNAL_NAMESPACE: provision.namespace });
    await stop(f);
  });

  it("requires current ready IPC and a fresh heartbeat matching computer and runtime", async () => {
    const f = await fixture(); await prepare(f); await f.controller.startDaemon(); const worker = f.spawned.at(-1)!;
    expect((await f.controller.daemonStatus()).state).toBe("starting");
    worker.child.emit("message", { type: "worker.ready", launchId: randomUUID() });
    expect((await f.controller.daemonStatus()).state).toBe("starting");
    worker.child.emit("message", { type: "worker.ready", launchId: worker.options.env.ARTOO_WORKER_LAUNCH_ID });
    expect((await f.controller.daemonStatus()).state).toBe("running");
    for (const patch of [{ computer_id: "another" }, { runtime: "another" }, { last_seen_at: new Date(Date.now() - 60_000).toISOString() }]) {
      f.health.body = { runtimes: [{ computer_id: "computer", runtime: "codex", last_seen_at: new Date().toISOString(), ...patch }] };
      expect((await f.controller.daemonStatus()).state).toBe("unhealthy");
    }
    f.health.body = undefined; expect((await f.controller.daemonStatus()).state).toBe("running");
    await stop(f); await f.controller.startDaemon();
    worker.child.emit("message", { type: "worker.ready", launchId: worker.options.env.ARTOO_WORKER_LAUNCH_ID });
    expect((await f.controller.daemonStatus()).state).toBe("starting");
    await stop(f);
  });

  it("does not accept an unmatched stopped reply or repair that result with a second Stop", async () => {
    const f = await fixture(); await prepare(f); await f.controller.startDaemon(); const worker = f.spawned.at(-1)!;
    const result = f.controller.stopDaemon(); const rejected = expect(result).rejects.toThrow("without confirming cleanup");
    await vi.waitFor(() => expect(worker.child.send).toHaveBeenCalledWith({ type: "shutdown", launchId: worker.options.env.ARTOO_WORKER_LAUNCH_ID }, expect.any(Function)));
    worker.child.emit("message", { type: "worker.stopped", launchId: randomUUID() }); close(worker); await rejected;
    expect(await f.controller.daemonStatus()).toMatchObject({ state: "failed", configurationLocked: true });
    await expect(f.controller.stopDaemon()).rejects.toThrow("without confirming cleanup");
    await expect(f.controller.configureDaemon(f.config)).rejects.toThrow("Stop the worker");
  });

  it.each([false, true])("never reports a nonzero requested Stop as stopped (prepared=%s)", async (prepared) => {
    const f = await fixture(); if (prepared) await prepare(f);
    await f.controller.startDaemon(); const worker = f.spawned.at(-1)!;
    const result = f.controller.stopDaemon(); const rejected = expect(result).rejects.toThrow("exit code 1");
    await vi.waitFor(() => expect(worker.child.send).toHaveBeenCalled());
    worker.child.emit("message", { type: "worker.stopped", launchId: worker.options.env.ARTOO_WORKER_LAUNCH_ID }); close(worker, 1);
    await rejected;
    expect((await f.controller.daemonStatus()).state).toBe("failed");
    await expect(f.controller.stopDaemon()).rejects.toThrow("exit code 1");
  });

  it("retains a living child after IPC error and blocks another writer or configuration", async () => {
    const f = await fixture(); await prepare(f); await f.controller.startDaemon(); const worker = f.spawned.at(-1)!;
    worker.child.emit("error", new Error("IPC is unavailable"));
    expect(await f.controller.daemonStatus()).toMatchObject({ state: "failed", pid: worker.child.pid, configurationLocked: true });
    await expect(f.controller.configureDaemon(f.config)).rejects.toThrow("Stop the worker");
    await f.controller.startDaemon(); expect(f.spawn).toHaveBeenCalledTimes(2);
    await expect(f.controller.stopDaemon()).rejects.toThrow("IPC is unavailable");
    expect((await f.controller.daemonStatus()).pid).toBe(worker.child.pid);
    stopped(worker);
    expect(await f.controller.daemonStatus()).toMatchObject({ state: "stopped", configurationLocked: false });
  });

  it("rejects shutdown IPC failure but accepts later exact cleanup proof after exit and close", async () => {
    const f = await fixture(); await prepare(f); await f.controller.startDaemon(); const worker = f.spawned.at(-1)!;
    worker.child.send.mockImplementation((_message: unknown, callback: (error?: Error) => void) => callback(new Error("Shutdown IPC failed")));
    await expect(f.controller.stopDaemon()).rejects.toThrow("Shutdown IPC failed");
    expect(await f.controller.daemonStatus()).toMatchObject({ state: "stopping", pid: worker.child.pid, configurationLocked: true });
    await expect(f.controller.stopDaemon()).rejects.toThrow("Shutdown IPC failed");
    expect((await f.controller.daemonStatus()).configurationLocked).toBe(true);
    worker.child.emit("message", { type: "worker.stopped", launchId: worker.options.env.ARTOO_WORKER_LAUNCH_ID });
    worker.child.emit("exit", 0, null);
    expect(await f.controller.daemonStatus()).toMatchObject({ state: "stopping", pid: worker.child.pid, configurationLocked: true });
    worker.child.emit("close", 0, null);
    expect(await f.controller.daemonStatus()).toMatchObject({ state: "stopped", configurationLocked: false });
    await f.controller.stopDaemon();
  });

  it("retains the child and stopping state at 12 seconds, then accepts its later confirmed closure", async () => {
    const f = await fixture(); await prepare(f); await f.controller.startDaemon(); const worker = f.spawned.at(-1)!;
    vi.useFakeTimers();
    const result = f.controller.stopDaemon(); const rejected = expect(result).rejects.toThrow("did not stop in time");
    await vi.waitFor(() => expect(worker.child.send).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(12_000); await rejected;
    expect(await f.controller.daemonStatus()).toMatchObject({ state: "stopping", pid: worker.child.pid, configurationLocked: true });
    await expect(f.controller.configureDaemon(f.config)).rejects.toThrow("Stop the worker");
    await f.controller.startDaemon(); expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(worker.child.kill).not.toHaveBeenCalled();
    stopped(worker);
    expect(await f.controller.daemonStatus()).toMatchObject({ state: "stopped", configurationLocked: false });
    await f.controller.stopDaemon();
  });

  it("ignores a health result that arrives after the observed prepared worker stops", async () => {
    const f = await fixture(); await prepare(f); await f.controller.startDaemon(); const worker = f.spawned.at(-1)!;
    worker.child.emit("message", { type: "worker.ready", launchId: worker.options.env.ARTOO_WORKER_LAUNCH_ID });
    let resolve!: (response: Response) => void;
    f.health.pending = new Promise<Response>((complete) => { resolve = complete; });
    const delayed = f.controller.daemonStatus();
    await stop(f);
    resolve(new Response(JSON.stringify({ runtimes: [{ computer_id: "computer", runtime: "codex", last_seen_at: new Date().toISOString() }] })));
    expect((await delayed).state).toBe("stopped");
  });

  it("clears every inherited managed override for an ordinary unprepared launch", async () => {
    const f = await fixture();
    for (const key of ["ARTOO_MANAGED_EXECUTION", "ARTOO_JOURNAL_VERSION", "ARTOO_JOURNAL_SERVER_ORIGIN", "ARTOO_JOURNAL_NODE_ID", "ARTOO_JOURNAL_DIRECTORY", "ARTOO_JOURNAL_NAMESPACE", "ARTOO_JOURNAL_CONTROLLER_SCOPE", "ARTOO_JOURNAL_REQUEST_ID", "ARTOO_JOURNAL_UNRECOGNIZED", "ARTOO_WORKER_LAUNCH_ID"]) vi.stubEnv(key, "inherited-value");
    await f.controller.startDaemon(); const worker = f.spawned.at(-1)!;
    expect(worker.args).toEqual([f.entry]);
    expect(Object.keys(worker.options.env).filter((key) => /^ARTOO_(MANAGED_|JOURNAL_)/.test(key))).toEqual([]);
    expect(worker.options.env.ARTOO_WORKER_LAUNCH_ID).not.toBe("inherited-value");
    await stop(f);
  });

  it("does not reuse a prepared binding for a different server origin", async () => {
    const f = await fixture(); await prepare(f);
    await f.controller.configureServer("https://other.example");
    expect((await f.controller.daemonStatus()).managedWorkspace.state).toBe("unprepared");
    const oldProfile = createManagedProfileStore(f.root, { platform: "darwin" });
    expect((await oldProfile.inspect({ serverOrigin: "https://team.example", nodeId: "computer" })).state).toBe("ready");
  });
});

it("keeps managed preparation and enabling unavailable on Windows", async () => {
  const f = await fixture("win32");
  await expect(f.controller.prepareManagedWorkspace()).rejects.toThrow("only on macOS");
  await expect(f.controller.configureDaemon({ ...f.config, allowNewAllocations: true })).rejects.toThrow("Prepare");
  expect(f.spawn).not.toHaveBeenCalled();
  expect((await f.controller.daemonStatus()).managedWorkspace.state).toBe("unsupported");
});
