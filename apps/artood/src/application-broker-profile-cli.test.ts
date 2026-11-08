// Entrypoint routing only. The profile suite exercises fixed local policy separately.
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as installation from "./windows-process-installation.js";
import * as profile from "./application-broker-profile.js";
import * as runner from "./node-runner.js";
import * as adapter from "./process-adapter.js";
import * as broker from "./application-broker-process.js";
import { runDaemonEntrypoint, type ShutdownHost } from "./main.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";

const selector = "--check-application-broker-profile", platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const backend = Object.freeze({}) as PreparedWindowsProcessBackend;
const env = { ARTOO_APPLICATION_BROKER_PROFILE_FILE: join(process.cwd(), "local-profile.json"), ARTOO_NODE_ID: "node1",
  ARTOO_ALLOWED_ROOTS: `${process.cwd()};${join(process.cwd(), "other")}`, ARTOO_WINDOWS_PROCESS_BUNDLE: process.cwd(),
  ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256: `sha256:${"a".repeat(64)}` };
function host(args: string[] = [selector]): ShutdownHost {
  return Object.assign(new EventEmitter(), { argv: ["node", "main.js", ...args], exit: vi.fn() });
}
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.spyOn(installation, "prepareWindowsProcessInstallation").mockReturnValue(backend);
  vi.spyOn(profile, "checkApplicationBrokerProfileFile").mockReturnValue(undefined);
  vi.spyOn(runner, "createArtoodNode").mockImplementation(() => { throw Error("Node construction is forbidden in a profile check"); });
  vi.spyOn(adapter, "createProcessAdapter").mockImplementation(() => { throw Error("Runtime construction is forbidden in a profile check"); });
  vi.spyOn(broker, "startApplicationBrokerProcess").mockImplementation(() => { throw Error("Broker startup is forbidden in a profile check"); });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });
describe("standalone broker profile inspection CLI", () => {
  it("branches before normal config, runtime and server construction without a server URL", async () => {
    expect(await runDaemonEntrypoint(env, host())).toBeUndefined();
    expect(installation.prepareWindowsProcessInstallation).toHaveBeenCalledWith({ directory: env.ARTOO_WINDOWS_PROCESS_BUNDLE,
      manifestSha256: env.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256, writableWorkspaceRoots: env.ARTOO_ALLOWED_ROOTS.split(";") });
    expect(profile.checkApplicationBrokerProfileFile).toHaveBeenCalledWith({ file: env.ARTOO_APPLICATION_BROKER_PROFILE_FILE,
      nodeId: "node1", allowedRoots: env.ARTOO_ALLOWED_ROOTS.split(";"), backend });
    expect(runner.createArtoodNode).not.toHaveBeenCalled(); expect(adapter.createProcessAdapter).not.toHaveBeenCalled();
    expect(broker.startApplicationBrokerProcess).not.toHaveBeenCalled();
    const result = JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string);
    expect(result).toEqual({ version: 1, kind: "application-broker-profile.checked", qualified_for_product: false,
      broker_started: false, database_opened: false, declared_local_bindings_checked: true,
      unqualified: ["compiler-source-artifact-binding", "generated-process-lpac", "effective-agent-write-scope"] });
    for (const privateValue of [env.ARTOO_APPLICATION_BROKER_PROFILE_FILE, env.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256, "backend", "artifact_digest"])
      expect(JSON.stringify(result)).not.toContain(privateValue);
  });
  it.each(["--windows-supervised", "--windows-supervised-daemon", "--prepared-journal", "--provision-managed-journal",
    "--initialize-owned-result-profiles", "--upgrade-owned-result-journal", selector, "--file=remote.json", "task text"])
    ("rejects a mixed selector or argv-supplied configuration: %s", async extra => {
      await expect(runDaemonEntrypoint(env, host([selector, extra]))).rejects.toThrow(/one standalone offline selector/);
      expect(installation.prepareWindowsProcessInstallation).not.toHaveBeenCalled(); expect(profile.checkApplicationBrokerProfileFile).not.toHaveBeenCalled();
    });
  it("does not fall through to ordinary startup on an equals-form selector", async () => {
    await expect(runDaemonEntrypoint(env, host([`${selector}=remote.json`]))).rejects.toThrow(/one standalone offline selector/);
    expect(installation.prepareWindowsProcessInstallation).not.toHaveBeenCalled();
  });
  it.each([true, false])("refuses an IPC-owned worker when connected=%s", async connected => {
    await expect(runDaemonEntrypoint(env, Object.assign(host(), { connected }))).rejects.toThrow(/standalone/);
    expect(profile.checkApplicationBrokerProfileFile).not.toHaveBeenCalled();
  });
  it.each(["ARTOO_WORKER_LAUNCH_ID", "ARTOO_WORKTREE_BASE_REPO", "ARTOO_OWNED_RESULT_PROFILES_FILE", "ARTOO_MANAGED_EXECUTION", "ARTOO_JOURNAL_VERSION"])
    ("rejects incompatible local launch settings: %s", async key => {
      await expect(runDaemonEntrypoint({ ...env, [key]: "0" }, host())).rejects.toThrow(/ordinary local node settings/);
      expect(installation.prepareWindowsProcessInstallation).not.toHaveBeenCalled();
    });
  it.each(["ARTOO_APPLICATION_BROKER_PROFILE_FILE", "ARTOO_NODE_ID", "ARTOO_ALLOWED_ROOTS"])
    ("requires local %s before qualifying the installation", async key => {
      await expect(runDaemonEntrypoint({ ...env, [key]: "" }, host())).rejects.toThrow(/absolute local profile file/);
      expect(installation.prepareWindowsProcessInstallation).not.toHaveBeenCalled();
    });
  it("requires the native installation and propagates admission failure without a success diagnostic", async () => {
    await expect(runDaemonEntrypoint({ ...env, ARTOO_WINDOWS_PROCESS_BUNDLE: undefined, ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256: undefined }, host()))
      .rejects.toThrow(/protected native Windows/);
    vi.mocked(profile.checkApplicationBrokerProfileFile).mockImplementation(() => { throw Error("Changed local profile"); });
    await expect(runDaemonEntrypoint(env, host())).rejects.toThrow("Changed local profile"); expect(console.log).not.toHaveBeenCalled();
  });
  it("does not select inspection merely because its environment variable exists", async () => {
    await expect(runDaemonEntrypoint(env, host([]))).rejects.toThrow(/ARTOO_NODE_URL/);
    expect(profile.checkApplicationBrokerProfileFile).not.toHaveBeenCalled();
  });
});
