// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { AgentsPage, ComputersPage } from "./InventoryPages.js";
import { DeleteResource, ResourceLifetime } from "./ResourceLifecycleControls.js";

describe("resource lifecycle controls", () => {
  it.each(["computer", "agent", "instance"] as const)("confirms %s deletion and refreshes the inventory immediately", async (kind) => {
    const user = userEvent.setup();
    let snapshot = bootstrapFixture();
    const remove = vi.fn(async (id: string) => {
      snapshot = { ...snapshot, agent_instances: [], ...(kind === "computer" ? { computers: [] } : kind === "agent" ? { agents: [] } : {}) };
      return { id, deleted: true };
    });
    const client = fakeApi({ bootstrap: async () => snapshot, deleteComputer: remove, deleteAgent: remove, deleteAgentInstance: remove,
      listComputerRuntimes: async () => ({ runtimes: [] }), listDaemons: async () => ({ daemons: [] }) });
    renderWithProviders(kind === "computer" ? <ComputersPage /> : <AgentsPage />, { client });
    if (kind === "computer") await user.click(await screen.findByText("Computer details", { exact: true }));
    await user.click(await screen.findByRole("button", { name: `Delete ${kind}` }));
    const dialog = screen.getByRole("dialog", { name: `Delete ${kind}` });
    expect(dialog).toHaveTextContent("Historical tasks and audit records are retained");
    expect(remove).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: `Delete ${kind}` }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm deletion" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(remove).toHaveBeenCalledWith(kind === "computer" ? "computer_local_mock" : kind === "agent" ? "agent_mock_coder" : "instance_mock_coder", expect.any(String));
    await waitFor(() => expect(screen.queryByRole("article", { name: kind === "computer" ? "Local Mock" : "Mock Coder" })).not.toBeInTheDocument());
  });

  it("keeps a failed deletion open and displays the server's reason", async () => {
    const user = userEvent.setup();
    const remove = vi.fn(async () => { throw new Error("Confirm disconnected processes have exited"); });
    renderWithProviders(<DeleteResource kind="computer" id="computer" name="Computer" role="owner" />, { client: fakeApi({ deleteComputer: remove }) });
    await user.click(screen.getByRole("button", { name: "Delete computer" }));
    await user.click(screen.getByRole("button", { name: "Confirm deletion" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Confirm disconnected processes have exited");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("hides deletion for members and shows expiration and reconnection guidance", () => {
    renderWithProviders(<><DeleteResource kind="computer" id="computer" name="Computer" role="member" /><ResourceLifetime lifecycle={{ version: 1, state: "expired", last_seen_at: null, expires_at: "2026-01-31T00:00:00Z", inactivity_timeout_ms: 30 * 86400000 }} /></>, { client: fakeApi({}) });
    expect(screen.queryByRole("button", { name: "Delete computer" })).not.toBeInTheDocument();
    expect(screen.getByText("Expired", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("After 30 days offline")).toBeInTheDocument();
    expect(screen.getByText("Reconnect the computer and its runtime to restore availability.")).toBeInTheDocument();
  });
});
