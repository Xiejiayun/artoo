// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeApi, renderWithProviders } from "../test/utils.js";
import { DesktopSettings } from "./DesktopSetup.js";
afterEach(() => { Reflect.deleteProperty(window, "artooDesktop"); });
function setup(options: { platform?: string; enabled?: boolean; publication?: boolean; locked?: boolean } = {}) {
  let config: DesktopDaemonConfig = { allowedRoots: ["C:\\workspace"], runtimes: ["codex"], trustedExecution: false,
    ...(options.enabled ? { nativeVerification: { version: 1, profilesFile: "C:\\Protected\\verification.json" } } : {}),
    ...(options.publication ? { nativePublication: { version: 1, profilesFile: "C:\\Protected\\publication.json" } } : {}) };
  const configureDaemon = vi.fn(async (value: DesktopDaemonInput) => { config = { ...value, codex: value.codex ? { ...value.codex, hasKey: false } : undefined }; });
  const chooseVerificationProfilesFile = vi.fn(async () => "C:\\Protected\\verification.json");
  const choosePublicationProfilesFile = vi.fn(async () => "C:\\Protected\\publication.json");
  Object.defineProperty(window, "artooDesktop", { configurable: true, value: {
    platform: options.platform ?? "win32", serverUrl: "http://localhost:4000", getConnection: async () => ({ paired: true, serverUrl: "http://localhost:4000" }),
    daemonStatus: async () => ({ state: options.locked ? "running" : "stopped", configurationLocked: options.locked ?? false, config }),
    configureDaemon, chooseVerificationProfilesFile, choosePublicationProfilesFile,
  } });
  renderWithProviders(<DesktopSettings />, { client: fakeApi({}) });
  return { configureDaemon, chooseVerificationProfilesFile, choosePublicationProfilesFile };
}
describe("desktop automatic task verification settings", () => {
  it("keeps existing Windows manual settings disabled by default", async () => {
    const f = setup(); expect(await screen.findByLabelText("Enable automatic task verification")).not.toBeChecked();
    expect(screen.queryByLabelText("Verification profiles file")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save worker configuration" }));
    await waitFor(() => expect(f.configureDaemon).toHaveBeenCalledOnce());
    expect(f.configureDaemon.mock.calls[0]![0]).not.toHaveProperty("nativeVerification");
  });
  it("selects and saves the local profiles file without asking for helper paths or hashes", async () => {
    const f = setup(); await userEvent.click(await screen.findByLabelText("Enable automatic task verification"));
    expect(screen.getByLabelText("Verification profiles file")).toBeRequired();
    expect(screen.getByRole("button", { name: "Save worker configuration" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Choose verification profiles" }));
    expect(f.chooseVerificationProfilesFile).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Verification profiles file")).toHaveValue("C:\\Protected\\verification.json");
    await userEvent.click(screen.getByRole("button", { name: "Save worker configuration" }));
    await screen.findByText("Worker configuration saved.");
    expect(f.configureDaemon).toHaveBeenCalledWith(expect.objectContaining({ nativeVerification: { version: 1, profilesFile: "C:\\Protected\\verification.json" } }));
  });
  it("restores the saved setting, preserves rejected input and lets the user disable it", async () => {
    const f = setup({ enabled: true });
    expect(await screen.findByLabelText("Enable automatic task verification")).toBeChecked();
    await userEvent.clear(screen.getByLabelText("Verification profiles file"));
    await userEvent.type(screen.getByLabelText("Verification profiles file"), "C:\\workspace\\unsafe.json");
    f.configureDaemon.mockRejectedValueOnce(new Error("Verification profiles file must be outside every allowed workspace folder"));
    await userEvent.click(screen.getByRole("button", { name: "Save worker configuration" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("outside every allowed workspace folder");
    expect(screen.getByLabelText("Verification profiles file")).toHaveValue("C:\\workspace\\unsafe.json");
    await userEvent.click(screen.getByLabelText("Enable automatic task verification"));
    await userEvent.click(screen.getByRole("button", { name: "Save worker configuration" }));
    await waitFor(() => expect(f.configureDaemon).toHaveBeenCalledTimes(2));
    expect(f.configureDaemon.mock.calls[1]![0]).not.toHaveProperty("nativeVerification");
  });
  it("keeps enabled settings locked until the worker has stopped", async () => {
    setup({ enabled: true, locked: true });
    expect(await screen.findByLabelText("Enable automatic task verification")).toBeDisabled();
    expect(screen.getByLabelText("Verification profiles file")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose verification profiles" })).toBeDisabled();
  });
  it("preserves the other desktop platform's existing setup", async () => {
    setup({ platform: "darwin" }); await screen.findByRole("form", { name: "Worker configuration" });
    expect(screen.queryByLabelText("Enable automatic task verification")).toBeNull();
  });
});

describe("desktop product publication settings", () => {
  it("requires an explicit publication opt-in after verification is enabled", async () => {
    const f = setup(); await screen.findByLabelText("Enable automatic task verification");
    expect(screen.queryByLabelText("Enable automatic product publication")).toBeNull();
    await userEvent.click(screen.getByLabelText("Enable automatic task verification"));
    await userEvent.click(screen.getByRole("button", { name: "Choose verification profiles" }));
    expect(screen.getByLabelText("Enable automatic product publication")).not.toBeChecked();
    await userEvent.click(screen.getByLabelText("Enable automatic product publication"));
    expect(screen.getByLabelText("Publication profiles file")).toBeRequired();
    expect(screen.getByRole("button", { name: "Save worker configuration" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Choose publication profiles" }));
    expect(f.choosePublicationProfilesFile).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Save worker configuration" }));
    await screen.findByText("Worker configuration saved.");
    expect(f.configureDaemon).toHaveBeenCalledWith(expect.objectContaining({ nativeVerification: { version: 1, profilesFile: "C:\\Protected\\verification.json" },
      nativePublication: { version: 1, profilesFile: "C:\\Protected\\publication.json" } }));
  });
  it("preserves rejected publication input and removes both settings when verification is disabled", async () => {
    const f = setup({ enabled: true, publication: true });
    expect(await screen.findByLabelText("Enable automatic product publication")).toBeChecked();
    await userEvent.clear(screen.getByLabelText("Publication profiles file"));
    await userEvent.type(screen.getByLabelText("Publication profiles file"), "C:\\workspace\\unsafe.json");
    f.configureDaemon.mockRejectedValueOnce(new Error("Publication profiles file must be outside every allowed workspace folder"));
    await userEvent.click(screen.getByRole("button", { name: "Save worker configuration" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("outside every allowed workspace folder");
    expect(screen.getByLabelText("Publication profiles file")).toHaveValue("C:\\workspace\\unsafe.json");
    await userEvent.click(screen.getByLabelText("Enable automatic task verification"));
    await userEvent.click(screen.getByRole("button", { name: "Save worker configuration" }));
    await waitFor(() => expect(f.configureDaemon).toHaveBeenCalledTimes(2));
    expect(f.configureDaemon.mock.calls[1]![0]).not.toHaveProperty("nativePublication");
    expect(f.configureDaemon.mock.calls[1]![0]).not.toHaveProperty("nativeVerification");
    await userEvent.click(screen.getByLabelText("Enable automatic task verification"));
    expect(screen.getByLabelText("Enable automatic product publication")).not.toBeChecked();
  });
  it("locks publication configuration until worker cleanup completes", async () => {
    setup({ enabled: true, publication: true, locked: true });
    expect(await screen.findByLabelText("Enable automatic product publication")).toBeDisabled();
    expect(screen.getByLabelText("Publication profiles file")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose publication profiles" })).toBeDisabled();
  });
});
