// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { fakeApi, renderWithProviders, taskFixture } from "../test/utils.js";
import { TaskActions } from "./TaskActions.js";

describe("TaskActions", () => {
  it("Mark ready calls markReady with an idempotency key (backlog)", async () => {
    const markReady = vi
      .fn()
      .mockResolvedValue({ task: taskFixture({ id: "task_1", title: "T", status: "ready" }) });
    const client = fakeApi({ markReady });
    renderWithProviders(<TaskActions task={taskFixture({ id: "task_1", title: "T", status: "backlog" })} />, {
      client,
    });

    await userEvent.click(screen.getByRole("button", { name: "Mark ready" }));

    const [id, key] = markReady.mock.calls[0] as [string, string];
    expect(id).toBe("task_1");
    expect(key.length).toBeGreaterThan(0);
  });

  it("Assign calls assignTask in auto mode (ready)", async () => {
    const assignTask = vi
      .fn()
      .mockResolvedValue({ run: { id: "run_1" }, scheduler_decision: { reason: "x", score: 1 } });
    const client = fakeApi({ assignTask });
    renderWithProviders(<TaskActions task={taskFixture({ id: "task_1", title: "T", status: "ready" })} />, {
      client,
    });

    await userEvent.click(screen.getByRole("button", { name: "Assign" }));

    const [id, body, key] = assignTask.mock.calls[0] as [string, { mode: string }, string];
    expect(id).toBe("task_1");
    expect(body.mode).toBe("auto");
    expect(key.length).toBeGreaterThan(0);
  });

  it("Retry calls retryTask (blocked)", async () => {
    const retryTask = vi
      .fn()
      .mockResolvedValue({ task: taskFixture({ id: "task_1", title: "T", status: "ready" }) });
    const client = fakeApi({ retryTask });
    renderWithProviders(<TaskActions task={taskFixture({ id: "task_1", title: "T", status: "blocked" })} />, {
      client,
    });

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryTask).toHaveBeenCalledTimes(1);
  });

  it("renders nothing for non-actionable statuses (review)", () => {
    const client = fakeApi({});
    const { container } = renderWithProviders(
      <TaskActions task={taskFixture({ id: "task_1", title: "T", status: "review" })} />,
      { client },
    );
    expect(container).toBeEmptyDOMElement();
  });
});
