// Data materializer tests with a controlled original admission/reader. No actual
// filesystem, native helper, SQLite, application execution or browser is used.
import { createHash, randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationInitializationTarget, PreparedApplicationInitializationAdmission } from "./application-bootstrap-admission.js";
import type { ApplicationInstallationPlan } from "./application-installation.js";
import type { ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";

const state = vi.hoisted(() => ({ describe: vi.fn(), read: vi.fn(), forbidden: vi.fn() }));
vi.mock("./application-bootstrap-admission.js", () => ({ describeApplicationInitializationPackage: state.describe,
  readApplicationInitializationFile: state.read }));
// Schemas are real. Model Windows path syntax on non-Windows test hosts, too.
vi.mock("node:path", async original => { const path = await original<typeof import("node:path")>(); return { ...path, isAbsolute: path.win32.isAbsolute }; });
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: state.forbidden, spawnSync: state.forbidden, exec: state.forbidden, execSync: state.forbidden,
  execFile: state.forbidden, execFileSync: state.forbidden, fork: state.forbidden }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(),
  openSync: state.forbidden, closeSync: state.forbidden, readSync: state.forbidden, writeSync: state.forbidden,
  readFileSync: state.forbidden, writeFileSync: state.forbidden, lstatSync: state.forbidden, fstatSync: state.forbidden,
  readdirSync: state.forbidden, mkdirSync: state.forbidden, realpathSync: Object.assign(state.forbidden, { native: state.forbidden }) }));
vi.mock("./application-data-broker.js", () => ({ ApplicationDataBroker: state.forbidden }));
vi.mock("./application-installation.js", () => ({ describeApplicationInstallation: state.forbidden, assertApplicationInstallation: state.forbidden,
  auditApplicationInstallation: state.forbidden, invalidateApplicationInstallation: state.forbidden, bindApplicationInstallationClientReader: state.forbidden }));
import { materializeApplicationInstallationPlan } from "./application-install-package.js";

