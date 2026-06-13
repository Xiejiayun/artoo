// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { approvalFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { ApprovalInbox } from "./ApprovalInbox.js";

describe("ApprovalInbox", () => {
  it("resolves a pending approval with decision + idempotency key", async () => {
    const resolveApproval = vi
      .fn()
      .mockResolvedValue({ approval: approvalFixture({ id: "approval_1", status: "approved" }) });
    const client = fakeApi({ resolveApproval });

    renderWithProviders(
      <ApprovalInbox
        taskId="task_1"
        approvals={[
          approvalFixture({
            id: "approval_1",
            status: "pending",
            action: "git.push",
            summary: "Push branch artoo/task-1",
          }),
        ]}
      />,
      { client },
    );

    expect(screen.getByText("Push branch artoo/task-1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(resolveApproval).toHaveBeenCalledTimes(1);
    const call = resolveApproval.mock.calls[0];
    expect(call).toBeDefined();
    const [id, body, key] = call as [string, { decision: string }, string];
    expect(id).toBe("approval_1");
    expect(body.decision).toBe("approved");
    expect(typeof key).toBe("string");
    expect(key.length).toBeGreaterThan(0);
  });

  it("renders nothing when there are no pending approvals", () => {
    const client = fakeApi({});
    const { container } = renderWithProviders(
      <ApprovalInbox taskId="task_1" approvals={[approvalFixture({ id: "a", status: "approved" })]} />,
      { client },
    );
    expect(container).toBeEmptyDOMElement();
  });
});
