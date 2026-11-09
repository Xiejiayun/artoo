// Controlled filesystem and admission tests only. No native helper, SQLite or HTTP is started.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationBrokerInstallation } from "./application-broker-process.js";
import type { ApplicationRuntimeInstallation } from "./application-runtime-process.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import type { PreparedApplicationInstallation } from "./application-installation.js";
import type { ApplicationClientReader } from "./application-artifact-admission.js";
type InstallationBinding = ReturnType<typeof import("./application-installation.js").describeApplicationInstallation>;

type Node = { directory: boolean; ino: bigint; bytes: Buffer; ctimeNs: bigint; mtimeNs: bigint; nlink: bigint; link?: boolean };
const controlled = vi.hoisted(() => ({
  nodes: new Map<string, Node>(), handles: new Map<number, { path: string; node: Node }>(), aliases: new Map<string, string>(),
  statErrors: new Map<string, string>(), next: 0n, fd: 0, opened: [] as string[], backend: Object.freeze({}),
  nativeRoots: [] as string[], native: true, unsafe: "", codeTokens: new Map<object, string>(), storeTokens: new Map<object, string>(),
  afterRead: (_path: string, _node: Node) => {}, afterClose: (_path: string, _node: Node) => {},
  codePrepare: vi.fn(), codeAssert: vi.fn(), codeAudit: vi.fn(), storePrepare: vi.fn(), storeAssert: vi.fn(), storeAudit: vi.fn(),
  backendAssert: vi.fn(), runtimePrepare: vi.fn(), brokerPrepare: vi.fn(), helperLoad: vi.fn(), runtimeLoad: vi.fn(),
  ownerCreate: vi.fn(), capture: vi.fn(), revoke: vi.fn(), clientReader: vi.fn(), forbidden: vi.fn(),
  installations: new Map<object, { binding: InstallationBinding; failed: boolean; readers: Set<ApplicationClientReader> }>(),
  installationDescribe: vi.fn(), installationAssert: vi.fn(), installationAudit: vi.fn(), installationInvalidate: vi.fn(), installationBind: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: controlled.forbidden, spawnSync: controlled.forbidden,
  exec: controlled.forbidden, execFile: controlled.forbidden, execFileSync: controlled.forbidden, fork: controlled.forbidden }));
vi.mock("node:sqlite", () => ({ DatabaseSync: controlled.forbidden }));
vi.mock("node:http", () => ({ createServer: controlled.forbidden }));
vi.mock("./application-data-broker.js", () => ({ ApplicationDataBroker: controlled.forbidden }));
vi.mock("node:fs", () => {
  const facts = (node: Node) => ({ ...node, dev: 1n, size: BigInt(node.bytes.length),
    isFile: () => !node.directory, isDirectory: () => node.directory, isSymbolicLink: () => !!node.link });
  return {
    lstatSync: (path: string) => {
      const code = controlled.statErrors.get(path), node = controlled.nodes.get(path);
      if (code || !node) throw Object.assign(Error(`Controlled stat failure: ${path}`), { code: code ?? "ENOENT" });
      return facts(node);
    },
    realpathSync: { native: (path: string) => controlled.aliases.get(path) ?? path },
    openSync: (path: string, mode: string) => {
      if (mode !== "r" || path.endsWith(".sqlite")) return controlled.forbidden();
      const node = controlled.nodes.get(path); if (!node) throw Object.assign(Error("Missing controlled file"), { code: "ENOENT" });
      controlled.opened.push(path); const fd = ++controlled.fd; controlled.handles.set(fd, { path, node }); return fd;
    },
    fstatSync: (fd: number) => facts(controlled.handles.get(fd)!.node),
    closeSync: (fd: number) => {
      const { path, node } = controlled.handles.get(fd)!; controlled.handles.delete(fd); controlled.afterClose(path, node);
    },
    readSync: (fd: number, output: Buffer, offset: number, length: number, position: number) => {
      const { path, node } = controlled.handles.get(fd)!, count = node.bytes.copy(output, offset, position, position + length);
      if (count) controlled.afterRead(path, node); return count;
    },
  };
});
vi.mock("./windows-local-acl.js", async () => {
  const { win32 } = await import("node:path");
  const canonical = (path: string) => {
    if (typeof path !== "string" || !/^[A-Z]:\\/u.test(path) || path.includes("/") || win32.normalize(path) !== path)
      throw Error("Controlled canonical Windows path required");
  };
  return {
    assertNativeWindows: () => { if (!controlled.native) throw Error("Native Windows required"); },
    assertCanonicalWindowsPath: canonical,
    physicalWindowsDirectory: (path: string) => {
      canonical(path); const node = controlled.nodes.get(path);
      if (!node?.directory || node.link || controlled.aliases.has(path)) throw Error("Controlled physical directory required");
      return path;
    },
    windowsPathsOverlap: (left: string, right: string) => {
      left = left.toLowerCase(); right = right.toLowerCase();
      return left === right || left.startsWith(`${right}\\`) || right.startsWith(`${left}\\`);
    },
  };
});
vi.mock("./windows-code-installation.js", () => ({ prepareWindowsCodeInstallation: controlled.codePrepare,
  assertWindowsCodeInstallation: controlled.codeAssert, auditWindowsCodeInstallation: controlled.codeAudit }));
vi.mock("./windows-release-storage.js", () => ({ prepareWindowsReleaseStorage: controlled.storePrepare,
  assertWindowsReleaseStorage: controlled.storeAssert, auditWindowsReleaseStorage: controlled.storeAudit }));
