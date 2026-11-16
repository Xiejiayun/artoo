// Controlled path/ACL/flush facts only; no filesystem writes or native helpers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowsAclReport, WindowsAclTarget } from "../windows-local-acl.js";
interface Node {
  directory: boolean;
  ino: bigint;
  linked?: boolean;
  links?: bigint;
}
const state = vi.hoisted(() => ({ nodes: new Map<string, Node>(), collect: vi.fn(), flush: vi.fn() }));
vi.mock("node:fs", () => ({
  lstatSync: (path: string) => {
    const value = state.nodes.get(path);
    if (!value) throw new Error("Missing controlled node");
    return {
      dev: 1234567890n,
      ino: value.ino,
      nlink: value.links ?? 1n,
      isDirectory: () => value.directory,
      isFile: () => !value.directory,
      isSymbolicLink: () => !!value.linked,
    };
  },
  realpathSync: { native: (path: string) => path },
}));
vi.mock("../windows-local-acl.js", async (load) => ({
  ...(await load<typeof import("../windows-local-acl.js")>()),
  assertNativeWindows: () => undefined,
  physicalWindowsDirectory: (path: string) => path,
  collectWindowsAclFacts: state.collect,
}));
vi.mock("./windows-journal-native.js", () => ({ assertWindowsJournalProtectedDirectory: state.flush }));
import { inspectWindowsJournalBoundary } from "./windows-journal-boundary.js";

const sid = "S-1-5-21-100-200-300-1001",
  outsider = "S-1-5-21-100-200-300-1002";
const directory = "C:\\node\\private",
  database = `${directory}\\journal.sqlite`,
  marker = `${directory}\\namespace.json`;
let change: (report: WindowsAclReport) => void, afterCollect: () => void;
beforeEach(() => {
  state.nodes.clear();
  state.flush.mockReset();
  change = () => undefined;
  afterCollect = () => undefined;
  for (const [index, path] of ["C:\\", "C:\\node", directory, database, marker].entries()) {
    state.nodes.set(path, { directory: index < 3, ino: 9007199254740993n + BigInt(index) });
  }
  state.collect.mockReset().mockImplementation((targets: readonly WindowsAclTarget[]) => {
    const report: WindowsAclReport = {
      version: 1,
      currentSid: sid,
      nodes: targets.map((target) => ({
        path: target.path,
        directory: target.directory,
        attributes: target.directory ? 16 : 32,
        volumeRoot: "C:\\",
        driveType: "Fixed",
        fileSystem: "NTFS",
        ownerSid: sid,
        daclPresent: true,
        canonical: true,
        aces: [{ sid, qualifier: "AccessAllowed", mask: 0x1f01ff, flags: target.directory ? 3 : 0 }],
      })),
    };
    change(report);
    afterCollect();
    return report;
  });
});

describe("Windows physical journal private storage boundary", () => {
  it("audits all ancestry and preserves native identities with a real-flush boundary", () => {
    const result = inspectWindowsJournalBoundary(directory, ["journal.sqlite", "namespace.json"]);
    expect(result.directoryIdentity).toEqual({ dev: "1234567890", ino: "9007199254740995" });
    expect(result.files.get("journal.sqlite")).toEqual({ dev: "1234567890", ino: "9007199254740996" });
    expect(state.collect.mock.calls[0]![0]).toEqual(
      [...state.nodes].map(([path, value]) => ({ path, directory: value.directory, readAcl: true })),
    );
    expect(state.flush).toHaveBeenCalledWith(directory, sid, result.directoryIdentity);
  });
  it.each([
    [database, 1, 0],
    [directory, 0x80000000, 0],
    [directory, 1, 11],
    ["C:\\node", 0x40, 0],
  ] as const)("rejects foreign access/replacement rights at %s", (path, mask, flags) => {
    change = (report) => {
      report.nodes
        .find((node) => node.path === path)!
        .aces.push({ sid: outsider, qualifier: "AccessAllowed", mask, flags });
    };
    expect(() => inspectWindowsJournalBoundary(directory, ["journal.sqlite"])).toThrow(/Another Windows principal/);
    expect(state.flush).not.toHaveBeenCalled();
  });
  it("permits unrelated sibling-directory creation at an ancestor", () => {
    change = (report) => {
      report.nodes
        .find((node) => node.path === "C:\\")!
        .aces.push({ sid: outsider, qualifier: "AccessAllowed", mask: 4, flags: 0 });
    };
    expect(() => inspectWindowsJournalBoundary(directory)).not.toThrow();
  });
  it("rejects untrusted ownership despite an otherwise private DACL", () => {
    change = (report) => {
      report.nodes.find((node) => node.path === directory)!.ownerSid = outsider;
    };
    expect(() => inspectWindowsJournalBoundary(directory)).toThrow(/untrusted/);
  });
  it.each(["reparse", "hardlink"])("rejects a %s before collecting ACL evidence", (kind) => {
    const node = state.nodes.get(database)!;
    if (kind === "reparse") node.linked = true;
    else node.links = 2n;
    expect(() => inspectWindowsJournalBoundary(directory, ["journal.sqlite"])).toThrow(/linked/);
    expect(state.collect).not.toHaveBeenCalled();
  });
  it("rejects replacement during ACL collection", () => {
    afterCollect = () => {
      state.nodes.get(directory)!.ino++;
    };
    expect(() => inspectWindowsJournalBoundary(directory)).toThrow(/changed during ACL/);
  });
  it("rejects replacement during native protection/flush confirmation", () => {
    state.flush.mockImplementation(() => {
      state.nodes.get(database)!.ino++;
    });
    expect(() => inspectWindowsJournalBoundary(directory, ["journal.sqlite"])).toThrow(/changed during ACL/);
  });
  it("never swallows native protection or durability refusal", () => {
    state.flush.mockImplementation(() => {
      throw new Error("Native directory flush refused");
    });
    expect(() => inspectWindowsJournalBoundary(directory)).toThrow(/flush refused/);
  });
  it("does not reuse previously safe ACL facts", () => {
    inspectWindowsJournalBoundary(directory);
    change = (report) => {
      report.nodes.find((node) => node.path === directory)!.ownerSid = outsider;
    };
    expect(() => inspectWindowsJournalBoundary(directory)).toThrow(/untrusted/);
    expect(state.collect).toHaveBeenCalledTimes(2);
  });
  it("audits a provisioning parent as ancestry without requiring it to be private", () => {
    inspectWindowsJournalBoundary("C:\\node", [], false);
    expect(state.flush).not.toHaveBeenCalled();
    expect(state.collect).toHaveBeenCalledTimes(1);
  });
  it("rejects namespace root adoption and unknown file inventory", () => {
    expect(() => inspectWindowsJournalBoundary("C:\\")).toThrow(/inventory/);
    expect(() => inspectWindowsJournalBoundary(directory, ["caller-supplied.db"])).toThrow(/inventory/);
    expect(state.collect).not.toHaveBeenCalled();
  });
});
