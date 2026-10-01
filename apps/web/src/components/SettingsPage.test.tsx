// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Device } from "@artoo/domain";
import { ApiClientError } from "../api/client.js";
import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { SettingsPage } from "./SettingsPage.js";

function device(patch: Partial<Device> = {}): Device {
  return { id: "device_mac", organization_id: "org_default", display_name: "Member Mac", platform: "macos", app_version: "1",
    computer_id: null, enrolled_by_user_id: "member_1", trust: "active", last_seen_at: null, created_at: "2026-09-30", revoked_at: null, ...patch };
}

describe("device enrollment in Settings", () => {
  it("keeps a pending project creation visible until it settles and preserves fields after failure", async () => {
    let rejectCreate!: (error: Error) => void;
    const createProject = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectCreate = reject; }));
    renderWithProviders(<SettingsPage />, { client: fakeApi({ bootstrap: async () => bootstrapFixture(), listDevices: async () => ({ devices: [] }), createProject }) });
    await userEvent.click(await screen.findByRole("button", { name: "New project" }));
    const dialog = screen.getByRole("dialog", { name: "New project" });
    await userEvent.type(within(dialog).getByLabelText("Project name"), "Launch workspace");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(createProject).toHaveBeenCalledOnce());
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Project name")).toBeDisabled();
    rejectCreate(new Error("Could not save project"));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Could not save project");
    expect(within(dialog).getByLabelText("Project name")).toHaveValue("Launch workspace");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("scrolls between sections without replacing the desktop hash route", async () => {
    const previousScroll = HTMLElement.prototype.scrollIntoView;
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    const previousHash = window.location.hash;
    window.location.hash = "#/settings";
    try {
      renderWithProviders(<SettingsPage />, { client: fakeApi({ bootstrap: async () => bootstrapFixture(), listDevices: async () => ({ devices: [] }) }) });
      const navigation = screen.getByRole("navigation", { name: "Settings sections" });
      await userEvent.click(within(navigation).getByRole("button", { name: "Connect a device" }));
      expect(scroll).toHaveBeenCalledOnce();
      expect(scroll.mock.instances[0]).toHaveAttribute("id", "pairing-settings");
      expect(window.location.hash).toBe("#/settings");
    } finally {
      HTMLElement.prototype.scrollIntoView = previousScroll;
      window.location.hash = previousHash;
    }
  });

  it.each(["owner", "admin"] as const)("lets an %s confirm enrollment and refreshes the registered computer", async (role) => {
    const current = device();
    const enrollDevice = vi.fn(async () => {
      current.computer_id = "computer_new";
      return { device_id: current.id, computer_id: current.computer_id, created: true };
    });
    const bootstrap = vi.fn(async () => bootstrapFixture({ user: { ...bootstrapFixture().user, role } }));
    const listDevices = vi.fn(async () => ({ devices: [{ ...current }] }));
    renderWithProviders(<SettingsPage />, { client: fakeApi({ bootstrap, listDevices, enrollDevice }) });
    await userEvent.click(await screen.findByRole("button", { name: "Enroll computer" }));
    expect(enrollDevice).not.toHaveBeenCalled();
    expect(screen.getByText(/Enroll Member Mac as an execution computer/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel enrollment" }));
    expect(enrollDevice).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Enroll computer" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm enrollment" }));
    expect(enrollDevice).toHaveBeenCalledWith("device_mac", expect.any(String));
    expect(await screen.findByText("Computer: computer_new")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enroll computer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm enrollment" })).toBeNull();
    await waitFor(() => expect(bootstrap.mock.calls.length).toBeGreaterThan(1));
    expect(listDevices.mock.calls.length).toBeGreaterThan(1);
  });

  it("offers enrollment only for active, unregistered desktop devices", async () => {
    const devices = [device(), device({ id: "win", display_name: "Member Windows", platform: "windows" }),
      device({ id: "phone", display_name: "Phone", platform: "ios" }), device({ id: "android", display_name: "Android", platform: "android" }),
      device({ id: "revoked", display_name: "Revoked Mac", trust: "revoked" }), device({ id: "registered", display_name: "Registered Mac", computer_id: "computer_existing" })];
    renderWithProviders(<SettingsPage />, { client: fakeApi({ bootstrap: async () => bootstrapFixture(), listDevices: async () => ({ devices }) }) });
    await screen.findByRole("button", { name: "New project" });
    await screen.findByRole("heading", { name: "Registered Mac" });
    expect(screen.getAllByRole("button", { name: "Enroll computer" })).toHaveLength(2);
    for (const name of ["Phone", "Android", "Revoked Mac", "Registered Mac"]) {
      const row = screen.getByRole("heading", { name }).closest("article")!;
      expect(within(row).queryByRole("button", { name: "Enroll computer" })).toBeNull();
    }
  });

  it("explains the administrator requirement to members without exposing enrollment controls", async () => {
    const base = bootstrapFixture();
    renderWithProviders(<SettingsPage />, { client: fakeApi({ bootstrap: async () => ({ ...base, user: { ...base.user, role: "member" } }), listDevices: async () => ({ devices: [device()] }) }) });
    expect(await screen.findByText(/An owner or admin must enroll this computer/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enroll computer" })).toBeNull();
  });

  it("keeps failed enrollment visible and lets the administrator retry", async () => {
    const current = device();
    const enrollDevice = vi.fn()
      .mockRejectedValueOnce(new ApiClientError("permission_denied", "Enrollment permission changed; sign in again", 403))
      .mockImplementationOnce(async () => { current.computer_id = "computer_retry"; return { device_id: current.id, computer_id: current.computer_id, created: true }; });
    renderWithProviders(<SettingsPage />, { client: fakeApi({ bootstrap: async () => bootstrapFixture(), listDevices: async () => ({ devices: [{ ...current }] }), enrollDevice }) });
    await userEvent.click(await screen.findByRole("button", { name: "Enroll computer" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm enrollment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enrollment permission changed");
    expect(screen.getByRole("button", { name: "Confirm enrollment" })).toBeEnabled();
    expect(screen.queryByText(/Computer:/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Confirm enrollment" }));
    expect(await screen.findByText("Computer: computer_retry")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(enrollDevice).toHaveBeenCalledTimes(2);
  });
});
