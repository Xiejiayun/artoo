import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as installation from "./windows-process-installation.js";
import * as runner from "./node-runner.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { createNodeFromConfig, loadConfigFromEnv } from "./main.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => { Object.defineProperty(process, "platform", { ...platform, value: "win32" }); });
afterEach(() => { vi.restoreAllMocks(); Object.defineProperty(process, "platform", platform); });
describe("standard source environment selection", () => {
  const root = process.cwd(), file = root + "\\source.json", env = { ARTOO_NODE_URL: "wss://control.example/api/v1/node?token=sk_device_fixture_secret",
    ARTOO_NODE_ID: "node", ARTOO_ALLOWED_ROOTS: root, ARTOO_WINDOWS_PROCESS_BUNDLE: root,
    ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256: `sha256:${"a".repeat(64)}`, ARTOO_PRODUCT_SOURCE_CONFIG_FILE: file };
  it("passes the explicit protected file and original native backend to ordinary startup with committed receipts", () => {
    const backend = Object.freeze({}) as PreparedWindowsProcessBackend;
    vi.spyOn(installation, "prepareWindowsProcessInstallation").mockReturnValue(backend);
    const create = vi.spyOn(runner, "createArtoodNode").mockReturnValue({ start: async () => {}, stop: async () => {} });
    const config = loadConfigFromEnv(env); createNodeFromConfig(config);
    expect(create.mock.calls[0]![0]).toMatchObject({ productSourceConfigFile: file, windowsProcessBackend: backend, acknowledgeRunEvents: true });
    expect(config.managedJournal).toBeUndefined();
  });
  it("rejects source selection without native qualification and rejects malformed absolute file settings", () => {
    vi.spyOn(installation, "prepareWindowsProcessInstallation").mockReturnValue(Object.freeze({}) as PreparedWindowsProcessBackend);
    for (const value of ["", "relative", `${root}\0`]) expect(() => loadConfigFromEnv({ ...env, ARTOO_PRODUCT_SOURCE_CONFIG_FILE: value })).toThrow(/ARTOO_PRODUCT_SOURCE_CONFIG_FILE/);
    expect(() => loadConfigFromEnv({ ...env, ARTOO_WINDOWS_PROCESS_BUNDLE: undefined, ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256: undefined })).toThrow(/native Windows/);
  });
});
