import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeFromConfig, loadConfigFromEnv, validateManagedLaunchSelection } from "./main.js";
import * as bootstrap from "./managed/managed-bootstrap.js";
import * as journal from "./managed/journal.js";
import * as ordinary from "./node-runner.js";

const baseEnv = { ARTOO_NODE_URL: "wss://artoo.example/api/v1/node?token=fixture", ARTOO_NODE_ID: "computer_1",
  ARTOO_ALLOWED_ROOTS: "/Users/fixture", ARTOO_WORKTREE_BASE_REPO: "/Users/fixture/source", ARTOO_RUNTIMES: "codex" };
const preparedEnv = { ...baseEnv, ARTOO_MANAGED_EXECUTION: "0", ARTOO_JOURNAL_VERSION: "1",
  ARTOO_JOURNAL_SERVER_ORIGIN: "https://artoo.example", ARTOO_JOURNAL_NODE_ID: "computer_1",
  ARTOO_JOURNAL_DIRECTORY: "/Users/fixture/Artoo/journal", ARTOO_JOURNAL_NAMESPACE: "saved_namespace",
  ARTOO_JOURNAL_CONTROLLER_SCOPE: "saved_controller" };
const bindingKeys = ["ARTOO_JOURNAL_VERSION", "ARTOO_JOURNAL_SERVER_ORIGIN", "ARTOO_JOURNAL_NODE_ID",
  "ARTOO_JOURNAL_DIRECTORY", "ARTOO_JOURNAL_NAMESPACE", "ARTOO_JOURNAL_CONTROLLER_SCOPE"] as const;
afterEach(() => { vi.restoreAllMocks(); });

