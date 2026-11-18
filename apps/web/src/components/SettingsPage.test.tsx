// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Device } from "@artoo/domain";
import { ApiClientError } from "../api/client.js";
import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { SettingsPage } from "./SettingsPage.js";

function device(patch: Partial<Device> = {}): Device {
  return {
    id: "device_win",
    organization_id: "org_default",
    display_name: "Member Windows",
    platform: "windows",
    app_version: "1",
    computer_id: null,
    enrolled_by_user_id: "member_1",
    trust: "active",
    last_seen_at: null,
    created_at: "2026-09-30",
    revoked_at: null,
    ...patch,
  };
}

describe("device enrollment in Settings", () => {
  it("announces a project save exactly once after the server confirms it", async () => {
    const project = bootstrapFixture().projects[0]!;
    let finish!: (result: { project: typeof project }) => void;
    const updateProject = vi.fn(
      () =>
        new Promise<{ project: typeof project }>((resolve) => {
          finish = resolve;
        }),
    );
    renderWithProviders(<SettingsPage />, {
      client: fakeApi({
        bootstrap: async () => bootstrapFixture(),
        listDevices: async () => ({ devices: [] }),
        updateProject,
      }),
    });
    const form = await screen.findByRole("form", { name: "Edit project" });
    await userEvent.click(within(form).getByRole("button", { name: "Save project" }));
    await waitFor(() => expect(updateProject).toHaveBeenCalledOnce());
    expect(screen.queryByText("Project saved.")).not.toBeInTheDocument();
    finish({ project });
    const notifications = await screen.findByRole("region", { name: "Notifications" });
    expect(within(notifications).getByRole("status")).toHaveTextContent("Project saved.");
    expect(screen.getAllByText("Project saved.")).toHaveLength(1);
  });

  it("keeps a pending project creation visible until it settles and preserves fields after failure", async () => {
    let rejectCreate!: (error: Error) => void;
    const createProject = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectCreate = reject;
        }),
    );
    renderWithProviders(<SettingsPage />, {
      client: fakeApi({
        bootstrap: async () => bootstrapFixture(),
        listDevices: async () => ({ devices: [] }),
        createProject,
      }),
    });
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
    expect(screen.queryByText("Project saved.")).not.toBeInTheDocument();
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
      renderWithProviders(<SettingsPage />, {
        client: fakeApi({ bootstrap: async () => bootstrapFixture(), listDevices: async () => ({ devices: [] }) }),
      });
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

  it("creates a Windows pairing code from the selected platform", async () => {
    const createPairing = vi.fn(async () => ({ code: "WIN1-X123", pairing: { expires_at: "2099-01-01T00:00:00Z" } }));
    renderWithProviders(<SettingsPage />, {
      client: fakeApi({
        bootstrap: async () => bootstrapFixture(),
        listDevices: async () => ({ devices: [] }),
        createPairing,
      }),
    });
    await userEvent.click(screen.getByText("Pair a desktop or mobile app"));
    await userEvent.selectOptions(screen.getByLabelText("Device platform"), "windows");
    await userEvent.click(screen.getByRole("button", { name: "Generate pairing code" }));
    expect(await screen.findByLabelText("Pairing code")).toHaveTextContent("WIN1-X123");
    expect(createPairing).toHaveBeenCalledWith("windows", expect.any(String));
  });

  it("opens the shared one-command node connection flow without creating a code prematurely", async () => {
    const createPairing = vi.fn();
    renderWithProviders(<SettingsPage />, {
      client: fakeApi({
        bootstrap: async () => bootstrapFixture(),
        listDevices: async () => ({ devices: [] }),
        createPairing,
      }),
    });
    await userEvent.click(screen.getByRole("button", { name: "Connect Local Node" }));
    expect(screen.getByRole("dialog", { name: "Connect Local Node" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Generate connection command" })).toBeVisible();
    expect(createPairing).not.toHaveBeenCalled();
  });

  it.each([
    ["owner", "windows"],
    ["admin", "windows"],
  ] as const)("lets an %s confirm %s enrollment and refreshes the registered computer", async (role, platform) => {
    const current = device({ id: `device_${platform}`, display_name: `Member ${platform}`, platform });
    const enrollDevice = vi.fn(async () => {
      current.computer_id = "computer_new";
      return { device_id: current.id, computer_id: current.computer_id, created: true };
    });
    const bootstrap = vi.fn(async () => bootstrapFixture({ user: { ...bootstrapFixture().user, role } }));
    const listDevices = vi.fn(async () => ({ devices: [{ ...current }] }));
    renderWithProviders(<SettingsPage />, { client: fakeApi({ bootstrap, listDevices, enrollDevice }) });
    await userEvent.click(await screen.findByRole("button", { name: "Enroll computer" }));
    expect(enrollDevice).not.toHaveBeenCalled();
    expect(screen.getByText(new RegExp(`Enroll Member ${platform} as an execution computer`))).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel enrollment" }));
    expect(enrollDevice).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Enroll computer" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm enrollment" }));
    expect(enrollDevice).toHaveBeenCalledWith(current.id, expect.any(String));
    expect(await screen.findByText("Computer: computer_new")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enroll computer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm enrollment" })).toBeNull();
    await waitFor(() => expect(bootstrap.mock.calls.length).toBeGreaterThan(1));
    expect(listDevices.mock.calls.length).toBeGreaterThan(1);
  });

  it("offers enrollment only for active, unregistered Windows desktop devices", async () => {
    const devices = [
      device(),
      device({ id: "win2", display_name: "Second Windows", platform: "windows" }),
      device({ id: "mac", display_name: "Member Mac", platform: "macos" }),
      device({ id: "linux", display_name: "Member Linux", platform: "linux" }),
      device({ id: "phone", display_name: "Phone", platform: "ios" }),
      device({ id: "android", display_name: "Android", platform: "android" }),
      device({ id: "revoked", display_name: "Revoked Windows", trust: "revoked" }),
      device({ id: "registered", display_name: "Registered Windows", computer_id: "computer_existing" }),
    ];
    renderWithProviders(<SettingsPage />, {
      client: fakeApi({ bootstrap: async () => bootstrapFixture(), listDevices: async () => ({ devices }) }),
    });
    await screen.findByRole("button", { name: "New project" });
    await screen.findByRole("heading", { name: "Registered Windows" });
    expect(screen.getAllByRole("button", { name: "Enroll computer" })).toHaveLength(2);
    for (const name of ["Member Mac", "Member Linux", "Phone", "Android", "Revoked Windows", "Registered Windows"]) {
      const row = screen.getByRole("heading", { name }).closest("article")!;
      expect(within(row).queryByRole("button", { name: "Enroll computer" })).toBeNull();
    }
  });

  it("explains the administrator requirement for windows to members without exposing enrollment controls", async () => {
    const base = bootstrapFixture();
    renderWithProviders(<SettingsPage />, {
      client: fakeApi({
        bootstrap: async () => ({ ...base, user: { ...base.user, role: "member" } }),
        listDevices: async () => ({ devices: [device({ platform: "windows" })] }),
      }),
    });
    expect(await screen.findByText(/An owner or admin must enroll this computer/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enroll computer" })).toBeNull();
  });

  it("keeps failed enrollment visible and lets the administrator retry", async () => {
    const current = device();
    const enrollDevice = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiClientError("permission_denied", "Enrollment permission changed; sign in again", 403),
      )
      .mockImplementationOnce(async () => {
        current.computer_id = "computer_retry";
        return { device_id: current.id, computer_id: current.computer_id, created: true };
      });
    renderWithProviders(<SettingsPage />, {
      client: fakeApi({
        bootstrap: async () => bootstrapFixture(),
        listDevices: async () => ({ devices: [{ ...current }] }),
        enrollDevice,
      }),
    });
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