vi.mock("./windows-process-installation.js", () => ({ describeWindowsProcessInstallation: (backend: unknown) => {
  if (backend !== controlled.backend) throw Error("Original native installation required");
  return { directory: "C:\\node\\native", manifestSha256: `sha256:${"a".repeat(64)}`, writableWorkspaceRoots: controlled.nativeRoots };
} }));
vi.mock("./owned/windows-owned-process.js", () => ({ assertWindowsProcessBackend: controlled.backendAssert }));
vi.mock("./application-broker-process.js", () => ({ prepareApplicationBrokerProcess: controlled.brokerPrepare }));
vi.mock("./application-runtime-process.js", () => ({ prepareApplicationRuntimeProcess: controlled.runtimePrepare }));
vi.mock("./application-runtime-installation.js", () => ({ loadApplicationRuntimeHelperManifest: controlled.helperLoad,
  loadApplicationRuntimeConfiguration: controlled.runtimeLoad }));
vi.mock("./application-artifact-admission.js", async original => ({
  ...await original<typeof import("./application-artifact-admission.js")>(), createApplicationArtifactOwner: controlled.ownerCreate,
}));
vi.mock("./application-installation.js", () => ({ describeApplicationInstallation: controlled.installationDescribe,
  assertApplicationInstallation: controlled.installationAssert, auditApplicationInstallation: controlled.installationAudit,
  invalidateApplicationInstallation: controlled.installationInvalidate, bindApplicationInstallationClientReader: controlled.installationBind }));
import { assertApplicationClientReader, readApplicationClientArtifact, revokeApplicationClientReader } from "./application-artifact-admission.js";
import { prepareApplicationServiceProfile, describeApplicationServiceProfile, assertApplicationServiceOpenStore,
  prepareInstalledApplicationServiceProfile, prepareProfileApplicationRuntime, prepareProfileApplicationBroker,
  prepareProfileApplicationClient, type PreparedApplicationServiceProfile } from "./application-service-profile.js";

const installation = "C:\\node\\installation", storage = "C:\\node\\store", nodeDirectory = "C:\\node\\runtime";
const file = `${installation}\\settings\\service.json`, node = `${nodeDirectory}\\node.exe`, database = `${storage}\\data.sqlite`;
const runtimeEntry = `${installation}\\runtime\\application-runtime.mjs`, runtimeConfig = `${installation}\\runtime\\application-runtime.json`;
const helper = `${installation}\\helper\\artoo-quickjs-process-host.exe`, helperManifest = `${installation}\\helper\\quickjs-native-manifest.json`;
const brokerEntry = `${installation}\\broker\\application-broker.mjs`, createConfig = `${installation}\\settings\\create.json`, openConfig = `${installation}\\settings\\open.json`;
const sourceFile = `${installation}\\source\\handler.ts`, helperDependency = `${installation}\\helper\\host.dll`;
const allowedRoots = ["C:\\products\\one", "C:\\products\\two"];
const scope = { product_id: "p1", data_generation: "d1", service_generation: 1, artifact_digest: `sha256:${"b".repeat(64)}` };
const schemaJson = JSON.stringify({ version: 1, tables: [{ name: "items", columns: [{ name: "value", type: "text", max_bytes: 64, nullable: false }] }] });
function add(path: string, bytes?: string): void {
  controlled.nodes.set(path, { directory: bytes === undefined, bytes: Buffer.from(bytes ?? ""), ino: ++controlled.next,
    ctimeNs: 1n, mtimeNs: 1n, nlink: 1n });
}
function pin(path: string) { const bytes = controlled.nodes.get(path)!.bytes; return { path, bytes: bytes.length,
  sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }; }
function profile() {
  return { version: 1, format: "artoo.application-service-profile.v1", node_id: "node1", writable_workspace_roots: [...allowedRoots],
    installation_directory: installation, storage_directory: storage,
    runtime: { helper: pin(helper), helperManifest: pin(helperManifest), node: pin(node), entry: pin(runtimeEntry), configuration: pin(runtimeConfig) },
    broker: { node: pin(node), entry: pin(brokerEntry), create_configuration: pin(createConfig), open_configuration: pin(openConfig) },
    http: { origin: "http://127.0.0.1:18182", timeout_ms: 30_000, maximum_concurrent: 1, access: "write" } };
}
function saveProfile(change: Record<string, unknown> = {}) { add(file, JSON.stringify({ ...profile(), ...change })); }
function saveConfiguration(createChange: Record<string, unknown> = {}, openChange: Record<string, unknown> = {}) {
  const common = { version: 1, protocol: "artoo.application-broker.v1", databasePath: database, schemaJson, scope, maximumAccess: "write" };
  add(createConfig, JSON.stringify({ ...common, mode: "create", ...createChange }));
  add(openConfig, JSON.stringify({ ...common, mode: "open", ...openChange })); saveProfile();
}
const options = () => ({ file, nodeId: "node1", allowedRoots: [...allowedRoots], backend: controlled.backend as PreparedWindowsProcessBackend });
const prepare = () => prepareApplicationServiceProfile(options());
const managedFile = `${installation}\\service.json`, generationId = "generation-1";
function managed(change: Record<string, unknown> = {}, bindingChange: Partial<InstallationBinding> = {}) {
  add(managedFile, JSON.stringify({ ...profile(), installation: { version: 1, generation_id: generationId }, ...change }));
  const code = Object.freeze({}) as InstallationBinding["code"], nodeCode = Object.freeze({}) as InstallationBinding["nodeCode"];
  const store = Object.freeze({}) as InstallationBinding["storage"];
  controlled.codeTokens.set(code, installation); controlled.codeTokens.set(nodeCode, nodeDirectory); controlled.storeTokens.set(store, storage);
  const binding: InstallationBinding = Object.freeze({ generationId, nodeId: "node1", allowedRoots: Object.freeze([...allowedRoots]),
    profile: Object.freeze(pin(managedFile)), directory: installation, storageDirectory: storage, node: Object.freeze(pin(node)), nodeDirectory,
    code, nodeCode, storage: store, backend: controlled.backend as PreparedWindowsProcessBackend, ...bindingChange });
  const token = Object.freeze({}) as PreparedApplicationInstallation;
  controlled.installations.set(token, { binding, failed: false, readers: new Set() }); return { token, binding };
}

