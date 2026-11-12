// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SkillInstallSchema, summarizeSkillPermissions, SkillManifestSchema, type AgentRuntime } from "@artoo/domain";
import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { AgentsPage, SkillsPage } from "./InventoryPages.js";
import { matchesSkillSearch, nativeSkillMatchesInstance, skillInstallMatchesInstance } from "./skill-inventory-model.js";

function fixture() {
  const bootstrap = bootstrapFixture();
  const runtime: AgentRuntime = { id: "runtime_mock", organization_id: "org_default", computer_id: bootstrap.computers[0]!.id,
    runtime: "mock", status: "available", capabilities: [], native_skills: { version: 1, observed_at: "2026-11-12T00:00:00Z", truncated: false, unreadable_count: 0,
      skills: [{ id: "browser-tests", name: "Browser testing", description: "运行浏览器测试 and inspect screenshots", path: "C:/skills/browser-tests/SKILL.md", scope: "user" }] } };
  const manifest = SkillManifestSchema.parse({ api_version: "v1alpha1", id: "tests", name: "Project tests", version: "1.0.0", capabilities: ["test.run"], compatible_runtimes: ["mock"] });
  const install = SkillInstallSchema.parse({ id: "install_1", organization_id: "org_default", project_id: "proj_artoo", skill_id: "tests", name: "Project tests", version: "1.0.0", enabled: true,
    manifest, capabilities: manifest.capabilities, compatible_runtimes: manifest.compatible_runtimes, permission_summary: summarizeSkillPermissions(manifest),
    installed_by_type: "user", installed_by_id: "owner", installed_at: "2026-11-12T00:00:00Z", updated_at: "2026-11-12T00:00:00Z" });
  return { bootstrap, runtime, install };
}

describe("skill inventory and agent associations", () => {
  it("searches native skill names and descriptions across words, and follows their matching agent", async () => {
    const user = userEvent.setup(), { bootstrap, runtime } = fixture();
    renderWithProviders(<SkillsPage />, { client: fakeApi({ bootstrap: async () => bootstrap, listSkillInstalls: async () => ({ skills: [] }), listComputerRuntimes: async () => ({ runtimes: [runtime] }) }) });
    const native = await screen.findByRole("article", { name: "Browser testing" });
    expect(native).toHaveTextContent("运行浏览器测试");
    expect(within(native).getByRole("link", { name: "Mock Coder" })).toHaveAttribute("href", "/agents?instance=instance_mock_coder");
    await user.type(screen.getByRole("searchbox", { name: "Search skills" }), "screenshots browser");
    expect(screen.getByRole("article", { name: "Browser testing" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Skill source"), "installed");
    expect(screen.queryByRole("article", { name: "Browser testing" })).not.toBeInTheDocument();
    expect(screen.getByText("No matching resources")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("article", { name: "Browser testing" })).toBeInTheDocument();
  });

  it("finds installed skills with Chinese capability terms and retains org-wide installs in a project filter", async () => {
    const user = userEvent.setup(), { bootstrap, install } = fixture();
    renderWithProviders(<SkillsPage />, { client: fakeApi({ bootstrap: async () => bootstrap, listSkillInstalls: async () => ({ skills: [install, { ...install, id: "org", name: "Org tests", project_id: null }] }), listComputerRuntimes: async () => ({ runtimes: [] }) }) });
    await screen.findByRole("article", { name: "Project tests" });
    await user.type(screen.getByRole("searchbox", { name: "Search skills" }), "测试 mock");
    await user.selectOptions(screen.getByLabelText("Skill project"), "proj_artoo");
    expect(screen.getByRole("article", { name: "Project tests" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Org tests" })).toBeInTheDocument();
  });

  it("shows an instance's native and matching project skills and searches agents by those skills", async () => {
    const user = userEvent.setup(), { bootstrap, runtime, install } = fixture();
    bootstrap.agent_instances[0]!.project_id = "proj_artoo";
    renderWithProviders(<AgentsPage />, { client: fakeApi({ bootstrap: async () => bootstrap, listSkillInstalls: async () => ({ skills: [install] }), listComputerRuntimes: async () => ({ runtimes: [runtime] }) }) });
    const card = await screen.findByRole("article", { name: "Mock Coder" });
    expect(await within(card).findByText("Browser testing")).toBeInTheDocument();
    expect(await within(card).findByText("Project tests")).toBeInTheDocument();
    await user.type(screen.getByRole("searchbox", { name: "Search agents" }), "运行浏览器测试");
    expect(screen.getByRole("article", { name: "Mock Coder" })).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "Search agents" }));
    await user.type(screen.getByRole("searchbox", { name: "Search agents" }), "screenshots browser");
    expect(screen.getByRole("article", { name: "Mock Coder" })).toBeInTheDocument();
  });

  it("distinguishes a daemon that never reported discovery from an explicit empty scan", async () => {
    const { bootstrap, runtime } = fixture();
    runtime.native_skills = undefined;
    renderWithProviders(<AgentsPage />, { client: fakeApi({ bootstrap: async () => bootstrap, listSkillInstalls: async () => ({ skills: [] }), listComputerRuntimes: async () => ({ runtimes: [runtime] }) }) });
    expect(await screen.findByText("Native skills not reported. Reconnect this machine with the updated daemon.")).toBeInTheDocument();
    expect(screen.queryByText("No native skills discovered for this workspace.")).not.toBeInTheDocument();
  });

  it("reports discovery errors without presenting them as an empty successful scan", async () => {
    const { bootstrap } = fixture();
    renderWithProviders(<SkillsPage />, { client: fakeApi({ bootstrap: async () => bootstrap, listSkillInstalls: async () => ({ skills: [] }), listComputerRuntimes: async () => { throw new Error("offline"); } }) });
    expect(await screen.findByText("Some machines' native skills could not be refreshed.")).toBeInTheDocument();
    expect(screen.queryByText("No native skills reported yet. Connect a machine with skills in its standard runtime folders.")).not.toBeInTheDocument();
  });

  it("matches exact machine/runtime and workspace boundaries, preserving case on POSIX and project isolation", () => {
    const { bootstrap, runtime, install } = fixture();
    const instance = { ...bootstrap.agent_instances[0]!, workspace_root: "C:/Work/App/child", project_id: "proj_artoo" };
    const entry = { computer: bootstrap.computers[0]!, runtime, skill: { ...runtime.native_skills!.skills[0]!, scope: "workspace" as const, workspace_root: "c:\\work\\app" } };
    expect(nativeSkillMatchesInstance(entry, instance)).toBe(true);
    expect(nativeSkillMatchesInstance(entry, { ...instance, workspace_root: "C:/Work/Application" })).toBe(false);
    expect(nativeSkillMatchesInstance(entry, { ...instance, computer_id: "other" })).toBe(false);
    expect(nativeSkillMatchesInstance(entry, { ...instance, runtime: "claude-code" })).toBe(false);
    expect(nativeSkillMatchesInstance({ ...entry, skill: { ...entry.skill, workspace_root: "/Work" } }, { ...instance, workspace_root: "/work/app" })).toBe(false);
    expect(skillInstallMatchesInstance(install, instance)).toBe(true);
    expect(skillInstallMatchesInstance(install, { ...instance, project_id: "other" })).toBe(false);
    expect(skillInstallMatchesInstance(install, { ...instance, project_id: undefined })).toBe(false);
    expect(skillInstallMatchesInstance({ ...install, project_id: null }, { ...instance, project_id: undefined })).toBe(true);
    expect(matchesSkillSearch("ＣＯＤＥＸ 测试", "codex", "运行测试")).toBe(true);
  });
});
