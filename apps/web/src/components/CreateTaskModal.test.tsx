// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { fakeApi, renderWithProviders, taskFixture } from "../test/utils.js";
import { CreateTaskModal } from "./CreateTaskModal.js";

describe("CreateTaskModal", () => {
  it("submits a CreateTaskRequest with title + criteria and an idempotency key", async () => {
    const createTask = vi
      .fn()
      .mockResolvedValue({ task: taskFixture({ id: "task_new", title: "Build inbox", status: "backlog" }) });
    const onClose = vi.fn();
    const onCreated = vi.fn();
    const client = fakeApi({ createTask });

    renderWithProviders(
      <CreateTaskModal projectId="proj_artoo" onClose={onClose} onCreated={onCreated} />,
      { client },
    );

    await userEvent.type(screen.getByLabelText("Title"), "Build inbox");
    await userEvent.type(
      screen.getByLabelText("Acceptance criteria (one per line)"),
      "see pending\nresolve updates room",
    );
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));

    expect(createTask).toHaveBeenCalledTimes(1);
    const call = createTask.mock.calls[0];
    expect(call).toBeDefined();
    const [request, idempotencyKey] = call as [Record<string, unknown>, string];
    expect(request).toMatchObject({
      project_id: "proj_artoo",
      title: "Build inbox",
      acceptance_criteria: ["see pending", "resolve updates room"],
    });
    expect(typeof idempotencyKey).toBe("string");
    expect(idempotencyKey.length).toBeGreaterThan(0);
    expect(onCreated).toHaveBeenCalledWith("task_new");
    expect(onClose).toHaveBeenCalled();
  });

  it("disables submit until a title is entered", async () => {
    const client = fakeApi({ createTask: vi.fn() });
    renderWithProviders(
      <CreateTaskModal projectId="proj_artoo" onClose={() => undefined} />,
      { client },
    );

    expect(screen.getByRole("button", { name: "Create task" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Title"), "x");
    expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled();
  });
});
