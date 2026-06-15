// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { AgentsPage, ComputersPage, SkillsPage } from "./InventoryPages.js";

describe("Inventory pages", () => {
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
    });

    renderWithProviders(<ComputersPage />, { client, route: "/computers" });

    const computer = await screen.findByRole("article", { name: "Local Mock" });
    expect(computer).toHaveTextContent("online");
    expect(computer).toHaveTextContent("localhost");
    expect(await within(computer).findByText(/mock/)).toBeInTheDocument();
    expect(computer).toHaveTextContent("available");
    expect(computer).toHaveTextContent("code.modify");
    expect(listComputerRuntimes).toHaveBeenCalledWith("computer_local_mock");
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
