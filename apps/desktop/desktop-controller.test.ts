import { createRequire } from "node:module";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createConnectionStore, normalizeServerUrl } = require("./connection-store.cjs");
const { createDesktopController } = require("./desktop-controller.cjs");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temporary() { const root = await mkdtemp(join(tmpdir(), "artoo-desktop-controller-")); roots.push(root); return root; }
function encryption() {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true, encryptString(text: string) {
    const iv = randomBytes(16); const cipher = createCipheriv("aes-256-cbc", key, iv);
    return Buffer.concat([iv, cipher.update(text), cipher.final()]);
  }, decryptString(bytes: Buffer) {
    const decipher = createDecipheriv("aes-256-cbc", key, bytes.subarray(0, 16));
    return Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString();
  } };
}

describe("desktop secure connection and worker lifecycle", () => {
  it("persists only encrypted provider keys and rejects invalid edits without replacing saved settings", async () => {
    const root = await temporary(); const secure = encryption();
    const options = { directory: root, safeStorage: secure };
    const controller = createDesktopController(options);
    const base = { allowedRoots: [root], runtimes: ["codex"], trustedExecution: false };
    const codex = { mode: "responses", binaryPath: process.execPath, model: "test-model", baseUrl: "http://127.0.0.1:18181/v1", authMode: "api-key", apiKey: "provider-sentinel-secret" };
    await controller.configureDaemon({ ...base, codex });
    const status = await controller.daemonStatus();
    expect(status.config.codex).toEqual({ ...codex, apiKey: undefined, hasKey: true });
    expect(JSON.stringify(status)).not.toContain(codex.apiKey);
    const saved = await readFile(join(root, "connection.json"), "utf8");
    expect(saved).not.toContain(codex.apiKey);
    expect(JSON.parse(saved).daemon.codex).not.toHaveProperty("apiKey");
    const reopened = createDesktopController(options); await reopened.initialize();
    expect((await reopened.daemonStatus()).config.codex.hasKey).toBe(true);
    for (const patch of [{ binaryPath: "relative.exe" }, { binaryPath: join(root, "missing.exe") }, { baseUrl: "http://remote.example/v1" },
      { baseUrl: "https://user:provider-sentinel-secret@example.test/v1" }, { baseUrl: "https://example.test/v1?key=provider-sentinel-secret" }, { model: "" }]) {
      let error;
      try { await reopened.configureDaemon({ ...base, codex: { ...codex, ...patch } }); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(codex.apiKey);
      expect(await readFile(join(root, "connection.json"), "utf8")).toBe(saved);
    }
    await reopened.configureDaemon({ ...base, codex: { ...codex, apiKey: undefined, model: "other-model" } });
    expect((await reopened.daemonStatus()).config.codex.hasKey).toBe(true);
    await expect(reopened.configureDaemon({ ...base, codex: { ...codex, apiKey: undefined, baseUrl: "https://new.example/v1" } })).rejects.toThrow("Enter an API key");
    await reopened.configureDaemon({ ...base, codex: { ...codex, authMode: "none", apiKey: undefined } });
    expect((await reopened.daemonStatus()).config.codex.hasKey).toBe(false);
    expect(JSON.parse(await readFile(join(root, "connection.json"), "utf8")).encryptedCodexApiKey).toBeNull();
    await reopened.configureDaemon({ ...base, codex });
    await reopened.configureDaemon({ ...base, codex: { mode: "default" } });
    expect((await reopened.daemonStatus()).config.codex).toEqual({ mode: "default", authMode: "none", hasKey: false });
  });

  it.each(["logout", "server"])("clears provider credentials on %s while retaining non-secret connection metadata", async (action) => {
    const root = await temporary(); const secure = encryption();
    const controller = createDesktopController({ directory: root, safeStorage: secure, fetch: async () => new Response("{}") });
    await controller.configureDaemon({ allowedRoots: [root], runtimes: ["codex"], trustedExecution: false,
      codex: { mode: "responses", model: "test-model", baseUrl: "https://example.test/v1", authMode: "api-key", apiKey: "clear-me" } });
    if (action === "logout") await controller.logout(); else await controller.configureServer("https://other.example");
    const reopened = createDesktopController({ directory: root, safeStorage: secure }); await reopened.initialize();
    expect((await reopened.daemonStatus()).config.codex).toMatchObject({ model: "test-model", hasKey: false });
    expect(JSON.parse(await readFile(join(root, "connection.json"), "utf8")).encryptedCodexApiKey).toBeNull();
  });

  it("fails closed when OS encryption is unavailable without overwriting the prior worker configuration", async () => {
    const root = await temporary(); const secure = encryption();
    const controller = createDesktopController({ directory: root, safeStorage: secure });
    const base = { allowedRoots: [root], runtimes: ["codex"], trustedExecution: false };
    await controller.configureDaemon(base);
    const before = await readFile(join(root, "connection.json"), "utf8");
    secure.isEncryptionAvailable = () => false;
    await expect(controller.configureDaemon({ ...base, codex: { mode: "responses", model: "test", baseUrl: "https://example.test/v1", authMode: "api-key", apiKey: "never-store-plaintext" } })).rejects.toThrow("secure credential storage");
    expect(await readFile(join(root, "connection.json"), "utf8")).toBe(before);
  });

  it("launches saved provider settings through worker env and removes inherited settings when switched off", async () => {
    const root = await temporary(); const entry = join(root, "daemon.mjs"); await writeFile(entry, "");
    const secure = encryption(); const store = createConnectionStore(root, secure);
    await store.pair("d", "control", "node"); await store.setComputer("c");
    const spawned: any[] = [];
    const options = { directory: root, safeStorage: secure, executable: "electron", daemonEntry: entry,
      fetch: async () => new Response("{}"), spawn: (_exe: string, args: string[], config: any) => {
        const child: any = Object.assign(new EventEmitter(), { connected: true, pid: 1, send: () => queueMicrotask(() => child.emit("exit", 0)) });
        spawned.push({ args, config }); return child;
      } };
    const base = { allowedRoots: [root], runtimes: ["codex"], trustedExecution: false };
    const controller = createDesktopController(options); await controller.initialize();
    const codex = { mode: "responses", binaryPath: process.execPath, model: "test-model", baseUrl: "http://127.0.0.1:18181/v1", authMode: "api-key", apiKey: "local-only-key" };
    await controller.configureDaemon({ ...base, codex });
    const reopened = createDesktopController(options); await reopened.initialize();
    vi.stubEnv("ARTOO_CODEX_PROVIDER_KEY", "inherited-key");
    vi.stubEnv("ARTOO_CODEX_PROVIDER_URL", "https://unwanted.example/v1");
    vi.stubEnv("ARTOO_CODEX_MODEL", "unwanted-model");
    try {
      await reopened.startDaemon(); await reopened.stopDaemon();
      expect(spawned[0].config.env).toMatchObject({ ARTOO_CODEX_BINARY: process.execPath, ARTOO_CODEX_MODEL: "test-model", ARTOO_CODEX_PROVIDER_URL: codex.baseUrl, ARTOO_CODEX_PROVIDER_KEY: "local-only-key" });
      expect(JSON.stringify(spawned[0].args)).not.toContain("local-only-key");
      await reopened.configureDaemon({ ...base, codex: { ...codex, authMode: "none", apiKey: undefined } });
      await reopened.startDaemon(); await reopened.stopDaemon();
      expect(spawned[1].config.env.ARTOO_CODEX_PROVIDER_KEY).toBeUndefined();
      expect(spawned[1].config.env.ARTOO_CODEX_PROVIDER_URL).toBe(codex.baseUrl);
      await reopened.configureDaemon(base);
      await reopened.startDaemon(); await reopened.stopDaemon();
      for (const name of ["BINARY", "MODEL", "PROVIDER_URL", "PROVIDER_KEY"]) expect(spawned[2].config.env[`ARTOO_CODEX_${name}`]).toBeUndefined();
    } finally { vi.unstubAllEnvs(); await reopened.stopDaemon(); }
  });

  it("stores encrypted tokens, restores configuration, and clears credentials on server change", async () => {
    const root = await temporary(); const secure = encryption();
    const store = createConnectionStore(root, secure);
    await store.pair("device", "control-secret", "node-secret");
    await store.setComputer("computer");
    const disk = await readFile(join(root, "connection.json"), "utf8");
    expect(disk).not.toContain("control-secret"); expect(disk).not.toContain("node-secret");
    const reopened = createConnectionStore(root, secure); await reopened.load();
    expect(reopened.credentials()).toEqual({ controlToken: "control-secret", nodeToken: "node-secret" });
    expect(reopened.connection()).toMatchObject({ paired: true, computerId: "computer" });
    await reopened.configureServer("https://team.example.com/");
    expect(reopened.connection()).toMatchObject({ paired: false, deviceId: null, computerId: null });
    expect(reopened.credentials()).toBeNull();
    for (const url of ["http://team.example.com", "https://user:secret@team.example.com", "https://team.example.com/path", "file:///C:/app", "https://team.example.com?token=x"]) expect(() => normalizeServerUrl(url)).toThrow();
  });
  it("refuses insecure storage before consuming a pairing code", async () => {
    const request = vi.fn();
    const controller = createDesktopController({ directory: await temporary(), safeStorage: { isEncryptionAvailable: () => false }, fetch: request });
    await expect(controller.pairDevice({ code: "unused", displayName: "Windows" })).rejects.toThrow("secure credential");
    expect(request).not.toHaveBeenCalled();
  });
  it("serializes double start, enrolls with bearer, waits for shutdown acknowledgement and restores pairing", async () => {
    const root = await temporary(); const entry = join(root, "daemon.mjs"); await writeFile(entry, "");
    const secure = encryption();
    const requests: { route: string; authorization?: string }[] = [];
    const request = vi.fn(async (url: string, options: { headers: { Authorization?: string } }) => {
      const route = new URL(url).pathname; requests.push({ route, authorization: options.headers.Authorization });
      const body = route.endsWith("/claim") ? { device: { id: "d" }, control_token: "control", node_token: "node" } :
        route.endsWith("/enroll") ? { computer_id: "c" } : route === "/auth/session" ? { user: { role: "owner" } } : route.endsWith("/runtimes") ? { runtimes: [{ last_seen_at: new Date().toISOString(), status: "available" }] } : {};
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const spawned: any[] = [];
    const spawn = vi.fn((_executable, args, options) => {
      const child = Object.assign(new EventEmitter(), { connected: true, pid: 42, send: vi.fn(), kill: vi.fn() });
      spawned.push({ child, args, options }); return child;
    });
    const controller = createDesktopController({ directory: root, safeStorage: secure, fetch: request, spawn, executable: "electron", daemonEntry: entry, version: "test" });
    await controller.pairDevice({ code: "one-use", displayName: "Windows" });
    await controller.configureDaemon({ allowedRoots: [root], runtimes: ["codex"], trustedExecution: false });
    await Promise.all([controller.startDaemon(), controller.startDaemon()]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawned[0].args).toEqual([entry]);
    expect(spawned[0].options.env.ARTOO_TRUSTED_EXECUTION).toBe("0");
    expect(spawned[0].options.env.ARTOO_NODE_URL).toContain("token=node");
    expect(requests.find((r) => r.route.endsWith("/claim"))?.authorization).toBeUndefined();
    expect(requests.find((r) => r.route.endsWith("/enroll"))?.authorization).toBe("Bearer control");
    const stop = controller.stopDaemon();
    await vi.waitFor(() => expect(spawned[0].child.send).toHaveBeenCalledWith({ type: "shutdown" }));
    expect((await controller.daemonStatus()).state).toBe("stopping");
    spawned[0].child.emit("exit", 0); await stop;
    expect((await controller.daemonStatus()).state).toBe("stopped");
    const reopened = createDesktopController({ directory: root, safeStorage: secure, fetch: request }); await reopened.initialize();
    expect(reopened.getConnection()).toMatchObject({ paired: true, computerId: "c" });
    await reopened.logout(); expect(reopened.getToken()).toBeNull();
  });

  it("pairs members for control access and starts execution only after an administrator enrolls their device", async () => {
    const root = await temporary(); const entry = join(root, "daemon.mjs"); await writeFile(entry, "");
    const secure = encryption();
    let enrolled = false;
    const request = vi.fn(async (url: string) => {
      const route = new URL(url).pathname;
      const body = route.endsWith("/claim") ? { device: { id: "member-device" }, control_token: "member-control", node_token: "member-node" } :
        route === "/auth/session" ? { user: { role: "member" } } :
        route === "/api/v1/devices" ? { devices: [{ id: "other-device", computer_id: "other-computer" }, { id: "member-device", computer_id: enrolled ? "member-computer" : null }] } : {};
      return new Response(JSON.stringify(body));
    });
    const spawn = vi.fn(() => {
      const child: any = Object.assign(new EventEmitter(), { connected: true, pid: 10, send: () => queueMicrotask(() => child.emit("exit", 0)) });
      return child;
    });
    const controller = createDesktopController({ directory: root, safeStorage: secure, fetch: request, spawn, executable: "electron", daemonEntry: entry });
    await expect(controller.pairDevice({ code: "member-code", displayName: "Member Mac" })).resolves.toMatchObject({ paired: true, computerId: null });
    expect(controller.getToken()).toBe("member-control");
    await controller.configureDaemon({ allowedRoots: [root], runtimes: ["codex"], trustedExecution: false });
    await expect(controller.startDaemon()).rejects.toThrow("Ask an owner or admin to enroll");
    expect(spawn).not.toHaveBeenCalled();
    expect(controller.getConnection()).toMatchObject({ paired: true, computerId: null });
    enrolled = true;
    await controller.startDaemon();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(controller.getConnection().computerId).toBe("member-computer");
    expect(request.mock.calls.some(([url]) => url.endsWith("/enroll"))).toBe(false);
    await controller.stopDaemon();
    const reopened = createDesktopController({ directory: root, safeStorage: secure }); await reopened.initialize();
    expect(reopened.getConnection()).toMatchObject({ paired: true, computerId: "member-computer" });
  });

  it("does not let an automatic restart outlive logout or race a second writer", async () => {
    const root = await temporary(); const entry = join(root, "daemon.mjs"); await writeFile(entry, "");
    const secure = encryption(); const store = createConnectionStore(root, secure);
    await store.pair("d", "control", "node"); await store.setComputer("c");
    let blockSession = false; let entered = false; let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const request = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/session") && blockSession) { entered = true; await gate; }
      return new Response("{}", { status: 200 });
    });
    const children: any[] = [];
    const spawn = vi.fn(() => {
      const child: any = Object.assign(new EventEmitter(), { connected: true, pid: 1,
        send: () => queueMicrotask(() => child.emit("exit", 0)), kill: vi.fn() });
      children.push(child); return child;
    });
    const controller = createDesktopController({ directory: root, safeStorage: secure, fetch: request, spawn, executable: "electron", daemonEntry: entry });
    await controller.initialize();
    await controller.configureDaemon({ allowedRoots: [root], runtimes: ["codex"], trustedExecution: false });
    await controller.startDaemon(); blockSession = true; children[0].emit("exit", 1);
    await vi.waitFor(() => expect(entered).toBe(true), { timeout: 3000 });
    let signedOut = false;
    const logout = controller.logout().then(() => { signedOut = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(signedOut).toBe(false);
    release(); await logout;
    expect(controller.getConnection().paired).toBe(false);
    expect((await controller.daemonStatus()).state).toBe("stopped");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it.each([
    { action: "stop", fail: false, expected: "stopped" },
    { action: "restart", fail: false, expected: "starting" },
    { action: "restart", fail: true, expected: "running" },
  ])("ignores a delayed health response after $action (failure=$fail)", async ({ action, fail, expected }) => {
    const root = await temporary(); const entry = join(root, "daemon.mjs"); await writeFile(entry, "");
    const secure = encryption(); const store = createConnectionStore(root, secure);
    await store.pair("d", "control", "node"); await store.setComputer("c");
    let complete!: (response: Response) => void; let reject!: (error: Error) => void;
    let deferHealth = true;
    const health = () => new Response(JSON.stringify({ runtimes: [{ last_seen_at: new Date().toISOString() }] }));
    const request = async (url: string) => {
      if (url.endsWith("/runtimes")) {
        if (deferHealth) { deferHealth = false; return new Promise<Response>((resolve, failRequest) => { complete = resolve; reject = failRequest; }); }
        return health();
      }
      return new Response("{}");
    };
    let nextPid = 1;
    const spawn = () => {
      const worker: any = Object.assign(new EventEmitter(), { connected: true, pid: nextPid++,
        send: () => queueMicrotask(() => worker.emit("exit", 0)), kill: vi.fn() });
      return worker;
    };
    const controller = createDesktopController({ directory: root, safeStorage: secure, fetch: request, spawn, executable: "electron", daemonEntry: entry });
    await controller.initialize();
    await controller.configureDaemon({ allowedRoots: [root], runtimes: ["codex"], trustedExecution: false });
    await controller.startDaemon();
    const delayedStatus = controller.daemonStatus();
    if (action === "stop") await controller.stopDaemon();
    else {
      await controller.restartDaemon();
      if (fail) expect((await controller.daemonStatus()).state).toBe("running");
    }
    if (fail) reject(new Error("Old health request failed")); else complete(health());
    const status = await delayedStatus;
    expect(status.state).toBe(expected);
    expect(status.pid).toBe(action === "stop" ? undefined : 2);
    await controller.stopDaemon();
  });
});