beforeEach(() => {
  controlled.nodes.clear(); controlled.handles.clear(); controlled.aliases.clear(); controlled.statErrors.clear();
  controlled.codeTokens.clear(); controlled.storeTokens.clear(); controlled.opened = []; controlled.next = 9007199254740991n;
  controlled.fd = 0; controlled.nativeRoots = [...allowedRoots]; controlled.native = true; controlled.unsafe = "";
  controlled.afterRead = () => {}; controlled.afterClose = () => {};
  for (const path of ["C:\\", "C:\\node", installation, `${installation}\\settings`, `${installation}\\runtime`, `${installation}\\helper`,
    `${installation}\\broker`, `${installation}\\source`, nodeDirectory, storage, "C:\\node\\native", "C:\\products", ...allowedRoots]) add(path);
  for (const path of [node, runtimeEntry, runtimeConfig, helper, helperManifest, brokerEntry, sourceFile, helperDependency]) add(path, `Controlled bytes: ${path}`);
  add(database, "unopened store sentinel"); saveConfiguration();
  controlled.forbidden.mockReset().mockImplementation(() => { throw Error("A real process, database, HTTP listener or filesystem write is forbidden"); });
  const admit = (tokens: Map<object, string>) => (input: { directory: string; writableWorkspaceRoots: readonly string[] }) => {
    if (input.directory === controlled.unsafe || input.writableWorkspaceRoots.some(root => input.directory === root
      || input.directory.startsWith(`${root}\\`) || root.startsWith(`${input.directory}\\`))) throw Error("Controlled protected boundary rejected");
    const token = Object.freeze({}); tokens.set(token, input.directory); return token;
  };
  const assert = (tokens: Map<object, string>) => (token: object, directory: string) => {
    if (tokens.get(token) !== directory || directory === controlled.unsafe) throw Error("Original controlled admission rejected");
  };
  controlled.codePrepare.mockReset().mockImplementation(admit(controlled.codeTokens));
  controlled.codeAssert.mockReset().mockImplementation(assert(controlled.codeTokens));
  controlled.codeAudit.mockReset().mockImplementation(assert(controlled.codeTokens));
  controlled.storePrepare.mockReset().mockImplementation(admit(controlled.storeTokens));
  controlled.storeAssert.mockReset().mockImplementation(assert(controlled.storeTokens));
  controlled.storeAudit.mockReset().mockImplementation(assert(controlled.storeTokens));
  controlled.backendAssert.mockReset().mockImplementation((backend: unknown) => {
    if (backend !== controlled.backend) throw Error("Original native backend required");
  });
  controlled.runtimePrepare.mockReset().mockImplementation((input: ApplicationRuntimeInstallation) => { input.assertLocalAdmission(); return Object.freeze({}); });
  controlled.brokerPrepare.mockReset().mockImplementation((input: ApplicationBrokerInstallation) => {
    input.native.assertLocalInstallation(); input.assertLocalAdmission(); return Object.freeze({});
  });
  controlled.helperLoad.mockReset().mockReturnValue([pin(helperDependency)]);
  controlled.runtimeLoad.mockReset().mockReturnValue({ config: { expectation: { artifacts: { digest: scope.artifact_digest } } },
    capture: { source: [], artifacts: [], toolchain: [] }, runtimeFiles: [pin(sourceFile)] });
  controlled.capture.mockReset().mockReturnValue(Object.freeze({})); controlled.revoke.mockReset();
  controlled.clientReader.mockReset().mockImplementation(() => Object.freeze({}));
  controlled.ownerCreate.mockReset().mockReturnValue({ capture: controlled.capture, revoke: controlled.revoke, clientReader: controlled.clientReader });
  controlled.installations.clear();
  const currentInstallation = (token: object) => {
    const saved = controlled.installations.get(token);
    if (!saved || saved.failed) throw Error("Original controlled installation authority required"); return saved;
  };
  controlled.installationDescribe.mockReset().mockImplementation((token: object) => currentInstallation(token).binding);
  controlled.installationAssert.mockReset().mockImplementation((token: object) => { currentInstallation(token); });
  controlled.installationAudit.mockReset().mockImplementation((token: object) => { currentInstallation(token); });
  controlled.installationInvalidate.mockReset().mockImplementation((token: object) => {
    const saved = controlled.installations.get(token); if (!saved) return; saved.failed = true;
    for (const reader of saved.readers) revokeApplicationClientReader(reader); saved.readers.clear();
  });
  controlled.installationBind.mockReset().mockImplementation((token: object, reader: ApplicationClientReader) => {
    const saved = currentInstallation(token); assertApplicationClientReader(reader); saved.readers.add(reader);
  });
});
afterEach(() => { expect(controlled.handles.size).toBe(0); expect(controlled.forbidden).not.toHaveBeenCalled(); });

