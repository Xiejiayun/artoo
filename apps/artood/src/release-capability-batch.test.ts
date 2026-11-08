// Real prepared profile identities and protected files, with controlled native
// installation/storage boundaries. No process, browser or listener is started.
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as verification from "./verification.js";
import { attachWindowsVerificationBackend, prepareVerificationProfiles, readWindowsVerificationBackend, readWindowsVerificationBackends,
  type VerificationProfile } from "./verification.js";
import { prepareReleaseProfiles, prepareReleaseCapabilityReader, prepareReleaseCapabilityReaders, readReleaseCapabilities, readReleaseCapabilitiesBatch, type ReleaseProfile } from "./product-release.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import type { PreparedWindowsReleaseStorage } from "./windows-release-storage.js";

const native = vi.hoisted(() => ({ backends: new WeakSet<object>(), revoked: new WeakSet<object>(), imagesChanged: new WeakSet<object>(),
  storage: new WeakMap<object, string>(), fullAudit: vi.fn(), imageAudit: vi.fn(), storageAudit: vi.fn() }));
vi.mock("./owned/windows-owned-process.js", () => ({
  assertWindowsProcessBackend: (backend: object) => {
    native.fullAudit(backend);
    if (!native.backends.has(backend) || native.revoked.has(backend)) throw Error("Controlled native installation revoked");
    if (native.imagesChanged.has(backend)) throw Error("Controlled native image changed");
  },
  assertWindowsProcessBackendImage: (backend: object) => {
    native.imageAudit(backend);
    if (!native.backends.has(backend) || native.imagesChanged.has(backend)) throw Error("Controlled native image changed");
  },
}));
vi.mock("./windows-release-storage.js", () => ({
  assertWindowsReleaseStorage: (storage: object, directory: string) => {
    native.storageAudit(storage, directory);
    if (native.storage.get(storage) !== directory) throw Error("Controlled storage authority revoked");
  },
}));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!, roots: string[] = [];
beforeEach(() => { Object.defineProperty(process, "platform", { ...platform, value: "win32" }); vi.clearAllMocks(); });
afterEach(() => {
  Object.defineProperty(process, "platform", platform); vi.restoreAllMocks();
  const prefix = `${realpathSync.native(tmpdir())}${sep}artoo-release-batch-`;
  for (const root of roots.splice(0)) {
    if (!root.startsWith(prefix) || realpathSync.native(root) !== root) throw Error("Unexpected batch fixture cleanup path");
    rmSync(root, { recursive: true, force: true });
  }
});
const write = (path: string, value: string) => { writeFileSync(path, value); readFileSync(path); };
function fixture(backendIds: readonly number[] = [0, 0], windows = true, capable = true) {
  if (!windows) Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-release-batch-"))); roots.push(root);
  const bindings = new Map<number, PreparedWindowsProcessBackend>();
  const entries = backendIds.map((id, index) => {
    const workspace = join(root, `workspace-${index}`), storage = join(root, `storage-${index}`), evidence = join(root, `evidence-${index}`), config = join(root, `browser-${index}.json`);
    for (const path of [workspace, storage, evidence]) mkdirSync(path);
    write(config, JSON.stringify({ evidence_root: evidence, design_capture_cases: true,
      browser_program: { version: 3, viewports: [{ id: "compact", width: 390, height: 900 }] } }));
    const rawVerifier: VerificationProfile = { id: `verify-${index}`, project_id: "project", workspace_root: workspace,
      required_files: [], subject_paths: ["product", ".artoo/product"],
      measurement_plan_policy: { version: 2, coverage: "every-must-criterion", methods: ["workspace-check", "configured-static-release"] },
      commands: [{ id: "browser", argv: [process.execPath, fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url)), config], timeout_ms: 1000,
        observation: { format: "static-web-acceptance.v3", evidence_root: evidence, capabilities: { version: 1 } } }] };
    const verifier = prepareVerificationProfiles([rawVerifier])[0]!;
    let backend = bindings.get(id);
    if (!backend) { backend = Object.freeze({}) as PreparedWindowsProcessBackend; bindings.set(id, backend); native.backends.add(backend); }
    if (windows) attachWindowsVerificationBackend(verifier, backend);
    const storageAuthority = Object.freeze({}) as PreparedWindowsReleaseStorage; native.storage.set(storageAuthority, storage);
    const raw: ReleaseProfile = { id: `release-${index}`, project_id: "project", verification_profile_id: verifier.id,
      storage_root: storage, output_path: "product", public_url: `http://127.0.0.1:${19000 + index}`, listen_host: "127.0.0.1", listen_port: 19000 + index,
      health_checks: [{ path: "/" }], health_timeout_ms: 1000, ...(capable ? { criterion_acceptance: { version: 1 } as const } : {}) };
    const release = prepareReleaseProfiles([raw], [verifier], windows ? { windowsStorage: new Map([[storage, storageAuthority]]) } : {})[0]!;
    return { verifier, backend, storage, storageAuthority, config, release };
  });
  vi.clearAllMocks();
  return { entries, profiles: entries.map(entry => entry.verifier), releases: entries.map(entry => entry.release) };
}

