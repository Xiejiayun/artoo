// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GoalSchema, GoalAutomationSchema, ProductReleaseSchema, ReleaseAcceptanceBindingV1Schema,
  canonicalReleaseAcceptanceBinding, type Plan } from "@artoo/domain";
import { createHash } from "node:crypto";
import type { ApiClient } from "../api/client.js";
import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { GoalsPage } from "./GoalsPage.js";

const goal = GoalSchema.parse({ id: "goal_1", organization_id: "org_default", project_id: "proj_artoo", room_id: null, owner_user_id: "user_1", title: "A reliable release", objective: "Make delivery repeatable", priority: "p2", status: "draft", acceptance_criteria: ["Evidence is reviewed"], stop_conditions: {}, budgets: {}, current_plan_id: null, running_since: null, elapsed_cost_usd: null, retry_count: 0, created_at: "2026-10-01", updated_at: "2026-10-01" });
function api(overrides: Partial<ApiClient> = {}) {
  return fakeApi({ bootstrap: async () => bootstrapFixture(), listGoals: async () => ({ goals: [goal] }), listPlans: async () => ({ plans: [] }), listCheckpoints: async () => ({ checkpoints: [] }), listDiscussions: async () => ({ discussions: [] }), listChannels: async () => ({ channels: [] }), ...overrides });
}