const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const root = "C:\\package", storage = "C:\\template-store", absolute = (name: string) => win32.join(root, ...name.split("/"));
const path = {
  profile: absolute("service.json"), configuration: absolute("runtime/application-runtime.json"),
  create: absolute("settings/create.json"), open: absolute("settings/open.json"),
  helperManifest: absolute("native/quickjs-native-manifest.json"), vendorManifest: absolute("runtime/vendor/vendor.json"),
  runtime: absolute("runtime/application-runtime.mjs"), broker: absolute("broker/application-broker.mjs"),
  helper: absolute("native/artoo-quickjs-process-host.exe"), helperDependency: absolute("native/host.dll"),
  vendorCode: absolute("runtime/vendor/js/index.js"), vendorWasm: absolute("runtime/vendor/wasm/quickjs.wasm"),
  sourceClient: absolute("source/client.html"), sourceServer: absolute("source/handler.ts"),
  artifactClient: absolute("artifacts/index.html"), artifactServer: absolute("artifacts/handler.js"), toolchain: absolute("toolchain/compiler.js"),
};
beforeEach(() => {
  state.describe.mockReset(); state.read.mockReset(); state.forbidden.mockReset().mockImplementation(() => { throw Error("Real workload forbidden"); });
});
afterEach(() => { expect(state.forbidden).not.toHaveBeenCalled(); });
function fixture(parent = "C:\\installed") {
  const contents = new Map<string, Buffer>();
  const put = (file: string, value: string | Buffer) => { contents.set(file, Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value)); };
  const json = (file: string, value: unknown) => put(file, JSON.stringify(value) + "\n");
  for (const file of Object.values(path)) put(file, `unchanged bytes with C:\\package and C:\\template-store in ${file}`);
  put(path.vendorWasm, Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const pin = (file: string): ApplicationRuntimeFilePin => { const bytes = contents.get(file)!; return { path: file, bytes: bytes.length, sha256: digest(bytes) }; };
  const node: ApplicationRuntimeFilePin = Object.freeze({ path: "C:\\node\\node.exe", bytes: 9, sha256: "sha256:" + "a".repeat(64) });
  const target: ApplicationInitializationTarget = Object.freeze({ parent, sourceManifest: { path: absolute("application-install-package.json"), bytes: 99,
    sha256: "sha256:" + "b".repeat(64) }, nodeId: "node1", allowedRoots: Object.freeze(["C:\\work"]), node,
    backend: Object.freeze({}) as ApplicationInitializationTarget["backend"], hostCode: Object.freeze({}) as ApplicationInitializationTarget["hostCode"], hostDirectory: "C:\\host" });
  const token = Object.freeze({}) as PreparedApplicationInitializationAdmission;
  const owner = (generationId = randomUUID()) => ({ generationId, directory: win32.join(target.parent, generationId, "code"), storageDirectory: win32.join(target.parent, generationId, "store") });
  const helper = { version: 1, format: "artoo.quickjs-native-host.v1", platform: "win32", arch: "x64", entry: "artoo-quickjs-process-host.exe",
    files: [path.helper, path.helperDependency].map(file => ({ ...pin(file), path: win32.basename(file) })) };
  const vendor = { version: 1, format: "artoo.quickjs-runtime-vendor.v1", version_name: "0.32.0", variant: "wasmfile-release-sync", qualified_for_product: false,
    provenance: "C:\\package is literal provenance, not a path to relocate", files: [path.vendorCode, path.vendorWasm].map(file => ({
      ...pin(file), path: win32.relative(win32.dirname(path.vendorManifest), file).split(win32.sep).join("/"), sha256: pin(file).sha256.slice(7),
      url: "https://example.invalid/package", integrity: "controlled-fixture" })) };
  const scope = { product_id: "p1", data_generation: "d1", service_generation: 1, artifact_digest: "sha256:" + "c".repeat(64) };
  const runtime = { version: 1, protocol: "artoo.application-runtime.v1", vendorManifest: pin(path.vendorManifest),
    expectation: { version: 1, artifacts: { digest: scope.artifact_digest }, literal: root },
    source: [{ logicalPath: "product/client/index.html", file: pin(path.sourceClient) }, { logicalPath: "product/server/handler.ts", file: pin(path.sourceServer) }],
    artifacts: [{ logicalPath: "client/index.html", file: pin(path.artifactClient) }, { logicalPath: "server/handler.js", file: pin(path.artifactServer) }],
    toolchain: [{ logicalPath: "compiler.js", file: pin(path.toolchain) }] };
  const common = { version: 1, protocol: "artoo.application-broker.v1", databasePath: storage + "\\records.sqlite",
    schemaJson: JSON.stringify({ version: 1, tables: [{ name: "items", columns: [{ name: "value", type: "text", max_bytes: 64, nullable: false }] }] }),
    scope, maximumAccess: "write" };
  const create = { ...common, mode: "create" }, open = { ...common, mode: "open" };
  const profile = { version: 1, format: "artoo.application-service-profile.v1", node_id: target.nodeId, writable_workspace_roots: [...target.allowedRoots],
    installation: { version: 1, generation_id: "previous-generation" }, installation_directory: root, storage_directory: storage,
    runtime: { helper: pin(path.helper), helperManifest: pin(path.helperManifest), node: { ...node }, entry: pin(path.runtime), configuration: pin(path.configuration) },
    broker: { node: { ...node }, entry: pin(path.broker), create_configuration: pin(path.create), open_configuration: pin(path.open) },
    http: { origin: "http://127.0.0.1:31000", timeout_ms: 30000, maximum_concurrent: 1, access: "write", same_origin: { version: 1, api_prefix: "/api" } } };
  let pkg: { directory: string; profile: ApplicationRuntimeFilePin; files: { path: string; bytes: number; sha256: string }[] };
  const snapshot = () => { pkg = { directory: root, profile: pin(path.profile), files: [...contents].map(([file, bytes]) => ({
    path: win32.relative(root, file).split(win32.sep).join("/"), bytes: bytes.length, sha256: digest(bytes) })) }; };
  const saveProfile = () => { json(path.profile, profile); snapshot(); };
  const save = () => {
    json(path.helperManifest, helper); json(path.vendorManifest, vendor); runtime.vendorManifest = pin(path.vendorManifest);
    json(path.configuration, runtime); json(path.create, create); json(path.open, open);
    profile.runtime.configuration = pin(path.configuration); profile.runtime.helperManifest = pin(path.helperManifest);
    profile.broker.create_configuration = pin(path.create); profile.broker.open_configuration = pin(path.open); saveProfile();
  };
  const assert = (original: unknown, selected: ApplicationInitializationTarget) => {
    if (original !== token || selected.backend !== target.backend || selected.hostCode !== target.hostCode || JSON.stringify(selected) !== JSON.stringify(target))
      throw Error("Original initialization authority required");
  };
  state.describe.mockImplementation((original, selected) => { assert(original, selected); return pkg; });
  state.read.mockImplementation((original, selected, file) => { assert(original, selected); const bytes = contents.get(file);
    if (!bytes) throw Error("Missing selected original file"); return Buffer.from(bytes); });
  save();
  return { target, token, owner, contents, pin, put, json, snapshot, saveProfile, save, runtime, create, open, profile, helper, vendor,
    get pkg() { return pkg; }, run(destination = owner()) { return materializeApplicationInstallationPlan(token, target, destination); } };
}
function generated(plan: ApplicationInstallationPlan, name: string) {
  const file = plan.files.find(file => file.path === name); if (!file || !("content" in file)) throw Error("Generated member expected");
  expect(file.bytes).toBe(file.content.byteLength); expect(file.sha256).toBe(digest(file.content));
  return JSON.parse(Buffer.from(file.content).toString("utf8"));
}