describe("protected local application service profile", () => {
  it.each(["legacy", "installed"])("allocates profile bytes before opening the original file: %s", variant => {
    const installed = variant === "installed" ? managed() : undefined;
    const original = new RangeError("Controlled profile buffer allocation failure");
    const allocation = vi.spyOn(Buffer, "alloc").mockImplementationOnce(() => { throw original; });
    let caught: unknown;
    try { if (installed) prepareInstalledApplicationServiceProfile(installed.token); else prepare(); }
    catch (error) { caught = error; }
    finally { allocation.mockRestore(); }
    expect(caught).toBe(original);
    expect(controlled.opened).toEqual([]); expect(controlled.handles.size).toBe(0);
    expect(controlled.runtimePrepare).not.toHaveBeenCalled(); expect(controlled.brokerPrepare).not.toHaveBeenCalled();
    if (installed) expect(controlled.installations.get(installed.token)!.failed).toBe(true);
  });
  it("returns only frozen local authority and binding, checking content without starting work", () => {
    const token = prepare(), binding = describeApplicationServiceProfile(token);
    expect(Object.isFrozen(token)).toBe(true); expect(Object.keys(token)).toEqual([]); expect(Object.isFrozen(binding)).toBe(true);
    expect(binding).toEqual({ origin: "http://127.0.0.1:18182", port: 18182, timeoutMs: 30_000, maximumAccess: "write", qualifiedForProduct: false });
    expect(controlled.runtimePrepare).not.toHaveBeenCalled(); expect(controlled.brokerPrepare).not.toHaveBeenCalled();
    expect(controlled.opened).not.toContain(database);
    expect(controlled.capture).toHaveBeenCalledWith(controlled.runtimeLoad.mock.results[0]!.value.capture);
    expect(controlled.revoke).toHaveBeenCalledWith(controlled.capture.mock.results[0]!.value);
    expect(controlled.codePrepare).toHaveBeenCalledWith({ directory: installation, writableWorkspaceRoots: allowedRoots });
    expect(controlled.storePrepare).toHaveBeenCalledWith({ directory: storage, writableWorkspaceRoots: allowedRoots });
  });
  it("makes fresh original preparations and binds fixed runtime and open broker configurations", () => {
    const token = prepare(); assertApplicationServiceOpenStore(token);
    expect(prepareProfileApplicationRuntime(token)).not.toBe(prepareProfileApplicationRuntime(token));
    expect(prepareProfileApplicationBroker(token, "open")).not.toBe(prepareProfileApplicationBroker(token, "open"));
    expect(controlled.runtimePrepare.mock.calls[0]![0]).toMatchObject(profile().runtime);
    expect(controlled.brokerPrepare.mock.calls[0]![0]).toMatchObject({ node: pin(node), entry: pin(brokerEntry), configuration: pin(openConfig) });
    expect(controlled.opened).not.toContain(database);
  });
  it.each(["describe", "open-store", "runtime", "broker"])("rejects a forged authority for %s", action => {
    const token = {} as PreparedApplicationServiceProfile;
    expect(() => action === "describe" ? describeApplicationServiceProfile(token) : action === "open-store" ? assertApplicationServiceOpenStore(token)
      : action === "runtime" ? prepareProfileApplicationRuntime(token) : prepareProfileApplicationBroker(token, "open")).toThrow(/original local profile authority/);
  });
  it.each(["node", "roots", "duplicate", "native-roots", "backend", "caller-policy"])("requires exact local settings: %s", variant => {
    const input = options();
    if (variant === "node") input.nodeId = "other";
    if (variant === "roots") input.allowedRoots.pop();
    if (variant === "duplicate") saveProfile({ writable_workspace_roots: [allowedRoots[0], allowedRoots[0]] });
    if (variant === "native-roots") controlled.nativeRoots.pop();
    if (variant === "backend") input.backend = {} as PreparedWindowsProcessBackend;
    if (variant === "caller-policy") Object.assign(input, { assertLocalAdmission: controlled.forbidden });
    expect(() => prepareApplicationServiceProfile(input)).toThrow();
    expect(controlled.runtimePrepare).not.toHaveBeenCalled(); expect(controlled.brokerPrepare).not.toHaveBeenCalled();
  });
  it("rejects profile-selected callbacks or policy", () => { saveProfile({ assertLocalAdmission: "bypass" }); expect(prepare).toThrow(); });
  it("retains the original file, roots and backend after caller input mutation", () => {
    const input = options(), token = prepareApplicationServiceProfile(input);
    input.file = "C:\\other.json"; input.nodeId = "other"; input.allowedRoots.splice(0, 2, installation); input.backend = {} as PreparedWindowsProcessBackend;
    expect(() => assertApplicationServiceOpenStore(token)).not.toThrow();
    prepareProfileApplicationRuntime(token); prepareProfileApplicationBroker(token, "open");
    expect(controlled.backendAssert.mock.calls.every(call => call[0] === controlled.backend)).toBe(true);
    expect(controlled.runtimePrepare.mock.calls[0]![0].configuration).toEqual(pin(runtimeConfig));
    expect(controlled.brokerPrepare.mock.calls[0]![0].configuration).toEqual(pin(openConfig));
    expect(controlled.opened).not.toContain(input.file);
  });
  it.each(["https://127.0.0.1:18182", "http://localhost:18182", "http://0.0.0.0:18182", "http://127.0.0.1:18182/",
    "http://127.0.0.1:18182/path", "http://user@127.0.0.1:18182", "http://127.0.0.1", "http://127.0.0.1:80"])
    ("rejects a noncanonical or nonfixed loopback origin: %s", origin => { saveProfile({ http: { ...profile().http, origin } }); expect(prepare).toThrow(); });
  it.each([{ timeout_ms: 30_001 }, { timeout_ms: 0 }, { maximum_concurrent: 2 }, { access: "admin" }])
    ("rejects unsupported HTTP policy %j", change => { saveProfile({ http: { ...profile().http, ...change } }); expect(prepare).toThrow(); });
  it.each(["runtime-entry", "runtime-config", "runtime-config-directory", "node", "broker-entry"])("requires trusted entry names: %s", variant => {
    const value = profile();
    if (variant === "runtime-entry") value.runtime.entry.path = `${installation}\\runtime\\product.mjs`;
    if (variant === "runtime-config") value.runtime.configuration.path = `${installation}\\runtime\\other.json`;
    if (variant === "runtime-config-directory") value.runtime.configuration.path = `${installation}\\settings\\application-runtime.json`;
    if (variant === "node") value.runtime.node.path = `${nodeDirectory}\\product.exe`;
    if (variant === "broker-entry") value.broker.entry.path = `${installation}\\broker\\product.mjs`;
    saveProfile(value); expect(prepare).toThrow(/trusted entry names/);
  });
  it("requires runtime and broker to select the same exact Node pin", () => {
    saveProfile({ broker: { ...profile().broker, node: { ...pin(node), sha256: `sha256:${"c".repeat(64)}` } } });
    expect(prepare).toThrow(/same fixed Node/);
  });
  it.each([node, runtimeEntry, runtimeConfig, helper, helperManifest, brokerEntry, createConfig, openConfig])
    ("rejects installed bytes differing from the protected pin at %s", path => { controlled.nodes.get(path)!.bytes = Buffer.from("changed"); expect(prepare).toThrow(/installed bytes differ/); });
  it.each(["hardlink", "symlink", "alias", "directory"])("requires a physical single-link profile: %s", variant => {
    const current = controlled.nodes.get(file)!;
    if (variant === "hardlink") current.nlink = 2n;
    if (variant === "symlink") current.link = true;
    if (variant === "alias") controlled.aliases.set(file, "C:\\other.json");
    if (variant === "directory") current.directory = true;
    expect(prepare).toThrow(/physical single-link/); expect(controlled.opened).toEqual([]);
  });
  it.each([file, node])("rejects the first ctime change during the original read at %s", path => {
    controlled.afterRead = (current, value) => { if (current === path) value.ctimeNs++; };
    expect(prepare).toThrow(/changed during read/); expect(controlled.opened.filter(current => current === path)).toHaveLength(1);
  });
  it.each([file, node])("rejects the first ctime change at the original close at %s", path => {
    controlled.afterClose = (current, value) => { if (current === path) value.ctimeNs++; };
    expect(prepare).toThrow(/changed during close/); expect(controlled.opened.filter(current => current === path)).toHaveLength(1);
  });
  it.each(["replacement", "mtime", "growth"])("compares original handle and path metadata without bigint rounding: %s", variant => {
    controlled.afterRead = (current, value) => {
      if (current !== file) return;
      if (variant === "replacement") controlled.nodes.set(file, { ...value, ino: value.ino + 1n });
      if (variant === "mtime") value.mtimeNs++;
      if (variant === "growth") value.bytes = Buffer.concat([value.bytes, Buffer.from("x")]);
    };
    expect(prepare).toThrow(/changed during read/);
  });
  it("checks the original profile bytes again even when its size and timestamps are unchanged", () => {
    const token = prepare(), value = controlled.nodes.get(file)!;
    value.bytes = Buffer.from(value.bytes.toString().replace('"node1"', '"node2"'));
    expect(() => prepareProfileApplicationRuntime(token)).toThrow(/original profile changed/); expect(controlled.runtimePrepare).not.toHaveBeenCalled();
  });
  it("rejects initial profile admission before reading bytes", () => {
    controlled.unsafe = `${installation}\\settings`; expect(prepare).toThrow(/protected boundary/); expect(controlled.opened).toEqual([]);
  });
  it.each(["runtime", "broker", "open-store"])("re-audits original storage before %s", action => {
    const token = prepare(); controlled.unsafe = storage;
    expect(() => action === "runtime" ? prepareProfileApplicationRuntime(token) : action === "broker" ? prepareProfileApplicationBroker(token, "open")
      : assertApplicationServiceOpenStore(token)).toThrow(/admission rejected/);
    expect(controlled.runtimePrepare).not.toHaveBeenCalled(); expect(controlled.brokerPrepare).not.toHaveBeenCalled();
  });
  it.each(["helper", "runtime"])("rejects an external resolved %s closure member", variant => {
    const outside = { ...pin(sourceFile), path: "C:\\products\\one\\outside.js" };
    if (variant === "helper") controlled.helperLoad.mockReturnValue([outside]);
    else controlled.runtimeLoad.mockReturnValue({ ...controlled.runtimeLoad(), runtimeFiles: [outside] });
    expect(prepare).toThrow(/outside protected installation/); expect(controlled.capture).not.toHaveBeenCalled();
  });
  it.each(["helper", "broker"])("rejects a top-level installed %s pin outside the installation", variant => {
    const value = profile();
    if (variant === "helper") value.runtime.helper.path = "C:\\products\\one\\host.exe";
    else value.broker.entry.path = "C:\\products\\one\\application-broker.mjs";
    saveProfile(value); expect(prepare).toThrow(/outside protected installation/);
  });
  it.each([installation, nodeDirectory, "C:\\node\\native"])("rejects store overlap with %s", directory => {
    saveProfile({ storage_directory: directory }); expect(prepare).toThrow(/storage must be separate/);
  });
  it("propagates runtime artifact admission failure without preparing any process", () => {
    controlled.capture.mockImplementation(() => { throw Error("Controlled artifact mismatch"); });
    expect(prepare).toThrow(/artifact mismatch/); expect(controlled.revoke).not.toHaveBeenCalled();
    expect(controlled.runtimePrepare).not.toHaveBeenCalled(); expect(controlled.brokerPrepare).not.toHaveBeenCalled();
  });
  it.each(["create-mode", "open-mode", "access", "database", "schema", "product", "data-generation", "service-generation", "artifact"])
    ("rejects divergent create/open configuration bindings: %s", variant => {
      const change: Record<string, unknown> = variant === "create-mode" ? { mode: "open" } : variant === "open-mode" ? { mode: "create" }
        : variant === "access" ? { maximumAccess: "read" } : variant === "database" ? { databasePath: `${storage}\\other.sqlite` }
          : variant === "schema" ? { schemaJson: schemaJson.replace('"value"', '"other"') }
            : { scope: { ...scope, ...(variant === "product" ? { product_id: "p2" } : variant === "data-generation" ? { data_generation: "d2" }
              : variant === "service-generation" ? { service_generation: 2 } : { artifact_digest: `sha256:${"c".repeat(64)}` }) } };
      if (variant === "create-mode") saveConfiguration(change); else saveConfiguration({}, change);
      expect(prepare).toThrow(/create\/open bindings differ/);
    });
  it.each([{ schemaJson: "{}" }, { scope: { ...scope, artifact_digest: "unmeasured" } }, { scope: { ...scope, service_generation: 0 } }])
    ("rejects invalid common broker configuration %j", change => { saveConfiguration(change, change); expect(prepare).toThrow(); });
  it("binds broker artifact digest to the admitted runtime expectation", () => {
    const change = { scope: { ...scope, artifact_digest: `sha256:${"c".repeat(64)}` } }; saveConfiguration(change, change);
    expect(prepare).toThrow(/runtime and broker artifact bindings differ/);
  });
  it("binds HTTP maximum access to the actual fixed broker configuration", () => {
    saveProfile({ http: { ...profile().http, access: "read" } }); expect(prepare).toThrow(/create\/open bindings differ/);
  });
  it.each([`${storage}\\nested\\data.sqlite`, "C:\\products\\one\\data.sqlite"])("requires a direct child store at %s", databasePath => {
    saveConfiguration({ databasePath }, { databasePath }); expect(prepare).toThrow(/direct child of storage/);
  });
  it("prepares create only for an absent store and never opens or creates it itself", () => {
    controlled.nodes.delete(database); const token = prepare();
    expect(prepareProfileApplicationBroker(token, "create")).toBeDefined();
    expect(controlled.brokerPrepare.mock.calls[0]![0].configuration).toEqual(pin(createConfig));
    expect(controlled.nodes.has(database)).toBe(false); expect(controlled.opened).not.toContain(database);
  });
  it("refuses create for an existing store rather than overwriting it", () => {
    const token = prepare(), existing = controlled.nodes.get(database);
    expect(() => prepareProfileApplicationBroker(token, "create")).toThrow(/already exists/);
    expect(controlled.nodes.get(database)).toBe(existing); expect(controlled.brokerPrepare).not.toHaveBeenCalled();
  });
  it.each(["runtime", "broker", "open-store"])("requires an existing store for %s", action => {
    controlled.nodes.delete(database); const token = prepare();
    expect(() => action === "runtime" ? prepareProfileApplicationRuntime(token) : action === "broker" ? prepareProfileApplicationBroker(token, "open")
      : assertApplicationServiceOpenStore(token)).toThrow(/Controlled stat failure/);
    expect(controlled.runtimePrepare).not.toHaveBeenCalled(); expect(controlled.brokerPrepare).not.toHaveBeenCalled();
  });
  it.each(["hardlink", "symlink", "alias", "directory"])("refuses an unsafe existing store: %s", variant => {
    const token = prepare(), current = controlled.nodes.get(database)!;
    if (variant === "hardlink") current.nlink = 2n;
    if (variant === "symlink") current.link = true;
    if (variant === "alias") controlled.aliases.set(database, "C:\\other.sqlite");
    if (variant === "directory") current.directory = true;
    expect(() => assertApplicationServiceOpenStore(token)).toThrow(/physical single-link/);
    expect(() => prepareProfileApplicationBroker(token, "create")).toThrow(/physical single-link/);
    expect(controlled.opened).not.toContain(database);
  });
  it("does not reinterpret access failure as an absent store", () => {
    const token = prepare(); controlled.statErrors.set(database, "EACCES");
    expect(() => prepareProfileApplicationBroker(token, "create")).toThrow(/Controlled stat failure/); expect(controlled.brokerPrepare).not.toHaveBeenCalled();
  });
  it("rejects a caller-supplied unsupported store mode", () => {
    const token = prepare(); expect(() => prepareProfileApplicationBroker(token, "replace" as "open")).toThrow(/fixed store mode/);
    expect(controlled.brokerPrepare).not.toHaveBeenCalled();
  });
  it("rejects non-Windows before reading or admitting anything", () => {
    controlled.native = false; expect(prepare).toThrow(/Native Windows/); expect(controlled.opened).toEqual([]); expect(controlled.codePrepare).not.toHaveBeenCalled();
  });
});

