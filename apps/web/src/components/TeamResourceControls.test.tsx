// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { LogicalAgentEditor } from "./LogicalAgentEditor.js";
import { ProjectSquadEditor } from "./ProjectSquadEditor.js";
import { ComputerAdmissionControl } from "./ComputerAdmissionControl.js";
import { SchedulingPolicyEditor } from "./SchedulingPolicyEditor.js";

describe("Team resource controls", () => {
  it("creates a logical Agent independently from machine registration", async () => {
    const snapshot = bootstrapFixture();
    const createLogicalAgent = vi.fn<ApiClient["createLogicalAgent"]>().mockImplementation(async (configuration) => ({
      agent: snapshot.agents[0]!,
      configuration: { version: 1, agent_id: "agent_new", revision: 1, configuration },
    }));
    const registerAgent = vi.fn<ApiClient["registerAgent"]>();
    renderWithProviders(<LogicalAgentEditor role="owner" />, {
      client: fakeApi({ bootstrap: async () => snapshot, createLogicalAgent, registerAgent }),
    });
    await userEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Agent name"), "Project reviewer");
    await userEvent.type(within(dialog).getByLabelText("Team role"), "Review handoffs");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create Agent" }));
    await waitFor(() =>
      expect(createLogicalAgent).toHaveBeenCalledWith(
        expect.objectContaining({ display_name: "Project reviewer", role: "Review handoffs", version: 1 }),
        expect.any(String),
      ),
    );
    expect(registerAgent).not.toHaveBeenCalled();
  });
  it("retains the loaded Squad revision when another client edits during selection", async () => {
    const snapshot = bootstrapFixture();
    const putProjectSquad = vi
      .fn<ApiClient["putProjectSquad"]>()
      .mockRejectedValue(new Error("Configuration changed; reload before saving"));
    renderWithProviders(<ProjectSquadEditor projectId="proj_artoo" bootstrap={snapshot} />, {
      client: fakeApi({
        bootstrap: async () => snapshot,
        getProjectSquad: async () => ({
          squad: { version: 1, project_id: "proj_artoo", revision: 7, source: "configured", agent_ids: [] },
        }),
        putProjectSquad,
      }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "Configure project Squad" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Mock Coder/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Save project Squad" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Configuration changed");
    expect(putProjectSquad).toHaveBeenCalledWith("proj_artoo", 7, ["agent_mock_coder"]);
    expect(within(dialog).getByRole("checkbox", { name: /Mock Coder/ })).toBeChecked();
  });
  it("pauses new admission without cancelling any execution", async () => {
    const putComputerAdmission = vi
      .fn<ApiClient["putComputerAdmission"]>()
      .mockResolvedValue({ admission: { version: 1, computer_id: "machine", revision: 4, state: "draining" } });
    const cancelRun = vi.fn<ApiClient["cancelRun"]>();
    renderWithProviders(<ComputerAdmissionControl computerId="machine" role="owner" />, {
      client: fakeApi({
        getComputerAdmission: async () => ({
          admission: { version: 1, computer_id: "machine", revision: 3, state: "accepting" },
        }),
        putComputerAdmission,
        cancelRun,
      }),
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Pause new tasks" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Pause new tasks" }));
    expect(await screen.findByText("Paused for new tasks")).toBeInTheDocument();
    expect(putComputerAdmission).toHaveBeenCalledWith("machine", 3, "draining");
    expect(cancelRun).not.toHaveBeenCalled();
  });
  it("saves policy through revision CAS and keeps disabled rollout visible", async () => {
    const snapshot = bootstrapFixture();
    const response = {
      policy: null,
      active: false,
      capacity_admission: { version: 1 as const, shared_quotas_enabled: false, project_quota_enabled: false },
    };
    const putSchedulingPolicy = vi.fn(async () => response);
    renderWithProviders(<SchedulingPolicyEditor kind="project" id="proj_artoo" bootstrap={snapshot} />, {
      client: fakeApi({ getSchedulingPolicy: async () => response, putSchedulingPolicy }),
    });
    await userEvent.click(screen.getByText("Scheduling policy"));
    await userEvent.clear(await screen.findByLabelText("Maximum concurrent Runs"));
    await userEvent.type(screen.getByLabelText("Maximum concurrent Runs"), "3");
    await userEvent.click(screen.getByRole("button", { name: "Save scheduling policy" }));
    await waitFor(() =>
      expect(putSchedulingPolicy).toHaveBeenCalledWith("project", "proj_artoo", 0, {
        version: 1,
        max_concurrent_runs: 3,
        repo_url: null,
        default_branch: "main",
      }),
    );
    expect(screen.getByText(/Saving configuration does not enable automatic scheduling/)).toBeInTheDocument();
  });
});
