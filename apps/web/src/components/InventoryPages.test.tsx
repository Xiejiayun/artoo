// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { AgentsPage, ComputersPage, SkillsPage } from "./InventoryPages.js";

describe("Inventory pages", () => {
  it("explains a missing selected instance and lets the user return to the inventory", async () => {
    renderWithProviders(<AgentsPage />, { client: fakeApi({ bootstrap: async () => bootstrapFixture() }), route: "/agents?instance=removed" });
    expect(await screen.findByText("This instance is no longer available")).toBeInTheDocument();
    expect(screen.queryByText("No matching resources")).not.toBeInTheDocument();
    expect(screen.queryByText(/Selected instance:/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show all instances" }));
    expect(screen.getByRole("article", { name: "Mock Coder" })).toBeInTheDocument();
  });

  it("clears instance filters when returning from a selected instance to the full inventory", async () => {
    renderWithProviders(<AgentsPage />, { client: fakeApi({ bootstrap: async () => bootstrapFixture() }), route: "/agents?instance=instance_mock_coder" });
    expect(await screen.findByText(/Selected instance:/)).toHaveTextContent("Mock Coder");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search agents" }), "no such agent");
    await userEvent.click(screen.getByRole("button", { name: "Show all instances" }));
    expect(screen.getByRole("searchbox", { name: "Search agents" })).toHaveValue("");
    expect(screen.getByRole("article", { name: "Mock Coder" })).toBeInTheDocument();
  });

  it("helps an empty project choose an existing instance without inheriting another squad", async () => {
    const data = bootstrapFixture();
    data.projects.push({ id: "second", name: "Second project", default_workspace: "/second" });
    renderWithProviders(<AgentsPage />, { client: fakeApi({ bootstrap: async () => data }), route: "/agents?project=second" });
    expect(await screen.findByText("This project's squad is empty")).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Mock Coder" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Choose an existing instance" }));
    expect(screen.getByLabelText("Project scope")).toHaveValue("all");
    expect(screen.getByRole("article", { name: "Mock Coder" })).toBeInTheDocument();
  });

  it("filters enabled and disabled agents independently of connection and work state", async () => {
    const user = userEvent.setup();
    const bootstrap = bootstrapFixture();
    bootstrap.agents.push({ ...bootstrap.agents[0]!, id: "reviewer", display_name: "Design reviewer" });
    bootstrap.agent_instances.push({ ...bootstrap.agent_instances[0]!, id: "reviewer_workspace", agent_id: "reviewer", status: "running", config: { enabled: false } });
    const client = fakeApi({ bootstrap: async () => bootstrap, listDaemons: async () => ({ daemons: [{ computer_id: "computer_local_mock", display_name: "Local Mock", status: "offline", connected: false, last_heartbeat_at: null, heartbeat_age_ms: null, active_runs: 0, runtimes: [] }] }) });
    renderWithProviders(<AgentsPage />, { client, route: "/agents" });
    const reviewer = await screen.findByRole("article", { name: "Design reviewer" });
    expect(await within(reviewer).findByText("Daemon: offline")).toBeInTheDocument();
    expect(within(reviewer).getByText("Disabled", { exact: true })).toBeInTheDocument();
    expect(within(reviewer).getByText("running", { exact: true })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Agent state"), "enabled");
    expect(screen.queryByRole("article", { name: "Design reviewer" })).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Mock Coder" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Agent state"), "disabled");
    expect(screen.queryByRole("article", { name: "Mock Coder" })).not.toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search agents" }), "does not exist");
    expect(screen.getByText("No matching resources")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getAllByRole("article")).toHaveLength(2);
  });

  it("announces loading while computer inventory cards are skeletonized", () => {
    const client = fakeApi({
      bootstrap: () => new Promise(() => undefined),
    });

    renderWithProviders(<ComputersPage />, { client, route: "/computers" });

    expect(screen.getByRole("status", { name: "Loading computers" })).toBeInTheDocument();
  });

  it("announces loading while agent inventory cards are skeletonized", () => {
    const client = fakeApi({
      bootstrap: () => new Promise(() => undefined),
    });

    renderWithProviders(<AgentsPage />, { client, route: "/agents" });

    expect(screen.getByRole("status", { name: "Loading agents" })).toBeInTheDocument();
  });

  it("renders computers from bootstrap and runtime rows from the heartbeat endpoint", async () => {
    const listComputerRuntimes = vi.fn(async (computerId: string) => ({
      runtimes: [
        {
          id: "runtime_mock",
          organization_id: "org_default",
          computer_id: computerId,
          runtime: "mock",
          version: "0.1.0",
          status: "available" as const,
          capabilities: ["code.modify", "test.run"],
          last_seen_at: "2026-06-13T00:00:00Z",
        },
      ],
    }));
    const client = fakeApi({
      bootstrap: async () => bootstrapFixture(),
      listComputerRuntimes,
      listDaemons: async () => ({ daemons: [{ computer_id: "computer_local_mock", display_name: "Local Mock", status: "online",
        connected: true, last_heartbeat_at: null, heartbeat_age_ms: null, active_runs: 0, runtimes: [] }] }),
    });

    renderWithProviders(<ComputersPage />, { client, route: "/computers" });

    const computer = await screen.findByRole("article", { name: "Local Mock" });
    expect(await within(computer).findByText("Daemon: online")).toBeInTheDocument();
    expect(computer).toHaveTextContent("localhost");
    expect(await within(within(computer).getByRole("region", { name: "Local Mock runtimes" })).findByText("mock", { exact: true })).toBeInTheDocument();
    expect(computer).toHaveTextContent("available");
    expect(computer).toHaveTextContent("code.modify");
    expect(listComputerRuntimes).toHaveBeenCalledWith("computer_local_mock");
  });

  it("keeps maintenance information behind details while creation and agent navigation stay available", async () => {
    const data = bootstrapFixture();
    data.computers[0]!.lifecycle = { version: 1, state: "active", last_seen_at: "2026-11-12T12:00:00Z", expires_at: "2026-12-12T12:00:00Z", inactivity_timeout_ms: 30 * 86400000 };
    renderWithProviders(<ComputersPage />, { client: fakeApi({ bootstrap: async () => data, listComputerRuntimes: async () => ({ runtimes: [] }), listDaemons: async () => ({ daemons: [] }) }), route: "/computers" });
    const computer = await screen.findByRole("article", { name: "Local Mock" });
    expect(within(computer).getByRole("button", { name: "Create instance" })).toBeVisible();
    expect(within(computer).getByRole("link", { name: "Mock Coder" })).toHaveAttribute("href", "/agents?instance=instance_mock_coder");
    expect(within(computer).getByText("After 30 days offline")).not.toBeVisible();
    expect(within(computer).getByText("C:/workspace/artoo")).not.toBeVisible();
    expect(within(computer).getByRole("button", { name: "Delete computer", hidden: true })).not.toBeVisible();
    await userEvent.click(within(computer).getByText("Computer details", { exact: true }));
    expect(within(computer).getByText("After 30 days offline")).toBeVisible();
    expect(within(computer).getByText("C:/workspace/artoo")).toBeVisible();
    await userEvent.click(within(computer).getByRole("button", { name: "Delete computer" }));
    expect(screen.getByRole("dialog", { name: "Delete computer" })).toBeVisible();
  });

  it("keeps an expired computer's recovery notice visible before opening details", async () => {
    const data = bootstrapFixture();
    data.computers[0]!.lifecycle = { version: 1, state: "expired", last_seen_at: null, expires_at: "2026-01-31T00:00:00Z", inactivity_timeout_ms: 30 * 86400000 };
    renderWithProviders(<ComputersPage />, { client: fakeApi({ bootstrap: async () => data, listComputerRuntimes: async () => ({ runtimes: [] }), listDaemons: async () => ({ daemons: [] }) }), route: "/computers" });
    const computer = await screen.findByRole("article", { name: "Local Mock" });
    expect(within(computer).getByText("Reconnect this computer and its runtime to restore availability.")).toBeVisible();
    expect(within(computer).getByText("Computer ID")).not.toBeVisible();
  });

  it.each(["online", "offline"] as const)("shows only the live %s daemon status when inventory data disagrees", async (status) => {
    const stale = status === "online" ? "offline" : "online";
    const bootstrap = bootstrapFixture();
    bootstrap.computers[0]!.status = stale;
    const client = fakeApi({ bootstrap: async () => bootstrap, listComputerRuntimes: async () => ({ runtimes: [] }),
      listDaemons: async () => ({ daemons: [{ computer_id: "computer_local_mock", display_name: "Local Mock", status,
        connected: status === "online", last_heartbeat_at: null, heartbeat_age_ms: null, active_runs: 0, runtimes: [] }] }),
    });
    renderWithProviders(<ComputersPage />, { client, route: "/computers" });
    const computer = await screen.findByRole("article", { name: "Local Mock" });
    expect(await within(computer).findByText(`Daemon: ${status}`)).toBeInTheDocument();
    expect(within(computer).queryByText(stale, { exact: true })).not.toBeInTheDocument();
  });

  it("renders agent instances with their computer, model, effort, and workspace", async () => {
    const client = fakeApi({ bootstrap: async () => bootstrapFixture() });

    renderWithProviders(<AgentsPage />, { client, route: "/agents" });

    const agent = await screen.findByRole("article", { name: "Mock Coder" });
    expect(agent).toHaveTextContent("instance_mock_coder");
    expect(agent).toHaveTextContent("mock");
    expect(agent).toHaveTextContent("Local Mock");
    expect(agent).toHaveTextContent("standard_coding");
    expect(agent).toHaveTextContent("C:/workspace/artoo");
  });

  it("renders installed skills from the Phase B read API plus the manifest vocabulary", async () => {
    const listSkillInstalls = vi.fn(async () => ({
      skills: [
        {
          id: "skill_000001",
          organization_id: "org_default",
          project_id: "proj_artoo",
          skill_id: "web-research",
          name: "Web Research",
          version: "1.0.0",
          enabled: true,
          manifest: {
            api_version: "v1alpha1" as const,
            id: "web-research",
            name: "Web Research",
            version: "1.0.0",
            description: "",
            capabilities: ["research.web" as const],
            compatible_runtimes: ["mock"],
            approval_risks: [],
            evals: [],
          },
          capabilities: ["research.web" as const],
          compatible_runtimes: ["mock"],
          permission_summary: {
            filesystem: { read: [], write: [] },
            network: { outbound: ["search.example.com"] },
            secrets: [],
            external_services: [],
            high_risk_actions: [],
            approval_risks: [],
            categories: ["network" as const],
            risk: "medium" as const,
          },
          installed_by_type: "user" as const,
          installed_by_id: "user_owner",
          installed_at: "2026-06-13T00:00:00Z",
          updated_at: "2026-06-13T00:00:00Z",
        },
      ],
    }));
    const client = fakeApi({ listSkillInstalls });

    renderWithProviders(<SkillsPage />, { client, route: "/skills" });

    expect(screen.getByRole("heading", { name: "Skills", level: 1 })).toBeInTheDocument();
    const installed = await screen.findByRole("article", { name: "Web Research" });
    expect(installed).toHaveTextContent("enabled");
    expect(installed).toHaveTextContent("proj_artoo");
    expect(installed).toHaveTextContent("research.web");
    expect(installed).toHaveTextContent("mock");
    expect(installed).toHaveTextContent("medium");
    expect(installed).toHaveTextContent("network");
    expect(screen.getByRole("region", { name: "Skill manifest contract" })).toHaveTextContent(
      "v1alpha1",
    );
    expect(screen.getByRole("region", { name: "Permission categories" })).toHaveTextContent(
      "filesystem",
    );
    expect(screen.getByRole("region", { name: "Known capabilities" })).toHaveTextContent(
      "code.modify",
    );
    expect(listSkillInstalls).toHaveBeenCalledOnce();
  });

  it("renders an installed skill empty state", async () => {
    const client = fakeApi({ listSkillInstalls: async () => ({ skills: [] }) });

    renderWithProviders(<SkillsPage />, { client, route: "/skills" });

    expect(await screen.findByText("No skills installed.")).toBeInTheDocument();
  });
});
