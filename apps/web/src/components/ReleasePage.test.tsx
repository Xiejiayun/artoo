// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GoalSchema, ProductReleaseSchema, type ProductRelease } from "@artoo/domain";
import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { ReleasePage } from "./ReleasePage.js";

const time = "2026-11-11T00:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
const goal = GoalSchema.parse({ id: "goal_1", organization_id: "org_default", project_id: "proj_artoo", room_id: null, owner_user_id: "user_1", title: "Publish the journal", objective: "Make the journal available", priority: "p2", status: "completed", acceptance_criteria: [], stop_conditions: {}, budgets: {}, current_plan_id: null, running_since: null, elapsed_cost_usd: null, retry_count: 0, created_at: time, updated_at: time });
const request = { version: 1, release_id: "release_1", goal_id: goal.id, project_id: goal.project_id, run_id: "run_1", release_profile_id: "site", verification_request_id: "verification_1", verification_profile_id: "tests", verification_profile_digest: digest, subject_digest: digest };
const release = ProductReleaseSchema.parse({ id: "release_1", goal_id: goal.id, project_id: goal.project_id, computer_id: "computer_1", run_id: "run_1", evidence_id: "evidence_1", status: "published", request, receipt: { request, release_profile_digest: digest, artifact_digest: digest, outcome: "published", endpoint: "https://journal.example/", previous_release_id: null, health_checks: [{ path: "/", status_code: 200, body_digest: digest, passed: true, checked_at: time }] }, created_at: time, updated_at: time });
function client(value: ProductRelease | null = null) {
  return fakeApi({ bootstrap: async () => bootstrapFixture(), listGoals: async () => ({ goals: [goal] }), getGoalRelease: async () => ({ release: value }) });
}

describe("ReleasePage", () => {
  it("does not infer publication or invent a publish action from a completed goal", async () => {
    renderWithProviders(<ReleasePage />, { client: client() });
    expect(await screen.findByText("Not published")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open published product" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Publication overview" })).queryByRole("button", { name: /Publish|Deploy/ })).not.toBeInTheDocument();
    const checks = screen.getByRole("region", { name: "Release checks" });
    expect(within(checks).getAllByText("Pending")).toHaveLength(3);
  });

  it("shows executor evidence and a confirmed publication endpoint", async () => {
    renderWithProviders(<ReleasePage />, { client: client(release) });
    expect(await screen.findByRole("link", { name: "Open published product" })).toHaveAttribute("href", "https://journal.example/");
    expect(screen.getByRole("region", { name: "Endpoint measurements" })).toHaveTextContent("200");
    expect(screen.getByRole("region", { name: "Release record" })).toBeInTheDocument();
  });

  it("suppresses a historical endpoint after a failed health observation", async () => {
    const unhealthy: ProductRelease = { ...release, health: { version: 1, event_id: "health_1", sequence: 1, request: release.request, release_profile_digest: digest, artifact_digest: digest, state: "degraded", active_release_id: release.id, active_artifact_digest: digest, consecutive_failures: 1, health_checks: [{ path: "/", status_code: 503, body_digest: null, passed: false, checked_at: time }], recovery_checks: [], checked_at: time, reason: "Endpoint returned 503" } };
    renderWithProviders(<ReleasePage />, { client: client(unhealthy) });
    expect(await screen.findByText("degraded")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open published product" })).not.toBeInTheDocument();
    expect(screen.getByText("Endpoint returned 503")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Release checks" })).getByText("Failed")).toBeInTheDocument();
  });

  it.each(["javascript:alert(1)", "https://user:password@example.com/"])("does not expose unsafe endpoint %s", async (endpoint) => {
    renderWithProviders(<ReleasePage />, { client: client({ ...release, receipt: { ...release.receipt!, endpoint } }) });
    await screen.findByText("Published");
    expect(screen.queryByRole("link", { name: "Open published product" })).not.toBeInTheDocument();
  });

  it("keeps independent goals separate when switching release records", async () => {
    const getGoalRelease = vi.fn(async (id: string) => ({ release: id === goal.id ? release : null }));
    renderWithProviders(<ReleasePage />, { client: fakeApi({ bootstrap: async () => bootstrapFixture(), listGoals: async () => ({ goals: [goal, { ...goal, id: "goal_2", title: "Second outcome" }] }), getGoalRelease }) });
    await screen.findByRole("link", { name: "Open published product" });
    await userEvent.click(screen.getByRole("button", { name: /Second outcome/ }));
    await waitFor(() => expect(getGoalRelease).toHaveBeenCalledWith("goal_2"));
    expect(await screen.findByText("Not published")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open published product" })).not.toBeInTheDocument();
  });
});