describe("synchronous native capability batches (controlled boundaries)", () => {
  it("revalidates already prepared Windows profiles in one batch before returning their original identities", () => {
    const f = fixture([0, 0, 1]), input = Object.freeze([...f.profiles]), roots = f.profiles.map(profile => profile.workspace_root);
    const prepared = prepareVerificationProfiles(input, roots);
    expect(prepared).toEqual(input); expect(prepared.every((profile, index) => profile === input[index])).toBe(true);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(native.fullAudit.mock.calls.map(call => call[0])).toEqual([f.entries[0]!.backend, f.entries[2]!.backend]);
    expect(native.imageAudit).toHaveBeenCalledTimes(1);
    prepareVerificationProfiles(input, roots); expect(native.fullAudit).toHaveBeenCalledTimes(4);
    native.revoked.add(f.entries[2]!.backend);
    expect(() => prepareVerificationProfiles(input, roots)).toThrow(/installation revoked/);
  });
  it("preserves prepared-profile ID, write-root and protected-file rejection before returning a reused batch", () => {
    const f = fixture();
    expect(() => prepareVerificationProfiles([f.profiles[0]!, f.profiles[0]!])).toThrow(/duplicate profile id/);
    expect(() => prepareVerificationProfiles(f.profiles, [f.entries[1]!.config])).toThrow(/verifier.*outside|overlaps protected/);
    write(f.entries[1]!.config, `${readFileSync(f.entries[1]!.config, "utf8")} `);
    expect(() => prepareVerificationProfiles(f.profiles)).toThrow(/verifier changed/);
  });
  it("batches eager release reader preparation without retaining audit state in any returned reader", () => {
    const f = fixture([0, 0, 1]), input = [...f.releases], readers = prepareReleaseCapabilityReaders(input);
    expect(Object.isFrozen(readers)).toBe(true); expect(readers.every(Object.isFrozen)).toBe(true);
    expect(readers.map(reader => reader.capabilities.binding.release_profile_id)).toEqual(f.releases.map(profile => profile.id));
    expect(native.fullAudit.mock.calls.map(call => call[0])).toEqual([f.entries[0]!.backend, f.entries[2]!.backend]);
    input.reverse();
    expect(readers[0]!.readCapabilities().binding.release_profile_id).toBe(f.releases[0]!.id);
    expect(native.fullAudit).toHaveBeenCalledTimes(3);
    prepareReleaseCapabilityReaders(f.releases); expect(native.fullAudit).toHaveBeenCalledTimes(5);
    native.revoked.add(f.entries[0]!.backend);
    expect(() => readers[1]!.readCapabilities()).toThrow(/installation revoked/);
    expect(native.fullAudit).toHaveBeenCalledTimes(6);
  });
  it("rejects cloned, non-opted-in and changed release reader preparation inputs", () => {
    const f = fixture();
    expect(() => prepareReleaseCapabilityReaders([f.releases[0]!, structuredClone(f.releases[1]!)])).toThrow(/locally prepared/);
    write(f.entries[1]!.config, `${readFileSync(f.entries[1]!.config, "utf8")} `);
    expect(() => prepareReleaseCapabilityReaders(f.releases)).toThrow(/verifier changed/);
    const legacy = fixture([0], true, false);
    expect(() => prepareReleaseCapabilityReaders(legacy.releases)).toThrow(/does not opt in/);
    expect(() => prepareReleaseCapabilityReader(legacy.releases[0]!)).toThrow(/does not opt in/);
  });
  it("audits one shared backend once while checking each later image and preserving input order", () => {
    const f = fixture([0, 0, 0, 0]), input = Object.freeze([...f.profiles]);
    const result = readWindowsVerificationBackends(input);
    expect(result).toEqual(f.entries.map(entry => entry.backend)); expect(Object.isFrozen(result)).toBe(true);
    expect(input).toEqual(f.profiles); expect(native.fullAudit).toHaveBeenCalledExactlyOnceWith(f.entries[0]!.backend);
    expect(native.imageAudit).toHaveBeenCalledTimes(3);
  });
  it("audits distinct backend objects even when they have equal serialized data, and reaudits every later call", () => {
    const f = fixture([0, 1, 0]);
    readReleaseCapabilitiesBatch(f.releases);
    expect(native.fullAudit.mock.calls.map(call => call[0])).toEqual([f.entries[0]!.backend, f.entries[1]!.backend]);
    readReleaseCapabilitiesBatch(f.releases); expect(native.fullAudit).toHaveBeenCalledTimes(4);
    readReleaseCapabilities(f.releases[0]!); readWindowsVerificationBackend(f.profiles[0]!);
    expect(native.fullAudit).toHaveBeenCalledTimes(6);
  });
  it("keeps independent reader calls fresh after an initial batch", () => {
    const f = fixture(), reader = prepareReleaseCapabilityReader(f.releases[0]!); vi.clearAllMocks();
    const result = readReleaseCapabilitiesBatch(Object.freeze([...f.releases]));
    expect(result.map(value => value!.binding.verification_profile_id)).toEqual(f.profiles.map(profile => profile.id));
    expect(Object.isFrozen(result)).toBe(true); expect(native.fullAudit).toHaveBeenCalledTimes(1);
    native.revoked.add(f.entries[0]!.backend);
    expect(() => reader.readCapabilities()).toThrow(/installation revoked/);
    expect(native.fullAudit).toHaveBeenCalledTimes(2);
  });
  it("fails a later batch if any distinct backend was revoked", () => {
    const f = fixture([0, 1]); readReleaseCapabilitiesBatch(f.releases);
    native.revoked.add(f.entries[1]!.backend); vi.clearAllMocks();
    expect(() => readReleaseCapabilitiesBatch(f.releases)).toThrow(/installation revoked/);
    expect(native.fullAudit.mock.calls.map(call => call[0])).toEqual(f.entries.map(entry => entry.backend));
  });
  it("checks a shared backend's image again for a later member", () => {
    const f = fixture(); native.imageAudit.mockImplementationOnce(backend => { native.imagesChanged.add(backend); });
    expect(() => readReleaseCapabilitiesBatch(f.releases)).toThrow(/image changed/);
    expect(native.fullAudit).toHaveBeenCalledTimes(1); expect(native.imageAudit).toHaveBeenCalledTimes(1);
  });
  it("rejects changed protected files in a later profile sharing the audited backend", () => {
    const f = fixture(); write(f.entries[1]!.config, `${readFileSync(f.entries[1]!.config, "utf8")} `);
    expect(() => readReleaseCapabilitiesBatch(f.releases)).toThrow(/verifier changed/);
    expect(native.fullAudit).toHaveBeenCalledTimes(1);
  });
  it("retains every release's storage authority and physical identity checks", () => {
    const f = fixture(); native.storage.delete(f.entries[1]!.storageAuthority);
    expect(() => readReleaseCapabilitiesBatch(f.releases)).toThrow(/storage authority revoked/);
    native.storage.set(f.entries[1]!.storageAuthority, f.entries[1]!.storage);
    renameSync(f.entries[1]!.storage, `${f.entries[1]!.storage}-old`); mkdirSync(f.entries[1]!.storage);
    expect(() => readReleaseCapabilitiesBatch(f.releases)).toThrow(/physical directory identity changed/);
  });
  it("does not accept serialized release identities or grant an unbound profile a backend", () => {
    const f = fixture();
    expect(() => readReleaseCapabilitiesBatch([f.releases[0]!, structuredClone(f.releases[1]!)])).toThrow(/locally prepared/);
    expect(native.fullAudit).not.toHaveBeenCalled();
    expect(readWindowsVerificationBackends([structuredClone(f.profiles[0]!)])).toEqual([undefined]);
  });
  it("fails closed on Windows without its original native release authority", () => {
    const f = fixture([0], false); Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    expect(() => readReleaseCapabilitiesBatch(f.releases)).toThrow(/locally qualified/);
    expect(native.fullAudit).not.toHaveBeenCalled();
  });
  it.each(["absent", "different"] as const)("rejects an %s verifier backend returned for a release", kind => {
    const f = fixture();
    vi.spyOn(verification, "readWindowsVerificationBackends").mockReturnValue([f.entries[0]!.backend,
      kind === "absent" ? undefined : Object.freeze({}) as PreparedWindowsProcessBackend]);
    expect(() => readReleaseCapabilitiesBatch(f.releases)).toThrow(/backend changed/);
  });
  it("preserves POSIX capability reads without native audits and rejects unsupported platforms", () => {
    const f = fixture([0, 0], false);
    expect(readReleaseCapabilitiesBatch(f.releases)).toEqual(f.releases.map(readReleaseCapabilities));
    expect(native.fullAudit).not.toHaveBeenCalled();
    Object.defineProperty(process, "platform", { ...platform, value: "freebsd" });
    expect(() => readReleaseCapabilitiesBatch(f.releases)).toThrow(/locally qualified/);
  });
  it("preserves capability-absent profiles without native or storage admission", () => {
    const f = fixture([0, 0], true, false); native.revoked.add(f.entries[0]!.backend);
    expect(readReleaseCapabilitiesBatch(f.releases)).toEqual([undefined, undefined]);
    expect(readReleaseCapabilities(f.releases[0]!)).toBeUndefined();
    expect(native.fullAudit).not.toHaveBeenCalled(); expect(native.storageAudit).not.toHaveBeenCalled();
  });
});
