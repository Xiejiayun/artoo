// Controlled authority/transport checks. No real installation, process, browser or provider is started.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
const fixture = vi.hoisted(() => ({
  original: Object.freeze({ fixture: "original-parent-authority" }),
  child: Object.freeze({ fixture: "fresh-child-authority" }),
  describe: vi.fn(), prepare: vi.fn(), aliases: new Map<string, string>(),
}));
vi.mock("node:fs", () => ({ realpathSync: { native: (path: string) => fixture.aliases.get(path) ?? path } }));
vi.mock("./windows-process-installation.js", () => ({
  describeWindowsProcessInstallation: fixture.describe, prepareWindowsProcessInstallation: fixture.prepare,
}));
import { assertWindowsBrowserProcessInstallation, createWindowsBrowserProcessDescriptor,
  prepareWindowsBrowserProcessFromDescriptor } from "./windows-browser-process-authority.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const hash = (character: string) => `sha256:${character.repeat(64)}`;
const expected = { request_id: "verify-original", command_id: "browser", profile_digest: hash("a"),
  subject_digest: hash("b"), workspace_root: "C:\\work\\product" };
const installation = { directory: "C:\\protected\\host", manifestSha256: hash("c"), writableWorkspaceRoots: ["C:\\work"] };
const backend = () => fixture.original as unknown as PreparedWindowsProcessBackend;
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" }); fixture.aliases.clear();
  fixture.describe.mockReset().mockImplementation(value => {
    if (value !== fixture.original) throw new Error("Unqualified installation fixture");
    return structuredClone(installation);
  });
  fixture.prepare.mockReset().mockReturnValue(fixture.child);
});
afterEach(() => Object.defineProperty(process, "platform", platform));

describe("private Windows browser execution handoff", () => {
  it("transfers configuration while requiring fresh child-side qualification", () => {
    const descriptor = createWindowsBrowserProcessDescriptor(backend(), expected);
    expect(descriptor).toEqual({ version: 1, ...expected, installation });
    expect(Object.isFrozen(descriptor.installation.writableWorkspaceRoots)).toBe(true);
    const prepared = prepareWindowsBrowserProcessFromDescriptor(structuredClone(descriptor), expected, true);
    expect(prepared).toBe(fixture.child); expect(prepared).not.toBe(fixture.original);
    expect(fixture.prepare).toHaveBeenCalledExactlyOnceWith(installation);
  });
  it.each(["request_id", "command_id", "profile_digest", "subject_digest", "workspace_root"] as const)(
    "rejects a changed %s before local preparation", field => {
      const descriptor = structuredClone(createWindowsBrowserProcessDescriptor(backend(), expected));
      descriptor[field] = field.endsWith("digest") ? hash("d") : field === "workspace_root" ? "C:\\work\\other" : "other";
      expect(() => prepareWindowsBrowserProcessFromDescriptor(descriptor, expected, true)).toThrow(/binding mismatch/);
      expect(fixture.prepare).not.toHaveBeenCalled();
    });
  it("rejects missing, unsolicited, half-bound and extended descriptors", () => {
    const descriptor = createWindowsBrowserProcessDescriptor(backend(), expected);
    expect(prepareWindowsBrowserProcessFromDescriptor(undefined, undefined, false)).toBeUndefined();
    expect(() => prepareWindowsBrowserProcessFromDescriptor(descriptor, expected, false)).toThrow(/Unsolicited/);
    for (const value of [undefined, { ...descriptor, version: 2 }, { ...descriptor, authority: true },
      { ...descriptor, installation: { ...installation, assertLocalInstallation: "remote callback" } },
      { ...descriptor, installation: { ...installation, writableWorkspaceRoots: [] } }]) {
      expect(() => prepareWindowsBrowserProcessFromDescriptor(value, expected, true)).toThrow();
    }
    expect(fixture.prepare).not.toHaveBeenCalled();
  });
  it("does not promote a copied/generic backend into installation authority", () => {
    expect(() => createWindowsBrowserProcessDescriptor(structuredClone(backend()), expected)).toThrow(/Unqualified/);
    expect(() => assertWindowsBrowserProcessInstallation({} as PreparedWindowsProcessBackend, expected.workspace_root)).toThrow(/Unqualified/);
  });
  it("checks physical workspace coverage before creating or consuming a descriptor", () => {
    expect(() => createWindowsBrowserProcessDescriptor(backend(), { ...expected, workspace_root: "C:\\work-sibling\\product" })).toThrow(/outside/);
    const descriptor = createWindowsBrowserProcessDescriptor(backend(), expected);
    // Original descriptor is frozen; tamper only with a copied transport value.
    const changed = structuredClone(descriptor); changed.installation.writableWorkspaceRoots = ["C:\\other"];
    expect(() => prepareWindowsBrowserProcessFromDescriptor(changed, expected, true)).toThrow(/outside/);
    fixture.aliases.set(expected.workspace_root, "C:\\other");
    expect(() => prepareWindowsBrowserProcessFromDescriptor(descriptor, expected, true)).toThrow(/physical/);
    expect(fixture.prepare).not.toHaveBeenCalled();
  });
  it("propagates fresh local installation failure instead of returning serialized authority", () => {
    const descriptor = createWindowsBrowserProcessDescriptor(backend(), expected);
    fixture.prepare.mockImplementation(() => { throw new Error("Installation changed"); });
    expect(() => prepareWindowsBrowserProcessFromDescriptor(descriptor, expected, true)).toThrow(/Installation changed/);
  });
  it("rejects explicit Windows execution on an unsupported platform", () => {
    const descriptor = createWindowsBrowserProcessDescriptor(backend(), expected);
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    expect(() => createWindowsBrowserProcessDescriptor(backend(), expected)).toThrow(/requires Windows/);
    expect(() => prepareWindowsBrowserProcessFromDescriptor(descriptor, expected, true)).toThrow(/requires Windows/);
    expect(fixture.prepare).not.toHaveBeenCalled();
  });
});