describe("prepared managed profile configuration", () => {
  it("keeps missing or explicitly cleared settings on the ordinary default", () => {
    expect(loadConfigFromEnv(baseEnv).managedJournal).toBeUndefined();
    const cleared = { ...baseEnv, ARTOO_MANAGED_EXECUTION: "0", ...Object.fromEntries(bindingKeys.map((key) => [key, ""])) };
    expect(loadConfigFromEnv(cleared).managedJournal).toBeUndefined();
    expect(loadConfigFromEnv(cleared).allowNewAllocations).toBeUndefined();
  });

  it.each(["0", "1"])("preserves the exact saved binding when new-allocation mode is %s", (mode) => {
    const config = loadConfigFromEnv({ ...preparedEnv, ARTOO_MANAGED_EXECUTION: mode });
    expect(config.allowNewAllocations).toBe(mode === "1");
    expect(config.managedJournal).toEqual({ version: 1, serverOrigin: "https://artoo.example", nodeId: "computer_1",
      directory: "/Users/fixture/Artoo/journal", expectedNamespace: "saved_namespace", controllerScope: "saved_controller" });
    expect(Object.isFrozen(config.managedJournal)).toBe(true);
  });

  it("does not infer enablement or a saved identity from inherited partial fields", () => {
    expect(() => loadConfigFromEnv({ ...baseEnv, ARTOO_MANAGED_EXECUTION: "1" })).toThrow("complete saved journal binding");
    expect(() => loadConfigFromEnv({ ...baseEnv, ARTOO_JOURNAL_DIRECTORY: preparedEnv.ARTOO_JOURNAL_DIRECTORY })).toThrow("explicit ARTOO_MANAGED_EXECUTION");
    const withoutMode: NodeJS.ProcessEnv = { ...preparedEnv }; delete withoutMode.ARTOO_MANAGED_EXECUTION;
    expect(() => loadConfigFromEnv(withoutMode)).toThrow("explicit ARTOO_MANAGED_EXECUTION");
    expect(() => loadConfigFromEnv({ ...baseEnv, ARTOO_MANAGED_EXECUTION: "0", ARTOO_JOURNAL_NAMESPACE: "inherited" })).toThrow("Incomplete managed journal binding");
  });

  it.each(["0", "1"])("rejects a complete inherited IPC-child binding without the explicit selector, mode %s", (mode) => {
    const config = loadConfigFromEnv({ ...preparedEnv, ARTOO_MANAGED_EXECUTION: mode });
    expect(() => validateManagedLaunchSelection(config, { ipc: true, args: [] })).toThrow("explicit --prepared-journal");
    expect(() => validateManagedLaunchSelection(config, { ipc: true, args: ["--prepared-journal"] })).not.toThrow();
    expect(() => validateManagedLaunchSelection(config, { ipc: false, args: [] })).not.toThrow();
  });

  it.each([false, true])("the selector cannot invent a journal binding for IPC=%s", (ipc) => {
    const config = loadConfigFromEnv(baseEnv);
    expect(() => validateManagedLaunchSelection(config, { ipc, args: ["--prepared-journal"] })).toThrow("complete saved journal binding");
    expect(() => validateManagedLaunchSelection(config, { ipc, args: [] })).not.toThrow();
  });

  it.each(bindingKeys)("rejects a prepared binding with missing %s instead of deriving it", (key) => {
    const input: NodeJS.ProcessEnv = { ...preparedEnv }; delete input[key];
    expect(() => loadConfigFromEnv(input)).toThrow(key);
  });

  it.each(["true", "false", "yes", " 1 "])("rejects ambiguous managed mode %j", (mode) => {
    expect(() => loadConfigFromEnv({ ...preparedEnv, ARTOO_MANAGED_EXECUTION: mode })).toThrow("must be 0 or 1");
  });

  it.each([
    { ARTOO_JOURNAL_VERSION: "2" },
    { ARTOO_JOURNAL_SERVER_ORIGIN: "https://other.example" },
    { ARTOO_JOURNAL_NODE_ID: "computer_other" },
    { ARTOO_JOURNAL_SERVER_ORIGIN: "https://artoo.example/" },
    { ARTOO_JOURNAL_SERVER_ORIGIN: "https://user:secret@artoo.example" },
    { ARTOO_JOURNAL_DIRECTORY: "relative/journal" },
    { ARTOO_JOURNAL_DIRECTORY: "/Users/fixture/../other" },
    { ARTOO_JOURNAL_DIRECTORY: "/Users/fixture/Artoo/journal/" },
    { ARTOO_JOURNAL_DIRECTORY: "/" },
    { ARTOO_JOURNAL_NAMESPACE: " saved_namespace" },
    { ARTOO_JOURNAL_CONTROLLER_SCOPE: "scope\u0000" },
    { ARTOO_NODE_URL: "wss://artoo.example/another-endpoint?token=fixture" },
    { ARTOO_NODE_URL: "wss://user:secret@artoo.example/api/v1/node" },
  ])("rejects malformed or foreign prepared binding %j", (change) => {
    expect(() => loadConfigFromEnv({ ...preparedEnv, ...change })).toThrow();
  });

  it("allows an exact loopback development origin but rejects nonlocal cleartext", () => {
    expect(loadConfigFromEnv({ ...preparedEnv, ARTOO_NODE_URL: "ws://127.0.0.1:4010/api/v1/node?token=fixture",
      ARTOO_JOURNAL_SERVER_ORIGIN: "http://127.0.0.1:4010" }).managedJournal?.serverOrigin).toBe("http://127.0.0.1:4010");
    expect(() => loadConfigFromEnv({ ...preparedEnv, ARTOO_NODE_URL: "ws://artoo.example/api/v1/node",
      ARTOO_JOURNAL_SERVER_ORIGIN: "http://artoo.example" })).toThrow();
  });

  it("keeps the same saved profile when only the connection token rotates", () => {
    const initial = loadConfigFromEnv(preparedEnv);
    const rotated = loadConfigFromEnv({ ...preparedEnv, ARTOO_NODE_URL: "wss://artoo.example/api/v1/node?token=rotated_fixture" });
    expect(rotated.managedJournal).toEqual(initial.managedJournal); expect(rotated.allowNewAllocations).toBe(false);
  });

  it("constructs the prepared opt-out lifecycle synchronously and lazily, without ordinary fallback", async () => {
    const open = vi.spyOn(journal, "openLocalJournal"), managed = vi.spyOn(bootstrap, "createManagedBootstrap");
    const legacy = vi.spyOn(ordinary, "createArtoodNode"), config = loadConfigFromEnv(preparedEnv);
    const node = createNodeFromConfig(config);
    expect(typeof node.start).toBe("function"); expect(node.failed).toBeInstanceOf(Promise);
    expect(managed).toHaveBeenCalledTimes(1); expect(managed.mock.calls[0]![0]).toMatchObject({ binding: config.managedJournal, allowNewAllocations: false });
    expect(legacy).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); await node.stop(); expect(open).not.toHaveBeenCalled();
  });

  it("retains the ordinary constructor when no saved binding exists", async () => {
    const managed = vi.spyOn(bootstrap, "createManagedBootstrap"), legacy = vi.spyOn(ordinary, "createArtoodNode");
    const node = createNodeFromConfig(loadConfigFromEnv(baseEnv));
    expect(legacy).toHaveBeenCalledTimes(1); expect(managed).not.toHaveBeenCalled(); expect(node.failed).toBeUndefined(); await node.stop();
  });

  it("also validates direct config callers before choosing or constructing a node", () => {
    const config = loadConfigFromEnv(preparedEnv), managed = vi.spyOn(bootstrap, "createManagedBootstrap");
    expect(() => createNodeFromConfig({ ...config, nodeId: "other_computer" })).toThrow("differs from the connection");
    expect(() => createNodeFromConfig({ ...config, url: "wss://other.example/api/v1/node" })).toThrow("differs from the connection");
    expect(() => createNodeFromConfig({ ...config, allowNewAllocations: undefined })).toThrow("explicit new-allocation choice");
    expect(() => createNodeFromConfig({ ...loadConfigFromEnv(baseEnv), allowNewAllocations: true })).toThrow("saved journal binding");
    expect(() => bootstrap.validateManagedJournalBinding({ ...config.managedJournal, extra: true }, config)).toThrow("version or fields");
    expect(() => bootstrap.validateManagedJournalBinding(Object.create(config.managedJournal!), config)).toThrow("version or fields");
    expect(managed).not.toHaveBeenCalled();
  });
});