describe("fixed initialization package data materializer", () => {
  it("generates four bounded configurations for a fresh owner and retains every other source pin", () => {
    const f = fixture(), owner = f.owner(), before = new Map([...f.contents].map(([file, bytes]) => [file, Buffer.from(bytes)])), plan = f.run(owner);
    const service = generated(plan, "service.json"), runtime = generated(plan, "runtime/application-runtime.json");
    expect(plan.files.filter(file => "content" in file)).toHaveLength(4); expect(plan.files).toHaveLength(f.pkg.files.length);
    expect(service).toEqual({ ...f.profile, installation: { version: 1, generation_id: owner.generationId }, installation_directory: owner.directory,
      storage_directory: owner.storageDirectory, runtime: expect.objectContaining({ node: f.target.node }), broker: expect.objectContaining({ node: f.target.node }) });
    const relocated = (original: ApplicationRuntimeFilePin) => ({ ...original, path: win32.join(owner.directory, win32.relative(root, original.path)) });
    const generatedPin = (name: string) => { const file = plan.files.find(member => member.path === name)!;
      return { path: win32.join(owner.directory, ...name.split("/")), bytes: file.bytes, sha256: file.sha256 }; };
    expect(service.runtime).toEqual({ ...f.profile.runtime, helper: relocated(f.profile.runtime.helper), helperManifest: relocated(f.profile.runtime.helperManifest),
      entry: relocated(f.profile.runtime.entry), configuration: generatedPin("runtime/application-runtime.json") });
    expect(service.broker).toEqual({ ...f.profile.broker, entry: relocated(f.profile.broker.entry),
      create_configuration: generatedPin("settings/create.json"), open_configuration: generatedPin("settings/open.json") });
    expect(runtime.vendorManifest).toEqual(relocated(f.runtime.vendorManifest));
    expect(runtime.expectation).toEqual(f.runtime.expectation);
    for (const name of ["source", "artifacts", "toolchain"] as const) runtime[name].forEach((value: { logicalPath: string; file: ApplicationRuntimeFilePin }, index: number) => {
      const original = f.runtime[name][index]!; expect(value.logicalPath).toBe(original.logicalPath);
      expect(value.file).toEqual({ ...original.file, path: win32.join(owner.directory, win32.relative(root, original.file.path)) });
    });
    expect(generated(plan, "settings/create.json")).toEqual({ ...f.create, databasePath: owner.storageDirectory + "\\records.sqlite" });
    expect(generated(plan, "settings/open.json")).toEqual({ ...f.open, databasePath: owner.storageDirectory + "\\records.sqlite" });
    for (const file of plan.files) if ("source" in file) expect(file.source).toEqual(f.pin(absolute(file.path)));
    expect(plan.profile).toEqual({ path: owner.directory + "\\service.json", bytes: plan.files.find(file => file.path === "service.json")!.bytes,
      sha256: plan.files.find(file => file.path === "service.json")!.sha256 });
    expect(plan.directories).toEqual(["artifacts", "broker", "native", "runtime", "runtime/vendor", "runtime/vendor/js", "runtime/vendor/wasm", "settings", "source", "toolchain"]);
    expect(f.contents).toEqual(before); expect(state.describe).toHaveBeenCalledTimes(2);
    expect(state.read.mock.calls.map(call => call[2]).sort()).toEqual([path.profile, path.configuration, path.create, path.open, path.helperManifest, path.vendorManifest].sort());
    for (const call of state.read.mock.calls) { expect(call[0]).toBe(f.token); expect(call[1]).toBe(f.target); }
  });
  it("computes different final profile pins for different random generations without rewriting preserved manifests", () => {
    const f = fixture(), a = f.run(), b = f.run(); expect(a.profile.path).not.toBe(b.profile.path); expect(a.profile.sha256).not.toBe(b.profile.sha256);
    for (const name of ["native/quickjs-native-manifest.json", "runtime/vendor/vendor.json", "artifacts/handler.js"]) {
      const left = a.files.find(file => file.path === name), right = b.files.find(file => file.path === name);
      expect(left).toEqual(right); expect(left).toHaveProperty("source"); expect(left).not.toHaveProperty("content");
    }
  });
  it("accepts a source profile without an old generation tag", () => {
    const f = fixture(); Reflect.deleteProperty(f.profile, "installation"); f.saveProfile();
    const owner = f.owner(); expect(generated(f.run(owner), "service.json").installation).toEqual({ version: 1, generation_id: owner.generationId });
  });
  it.each(["../outside.js", "C:/outside.js", "source\\outside.js", "source/../outside.js", "source/NUL", "source/a."])("rejects package member path %s", value => {
    const f = fixture(); f.pkg.files.push({ path: value, bytes: 1, sha256: "sha256:" + "d".repeat(64) }); expect(() => f.run()).toThrow("path escapes or aliases");
  });
  it("rejects case-aliased complete package members", () => {
    const f = fixture(); f.pkg.files.push({ ...f.pkg.files[0]!, path: f.pkg.files[0]!.path.toUpperCase() }); expect(() => f.run()).toThrow("path escapes or aliases");
  });
  it.each(["path", "bytes", "sha256"])("rejects a runtime reference with changed %s", field => {
    const f = fixture(), pin = f.runtime.source[0]!.file;
    if (field === "path") pin.path = "C:\\outside\\client.html";
    else if (field === "bytes") pin.bytes++;
    else pin.sha256 = "sha256:" + "e".repeat(64);
    f.save(); expect(() => f.run()).toThrow("reference differs from complete package manifest");
  });
  it.each(["runtime", "broker"])("rejects a different selected Node in the %s profile", group => {
    const f = fixture(); f.profile[group as "runtime" | "broker"].node.path = "C:\\other-node\\node.exe"; f.saveProfile();
    expect(() => f.run()).toThrow("profile differs from selected package or node");
  });
  it.each(["node-id", "roots", "installation-directory"])("rejects changed profile %s", field => {
    const f = fixture(); if (field === "node-id") f.profile.node_id = "other";
    else if (field === "roots") f.profile.writable_workspace_roots.push("C:\\undeclared"); else f.profile.installation_directory = "C:\\elsewhere";
    f.saveProfile(); expect(() => f.run()).toThrow("profile differs from selected package or node");
  });
  it.each(["create-mode", "schema", "access", "database", "scope"])("rejects differing create/open %s", field => {
    const f = fixture(); if (field === "create-mode") f.create.mode = "open";
    else if (field === "schema") f.open.schemaJson += " "; else if (field === "access") f.open.maximumAccess = "read";
    else if (field === "database") f.open.databasePath = storage + "\\other.sqlite"; else f.open.scope = { ...f.open.scope, product_id: "other" };
    f.save(); expect(() => f.run()).toThrow("create and open configuration bindings differ");
  });
  it("rejects a database outside the selected source storage directory", () => {
    const f = fixture(); f.create.databasePath = f.open.databasePath = "C:\\outside\\records.sqlite"; f.save();
    expect(() => f.run()).toThrow("database must be a direct storage child");
  });
  it.each([root, root + "\\store", "C:\\node", "C:\\node\\store", "C:\\"])("rejects source storage overlapping protected code: %s", directory => {
    const f = fixture(); f.profile.storage_directory = directory;
    f.create.databasePath = f.open.databasePath = win32.join(directory, "records.sqlite"); f.save();
    expect(() => f.run()).toThrow("source storage must be separate from package and Node code");
  });
  it("does not copy an old database packaged under the source code tree", () => {
    const f = fixture(), directory = absolute("store"); f.profile.storage_directory = directory;
    f.create.databasePath = f.open.databasePath = win32.join(directory, "records.sqlite");
    f.put(f.open.databasePath, "existing controlled database bytes"); f.save();
    expect(() => f.run()).toThrow("source storage must be separate from package and Node code");
  });
  it("rejects output destinations outside the original generation", () => {
    const f = fixture(), owner = f.owner(); expect(() => f.run({ ...owner, directory: "C:\\escape\\code" })).toThrow("original generation destinations required");
    expect(() => f.run({ ...owner, storageDirectory: owner.directory })).toThrow("original generation destinations required");
  });
  it("rejects aliased generated files before reinterpreting their contents", () => {
    const f = fixture(); f.profile.broker.create_configuration = { ...f.profile.broker.open_configuration }; f.saveProfile();
    expect(() => f.run()).toThrow("four distinct generated configuration paths required");
  });
  it("rejects a retained product reference to a configuration that would be regenerated", () => {
    const f = fixture(); f.runtime.source[0]!.file = f.pin(path.create); f.save();
    expect(() => f.run()).toThrow("retained file references a generated configuration");
  });
  it.each(["vendor", "helper"])("rejects an incorrect nested %s manifest pin", type => {
    const f = fixture(); (type === "vendor" ? f.vendor.files[0]! : f.helper.files[0]!).bytes++; f.save();
    expect(() => f.run()).toThrow("reference differs from complete package manifest");
  });
  it.each(["vendor", "helper"])("rejects traversal in a nested %s manifest", type => {
    const f = fixture(); (type === "vendor" ? f.vendor.files[0]! : f.helper.files[0]!).path = "../escape.js"; f.save();
    expect(() => f.run()).toThrow("member escapes package");
  });
  it("rejects an unlisted helper dependency in the full package", () => {
    const f = fixture(); f.put(absolute("native/extra.dll"), "not in helper manifest"); f.snapshot(); expect(() => f.run()).toThrow("complete helper inventory differs");
  });
  it("rejects a source profile that is not a direct package child", () => {
    const f = fixture(), moved = absolute("settings/service.json"); f.put(moved, f.contents.get(path.profile)!); f.snapshot(); f.pkg.profile = f.pin(moved);
    expect(() => f.run()).toThrow("profile must be a direct package child");
  });
  it("rejects bytes changed after the original package description", () => {
    const f = fixture(); f.put(path.configuration, Buffer.concat([f.contents.get(path.configuration)!, Buffer.from(" ")]));
    expect(() => f.run()).toThrow("configuration bytes differ from original pin");
  });
  it("rejects invalid UTF-8 even when its byte count and hash match the package", () => {
    const f = fixture(); f.put(path.configuration, Buffer.from([0xff])); f.profile.runtime.configuration = f.pin(path.configuration); f.saveProfile();
    expect(() => f.run()).toThrow();
  });
  it("rejects a generated configuration that exceeds the bound after path expansion", () => {
    const f = fixture("C:\\" + Array(30).fill("p".repeat(60)).join("\\"));
    f.runtime.source = Array.from({ length: 60 }, (_, index) => ({ logicalPath: `product/client/file${index}.html`, file: f.pin(path.sourceClient) }));
    f.save(); expect(f.pin(path.configuration).bytes).toBeLessThan(65_536); expect(() => f.run()).toThrow("generated configuration exceeds byte bound");
  });
  it("rejects invalid data schemas even when create and open agree", () => {
    const f = fixture(); f.create.schemaJson = f.open.schemaJson = "{}"; f.save(); expect(() => f.run()).toThrow("invalid-schema");
  });
  it("propagates failure of the original strict reader without outputting a plan", () => {
    const f = fixture(), failure = Error("original read/close failed"); state.read.mockImplementationOnce(() => { throw failure; });
    expect(() => f.run()).toThrow(failure); expect(state.read).toHaveBeenCalledOnce();
  });
  it("performs a final original admission check after materialization", () => {
    const f = fixture(), failure = Error("selection changed during materialization");
    state.describe.mockImplementationOnce(() => f.pkg).mockImplementationOnce(() => { throw failure; }); expect(() => f.run()).toThrow(failure);
  });
  it("rejects copied initialization authorities and changed target objects", () => {
    const f = fixture(); expect(() => materializeApplicationInstallationPlan({ ...f.token }, f.target, f.owner())).toThrow("Original initialization authority required");
    expect(() => materializeApplicationInstallationPlan(f.token, { ...f.target, nodeId: "other" }, f.owner())).toThrow("Original initialization authority required");
    expect(state.read).not.toHaveBeenCalled();
  });
  it.each(["runtime", "profile", "broker"])("rejects undeclared fields in the strict %s configuration", group => {
    const f = fixture(); Object.assign(group === "runtime" ? f.runtime : group === "profile" ? f.profile : f.open, { execute: "anything" }); f.save();
    expect(() => f.run()).toThrow();
  });
  it("rejects a changed artifact binding while preserving arbitrary expectation metadata", () => {
    const f = fixture(); f.runtime.expectation.artifacts.digest = "sha256:" + "f".repeat(64); f.save();
    expect(() => f.run()).toThrow("runtime and broker artifact bindings differ");
  });
});
