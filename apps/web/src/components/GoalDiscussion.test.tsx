// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GoalSchema, type Discussion } from "@artoo/domain";
import type { ApiClient } from "../api/client.js";
import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { GoalDiscussion } from "./GoalDiscussion.js";

const goal = GoalSchema.parse({ id: "goal_1", organization_id: "org_default", project_id: "proj_artoo", room_id: "goal_room", owner_user_id: "user_1", title: "Shared outcome", objective: "Deliver it", priority: "p2", status: "draft", stop_conditions: {}, budgets: {}, current_plan_id: null, running_since: null, elapsed_cost_usd: null, retry_count: 0, created_at: "2026-09-29", updated_at: "2026-09-29" });
const session: Discussion = { id: "discussion_1", goal_id: "goal_1", room_id: "goal_room", thread_root_id: "root_1", participants: [], rounds: 1, max_minutes: 5,
  status: "running", current_step: 0, total_steps: 3, active_turn_id: null, plan_id: null, error: null, created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z", deadline_at: "2026-09-29T00:05:00Z" };
function api(overrides: Partial<ApiClient> = {}) {
  const bootstrap = bootstrapFixture();
  bootstrap.agent_instances.push({ ...bootstrap.agent_instances[0]!, id: "instance_review", agent_id: "agent_review" });
  bootstrap.agents.push({ ...bootstrap.agents[0]!, id: "agent_review", display_name: "Review Agent" });
  return fakeApi({ bootstrap: async () => bootstrap, listChannels: async () => ({ channels: [] }), listDiscussions: async () => ({ discussions: [] }),
    listMessages: async () => ({ messages: [] }), listAssistantTurns: async () => ({ turns: [] }), listMembers: async () => ({ members: [] }), ...overrides });
}
describe("GoalDiscussion", () => {
  it("requires two distinct instances and sends the selected roles and bounds", async () => {
    const startDiscussion = vi.fn<ApiClient["startDiscussion"]>().mockResolvedValue({ discussion: session });
    renderWithProviders(<GoalDiscussion goal={goal} />, { client: api({ startDiscussion }) });
    const submit = await screen.findByRole("button", { name: "Start planning discussion" });
    expect(submit).toBeDisabled();
    const boxes = await screen.findAllByRole("checkbox");
    await userEvent.click(boxes[0]!);
    expect(submit).toBeDisabled();
    await userEvent.click(boxes[1]!);
    await userEvent.clear(screen.getByLabelText("Discussion rounds")); await userEvent.type(screen.getByLabelText("Discussion rounds"), "1");
    await userEvent.clear(screen.getByLabelText("Discussion time limit (minutes)")); await userEvent.type(screen.getByLabelText("Discussion time limit (minutes)"), "5");
    await userEvent.click(submit);
    await waitFor(() => expect(startDiscussion).toHaveBeenCalledWith("goal_1", { participants: [
      { agent_instance_id: "instance_mock_coder", role: "Design and synthesis" }, { agent_instance_id: "instance_review", role: "Review and verification" },
    ], rounds: 1, max_minutes: 5 }, expect.any(String)));
  });
  it("creates a proposal without invoking plan acceptance or starting tasks", async () => {
    const proposeDiscussionPlan = vi.fn<ApiClient["proposeDiscussionPlan"]>().mockResolvedValue({ discussion: { ...session, status: "ready", plan_id: "plan_1" }, plan: {} as any });
    const planAction = vi.fn<ApiClient["planAction"]>();
    renderWithProviders(<GoalDiscussion goal={goal} />, { client: api({ listDiscussions: async () => ({ discussions: [{ ...session, status: "ready", current_step: 3 }] }), proposeDiscussionPlan, planAction }) });
    await userEvent.click(await screen.findByRole("button", { name: "Create plan proposal" }));
    expect(proposeDiscussionPlan).toHaveBeenCalledWith(session.id, expect.any(String));
    expect(planAction).not.toHaveBeenCalled();
  });
  it("shows stopping until daemon acknowledgement and prevents overlapping discussions", async () => {
    const cancelDiscussion = vi.fn<ApiClient["cancelDiscussion"]>().mockResolvedValue({ discussion: { ...session, status: "stopping" } });
    renderWithProviders(<GoalDiscussion goal={goal} />, { client: api({ listDiscussions: async () => ({ discussions: [{ ...session, status: "stopping" }] }), cancelDiscussion }) });
    expect(await screen.findByText(/Waiting for its daemon to confirm/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start planning discussion" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Stop discussion" }));
    expect(cancelDiscussion).toHaveBeenCalledWith(session.id, expect.any(String));
  });
});
