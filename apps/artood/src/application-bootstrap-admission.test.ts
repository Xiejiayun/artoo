// Controlled filesystem and admission facts only. No native collector, product
// module, loader hook or generated bundle is executed by this suite.
import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
type Entry = { directory: boolean; ino: bigint; bytes: Buffer; ctimeNs: bigint; mtimeNs: bigint; nlink: bigint; link?: boolean };
const state = vi.hoisted(() => ({ files: new Map<string, Entry>(), handles: new Map<number, { path: string; entry: Entry }>(),
  next: 0n, fd: 0, tokens: new Map<object, { directory: string; snapshot: string }>(), backend: Object.freeze({}),
  prepareCode: vi.fn(), assertCode: vi.fn(), auditCode: vi.fn(), prepareBackend: vi.fn(), assertBackend: vi.fn(),
  aliases: new Map<string, string>(), forbidden: vi.fn(), afterRead: (_file: string, _entry: Entry) => {},
  afterClose: (_file: string, _entry: Entry) => {}, closeFailure: null as Error | null, auditFailure: null as Error | null,
}));
vi.mock("node:child_process", () => ({ spawn: state.forbidden, spawnSync: state.forbidden }));
vi.mock("node:fs", () => {
  const facts = (entry: Entry) => ({ ...entry, dev: 1n, size: BigInt(entry.bytes.length),
    isFile: () => !entry.directory, isDirectory: () => entry.directory, isSymbolicLink: () => !!entry.link });
  const missing = () => Object.assign(Error("controlled missing file"), { code: "ENOENT" });
  return {
    lstatSync: (path: string) => { const entry = state.files.get(path); if (!entry) throw missing(); return facts(entry); },
    realpathSync: { native: (path: string) => state.aliases.get(path) ?? path },
    readdirSync: (directory: string) => [...state.files.keys()].filter(file => file.startsWith(directory + "\\") && !file.slice(directory.length + 1).includes("\\"))
      .map(file => file.slice(directory.length + 1)),
    openSync: (path: string, mode: string) => {
      if (mode !== "r") return state.forbidden(); const entry = state.files.get(path); if (!entry || entry.directory) throw missing();
      const fd = ++state.fd; state.handles.set(fd, { path, entry }); return fd;
    },
    fstatSync: (fd: number) => facts(state.handles.get(fd)!.entry),
    readSync: (fd: number, output: Buffer, offset: number, length: number, position: number) => {
      const { path, entry } = state.handles.get(fd)!, count = entry.bytes.copy(output, offset, position, position + length);
      state.afterRead(path, entry); return count;
    },
    closeSync: (fd: number) => { const { path, entry } = state.handles.get(fd)!; state.handles.delete(fd); state.afterClose(path, entry);
      if (state.closeFailure) throw state.closeFailure; },
  };
});
vi.mock("./windows-local-acl.js", () => ({ assertNativeWindows: () => {},
  assertCanonicalWindowsPath: (path: string) => { if (!/^[A-Z]:\\/u.test(path) || path.includes("/") || win32.normalize(path) !== path) throw Error("noncanonical path"); },
  physicalWindowsDirectory: (path: string) => { if (!state.files.get(path)?.directory || state.files.get(path)!.link || state.aliases.has(path)) throw Error("physical directory"); return path; },
  windowsPathsOverlap: (a: string, b: string) => { a = a.toLowerCase(); b = b.toLowerCase(); return a === b || a.startsWith(b + "\\") || b.startsWith(a + "\\"); },
}));
vi.mock("./windows-code-installation.js", () => ({ prepareWindowsCodeInstallation: state.prepareCode,
  assertWindowsCodeInstallation: state.assertCode, auditWindowsCodeInstallation: state.auditCode }));
vi.mock("./windows-process-installation.js", () => ({ prepareWindowsProcessInstallation: state.prepareBackend }));
vi.mock("./owned/windows-owned-process.js", () => ({ assertWindowsProcessBackend: state.assertBackend }));
import { applicationServiceSelection, prepareApplicationServiceHost, assertApplicationBootstrapAdmission, prepareApplicationInitializationHost,
  assertApplicationInitializationAdmission, describeApplicationInitializationPackage, readApplicationInitializationFile,
  prepareApplicationBootstrap } from "./application-bootstrap-admission.js";
