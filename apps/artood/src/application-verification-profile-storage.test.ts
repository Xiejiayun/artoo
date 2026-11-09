// Actual application-profile composition with controlled storage/code and file
// readers. This does not qualify native ACLs, collector timing or publication.
import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";

const controlled = vi.hoisted(() => ({ files: new Map<string, Buffer>(), directories: new Set<string>(),
  storage: new Map<object, { directory: string; roots: readonly string[] }>(),
  code: new Map<object, string>(), failStorage: "", afterStorage: () => {},
  readPin: vi.fn(), compiler: vi.fn(), helper: vi.fn(), storagePrepare: vi.fn(), storageBatch: vi.fn(),
  codePrepare: vi.fn(), codeBatch: vi.fn(), forbidden: vi.fn(),
}));
// Schemas are real. Model Windows path syntax on non-Windows test hosts, too.
vi.mock("node:path", async original => { const path = await original<typeof import("node:path")>(); return { ...path, isAbsolute: path.win32.isAbsolute }; });
vi.mock("node:child_process", () => ({ spawn: controlled.forbidden, spawnSync: controlled.forbidden,
  exec: controlled.forbidden, execFile: controlled.forbidden, fork: controlled.forbidden }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(),
  readdirSync: (directory: string) => {
    if (!controlled.directories.has(directory)) throw Error("Missing controlled directory");
    const children = [...controlled.directories, ...controlled.files.keys()].filter(file => win32.dirname(file) === directory && file !== directory);
    return children.map(file => ({ name: win32.basename(file), isSymbolicLink: () => false,
      isDirectory: () => controlled.directories.has(file), isFile: () => controlled.files.has(file) }));
  },
}));
vi.mock("./application-runtime-installation.js", async original => ({
  ...await original<typeof import("./application-runtime-installation.js")>(),
  readApplicationRuntimePin: controlled.readPin, loadApplicationRuntimeHelperManifest: controlled.helper,
}));
vi.mock("./application-compiler-installation.js", () => ({ loadApplicationCompilerConfiguration: controlled.compiler }));
vi.mock("./windows-code-installation.js", () => ({ prepareWindowsCodeInstallation: controlled.codePrepare,
  auditWindowsCodeInstallationBatch: controlled.codeBatch }));
vi.mock("./windows-release-storage.js", () => ({ prepareWindowsReleaseStorage: controlled.storagePrepare,
  auditWindowsReleaseStorageBatch: controlled.storageBatch }));
vi.mock("./windows-local-acl.js", () => ({ assertNativeWindows: () => {},
  assertCanonicalWindowsPath: (file: string) => {
    if (!/^[A-Z]:\\/u.test(file) || win32.normalize(file) !== file) throw Error("Controlled canonical path required");
  },
  physicalWindowsDirectory: (directory: string) => {
    if (!controlled.directories.has(directory)) throw Error("Missing controlled directory"); return directory;
  },
  windowsPathsOverlap: (left: string, right: string) => {
    const a = left.toLowerCase(), b = right.toLowerCase(); return a === b || a.startsWith(b + "\\") || b.startsWith(a + "\\");
  },
}));
import { prepareApplicationVerificationProfile, readApplicationVerificationProfile,
  type ApplicationVerificationConfiguration } from "./application-verification-profile.js";