describe("explicit same-origin local profile v1", () => {
  it("keeps old profiles API-only and requires the original authority", () => {
    const token = prepare();
    expect(describeApplicationServiceProfile(token).sameOrigin).toBeUndefined();
    expect(() => prepareProfileApplicationClient(token)).toThrow("not enabled");
    expect(() => prepareProfileApplicationClient({} as PreparedApplicationServiceProfile)).toThrow("original local profile");
    expect(controlled.clientReader).not.toHaveBeenCalled();
  });
  it("re-audits and captures a fresh reader from the installed artifact closure for each listener", () => {
    saveProfile({ http: { ...profile().http, same_origin: { version: 1, api_prefix: "/api" } } });
    const token = prepare(), before = controlled.codeAudit.mock.calls.length;
    expect(describeApplicationServiceProfile(token)).toMatchObject({ qualifiedForProduct: false, sameOrigin: { version: 1, apiPrefix: "/api" } });
    const one = prepareProfileApplicationClient(token), two = prepareProfileApplicationClient(token);
    expect(one).not.toBe(two); expect(controlled.clientReader).toHaveBeenCalledTimes(2);
    expect(controlled.codeAudit.mock.calls.length).toBeGreaterThan(before);
    expect(controlled.runtimePrepare).not.toHaveBeenCalled(); expect(controlled.brokerPrepare).not.toHaveBeenCalled();
    controlled.unsafe = installation;
    expect(() => prepareProfileApplicationClient(token)).toThrow("admission rejected");
    expect(controlled.clientReader).toHaveBeenCalledTimes(2);
  });
  it.each([{ version: 2, api_prefix: "/api" }, { version: 1, api_prefix: "/" },
    { version: 1, api_prefix: "/api", directory: "C:\\private" }, true, null])("rejects unsupported client routing configuration %j", same_origin => {
    saveProfile({ http: { ...profile().http, same_origin } }); expect(prepare).toThrow();
    expect(controlled.clientReader).not.toHaveBeenCalled();
  });
});