describe("GoalsPage", () => {
  const automation = GoalAutomationSchema.parse({ goal_id: goal.id, organization_id: "org_default", actor_user_id: "user_1",
    consent_id: null, policy_version: "local-v1", status: "planning", discussion_id: null, plan_id: null,
    agent_instance_id: null, computer_id: null, workspace_root: null, verification_profile_id: "default", last_error: null, created_at: goal.created_at, updated_at: goal.updated_at });

  it("starts autonomous development from one requirement without asking for a title, team or plan", async () => {
    const createAutonomousGoal = vi.fn<ApiClient["createAutonomousGoal"]>().mockResolvedValue({ goal, automation });
    renderWithProviders(<GoalsPage />, { client: api({ createAutonomousGoal }) });
    await userEvent.click(await screen.findByRole("button", { name: "New goal" }));
    const dialog = screen.getByRole("dialog", { name: "New goal" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Execution mode"), "autonomous");
    expect(within(dialog).queryByLabelText("Goal title")).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Goal acceptance criteria")).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Objective"), " Build a journal that preserves entries ");
    await userEvent.click(within(dialog).getByRole("button", { name: "Start autonomous goal" }));
    await waitFor(() => expect(createAutonomousGoal).toHaveBeenCalledWith({ project_id: "proj_artoo", objective: "Build a journal that preserves entries", verification_profile_id: "default", execution_mode: "agent_team", max_retries: 3 }, expect.any(String)));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("shows resource waiting and planning pause without manual plan controls", async () => {
    const goalAction = vi.fn<ApiClient["goalAction"]>().mockResolvedValue({});
    renderWithProviders(<GoalsPage />, { client: api({ goalAction, getGoalAutomation: async () => ({ automation: { ...automation, status: "waiting", last_error: "Waiting for a computer with acceptance checks" } }) }) });
    const progress = await screen.findByRole("region", { name: "Autonomous progress" });
    expect(within(progress).getByText("Waiting for a computer with acceptance checks")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Propose plan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start planning discussion" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Pause goal" }));
    await waitFor(() => expect(goalAction).toHaveBeenCalledWith(goal.id, "pause", expect.any(String)));
  });

  it("requests team publication with one objective and the configured destination", async () => {
    const createAutonomousGoal = vi.fn<ApiClient["createAutonomousGoal"]>().mockResolvedValue({ goal, automation });
    renderWithProviders(<GoalsPage />, { client: api({ createAutonomousGoal }) });
    await userEvent.click(await screen.findByRole("button", { name: "New goal" }));
    const dialog = screen.getByRole("dialog", { name: "New goal" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Execution mode"), "publish");
    expect(within(dialog).queryByLabelText("Goal title")).not.toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText("Objective"), "Publish an accessible journal");
    await userEvent.click(within(dialog).getByRole("button", { name: "Start autonomous goal" }));
    await waitFor(() => expect(createAutonomousGoal).toHaveBeenCalledWith({ project_id: "proj_artoo", objective: "Publish an accessible journal", verification_profile_id: "default", execution_mode: "agent_team", release_profile_id: "default", max_retries: 3 }, expect.any(String)));
  });

  it("shows real stage ownership without asking the user to assign the team", async () => {
    const team = { version: 1 as const, members: ["research", "design", "implementation", "validation"].map((stage) => ({ stage, agent_instance_id: stage === "implementation" ? "instance_mock_coder" : "instance_designer" })), reviewer_instance_ids: ["instance_mock_coder", "instance_designer"] };
    const state = GoalAutomationSchema.parse({ ...automation, execution_mode: "agent_team", team });
    const bootstrap = bootstrapFixture();
    bootstrap.agents.push({ ...bootstrap.agents[0]!, id: "agent_designer", display_name: "Product specialist" });
    bootstrap.agent_instances.push({ ...bootstrap.agent_instances[0]!, id: "instance_designer", agent_id: "agent_designer" });
    renderWithProviders(<GoalsPage />, { client: api({ bootstrap: async () => bootstrap, getGoalAutomation: async () => ({ automation: state }) }) });
    const roles = await screen.findByLabelText("Team responsibilities");
    expect(within(roles).getByText(/Implementation/).closest("li")).toHaveTextContent("Mock Coder");
    expect(within(roles).getByText(/Research/).closest("li")).toHaveTextContent("Product specialist");
    expect(within(roles).getByText(/reviewed by another team member/)).toBeInTheDocument();
  });

  it("does not report publication before an actual release receipt arrives", async () => {
    renderWithProviders(<GoalsPage />, { client: api({ getGoalAutomation: async () => ({ automation: { ...automation, release_profile_id: "default" } }) }) });
    const publication = await screen.findByLabelText("Product publication");
    expect(within(publication).getByText(/Waiting for implementation/)).toBeInTheDocument();
    expect(within(publication).queryByRole("link", { name: "Open published product" })).not.toBeInTheDocument();
  });

  it.each(["published", "rolled_back"] as const)("shows %s release evidence without confusing rollback with success", async (outcome) => {
    const digest = `sha256:${"a".repeat(64)}`;
    const request = { version: 1, release_id: "release_1", goal_id: goal.id, project_id: goal.project_id, run_id: "run_1", release_profile_id: "default", verification_request_id: "verify_1", verification_profile_id: "default", verification_profile_digest: digest, subject_digest: digest };
    const release = ProductReleaseSchema.parse({ id: "release_1", goal_id: goal.id, project_id: goal.project_id, computer_id: "computer_1", run_id: "run_1", evidence_id: "evidence_1", status: outcome, request, created_at: goal.created_at, updated_at: goal.updated_at,
      receipt: { request, release_profile_digest: digest, artifact_digest: digest, outcome, endpoint: outcome === "published" ? "https://journal.example.com/" : null, previous_release_id: null, health_checks: [{ path: "/", status_code: outcome === "published" ? 200 : 503, body_digest: digest, passed: outcome === "published", checked_at: "2026-11-04T00:00:00Z" }] } });
    renderWithProviders(<GoalsPage />, { client: api({ getGoalAutomation: async () => ({ automation: { ...automation, release_profile_id: "default" } }), getGoalRelease: async () => ({ release }) }) });
    const publication = await screen.findByLabelText("Product publication");
    if (outcome === "published") expect(await within(publication).findByRole("link", { name: "Open published product" })).toHaveAttribute("href", "https://journal.example.com/");
    else {
      expect(await within(publication).findByText(/previous release was restored/)).toBeInTheDocument();
      expect(within(publication).queryByRole("link", { name: "Open published product" })).not.toBeInTheDocument();
    }
  });

  it.each(["healthy", "degraded", "rolled_back", "unavailable"] as const)("shows the latest %s observation without reusing the initial publication success", async (state) => {
    const digest = `sha256:${"a".repeat(64)}`, checkedAt = "2026-11-04T00:01:00Z";
    const request = { version: 1, release_id: "release_1", goal_id: goal.id, project_id: goal.project_id, run_id: "run_1", release_profile_id: "default", verification_request_id: "verify_1", verification_profile_id: "default", verification_profile_digest: digest, subject_digest: digest };
    const checks = [{ path: "/", status_code: 200, body_digest: digest, passed: true, checked_at: "2026-11-04T00:00:00Z" }];
    const release = ProductReleaseSchema.parse({ id: request.release_id, goal_id: goal.id, project_id: goal.project_id, computer_id: "computer_1", run_id: "run_1", evidence_id: "evidence_1", status: "published", request, created_at: goal.created_at, updated_at: goal.updated_at,
      receipt: { request, release_profile_digest: digest, artifact_digest: digest, outcome: "published", endpoint: "https://journal.example.com/", previous_release_id: "release_previous", health_checks: checks },
      health: { version: 1, event_id: "health_1", sequence: 1, request, release_profile_digest: digest, artifact_digest: digest, state,
        active_release_id: state === "unavailable" ? null : state === "rolled_back" ? "release_previous" : request.release_id,
        active_artifact_digest: state === "unavailable" ? null : digest, consecutive_failures: state === "healthy" ? 0 : 1,
        health_checks: checks.map((check) => ({ ...check, passed: state === "healthy", status_code: state === "healthy" ? 200 : 503 })),
        recovery_checks: state === "rolled_back" ? checks : [], checked_at: checkedAt } });
    renderWithProviders(<GoalsPage />, { client: api({ getGoalAutomation: async () => ({ automation: { ...automation, status: "completed", release_profile_id: "default" } }), getGoalRelease: async () => ({ release }) }) });
    const publication = await screen.findByLabelText("Product publication");
    const labels = { healthy: /latest health check passed/, degraded: /latest health check failed/, rolled_back: /previous release was restored and checked/, unavailable: /taken offline/ };
    expect(await within(publication).findByText(labels[state])).toBeInTheDocument();
    expect(publication.querySelector("time")).toHaveAttribute("datetime", checkedAt);
    if (state === "healthy") expect(within(publication).getByRole("link", { name: "Open published product" })).toBeInTheDocument();
    else {
      expect(within(publication).queryByRole("link", { name: "Open published product" })).not.toBeInTheDocument();
      expect(screen.queryByText("The verified product was published and its endpoint passed the configured health checks.")).not.toBeInTheDocument();
    }
  });

  it.each(["queued", "published", "failed", "rolled_back"] as const)("keeps publication acceptance distinct for %s requests", async (status) => {
    const digest = `sha256:${"a".repeat(64)}`;
    const acceptanceBinding = ReleaseAcceptanceBindingV1Schema.parse({ version: 1, plan: { id: "plan_1", version: 1 },
      research: { path: ".artoo/product/research.json", checksum: digest, size: 100 }, measurement_plan_digest: digest,
      release_binding: { version: 1, release_profile_id: "default", release_profile_digest: digest, contract_digest: digest,
        project_id: goal.project_id, workspace_root: "/workspace/product", verification_profile_id: "default", verification_profile_digest: digest },
      criteria: [{ requirement_id: "publish", criterion_index: 0, criterion_digest: digest, claim_id: "configured-static-publication" }] });
    const request = { version: 1, release_id: "release_1", goal_id: goal.id, project_id: goal.project_id, run_id: "run_1",
      release_profile_id: "default", verification_request_id: "verify_1", verification_profile_id: "default",
      verification_profile_digest: digest, subject_digest: digest, acceptance_binding: acceptanceBinding };
    const passed = status === "published";
    const release = ProductReleaseSchema.parse({ id: request.release_id, goal_id: goal.id, project_id: goal.project_id,
      computer_id: "computer_1", run_id: request.run_id, evidence_id: "evidence_1", status, request,
      created_at: goal.created_at, updated_at: goal.updated_at, receipt: status === "queued" ? null : {
        request, release_profile_digest: digest, artifact_digest: digest, outcome: status, endpoint: passed ? "https://journal.example.com/" : null,
        previous_release_id: null, health_checks: [{ path: "/", status_code: passed ? 200 : 503, body_digest: digest, passed, checked_at: "2026-11-05T00:00:00Z" }],
        ...(passed ? { acceptance: { version: 1, scope: "node-http-point-in-time", settled_criteria: acceptanceBinding.criteria,
          binding_digest: `sha256:${createHash("sha256").update(canonicalReleaseAcceptanceBinding(acceptanceBinding)).digest("hex")}` } } : {}),
      } });
    renderWithProviders(<GoalsPage />, { client: api({ getGoalAutomation: async () => ({ automation: { ...automation, release_profile_id: "default" } }),
      getGoalRelease: async () => ({ release }) }) });
    const description = await screen.findByLabelText("Publication acceptance");
    expect(description).toHaveTextContent(passed ? "satisfied 1 publication acceptance criterion at publication time"
      : status === "queued" ? "remains pending" : "remains unsatisfied");
  });

  it("reports verified workspace completion without claiming publication", async () => {
    renderWithProviders(<GoalsPage />, { client: api({ listGoals: async () => ({ goals: [{ ...goal, status: "completed" }] }), getGoalAutomation: async () => ({ automation: { ...automation, status: "completed" } }) }) });
    const progress = await screen.findByRole("region", { name: "Autonomous progress" });
    expect(within(progress).getByText(/has not been automatically published/)).toBeInTheDocument();
  });

  it("creates an outcome in a focused dialog using the existing goal contract", async () => {
    const createGoal = vi.fn<ApiClient["createGoal"]>().mockResolvedValue({ goal });
    renderWithProviders(<GoalsPage />, { client: api({ createGoal }) });
    await userEvent.click(await screen.findByRole("button", { name: "New goal" }));
    const dialog = screen.getByRole("dialog", { name: "New goal" });
    await userEvent.type(within(dialog).getByLabelText("Goal title"), " Clear outcome ");
    await userEvent.type(within(dialog).getByLabelText("Objective"), " Deliver reliably ");
    await userEvent.type(within(dialog).getByLabelText("Goal acceptance criteria"), "Pass checks\nReview evidence");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create goal" }));
    await waitFor(() => expect(createGoal).toHaveBeenCalledWith(expect.objectContaining({ project_id: "proj_artoo", title: "Clear outcome", objective: "Deliver reliably", acceptance_criteria: ["Pass checks", "Review evidence"], priority: "p2" }), expect.any(String)));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("uses readable capability choices and preserves dependency references when proposing a plan", async () => {
    const proposePlan = vi.fn<ApiClient["proposePlan"]>().mockResolvedValue({ plan: {} as Plan });
    renderWithProviders(<GoalsPage />, { client: api({ proposePlan }) });
    await userEvent.click(await screen.findByRole("button", { name: "Propose plan" }));
    await userEvent.type(screen.getByLabelText("Plan rationale"), "Verify the work in order");
    await userEvent.type(screen.getByLabelText("Task 1 title"), "Implement release");
    await userEvent.type(screen.getByLabelText("Task 1 acceptance criteria"), "Tests pass");
    await userEvent.click(screen.getByText("Agent capabilities · 0 selected"));
    await userEvent.click(screen.getByRole("checkbox", { name: "Write code" }));
    await userEvent.click(screen.getByRole("button", { name: "Add plan task" }));
    await userEvent.type(screen.getByLabelText("Task 2 title"), "Review release");
    await userEvent.type(screen.getByLabelText("Task 2 acceptance criteria"), "Evidence accepted");
    await userEvent.click(screen.getByRole("checkbox", { name: "Implement release" }));
    await userEvent.click(screen.getByRole("button", { name: "Submit plan for review" }));
    await waitFor(() => expect(proposePlan).toHaveBeenCalledTimes(1));
    expect(proposePlan.mock.calls[0]?.[1].task_specs).toEqual([
      expect.objectContaining({ title: "Implement release", required_capabilities: ["code.modify"], dependencies: [], acceptance_criteria: ["Tests pass"] }),
      expect.objectContaining({ title: "Review release", required_capabilities: [], dependencies: [{ ref: "0", type: "blocks" }], acceptance_criteria: ["Evidence accepted"] }),
    ]);
  });
});
