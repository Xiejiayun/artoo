// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Device, PairingCode } from "@artoo/domain";
import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { ConnectNodeDialog, daemonConnectCommand } from "./ConnectNodeDialog.js";

const pairing: PairingCode = { id: "pairing_exact", organization_id: "org_default", status: "pending", created_by_user_id: "user_1", intended_platform: "windows", expires_at: "2099-01-01T00:00:00Z", claimed_by_device_id: null, created_at: "2026-11-11T00:00:00Z", claimed_at: null };
const device: Device = { id: "device_exact", organization_id: "org_default", display_name: "My workstation", platform: "windows", app_version: "0.1.0-rc.3", computer_id: "computer_exact", enrolled_by_user_id: "user_1", trust: "active", last_seen_at: null, created_at: "2026-11-11T00:00:00Z", revoked_at: null };

describe("one-command machine connection", () => {
  it("rejects unsafe command origins and codes", () => {
    expect(daemonConnectCommand("https://artoo.example.com", "ABCD-1234")).toContain("--server https://artoo.example.com --code ABCD-1234");
    for (const origin of ["http://remote.example.com", "https://user:pass@artoo.example.com", "https://artoo.example.com/path", "https://artoo.example.com?x=1", "https://artoo.example.com;echo"]) {
      expect(() => daemonConnectCommand(origin, "ABCD-1234")).toThrow();
    }
    expect(() => daemonConnectCommand("https://artoo.example.com", "ABCD-1234;echo")).toThrow();
  });

  it("generates only on request, tracks the exact pairing, and copies a short-lived command", async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const createPairing = vi.fn(async () => ({ code: "ABCD-1234", pairing }));
    const getPairingStatus = vi.fn(async () => ({ pairing, device: null }));
    const listDaemons = vi.fn(async () => ({ daemons: [] }));
    renderWithProviders(<ConnectNodeDialog open onClose={() => undefined} />, { client: fakeApi({ bootstrap: async () => bootstrapFixture(), createPairing, getPairingStatus, listDaemons }) });
    expect(createPairing).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText("Target operating system"), "linux");
    await user.click(screen.getByRole("button", { name: "Generate connection command" }));
    expect(await screen.findByLabelText("Connection command")).toHaveTextContent("ABCD-1234");
    expect(createPairing).toHaveBeenCalledWith("linux", expect.any(String));
    await waitFor(() => expect(getPairingStatus).toHaveBeenCalledWith("pairing_exact"));
    expect(listDaemons).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Copy command" }));
    expect(copy).toHaveBeenCalledWith(daemonConnectCommand(window.location.origin, "ABCD-1234", "linux"));
    copy.mockRestore();
  });

  it("connects only the machine claimed by this pairing and hands its ID to instance creation", async () => {
    const user = userEvent.setup(), onCreateInstance = vi.fn(), onClose = vi.fn();
    const claimed = { ...pairing, status: "claimed" as const, claimed_by_device_id: device.id };
    renderWithProviders(<ConnectNodeDialog open onClose={onClose} onCreateInstance={onCreateInstance} />, { client: fakeApi({ bootstrap: async () => bootstrapFixture(),
      createPairing: async () => ({ code: "ABCD-1234", pairing }), getPairingStatus: async () => ({ pairing: claimed, device }),
      listDaemons: async () => ({ daemons: [{ computer_id: "computer_exact", display_name: "My workstation", status: "online", connected: true, last_heartbeat_at: null, heartbeat_age_ms: null, active_runs: 0, runtimes: [] }] }) }) });
    await user.click(screen.getByRole("button", { name: "Generate connection command" }));
    await user.click(await screen.findByRole("button", { name: "Create an instance" }));
    expect(onCreateInstance).toHaveBeenCalledWith("computer_exact");
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("Connection command")).not.toBeInTheDocument();
  });

  it("shows expired commands as expired and never infers success from another online machine", async () => {
    const user = userEvent.setup();
    const expired = { ...pairing, status: "expired" as const, expires_at: "2000-01-01T00:00:00Z" };
    renderWithProviders(<ConnectNodeDialog open onClose={() => undefined} />, { client: fakeApi({ bootstrap: async () => bootstrapFixture(),
      createPairing: async () => ({ code: "ABCD-1234", pairing: expired }), getPairingStatus: async () => ({ pairing: expired, device: null }) }) });
    await user.click(screen.getByRole("button", { name: "Generate connection command" }));
    expect(await screen.findByRole("button", { name: "Generate new command" })).toBeVisible();
    expect(screen.queryByLabelText("Connection command")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create an instance" })).not.toBeInTheDocument();
  });
});