describe("original installed-generation profile handoff", () => {
  it("reuses the original code, Node, storage and backend authorities without preparing a new baseline", () => {
    const installed = managed(), token = prepareInstalledApplicationServiceProfile(installed.token);
    expect(describeApplicationServiceProfile(token)).toMatchObject({ qualifiedForProduct: false, maximumAccess: "write" });
    assertApplicationServiceOpenStore(token);
    expect(prepareProfileApplicationRuntime(token)).not.toBe(prepareProfileApplicationRuntime(token));
    expect(prepareProfileApplicationBroker(token, "open")).not.toBe(prepareProfileApplicationBroker(token, "open"));
    expect(controlled.codePrepare).not.toHaveBeenCalled(); expect(controlled.storePrepare).not.toHaveBeenCalled();
    expect(controlled.codeAssert.mock.calls.every(([authority]) => authority === installed.binding.code || authority === installed.binding.nodeCode)).toBe(true);
    expect(controlled.storeAssert.mock.calls.every(([authority]) => authority === installed.binding.storage)).toBe(true);
    expect(controlled.backendAssert.mock.calls.every(([authority]) => authority === installed.binding.backend)).toBe(true);
    expect(controlled.installationAudit).toHaveBeenCalledWith(installed.token);
    expect(controlled.installationInvalidate).not.toHaveBeenCalled(); expect(controlled.opened).not.toContain(database);
  });
  it.each([{ version: 1, generation_id: generationId }, { version: 2, generation_id: generationId }, null, "managed"])(
    "rejects every managed tag through the legacy file-only entry: %j", installation => {
      saveProfile({ installation }); expect(prepare).toThrow();
      expect(controlled.installationDescribe).not.toHaveBeenCalled();
      expect(controlled.runtimePrepare).not.toHaveBeenCalled(); expect(controlled.brokerPrepare).not.toHaveBeenCalled();
    });
  it.each([undefined, { version: 2, generation_id: generationId }, { version: 1, generation_id: "another-generation" },
    { version: 1, generation_id: generationId, bypass: true }])("requires the exact versioned original generation tag: %j", installation => {
    const installed = managed({ installation });
    expect(() => prepareInstalledApplicationServiceProfile(installed.token)).toThrow();
    expect(controlled.installations.get(installed.token)!.failed).toBe(true);
    expect(controlled.codePrepare).not.toHaveBeenCalled(); expect(controlled.storePrepare).not.toHaveBeenCalled();
  });
  it.each(["profile-only", "profile-and-referenced-pins"])("compares the independently fixed profile before trusting rewritten %s", variant => {
    const installed = managed();
    if (variant === "profile-and-referenced-pins") controlled.nodes.get(runtimeEntry)!.bytes = Buffer.from("replacement runtime");
    add(managedFile, JSON.stringify({ ...profile(), node_id: variant === "profile-only" ? "node2" : "node1",
      installation: { version: 1, generation_id: generationId } }));
    expect(() => prepareInstalledApplicationServiceProfile(installed.token)).toThrow("independently selected installation pin");
    expect(controlled.opened).toEqual([managedFile]);
    expect(controlled.installations.get(installed.token)!.failed).toBe(true); expect(controlled.helperLoad).not.toHaveBeenCalled();
    expect(controlled.codePrepare).not.toHaveBeenCalled(); expect(controlled.storePrepare).not.toHaveBeenCalled();
  });
  it("requires the profile itself at the original code root", () => {
    saveProfile({ installation: { version: 1, generation_id: generationId } });
    const installed = managed({}, { profile: pin(file) });
    expect(() => prepareInstalledApplicationServiceProfile(installed.token)).toThrow("original file at the code root");
    expect(controlled.opened).toEqual([]); expect(controlled.installations.get(installed.token)!.failed).toBe(true);
  });
  it.each(["node", "storage", "node-directory"])("requires independently selected installation destinations: %s", variant => {
    const installed = managed({}, variant === "node" ? { node: { ...pin(node), sha256: `sha256:${"c".repeat(64)}` } }
      : variant === "storage" ? { storageDirectory: "C:\\node\\other-store" } : { nodeDirectory: "C:\\node\\other-runtime" });
    expect(() => prepareInstalledApplicationServiceProfile(installed.token)).toThrow("original installation destinations or Node selection");
    expect(controlled.installations.get(installed.token)!.failed).toBe(true);
  });
  it("rejects forged, deserialized and already failed installation tokens before opening files", () => {
    const installed = managed(); controlled.installationInvalidate(installed.token);
    for (const token of [{} as PreparedApplicationInstallation, JSON.parse(JSON.stringify(installed.token)), installed.token])
      expect(() => prepareInstalledApplicationServiceProfile(token)).toThrow("Original controlled installation authority");
    expect(controlled.opened).toEqual([]); expect(controlled.codePrepare).not.toHaveBeenCalled();
  });
  it.each(["read", "close"])("keeps strict ctime rejection during the first installed profile %s", phase => {
    const installed = managed(), mutate = (path: string, value: Node) => { if (path === managedFile) value.ctimeNs++; };
    if (phase === "read") controlled.afterRead = mutate; else controlled.afterClose = mutate;
    expect(() => prepareInstalledApplicationServiceProfile(installed.token)).toThrow(`changed during ${phase}`);
    expect(controlled.opened.filter(path => path === managedFile)).toHaveLength(1);
    expect(controlled.installations.get(installed.token)!.failed).toBe(true); expect(controlled.codePrepare).not.toHaveBeenCalled();
  });
  it("retains the original integrity error and permanently invalidates the derived profile", () => {
    const installed = managed(), token = prepareInstalledApplicationServiceProfile(installed.token), original = Error("Controlled original integrity failure");
    controlled.runtimePrepare.mockImplementation(() => { throw original; });
    let caught; try { prepareProfileApplicationRuntime(token); } catch (error) { caught = error; }
    expect(caught).toBe(original); expect(controlled.installations.get(installed.token)!.failed).toBe(true);
    expect(() => describeApplicationServiceProfile(token)).toThrow("Original controlled installation authority");
    expect(() => prepareInstalledApplicationServiceProfile(installed.token)).toThrow("Original controlled installation authority");
    expect(controlled.codePrepare).not.toHaveBeenCalled();
  });
  it("guards the original callbacks retained by prepared runtime and broker objects after generation revocation", () => {
    const installed = managed(), token = prepareInstalledApplicationServiceProfile(installed.token);
    prepareProfileApplicationRuntime(token); prepareProfileApplicationBroker(token, "open");
    const runtime = controlled.runtimePrepare.mock.calls[0]![0] as ApplicationRuntimeInstallation;
    const broker = controlled.brokerPrepare.mock.calls[0]![0] as ApplicationBrokerInstallation;
    controlled.installationInvalidate(installed.token);
    // Controlled preparation callbacks only; no native launch is performed here.
    for (const check of [runtime.assertLocalAdmission, broker.assertLocalAdmission, broker.native.assertLocalInstallation])
      expect(check).toThrow("Original controlled installation authority");
    expect(() => prepareProfileApplicationRuntime(token)).toThrow("Original controlled installation authority");
    expect(() => prepareProfileApplicationBroker(token, "open")).toThrow("Original controlled installation authority");
    expect(controlled.runtimePrepare).toHaveBeenCalledTimes(1); expect(controlled.brokerPrepare).toHaveBeenCalledTimes(1);
  });
  it("revokes generation authority on later profile byte changes even when size and timestamps match", () => {
    const installed = managed(), token = prepareInstalledApplicationServiceProfile(installed.token);
    const current = controlled.nodes.get(managedFile)!;
    current.bytes = Buffer.from(current.bytes.toString().replace('"node1"', '"node2"'));
    expect(() => assertApplicationServiceOpenStore(token)).toThrow("original profile changed");
    expect(controlled.installations.get(installed.token)!.failed).toBe(true);
    expect(() => describeApplicationServiceProfile(token)).toThrow("Original controlled installation authority");
  });
  it("keeps ordinary data lifecycle and unsupported-client preconditions separate from code integrity", () => {
    const installed = managed(), token = prepareInstalledApplicationServiceProfile(installed.token);
    expect(() => prepareProfileApplicationBroker(token, "create")).toThrow("already exists");
    expect(() => prepareProfileApplicationClient(token)).toThrow("not enabled");
    controlled.nodes.delete(database);
    expect(() => assertApplicationServiceOpenStore(token)).toThrow("Controlled stat failure");
    expect(prepareProfileApplicationBroker(token, "create")).toBeDefined();
    expect(controlled.installationInvalidate).not.toHaveBeenCalled();
  });
  it.each(["physical-file", "permission"])("invalidates on an unsafe store %s rather than treating it as absent", variant => {
    const installed = managed(), token = prepareInstalledApplicationServiceProfile(installed.token);
    if (variant === "physical-file") controlled.nodes.get(database)!.nlink = 2n; else controlled.statErrors.set(database, "EACCES");
    expect(() => assertApplicationServiceOpenStore(token)).toThrow();
    expect(controlled.installations.get(installed.token)!.failed).toBe(true); expect(controlled.brokerPrepare).not.toHaveBeenCalled();
  });
  async function realClient() {
    const real = await vi.importActual<typeof import("./application-artifact-admission.js")>("./application-artifact-admission.js");
    const item = (path: string, text: string) => ({ path, bytes: Buffer.from(text) });
    const input = { source: [item("product/client/index.html", "<h1>installed</h1>"), item("product/server/handler.ts", "export {};")],
      artifacts: [item("client/index.html", "<h1>installed</h1>"), item("server/handler.js", "export {};")],
      toolchain: [item("bootstrap.js", "// controlled bytes")] };
    const digest = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const set = (files: typeof input.source) => {
      const pins = files.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: digest(file.bytes) }))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      return { files: pins, digest: digest(JSON.stringify(pins)) };
    };
    const expected = { version: 1 as const, source: set(input.source), artifacts: set(input.artifacts), toolchain: set(input.toolchain) };
    const change = { scope: { ...scope, artifact_digest: expected.artifacts.digest } }; saveConfiguration(change, change);
    controlled.ownerCreate.mockImplementation(real.createApplicationArtifactOwner);
    controlled.runtimeLoad.mockReturnValue({ config: { expectation: expected }, capture: input, runtimeFiles: [pin(sourceFile)] });
    const installed = managed({ http: { ...profile().http, same_origin: { version: 1, api_prefix: "/api" } } });
    return { installed, token: prepareInstalledApplicationServiceProfile(installed.token) };
  }
  it("registers real artifact readers and revokes issued client bytes on a later integrity failure", async () => {
    const { installed, token } = await realClient(), reader = prepareProfileApplicationClient(token);
    expect(controlled.installationBind).toHaveBeenCalledWith(installed.token, reader);
    expect(Buffer.from(readApplicationClientArtifact(reader, "client/index.html")!).toString()).toBe("<h1>installed</h1>");
    const original = Error("Controlled later artifact failure"); controlled.runtimeLoad.mockImplementation(() => { throw original; });
    let caught; try { prepareProfileApplicationClient(token); } catch (error) { caught = error; }
    expect(caught).toBe(original); expect(() => readApplicationClientArtifact(reader, "client/index.html")).toThrow("client-reader-required");
    expect(() => prepareProfileApplicationClient(token)).toThrow("Original controlled installation authority");
  });
  it("closes a newly created real reader if installation registration rejects, preserving the original error", async () => {
    const { token } = await realClient(), original = Error("Controlled reader registration failure");
    let rejected!: ApplicationClientReader;
    controlled.installationBind.mockImplementation((_token: object, reader: ApplicationClientReader) => { rejected = reader; throw original; });
    let caught; try { prepareProfileApplicationClient(token); } catch (error) { caught = error; }
    expect(caught).toBe(original); expect(() => assertApplicationClientReader(rejected)).toThrow("client-reader-required");
    expect(() => describeApplicationServiceProfile(token)).toThrow("Original controlled installation authority");
  });
});
