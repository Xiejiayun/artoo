// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { PlanSchema, TaskSpecSchema } from "@artoo/domain";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import { fakeApi, renderWithProviders } from "../test/utils.js";
import { PlanRevisionDialog } from "./PlanRevisionDialog.js";

describe("PlanRevisionDialog", () => {
  it("creates a reviewable revision without accepting or removing task constraints", async () => {
    const plan = PlanSchema.parse({ id: "plan_revision", organization_id: "org_default", goal_id: "goal_1", version: 1,
      author_type: "user", author_id: "user_1", status: "proposed", rationale: "Original rationale",
      task_specs: [TaskSpecSchema.parse({ title: "Upstream", acceptance_criteria: ["Evidence exists"], required_capabilities: ["code.modify"] }),
        TaskSpecSchema.parse({ title: "Downstream", acceptance_criteria: ["Evidence reviewed"], dependencies: [{ ref: "0", type: "artifact_required" }], approval_gates: ["execution"], write_scopes: ["src"], expected_artifacts: [{ type: "report", description: "Review evidence" }] })],
      materialized_at: null, materialization_event_id: null, created_at: "2026-11-16T00:00:00Z", accepted_at: null });
    const proposePlan = vi.fn<ApiClient["proposePlan"]>().mockResolvedValue({ plan });
    const planAction = vi.fn<ApiClient["planAction"]>();
    const onCreated = vi.fn(async () => undefined);
    renderWithProviders(<PlanRevisionDialog plan={plan} onClose={() => undefined} onCreated={onCreated} />, { client: fakeApi({ proposePlan, planAction }) });
    await userEvent.clear(screen.getByLabelText("Revised task 2 title"));
    await userEvent.type(screen.getByLabelText("Revised task 2 title"), "Review downstream");
    await userEvent.click(screen.getByRole("button", { name: "Save revised proposal" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(proposePlan).toHaveBeenCalledWith("goal_1", { rationale: "Original rationale", task_specs: [expect.objectContaining(plan.task_specs[0]!), expect.objectContaining({ ...plan.task_specs[1]!, title: "Review downstream" })] }, expect.any(String));
    expect(planAction).not.toHaveBeenCalled();
  });
});