const architecture = Object.getOwnPropertyDescriptor(process, "arch")!;
const roots = ["C:\\work\\one", "C:\\work\\two"];
const storageDirectories = ["C:\\verification\\candidates", "C:\\verification\\installations", "C:\\verification\\selections"];
const configurationPath = "C:\\protected\\profile\\application.json", browserPath = "C:\\protected\\browser\\chrome.exe";
const sha = (bytes: Uint8Array | string) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
let configuration: ApplicationVerificationConfiguration;
function directory(file: string): void {
  for (let current = file;; current = win32.dirname(current)) {
    controlled.directories.add(current); if (current === win32.dirname(current)) break;
  }
}
function put(file: string, text: string): ApplicationRuntimeFilePin {
  directory(win32.dirname(file)); const bytes = Buffer.from(text); controlled.files.set(file, bytes);
  return { path: file, bytes: bytes.length, sha256: sha(bytes) };
}
function prepare() {
  return prepareApplicationVerificationProfile({ version: 1, configuration: put(configurationPath, JSON.stringify(configuration)) }, roots);
}
beforeEach(() => {
  vi.resetAllMocks(); controlled.files.clear(); controlled.directories.clear(); controlled.code.clear(); controlled.storage.clear();
  controlled.failStorage = ""; controlled.afterStorage = () => {};
  Object.defineProperty(process, "arch", { ...architecture, value: "x64" });
  [...roots, ...storageDirectories].forEach(directory);
  controlled.forbidden.mockImplementation(() => { throw Error("Unexpected process execution in controlled profile test"); });
  controlled.readPin.mockImplementation((pin: ApplicationRuntimeFilePin) => {
    const bytes = controlled.files.get(pin.path);
    if (!bytes || bytes.length !== pin.bytes || sha(bytes) !== pin.sha256) throw Error("Controlled pinned bytes differ");
    return Buffer.from(bytes);
  });
  controlled.compiler.mockReturnValue({ files: [] });
  controlled.helper.mockImplementation((helper: ApplicationRuntimeFilePin, manifest: ApplicationRuntimeFilePin) => [manifest, helper]);
  controlled.codePrepare.mockImplementation(({ directory: selected }: { directory: string }) => {
    if (!controlled.directories.has(selected)) throw Error("Missing controlled code directory");
    const token = Object.freeze({}); controlled.code.set(token, selected); return token;
  });
  controlled.codeBatch.mockImplementation((entries: readonly { code: object; directory: string }[]) => {
    for (const entry of entries) if (controlled.code.get(entry.code) !== entry.directory) throw Error("Original controlled code required");
  });
  controlled.storagePrepare.mockImplementation(({ directory: selected, writableWorkspaceRoots }: { directory: string; writableWorkspaceRoots: readonly string[] }) => {
    const token = Object.freeze({}); controlled.storage.set(token, { directory: selected, roots: [...writableWorkspaceRoots] }); return token;
  });
  controlled.storageBatch.mockImplementation((entries: readonly { storage: object; directory: string }[]) => {
    for (const entry of entries) {
      const saved = controlled.storage.get(entry.storage);
      if (!saved || saved.directory !== entry.directory || JSON.stringify(saved.roots) !== JSON.stringify(roots)
        || entry.directory === controlled.failStorage) throw Error("Original controlled storage rejected");
    }
    controlled.afterStorage();
  });
  const node = put("C:\\protected\\node\\node.exe", "Node"), helper = put("C:\\protected\\native\\artoo-quickjs-process-host.exe", "Native helper");
  const helperManifest = put("C:\\protected\\native\\quickjs-native-manifest.json", "Controlled helper manifest");
  const vendorMember = put("C:\\protected\\vendor\\core\\index.mjs", "Fixed vendor member");
  const vendorManifest = put("C:\\protected\\vendor\\manifest.json", JSON.stringify({ version: 1,
    format: "artoo.quickjs-runtime-vendor.v1", version_name: "0.32.0", variant: "wasmfile-release-sync",
    qualified_for_product: false, provenance: "Controlled fixed vendor",
    files: [{ path: "core/index.mjs", bytes: vendorMember.bytes, sha256: vendorMember.sha256.slice(7), url: "", integrity: "" }] }));
  const hostMembers = [put("C:\\protected\\host\\application-service-bootstrap.mjs", "Fixed bootstrap"),
    put("C:\\protected\\host\\application-service-host-api.mjs", "Fixed host API")];
  const hostManifest = put("C:\\protected\\host\\application-service-host-manifest.json", JSON.stringify({
    version: 1, format: "artoo.application-service-host.v1", platform: "win32", arch: "x64",
    bootstrap: "application-service-bootstrap.mjs", host_api: "application-service-host-api.mjs",
    files: hostMembers.map(pin => ({ ...pin, path: win32.basename(pin.path) })) }));
  configuration = { version: 1, format: "artoo.application-verification-profile.v1", node,
    compiler: { helper, helperManifest, node,
      entry: put("C:\\protected\\compiler\\entry.mjs", "Compiler"), configuration: put("C:\\protected\\compiler\\config.json", "Compiler configuration") },
    runtime: { helper, helperManifest, vendorManifest,
      entry: put("C:\\protected\\runtime\\application-runtime.mjs", "Runtime"),
      guestBootstrap: put("C:\\protected\\guest\\application-runtime-guest-bootstrap.js", "Guest bootstrap") },
    broker: put("C:\\protected\\broker\\application-broker.mjs", "Broker"), browser: put(browserPath, "Browser-A"), hostManifest,
    candidate_parent: storageDirectories[0]!, installation_parent: storageDirectories[1]!, selection_parent: storageDirectories[2]!,
    origin: "http://127.0.0.1:31000", timeout_ms: 600_000, operation_timeout_ms: 30_000, action_timeout_ms: 5_000 };
});
afterEach(() => {
  Object.defineProperty(process, "arch", architecture); expect(controlled.forbidden).not.toHaveBeenCalled();
});

