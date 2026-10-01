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

  it("focuses the brief, supports keyboard submission, and preserves selected routing fields", async () => {
    const createTask = vi.fn().mockResolvedValue({ task: taskFixture({ id: "new", title: "Improve search", status: "backlog" }) });
    renderWithProviders(<CreateTaskModal projectId="proj_artoo" onClose={() => undefined} />, { client: fakeApi({ createTask }) });

    expect(screen.getByRole("dialog", { name: "Create task" })).toHaveAttribute("aria-modal", "true");
    expect(screen.getByLabelText("Title")).toHaveFocus();
    await userEvent.type(screen.getByLabelText("Title"), "  Improve search  ");
    await userEvent.type(screen.getByLabelText("Description"), "Keep keyboard navigation working");
    await userEvent.selectOptions(screen.getByLabelText("Priority"), "p1");
    await userEvent.click(screen.getByText("Required capabilities"));
    await userEvent.click(screen.getByRole("checkbox", { name: "Write code" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Run tests" }));
    await userEvent.click(screen.getByLabelText("Title"));
    await userEvent.keyboard("{Control>}{Enter}{/Control}");

    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ title: "Improve search", description: "Keep keyboard navigation working", priority: "p1", required_capabilities: ["code.modify", "test.run"] }), expect.any(String));
  });

  it("closes with Escape without creating work", async () => {
    const onClose = vi.fn();
    const createTask = vi.fn();
    renderWithProviders(<CreateTaskModal projectId="proj_artoo" onClose={onClose} />, { client: fakeApi({ createTask }) });
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(createTask).not.toHaveBeenCalled();
  });
});
