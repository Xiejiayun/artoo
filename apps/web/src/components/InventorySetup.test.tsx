// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime, SkillInstall } from "@artoo/domain";
import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { AgentRegistration, SkillInstallForm } from "./InventorySetup.js";

const runtime: AgentRuntime = { id: "runtime_mock", organization_id: "org_default", computer_id: "computer_local_mock", runtime: "mock", version: "1.0", status: "available", capabilities: ["code.modify"], last_seen_at: "2026-10-01T00:00:00Z" };
const manifest = { api_version: "v1alpha1", id: "review-kit", name: "Review kit", version: "1.0.0", capabilities: ["code.review"], compatible_runtimes: ["mock"], permissions: { filesystem: { read: ["src/**"], write: [] }, network: { outbound: ["docs.example.com"] }, secrets: ["REVIEW_SERVICE"], high_risk_actions: [{ action: "Publish review", risk: "high" }] }, approval_risks: [{ action: "Send report", risk: "medium", reason: "Shares the report with the team" }] };

describe("Resource setup", () => {
  it("reviews readable access before installing the exact manifest and scope", async () => {
    const user = userEvent.setup();
    const installSkill = vi.fn(async () => ({ skill: {} as SkillInstall }));
    renderWithProviders(<SkillInstallForm />, { client: fakeApi({ bootstrap: async () => bootstrapFixture(), installSkill }) });
    await user.click(await screen.findByRole("button", { name: "Install a skill manifest" }));
    await user.selectOptions(screen.getByLabelText("Install scope"), "organization");
    await user.click(screen.getByLabelText("Skill manifest (JSON)"));
    await user.paste(JSON.stringify(manifest));
    expect(screen.queryByRole("button", { name: "Install reviewed skill" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review manifest" }));
    const dialog = screen.getByRole("dialog", { name: "Install a skill" });
    for (const text of ["Files to read", "src/**", "Network destinations", "docs.example.com", "Secret references", "REVIEW_SERVICE", "High-risk actions", "Publish review", "Approval requirements", "Shares the report with the team"]) expect(within(dialog).getByText(text, { exact: true })).toBeVisible();
    expect(installSkill).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Install reviewed skill" }));
    await waitFor(() => expect(installSkill).toHaveBeenCalledWith(expect.objectContaining({ project_id: null, enabled: true, manifest: expect.objectContaining(manifest) }), expect.any(String)));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("Skill installed.")).toBeInTheDocument();
  });

  it("requires a fresh review after editing the manifest and keeps invalid input editable", async () => {
    const user = userEvent.setup();
    const installSkill = vi.fn(async () => ({ skill: {} as SkillInstall }));
    renderWithProviders(<SkillInstallForm />, { client: fakeApi({ bootstrap: async () => bootstrapFixture(), installSkill }) });
    await user.click(await screen.findByRole("button", { name: "Install a skill manifest" }));
    await user.click(screen.getByLabelText("Skill manifest (JSON)")); await user.paste(JSON.stringify(manifest));
    await user.click(screen.getByRole("button", { name: "Review manifest" }));
    await user.click(screen.getByRole("button", { name: "Back to manifest" }));
    await user.clear(screen.getByLabelText("Skill manifest (JSON)")); await user.type(screen.getByLabelText("Skill manifest (JSON)"), "invalid JSON");
    await user.click(screen.getByRole("button", { name: "Review manifest" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Install reviewed skill" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Skill manifest (JSON)")).toHaveValue("invalid JSON");
    expect(installSkill).not.toHaveBeenCalled();
  });

  it("registers the selected runtime and trimmed workspace without changing the API contract", async () => {
    const user = userEvent.setup();
    const registerAgent = vi.fn(async () => ({}));
    renderWithProviders(<AgentRegistration computerId="computer_local_mock" computerName="Local Mock" runtimes={[runtime]} />, { client: fakeApi({ bootstrap: async () => bootstrapFixture(), registerAgent }) });
    await user.click(await screen.findByRole("button", { name: "Register an agent workspace" }));
    await user.type(screen.getByLabelText("Agent display name"), " Code reviewer ");
    await user.selectOptions(screen.getByLabelText("Agent runtime"), "mock");
    await user.type(screen.getByLabelText("Agent workspace path"), " C:/workspace/team ");
    await user.click(screen.getByRole("button", { name: "Register agent" }));
    await waitFor(() => expect(registerAgent).toHaveBeenCalledWith("computer_local_mock", { runtime: "mock", workspace_root: "C:/workspace/team", display_name: "Code reviewer" }, expect.any(String)));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("Agent workspace registered. It is available on the Agents page.")).toBeInTheDocument();
  });

  it("explains missing runtimes and prevents registration", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgentRegistration computerId="computer_local_mock" runtimes={[]} />, { client: fakeApi({ bootstrap: async () => bootstrapFixture() }) });
    await user.click(await screen.findByRole("button", { name: "Register an agent workspace" }));
    expect(screen.getByText(/No runtimes reported yet/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Agent workspace path"), "C:/workspace/team");
    expect(screen.getByRole("button", { name: "Register agent" })).toBeDisabled();
  });
});