describe("application verification profile storage batch composition", () => {
  it("retains all three original storage authorities and directories on each fresh projection read", () => {
    const token = prepare(), authorities = [...controlled.storage.keys()];
    expect(authorities).toHaveLength(3); expect(new Set(authorities).size).toBe(3);
    expect(controlled.storagePrepare).toHaveBeenCalledTimes(3); controlled.storageBatch.mockClear();
    const projection = readApplicationVerificationProfile(token);
    expect(projection.config).toEqual(configuration); expect(projection).not.toHaveProperty("storage");
    expect(controlled.storageBatch).toHaveBeenCalledOnce();
    const entries = controlled.storageBatch.mock.calls[0]![0] as { storage: object; directory: string }[];
    expect(entries.map(entry => entry.directory)).toEqual(storageDirectories);
    for (const [index, entry] of entries.entries()) expect(entry.storage).toBe(authorities[index]);
    readApplicationVerificationProfile(token);
    expect(controlled.storageBatch).toHaveBeenCalledTimes(2); expect(controlled.storagePrepare).toHaveBeenCalledTimes(3);
  });

  it.each([0, 1, 2])("rejects the entire projection when original storage %i fails", index => {
    const token = prepare(); readApplicationVerificationProfile(token);
    controlled.storageBatch.mockClear(); controlled.readPin.mockClear(); controlled.failStorage = storageDirectories[index]!;
    expect(() => readApplicationVerificationProfile(token)).toThrow("Original controlled storage rejected");
    expect(controlled.storageBatch).toHaveBeenCalledOnce(); expect(controlled.readPin).not.toHaveBeenCalled();
  });

  it("does not return a prepared profile when any initial storage batch fails", () => {
    controlled.failStorage = storageDirectories[1]!;
    expect(prepare).toThrow("Original controlled storage rejected");
    expect(controlled.storagePrepare).toHaveBeenCalledTimes(3); expect(controlled.storageBatch).toHaveBeenCalledOnce();
  });

  it("rejects a same-size pinned byte change after an earlier successful projection", () => {
    const token = prepare(); readApplicationVerificationProfile(token); controlled.storageBatch.mockClear();
    controlled.files.set(browserPath, Buffer.from("Browser-B"));
    expect(() => readApplicationVerificationProfile(token)).toThrow("Controlled pinned bytes differ");
    expect(controlled.storageBatch).toHaveBeenCalledOnce();
  });

  it("still reads the original file pins after the storage batch within the same assertion", () => {
    const token = prepare(); controlled.storageBatch.mockClear();
    controlled.afterStorage = () => { controlled.files.set(browserPath, Buffer.from("Browser-B")); };
    expect(() => readApplicationVerificationProfile(token)).toThrow("Controlled pinned bytes differ");
    expect(controlled.storageBatch).toHaveBeenCalledOnce();
  });
});
