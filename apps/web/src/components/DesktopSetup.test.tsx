// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeApi, renderWithProviders } from "../test/utils.js";
import { DesktopSettings } from "./DesktopSetup.js";

afterEach(() => { Reflect.deleteProperty(window, "artooDesktop"); });

function setup(initial?: DesktopCodexConfig) {
  let config: DesktopDaemonConfig = { allowedRoots: ["C:\\workspace"], runtimes: ["codex"], trustedExecution: false, ...(initial ? { codex: initial } : {}) };
  const configureDaemon = vi.fn(async (input: DesktopDaemonInput) => {
    const { apiKey, ...codex } = input.codex!;
    config = { ...input, codex: { ...codex, ...(codex.baseUrl ? { baseUrl: new URL(codex.baseUrl).toString().replace(/\/$/, "") } : {}), hasKey: codex.mode === "responses" && codex.authMode === "api-key" && (!!apiKey || !!config.codex?.hasKey) } };
  });
  const chooseExecutable = vi.fn(async () => "C:\\Apps\\codex.exe");
  Object.defineProperty(window, "artooDesktop", { configurable: true, value: {
    serverUrl: "http://localhost:4000", getConnection: async () => ({ serverUrl: "http://localhost:4000", deviceId: "d", paired: true }),
    daemonStatus: async () => ({ state: "stopped", config }), configureDaemon, chooseExecutable,
  } });
  renderWithProviders(<DesktopSettings />, { client: fakeApi({}) });
  return { configureDaemon, chooseExecutable };
}

describe("desktop local model settings", () => {
  it("recognizes the saved key after URL canonicalization and permits another save without re-entering it", async () => {
    const { configureDaemon } = setup();
    await userEvent.selectOptions(await screen.findByLabelText("Model connection"), "responses");
    await userEvent.type(screen.getByLabelText("Model name"), "test-model");
    await userEvent.clear(screen.getByLabelText("Model API address"));
    await userEvent.type(screen.getByLabelText("Model API address"), "https://API.example.test:443/v1/");
    await userEvent.type(screen.getByLabelText("Model API key"), "canonical-url-key");
    await userEvent.click(screen.getByRole("button", { name: "Save worker configuration" }));
    await screen.findByText("Worker configuration saved.");
    expect(screen.getByLabelText("Model API address")).toHaveValue("https://api.example.test/v1");
    expect(screen.getByLabelText("Model API key")).toHaveValue("");
    expect(screen.getByLabelText("Model API key")).not.toBeRequired();
    await userEvent.click(screen.getByRole("button", { name: "Save worker configuration" }));
    await waitFor(() => expect(configureDaemon).toHaveBeenCalledTimes(2));
    expect(configureDaemon.mock.calls[1]![0].codex).not.toHaveProperty("apiKey");
  });
  it("keeps existing CLI mode compatible and configures a chosen program, model and write-only API key", async () => {
    const { configureDaemon, chooseExecutable } = setup();
    expect(await screen.findByLabelText("Model connection")).toHaveValue("default");
    await userEvent.click(screen.getByRole("button", { name: "Choose Codex program" }));
    expect(chooseExecutable).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Codex program (optional)")).toHaveValue("C:\\Apps\\codex.exe");
    await userEvent.selectOptions(screen.getByLabelText("Model connection"), "responses");
    await userEvent.type(screen.getByLabelText("Model name"), "copilot-model");
    await userEvent.type(screen.getByLabelText("Model API key"), "ui-test-key");
    await userEvent.click(screen.getByRole("button", { name: "Save worker configuration" }));
    await screen.findByText("Worker configuration saved.");
    expect(configureDaemon).toHaveBeenCalledWith(expect.objectContaining({ codex: { mode: "responses", authMode: "api-key", binaryPath: "C:\\Apps\\codex.exe", model: "copilot-model", baseUrl: "http://127.0.0.1:18181/v1", apiKey: "ui-test-key" } }));
    expect(screen.getByLabelText("Model API key")).toHaveValue("");
    expect(screen.getByText(/A key is saved for this address/)).toBeInTheDocument();
    expect(screen.getByText(/does not contact the model API/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("API authentication"), "none");
    expect(screen.queryByLabelText("Model API key")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save worker configuration" }));
    await waitFor(() => expect(configureDaemon).toHaveBeenCalledTimes(2));
    expect(configureDaemon.mock.calls[1]![0].codex).toMatchObject({ authMode: "none" });
    expect(configureDaemon.mock.calls[1]![0].codex).not.toHaveProperty("apiKey");
  });

  it("keeps rejected fields for retry and requires a fresh key when the API address changes", async () => {
    const { configureDaemon } = setup({ mode: "responses", authMode: "api-key", baseUrl: "https://example.test/v1", model: "test", hasKey: true });
    const key = await screen.findByLabelText("Model API key");
    expect(key).not.toBeRequired();
    await userEvent.clear(screen.getByLabelText("Model API address"));
    await userEvent.type(screen.getByLabelText("Model API address"), "https://another.example/v1");
    expect(key).toBeRequired();
    await userEvent.type(key, "replacement-test-key");
    configureDaemon.mockRejectedValueOnce(new Error("Stop the worker before changing its configuration"));
    await userEvent.click(screen.getByRole("button", { name: "Save worker configuration" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Stop the worker");
    expect(key).toHaveValue("replacement-test-key");
    expect(screen.queryByText("Worker configuration saved.")).toBeNull();
  });
});