const originalProcess = process, root = "C:\\host", entry = root + "\\application-service-bootstrap.mjs", file = "C:\\configuration\\application.json";
const sha = (bytes: Uint8Array) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
function add(path: string, text?: string) {
  state.files.set(path, { directory: text === undefined, ino: ++state.next, bytes: Buffer.from(text ?? ""), ctimeNs: 1n, mtimeNs: 1n, nlink: 1n });
}
const pin = (path: string) => { const bytes = state.files.get(path)!.bytes; return { path, bytes: bytes.length, sha256: sha(bytes) }; };
const snapshot = (root: string) => JSON.stringify([...state.files].filter(([path]) => path === root || path.startsWith(root + "\\"))
  .sort(([a], [b]) => a.localeCompare(b)).map(([path, value]) => [path, String(value.ino), String(value.ctimeNs), String(value.mtimeNs), String(value.nlink), value.bytes.length, !!value.link]));
function configuration() {
  return { version: 1, format: "artoo.application-service-selection.v1", node_id: "node1", writable_workspace_roots: ["C:\\work"],
    node: pin("C:\\node\\node.exe"), host_manifest: pin(root + "\\application-service-host-manifest.json"),
    installation_reference: { path: "C:\\installed\\generation\\control\\REOPEN.v1.json", bytes: 42, sha256: "sha256:" + "a".repeat(64) },
    backend: { directory: "C:\\native", manifest_sha256: "sha256:" + "b".repeat(64) }, system_root: "C:\\Windows", shutdown: "stdin" };
}
function manifest() {
  return { version: 1, format: "artoo.application-service-host.v1", platform: "win32", arch: "x64", bootstrap: "application-service-bootstrap.mjs",
    host_api: "application-service-host-api.mjs", files: ["application-service-bootstrap.mjs", "application-service-host-api.mjs", "chunks/authority.mjs"]
      .map(path => ({ ...pin(win32.join(root, ...path.split("/"))), path })) };
}
function saveManifest(value = manifest()) {
  add(root + "\\application-service-host-manifest.json", JSON.stringify(value)); add(file, JSON.stringify(configuration()));
}
beforeEach(() => {
  state.files.clear(); state.handles.clear(); state.tokens.clear(); state.aliases.clear(); state.afterRead = () => {}; state.afterClose = () => {};
  state.closeFailure = null; state.auditFailure = null;
  for (const path of ["C:\\", root, root + "\\chunks", "C:\\configuration", "C:\\node", "C:\\native", "C:\\Windows", "C:\\work", "C:\\installed", "C:\\installed\\generation"]) add(path);
  add(entry, "fixed bootstrap"); add(root + "\\application-service-host-api.mjs", "fixed delayed host"); add(root + "\\chunks\\authority.mjs", "one canonical authority");
  add("C:\\node\\node.exe", "fixed node"); saveManifest();
  state.forbidden.mockReset().mockImplementation(() => { throw Error("process forbidden"); });
  state.prepareCode.mockReset().mockImplementation(({ directory, writableWorkspaceRoots }: { directory: string; writableWorkspaceRoots: string[] }) => {
    if (writableWorkspaceRoots.some(root => directory === root || directory.startsWith(root + "\\"))) throw Error("writable root overlap");
    const token = Object.freeze({}); state.tokens.set(token, { directory, snapshot: snapshot(directory) }); return token;
  });
  state.assertCode.mockReset().mockImplementation((token: object, directory: string) => {
    const saved = state.tokens.get(token); if (!saved || saved.directory !== directory || saved.snapshot !== snapshot(directory)) throw Error("original code changed");
  });
  state.auditCode.mockReset().mockImplementation((token: object, directory: string) => {
    if (state.auditFailure) throw state.auditFailure; state.assertCode(token, directory);
  });
  state.prepareBackend.mockReset().mockReturnValue(state.backend);
  state.assertBackend.mockReset().mockImplementation((value: object) => { if (value !== state.backend) throw Error("original backend required"); });
  const runtime = Object.create(originalProcess);
  const env: NodeJS.ProcessEnv = { ...originalProcess.env, SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" };
  for (const key of Object.keys(env)) if (/^(NODE_OPTIONS|NODE_PATH)$/iu.test(key)) delete env[key];
  for (const [key, value] of Object.entries({ execPath: "C:\\node\\node.exe", execArgv: [], connected: undefined,
    argv: ["C:\\node\\node.exe", entry, "--selection=" + file], env })) Object.defineProperty(runtime, key, { value, writable: true, configurable: true });
  vi.stubGlobal("process", runtime);
});

const packageRoot = "C:\\package", packageManifest = packageRoot + "\\application-install-package.json";
function initializeFixture() {
  add(packageRoot); add("C:\\destinations");
  for (const path of ["service.json", "runtime.json", "create.json", "open.json"]) add(packageRoot + "\\" + path, "fixed " + path);
  const manifest = { version: 1, format: "artoo.application-install-package.v1", profile: "service.json",
    files: ["service.json", "runtime.json", "create.json", "open.json"].map(path => ({ ...pin(packageRoot + "\\" + path), path })) };
  const { installation_reference: _reference, ...base } = configuration();
  const write = (value = manifest) => {
    add(packageManifest, JSON.stringify(value));
    add(file, JSON.stringify({ ...base, format: "artoo.application-initialize-selection.v1", installation_parent: "C:\\destinations", source_manifest: pin(packageManifest) }));
  };
  write(); return { manifest, write };
}
describe("independent initialization bootstrap admission", () => {
  it("admits a complete package before any generation or descriptor exists", () => {
    initializeFixture(); const selected = prepareApplicationInitializationHost(file, entry);
    const source = describeApplicationInitializationPackage(selected.options.bootstrap, selected.options);
    expect(source.directory).toBe(packageRoot); expect(source.profile).toEqual(pin(packageRoot + "\\service.json")); expect(source.files).toHaveLength(4);
    expect(readApplicationInitializationFile(selected.options.bootstrap, selected.options, source.profile.path).toString()).toBe("fixed service.json");
    expect(selected.options.parent).toBe("C:\\destinations"); expect(selected.options.backend).toBe(state.backend);
    expect(state.forbidden).not.toHaveBeenCalled(); expect(prepareApplicationBootstrap(file, entry).operation).toBe("initialize");
    expect(() => assertApplicationInitializationAdmission(JSON.parse(JSON.stringify(selected.options.bootstrap)), selected.options)).toThrow("original current");
    expect(() => prepareApplicationServiceHost(file, entry)).toThrow();
  });
  it("preserves existing service selection dispatch and rejects an unknown mode", () => {
    expect(prepareApplicationBootstrap(file, entry).operation).toBe("reopen");
    add(file, JSON.stringify({ ...configuration(), format: "unknown" })); expect(() => prepareApplicationBootstrap(file, entry)).toThrow("fixed application selection format");
  });
  it.each(["extra", "missing", "empty-directory", "same-size", "manifest-ctime", "member-ctime"])("keeps strict package %s checks", change => {
    initializeFixture();
    if (change === "extra") add(packageRoot + "\\extra.json", "extra");
    if (change === "missing") state.files.delete(packageRoot + "\\create.json");
    if (change === "empty-directory") add(packageRoot + "\\extra");
    if (change === "same-size") state.files.get(packageRoot + "\\open.json")!.bytes.fill(88);
    if (change === "manifest-ctime" || change === "member-ctime") state.afterRead = (path, node) => {
      if (path === (change === "manifest-ctime" ? packageManifest : packageRoot + "\\open.json")) node.ctimeNs++;
    };
    expect(() => prepareApplicationInitializationHost(file, entry)).toThrow(); expect(state.forbidden).not.toHaveBeenCalled(); expect(state.handles.size).toBe(0);
  });
  it.each(["duplicate", "traversal", "profile", "self", "unknown"])("rejects malformed package manifest: %s", change => {
    const f = initializeFixture();
    if (change === "duplicate") f.manifest.files.push({ ...f.manifest.files[0]!, path: "Service.json" });
    if (change === "traversal") f.manifest.files[0]!.path = "../service.json";
    if (change === "profile") f.manifest.profile = "unknown.json";
    if (change === "self") f.manifest.files[0]!.path = "application-install-package.json";
    if (change === "unknown") Object.assign(f.manifest, { command: "execute" });
    f.write(); expect(() => prepareApplicationInitializationHost(file, entry)).toThrow();
  });
  it.each(["source", "selection", "environment", "parent-binding", "manifest-binding", "host-binding"])("permanently fails changed initialization authority: %s", change => {
    initializeFixture(); const selected = prepareApplicationInitializationHost(file, entry), target = { ...selected.options };
    if (change === "source") state.files.get(packageRoot + "\\open.json")!.ctimeNs++;
    if (change === "selection") state.files.get(file)!.ctimeNs++;
    if (change === "environment") process.env.SystemRoot = "C:\\other";
    if (change === "parent-binding") target.parent = "C:\\other";
    if (change === "manifest-binding") target.sourceManifest = { ...target.sourceManifest, bytes: 1 };
    if (change === "host-binding") target.hostCode = {} as typeof target.hostCode;
    expect(() => assertApplicationInitializationAdmission(selected.options.bootstrap, target)).toThrow();
    expect(() => selected.assertCurrent()).toThrow("original current initialization admission");
  });
  it("does not grant arbitrary file reads from a valid initialization token", () => {
    initializeFixture(); const selected = prepareApplicationInitializationHost(file, entry);
    expect(() => readApplicationInitializationFile(selected.options.bootstrap, selected.options, "C:\\node\\node.exe")).toThrow("original package member");
    expect(() => selected.assertCurrent()).toThrow("original current initialization admission");
  });
});
afterEach(() => vi.unstubAllGlobals());
describe("strict application-only host admission", () => {
  it("returns original local objects after complete manifest, Node and native admission", () => {
    const selected = prepareApplicationServiceHost(file, entry);
    expect(selected.options.backend).toBe(state.backend); expect(selected.options.hostCode).toBe(state.prepareCode.mock.results[1]!.value);
    expect(selected.options.reference).toEqual(configuration().installation_reference); expect(selected.options.node).toEqual(configuration().node);
    expect(state.prepareCode.mock.calls.map(([value]) => value.directory)).toEqual(["C:\\configuration", root, "C:\\node"]);
    expect(state.prepareBackend).toHaveBeenCalledExactlyOnceWith({ directory: "C:\\native", manifestSha256: configuration().backend.manifest_sha256, writableWorkspaceRoots: ["C:\\work"] });
    expect(state.handles.size).toBe(0); expect(state.forbidden).not.toHaveBeenCalled(); selected.assertCurrent();
    expect(() => assertApplicationBootstrapAdmission(JSON.parse(JSON.stringify(selected.options.bootstrap)), selected.options)).toThrow("original current");
  });
  it.each(["extra-file", "missing-file", "empty-directory", "same-size-content", "manifest-hash", "node-hash"])("rejects %s before preparing a native backend", change => {
    if (change === "extra-file") add(root + "\\unexpected.mjs", "unexpected");
    if (change === "missing-file") state.files.delete(root + "\\chunks\\authority.mjs");
    if (change === "empty-directory") add(root + "\\unused");
    if (change === "same-size-content") state.files.get(root + "\\chunks\\authority.mjs")!.bytes.fill(88);
    if (change === "manifest-hash" || change === "node-hash") {
      const config = configuration(); config[change === "manifest-hash" ? "host_manifest" : "node"].sha256 = "sha256:" + "0".repeat(64); add(file, JSON.stringify(config));
    }
    expect(() => prepareApplicationServiceHost(file, entry)).toThrow(); expect(state.prepareBackend).not.toHaveBeenCalled();
  });
  it.each(["duplicate", "traversal", "missing-entry", "unknown-field", "bare-package"])("rejects malformed complete manifests: %s", change => {
    const value = manifest();
    if (change === "duplicate") value.files.push({ ...value.files[0]!, path: "Application-service-bootstrap.mjs" });
    if (change === "traversal") value.files[2]!.path = "../escape.mjs";
    if (change === "missing-entry") value.files = value.files.filter(item => item.path !== "application-service-host-api.mjs");
    if (change === "bare-package") value.files[2]!.path = "node_modules/zod/index.js";
    if (change === "unknown-field") Object.assign(value, { loader: "bypass" });
    saveManifest(value); expect(() => prepareApplicationServiceHost(file, entry)).toThrow(); expect(state.prepareBackend).not.toHaveBeenCalled();
  });
  it.each(["ctime-read", "ctime-close", "replacement", "hardlink", "symlink"])("retains strict existing-file boundaries: %s", change => {
    if (change === "ctime-read") state.afterRead = (path, node) => { if (path === file) node.ctimeNs++; };
    if (change === "ctime-close") state.afterClose = (path, node) => { if (path === file) node.ctimeNs++; };
    if (change === "replacement") state.afterRead = (path, node) => { if (path === file) state.files.set(path, { ...node, ino: node.ino + 1n }); };
    if (change === "hardlink") state.files.get(file)!.nlink = 2n;
    if (change === "symlink") state.files.get(file)!.link = true;
    expect(() => prepareApplicationServiceHost(file, entry)).toThrow(); expect(state.prepareBackend).not.toHaveBeenCalled(); expect(state.handles.size).toBe(0);
  });
  it("retains both strict-read and original-close failure without continuing", () => {
    state.afterRead = (path, node) => { if (path === file) node.ctimeNs++; }; state.closeFailure = Error("original close failed");
    let caught: unknown; try { prepareApplicationServiceHost(file, entry); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError); expect((caught as AggregateError).errors[1]).toBe(state.closeFailure); expect(state.prepareBackend).not.toHaveBeenCalled();
  });
  it.each(["flags", "preload-env", "ipc", "wrong-node", "wrong-system-root", "wrong-entry"])("rejects unsupported runtime selection: %s", change => {
    if (change === "flags") process.execArgv.push("--import=hook");
    if (change === "preload-env") process.env.node_options = "--import=hook";
    if (change === "ipc") Object.defineProperty(process, "connected", { value: false, configurable: true });
    if (change === "wrong-node") Object.defineProperty(process, "execPath", { value: "C:\\different\\node.exe", configurable: true });
    if (change === "wrong-system-root") process.env.WINDIR = "C:\\other";
    if (change === "wrong-entry") process.argv[1] = "C:\\host\\other.mjs";
    expect(() => prepareApplicationServiceHost(file, entry)).toThrow(); expect(state.prepareBackend).not.toHaveBeenCalled();
  });
  it.each(["selection-metadata", "selection-content", "environment", "entry", "acl"])("latches later admission failure permanently: %s", change => {
    const selected = prepareApplicationServiceHost(file, entry), original = state.files.get(file)!;
    if (change === "selection-metadata") original.ctimeNs++;
    if (change === "selection-content") original.bytes.fill(88);
    if (change === "environment") process.env.SystemRoot = "C:\\changed";
    if (change === "entry") process.argv[1] = "C:\\host\\other.mjs";
    if (change === "acl") state.auditFailure = Error("ACL changed");
    expect(() => selected.assertCurrent()).toThrow();
    original.ctimeNs = 1n; state.auditFailure = null; process.env.SystemRoot = "C:\\Windows"; process.argv[1] = entry;
    expect(() => selected.assertCurrent()).toThrow("original current bootstrap admission");
  });
  it.each(["host", "backend", "reference", "node", "roots", "node-id"])("binds the bootstrap token to the full original options: %s", change => {
    const selected = prepareApplicationServiceHost(file, entry), target = { ...selected.options };
    if (change === "host") target.hostCode = {} as typeof target.hostCode;
    if (change === "backend") target.backend = {} as typeof target.backend;
    if (change === "reference") target.reference = { ...target.reference, sha256: "sha256:" + "0".repeat(64) };
    if (change === "node") target.node = { ...target.node, bytes: target.node.bytes + 1 };
    if (change === "roots") target.allowedRoots = ["C:\\other"];
    if (change === "node-id") target.nodeId = "other";
    expect(() => assertApplicationBootstrapAdmission(target.bootstrap, target)).toThrow("target binding differs");
  });
  it("accepts only one fixed local selection argument", () => {
    expect(applicationServiceSelection(["--selection=" + file])).toBe(file);
    for (const args of [[], ["--serve-application"], ["--selection=relative"], ["--selection=" + file, "--extra"]]) expect(() => applicationServiceSelection(args)).toThrow();
  });
});
