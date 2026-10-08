import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createManagedProfileStore } = require("./managed-profile-store.cjs");
const { createConnectionStore } = require("./connection-store.cjs");
const { atomicWriteJson } = require("./atomic-store.cjs");
const roots: string[] = [];
const identity = { serverOrigin: "https://team.example", nodeId: "enrolled-node" };
const options = { platform: "darwin" };
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function temporary() {
  const directory = await fs.mkdtemp(join(tmpdir(), "artoo-managed-profile-"));
  roots.push(directory);
  return fs.realpath(directory);
}
function failure(code = "EIO") { return Object.assign(new Error(`injected ${code}`), { code }); }

type FailureStage = "write" | "file-sync" | "rename" | "parent-sync" | "read-sync" | undefined;
function instrumentedFilesystem() {
  const control: { failAt: FailureStage; renamed: boolean; events: string[] } = { failAt: undefined, renamed: false, events: [] };
  const filesystem = {
    ...fs,
    async open(filename: string, flags: string | number, mode?: number) {
      const handle = await fs.open(filename, flags, mode);
      const temporary = filename.endsWith(".tmp");
      const record = basename(filename) === "profile.json";
      const directory = (await handle.stat()).isDirectory();
      return new Proxy(handle, {
        get(target, property) {
          if (property === "writeFile") return async (...args: Parameters<typeof handle.writeFile>) => {
            if (temporary) {
              control.events.push("write");
              if (control.failAt === "write") throw failure();
            }
            return handle.writeFile(...args);
          };
          if (property === "sync") return async () => {
            if (temporary) {
              control.events.push("file-sync");
              if (control.failAt === "file-sync") throw failure();
            } else if (directory && control.renamed) {
              control.events.push("parent-sync");
              if (control.failAt === "parent-sync") throw failure();
            } else if (record && control.failAt === "read-sync") throw failure();
            return handle.sync();
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    async rename(from: string, to: string) {
      control.events.push("rename");
      if (control.failAt === "rename") throw failure();
      await fs.rename(from, to);
      control.renamed = true;
    },
  };
  return { control, filesystem };
}

// These test file persistence only. A simulated platform does not qualify a
// journal or a physical producer on Linux; those have separate real Mac gates.
describe.skipIf(process.platform === "win32")("private prepared managed profiles", () => {
  it("reuses the exact completed same-origin/node binding and leaves the journal leaf for its provisioner", async () => {
    const root = await temporary();
    const store = createManagedProfileStore(root, options);
    expect(await store.inspect(identity)).toEqual({ state: "unprepared" });
    const prepared = await store.beginPreparation(identity);
    expect(prepared.kind).toBe("prepare");
    await expect(fs.stat(prepared.location.directory)).rejects.toMatchObject({ code: "ENOENT" });
    const recordPath = join(dirname(prepared.location.directory), "profile.json");
    const record = JSON.parse(await fs.readFile(recordPath, "utf8"));
    expect(record).toMatchObject({ version: 1, status: "incomplete", ...identity,
      requestId: prepared.requestId, controllerScope: prepared.location.controllerScope, journalLeaf: basename(prepared.location.directory) });
    const key = createHash("sha256").update(JSON.stringify([identity.serverOrigin, identity.nodeId])).digest("hex");
    expect(dirname(prepared.location.directory)).toBe(join(root, "managed-profiles", "v1", key));
    for (const directory of [join(root, "managed-profiles"), join(root, "managed-profiles", "v1"), dirname(prepared.location.directory)]) {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    }
    expect((await fs.stat(recordPath)).mode & 0o777).toBe(0o600);
    const namespace = randomUUID();
    const binding = await store.completePreparation(identity, { requestId: prepared.requestId, namespace });
    expect(binding).toEqual({ version: 1, ...identity, ...prepared.location, expectedNamespace: namespace });
    expect(Object.isFrozen(binding)).toBe(true);
    const bytes = await fs.readFile(recordPath, "utf8");
    expect(await store.beginPreparation({ ...identity, serverOrigin: "HTTPS://TEAM.EXAMPLE:443/" })).toEqual({ kind: "existing", binding });
    const reopened = createManagedProfileStore(root, options);
    expect(await reopened.inspect(identity)).toEqual({ state: "ready", binding });
    expect(await reopened.beginPreparation(identity)).toEqual({ kind: "existing", binding });
    expect(await fs.readFile(recordPath, "utf8")).toBe(bytes);
  });

  it("isolates different normalized origins and enrolled node identities", async () => {
    const root = await temporary(); const store = createManagedProfileStore(root, options);
    const identities = [identity, { ...identity, serverOrigin: "https://other.example" }, { ...identity, nodeId: "other-node" }];
    const attempts = [];
    for (const selected of identities) attempts.push(await store.beginPreparation(selected));
    expect(new Set(attempts.map((value) => value.location.directory)).size).toBe(3);
    expect(new Set(attempts.map((value) => value.location.controllerScope)).size).toBe(3);
    expect(new Set(attempts.map((value) => value.requestId)).size).toBe(3);
    await store.completePreparation(identity, { requestId: attempts[0].requestId, namespace: randomUUID() });
    expect((await store.inspect(identity)).state).toBe("ready");
    for (const other of identities.slice(1)) expect(await store.inspect(other)).toEqual({ state: "incomplete" });
  });

  it("rejects a wrong request or malformed namespace without changing the retained intent", async () => {
    const root = await temporary(); const store = createManagedProfileStore(root, options);
    const prepared = await store.beginPreparation(identity);
    const recordPath = join(dirname(prepared.location.directory), "profile.json");
    const before = await fs.readFile(recordPath, "utf8");
    await expect(store.completePreparation(identity, { requestId: randomUUID(), namespace: randomUUID() })).rejects.toThrow("does not match");
    for (const namespace of ["", "not-a-namespace", [randomUUID()], { value: randomUUID() }]) {
      await expect(store.completePreparation(identity, { requestId: prepared.requestId, namespace })).rejects.toThrow("Invalid");
    }
    expect(await fs.readFile(recordPath, "utf8")).toBe(before);
    expect(await store.inspect(identity)).toEqual({ state: "incomplete" });
  });

  it("retains interrupted setup across store reopen and refuses a replacement attempt", async () => {
    const root = await temporary(); const store = createManagedProfileStore(root, options);
    const prepared = await store.beginPreparation(identity);
    const directory = dirname(prepared.location.directory);
    const before = await fs.readFile(join(directory, "profile.json"), "utf8");
    const reopened = createManagedProfileStore(root, options);
    await expect(reopened.beginPreparation(identity)).rejects.toThrow("incomplete");
    expect(await reopened.inspect(identity)).toEqual({ state: "incomplete" });
    expect(await fs.readFile(join(directory, "profile.json"), "utf8")).toBe(before);
    expect(await fs.readdir(directory)).toEqual(["profile.json"]);
  });

  it("claims only one intent across simultaneous independent stores", async () => {
    const root = await temporary();
    const stores = [createManagedProfileStore(root, options), createManagedProfileStore(root, options)];
    const results = await Promise.allSettled(stores.map((store) => store.beginPreparation(identity)));
    expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((value) => value.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.message).toContain("incomplete");
    expect(await stores[0].inspect(identity)).toEqual({ state: "incomplete" });
  });

  it("never replaces a completed namespace and returns immutable detached binding values", async () => {
    const root = await temporary(); const store = createManagedProfileStore(root, options);
    const prepared = await store.beginPreparation(identity); const namespace = randomUUID();
    const reply = { requestId: prepared.requestId, namespace };
    const binding = await store.completePreparation(identity, reply);
    const recordPath = join(dirname(binding.directory), "profile.json");
    const before = await fs.readFile(recordPath, "utf8");
    expect(await store.completePreparation(identity, reply)).toEqual(binding);
    await expect(store.completePreparation(identity, { ...reply, namespace: randomUUID() })).rejects.toThrow("immutable");
    await expect(store.completePreparation(identity, { ...reply, requestId: randomUUID() })).rejects.toThrow("does not match");
    expect(() => { binding.expectedNamespace = randomUUID(); }).toThrow();
    expect(await fs.readFile(recordPath, "utf8")).toBe(before);
  });

  it("allows only one namespace to complete across competing stores", async () => {
    const root = await temporary(); const first = createManagedProfileStore(root, options);
    const prepared = await first.beginPreparation(identity);
    const second = createManagedProfileStore(root, options);
    const results = await Promise.allSettled([first, second].map((store) => store.completePreparation(identity, {
      requestId: prepared.requestId, namespace: randomUUID(),
    })));
    const completed = results.filter((result) => result.status === "fulfilled");
    expect(completed).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const binding = (completed[0] as PromiseFulfilledResult<any>).value;
    expect(await first.inspect(identity)).toEqual({ state: "ready", binding });
    expect(await second.inspect(identity)).toEqual({ state: "ready", binding });
  });

  it("retains prepared profiles through token rotation, opt-out, logout and server changes", async () => {
    const root = await temporary(); const profiles = createManagedProfileStore(root, options);
    const prepared = await profiles.beginPreparation(identity);
    const binding = await profiles.completePreparation(identity, { requestId: prepared.requestId, namespace: randomUUID() });
    const connection = createConnectionStore(root, { isEncryptionAvailable: () => true, encryptString: () => Buffer.from("encrypted-fixture") });
    await connection.configureServer(identity.serverOrigin);
    await connection.pair("device", "old-control", "old-node-token");
    await connection.pair("device", "new-control", "new-node-token");
    await connection.configureDaemon({ allowedRoots: [], runtimes: ["codex"], trustedExecution: false });
    await connection.clear();
    await connection.configureServer("https://another.example");
    expect(await profiles.beginPreparation(identity)).toEqual({ kind: "existing", binding });
    expect(await profiles.inspect({ ...identity, serverOrigin: "https://another.example" })).toEqual({ state: "unprepared" });
  });

  it("flushes the intent file before rename and its parent before exposing the preparation", async () => {
    const root = await temporary(); const { control, filesystem } = instrumentedFilesystem();
    const store = createManagedProfileStore(root, { ...options, filesystem });
    await store.beginPreparation(identity);
    expect(control.events).toEqual(["write", "file-sync", "rename", "parent-sync"]);
  });

  it.each(["write", "file-sync", "rename", "parent-sync"] as const)("retains a failed %s and never issues another attempt", async (stage) => {
    const root = await temporary(); const { control, filesystem } = instrumentedFilesystem();
    control.failAt = stage;
    const store = createManagedProfileStore(root, { ...options, filesystem });
    await expect(store.beginPreparation(identity)).rejects.toThrow("persistence failed");
    await expect(store.inspect(identity)).rejects.toThrow("unavailable");
    await expect(store.beginPreparation(identity)).rejects.toThrow("unavailable");
    const key = createHash("sha256").update(JSON.stringify([identity.serverOrigin, identity.nodeId])).digest("hex");
    expect((await fs.readdir(join(root, "managed-profiles", "v1", key))).length).toBeGreaterThan(0);
    const reopened = createManagedProfileStore(root, options);
    expect(await reopened.inspect(identity)).toEqual({ state: "incomplete" });
    await expect(reopened.beginPreparation(identity)).rejects.toThrow("incomplete");
  });

  it("latches uncertain completion writes and only reopens completed bytes after a successful new flush", async () => {
    const root = await temporary(); const { control, filesystem } = instrumentedFilesystem();
    const store = createManagedProfileStore(root, { ...options, filesystem });
    const prepared = await store.beginPreparation(identity);
    control.renamed = false; control.failAt = "parent-sync";
    const namespace = randomUUID();
    await expect(store.completePreparation(identity, { requestId: prepared.requestId, namespace })).rejects.toThrow("persistence failed");
    await expect(store.inspect(identity)).rejects.toThrow("unavailable");
    const record = JSON.parse(await fs.readFile(join(dirname(prepared.location.directory), "profile.json"), "utf8"));
    expect(record).toMatchObject({ status: "ready", expectedNamespace: namespace, requestId: prepared.requestId });
    const brokenReopen = instrumentedFilesystem(); brokenReopen.control.failAt = "read-sync";
    const unreadable = createManagedProfileStore(root, { ...options, filesystem: brokenReopen.filesystem });
    await expect(unreadable.inspect(identity)).rejects.toThrow("persistence failed");
    await expect(unreadable.beginPreparation(identity)).rejects.toThrow("unavailable");
    const reopened = createManagedProfileStore(root, options);
    expect(await reopened.inspect(identity)).toMatchObject({ state: "ready", binding: { directory: prepared.location.directory, expectedNamespace: namespace } });
  });
});

describe("connection atomic-save portability", () => {
  it("keeps ordinary Windows saves usable when directory flushing is unsupported", async () => {
    const root = await temporary(); const filename = join(root, "connection.json");
    const filesystem = { ...fs, open: async (name: string, flags: any, mode?: number) => {
      if (name === root) throw failure("EPERM");
      return fs.open(name, flags, mode);
    } };
    await atomicWriteJson(filename, { saved: true }, { filesystem, platform: "win32", allowUnsupportedWindowsDirectorySync: true });
    expect(JSON.parse(await fs.readFile(filename, "utf8"))).toEqual({ saved: true });
    await expect(atomicWriteJson(filename, { saved: false }, { filesystem, platform: "darwin", allowUnsupportedWindowsDirectorySync: true })).rejects.toMatchObject({ code: "EPERM" });
  });

  it("does not swallow file flush or real directory I/O errors on Windows", async () => {
    const root = await temporary(); const filename = join(root, "connection.json");
    const directoryFailure = { ...fs, open: async (name: string, flags: any, mode?: number) => {
      if (name === root) throw failure("EIO");
      return fs.open(name, flags, mode);
    } };
    await expect(atomicWriteJson(filename, {}, { filesystem: directoryFailure, platform: "win32", allowUnsupportedWindowsDirectorySync: true })).rejects.toMatchObject({ code: "EIO" });
    const fileFailure = { ...fs, open: async (name: string, flags: any, mode?: number) => {
      const handle = await fs.open(name, flags, mode);
      return new Proxy(handle, { get(target, property) {
        if (property === "sync") return async () => { throw failure("EPERM"); };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    } };
    await expect(atomicWriteJson(filename, {}, { filesystem: fileFailure, platform: "win32", allowUnsupportedWindowsDirectorySync: true })).rejects.toMatchObject({ code: "EPERM" });
  });

  it("refuses to construct a managed profile store for unqualified platforms", async () => {
    const root = await temporary();
    expect(() => createManagedProfileStore(root, { platform: "win32" })).toThrow("only on macOS");
  });
});
