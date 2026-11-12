// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { AgentProjectControl } from "./AgentProjectControl.js";

describe("Agent project squad control", () => {
  it("saves an explicit project without changing the workspace", async () => {
    const data = bootstrapFixture(), instance = data.agent_instances[0]!;
    const projects = [...data.projects, { id: "second", name: "Second project", default_workspace: "/second" }];
    const setAgentProject = vi.fn(async () => ({ agent_instance: { ...instance, project_id: "second" } }));
    renderWithProviders(<AgentProjectControl instance={instance} projects={projects} role="owner" />, { client: fakeApi({ setAgentProject }) });
    expect(screen.getByRole("button", { name: "Save project squad" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Project squad"), "second");
    expect(setAgentProject).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Save project squad" }));
    await waitFor(() => expect(setAgentProject).toHaveBeenCalledWith(instance.id, "second", expect.any(String)));
  });

  it("shows server conflicts and leaves the selection editable", async () => {
    const data = bootstrapFixture();
    const setAgentProject = vi.fn(async () => { throw new Error("Stop active work before changing project"); });
    renderWithProviders(<AgentProjectControl instance={data.agent_instances[0]!} projects={data.projects} role="admin" />, { client: fakeApi({ setAgentProject }) });
    await userEvent.selectOptions(screen.getByLabelText("Project squad"), "");
    await userEvent.click(screen.getByRole("button", { name: "Save project squad" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Stop active work");
    expect(setAgentProject).toHaveBeenCalledWith("instance_mock_coder", null, expect.any(String));
    expect(screen.getByLabelText("Project squad")).toBeEnabled();
  });

  it("shows membership without administrative controls to ordinary members", () => {
    const data = bootstrapFixture();
    renderWithProviders(<AgentProjectControl instance={data.agent_instances[0]!} projects={data.projects} role="member" />, { client: fakeApi({}) });
    expect(screen.getByText("Project squad: artoo")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
