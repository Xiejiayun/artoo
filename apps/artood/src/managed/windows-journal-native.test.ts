// Fixed helper transport/response model only; never launches a native process.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ spawn: vi.fn(), assertWindows: vi.fn() }));
vi.mock("node:child_process", () => ({ spawnSync: state.spawn }));
vi.mock("node:fs", () => ({ realpathSync: { native: (path: string) => path } }));
vi.mock("../windows-local-acl.js", () => ({
  assertNativeWindows: state.assertWindows,
  assertCanonicalWindowsPath: (path: string) => {
    if (!/^[A-Z]:\\/u.test(path)) throw new Error("Noncanonical controlled Windows path");
  },
  physicalWindowsDirectory: (path: string) => path,
}));
import {
  assertWindowsJournalProtectedDirectory,
  createWindowsJournalDirectory,
  flushWindowsJournalDirectory,
  readWindowsJournalBootSample,
} from "./windows-journal-native.js";

const bootId = "12345678-1234-1234-1234-123456789abc",
  sid = "S-1-5-21-100-200-300-1001";
const directory = "C:\\private\\journal",
  identity = { dev: "1234567890", ino: "9007199254740993" };
let change: (value: Record<string, unknown>) => unknown;
beforeEach(() => {
  vi.stubEnv("SystemRoot", "C:\\Windows");
  change = (value) => value;
  state.assertWindows.mockReset();
  state.spawn.mockReset().mockImplementation((_exe, _args, options) => {
    const input = JSON.parse(options.input) as { operation: string };
    return {
      status: 0,
      signal: null,
      stdout: JSON.stringify(
        change({
          version: 1,
          operation: input.operation,
          bootId,
          counter: "9007199254740993",
          frequency: "10000000",
          created: true,
          flushed: true,
          protected: true,
          currentSid: sid,
        }),
      ),
    };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("fixed Windows journal native boundary", () => {
  it("retains native decimal precision and authoritative boot identity", () => {
    expect(readWindowsJournalBootSample()).toEqual({ id: `windows-boot-v1:${bootId}`, counterNs: 900719925474099300n });
  });
  it("binds private creation to a fixed hidden system executable with data on stdin", () => {
    const unusual = "C:\\private\\'$(whoami)'";
    createWindowsJournalDirectory(unusual);
    const [executable, args, options] = state.spawn.mock.calls[0]!;
    expect(executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", expect.any(String)]);
    expect(args.join(" ")).not.toContain(unusual);
    expect(JSON.parse(options.input)).toEqual({ version: 1, operation: "create-directory", directory: unusual });
    expect(options).toMatchObject({ shell: false, windowsHide: true, timeout: 2500, maxBuffer: 8192 });
    expect(options.env).not.toHaveProperty("TEMP");
    expect(options.env).not.toHaveProperty("TMP");
  });
  it.each([
    { bootId: "00000000-0000-0000-0000-000000000000" },
    { bootId: "unavailable" },
    { counter: 9007199254740992 },
    { counter: "-1" },
    { frequency: "0" },
    { frequency: "1e7" },
  ])("rejects unusable boot/counter facts: %j", (invalid) => {
    change = (value) => ({ ...value, ...invalid });
    expect(() => readWindowsJournalBootSample()).toThrow(/unavailable/);
  });
  it.each([
    { status: 1 },
    { signal: "SIGTERM" },
    { error: new Error("Timed out") },
    { stdout: "not-json" },
    { stdout: JSON.stringify({ version: 1, operation: "clock", created: true }) },
  ])("rejects unsuccessful or unbound helper completion: %j", (failure) => {
    state.spawn.mockReturnValue({
      status: 0,
      signal: null,
      stdout: JSON.stringify({ version: 1, operation: "create-directory", created: true }),
      ...failure,
    });
    expect(() => createWindowsJournalDirectory(directory)).toThrow();
  });
  it("requires exact successful exclusive-creation evidence", () => {
    change = (value) => ({ ...value, created: "true" });
    expect(() => createWindowsJournalDirectory(directory)).toThrow(/creation/);
  });
  it("binds a real flush to precise device/file identity and current SID", () => {
    assertWindowsJournalProtectedDirectory(directory, sid, identity);
    expect(JSON.parse(state.spawn.mock.calls[0]![2].input)).toEqual({
      version: 1,
      operation: "flush-directory",
      directory,
      ...identity,
    });
  });
  it("does not accept an extra operation/directory/version on an identity object", () => {
    const supplied = { ...identity, operation: "create-directory", directory: "C:\\other", version: 99 };
    flushWindowsJournalDirectory(directory, supplied);
    expect(JSON.parse(state.spawn.mock.calls[0]![2].input)).toEqual({
      version: 1,
      operation: "flush-directory",
      directory,
      ...identity,
    });
  });
  it.each([{ protected: false }, { currentSid: "S-1-5-21-100-200-300-1002" }, { flushed: false }])(
    "rejects incomplete native storage evidence: %j",
    (invalid) => {
      change = (value) => ({ ...value, ...invalid });
      expect(() => assertWindowsJournalProtectedDirectory(directory, sid, identity)).toThrow();
    },
  );
  it("does not turn a refused directory flush into durability", () => {
    state.spawn.mockReturnValue({
      status: 1,
      signal: null,
      stdout: '{"version":1,"error":"windows_journal_native_failed"}',
    });
    expect(() => flushWindowsJournalDirectory(directory, identity)).toThrow(/unqualified/);
  });
  it("rejects malformed native handle identities before starting a helper", () => {
    expect(() => flushWindowsJournalDirectory(directory, { ...identity, ino: "not-an-inode" })).toThrow(/identity/);
    expect(state.spawn).not.toHaveBeenCalled();
  });
  it("retains unsupported Windows platform rejection", () => {
    state.assertWindows.mockImplementation(() => {
      throw new Error("Unsupported Windows platform");
    });
    expect(() => readWindowsJournalBootSample()).toThrow(/Unsupported/);
    expect(state.spawn).not.toHaveBeenCalled();
  });
});
