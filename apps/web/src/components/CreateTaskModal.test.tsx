// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { fakeApi, renderWithProviders, taskFixture } from "../test/utils.js";
import { CreateTaskModal } from "./CreateTaskModal.js";

describe("CreateTaskModal", () => {
  it("reuses one creation identity for an unchanged brief after a lost response", async () => {
    const createTask = vi
      .fn()
      .mockRejectedValueOnce(new Error("Response delivery lost"))
      .mockResolvedValue({
        task: taskFixture({ id: "already-created", title: "One logical task", status: "backlog" }),
      });
    renderWithProviders(<CreateTaskModal projectId="proj_artoo" onClose={() => undefined} />, {
      client: fakeApi({ createTask }),
    });
    await userEvent.type(screen.getByLabelText("Title"), "One logical task");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Response delivery lost");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask.mock.calls[1]).toEqual(createTask.mock.calls[0]);
  });

  it("uses a fresh creation identity when the submitted brief changes", async () => {
    const createTask = vi.fn().mockRejectedValue(new Error("Controlled rejection"));
    renderWithProviders(<CreateTaskModal projectId="proj_artoo" onClose={() => undefined} />, {
      client: fakeApi({ createTask }),
    });
    await userEvent.type(screen.getByLabelText("Title"), "Original task");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    await screen.findByRole("alert");
    await userEvent.type(screen.getByLabelText("Description"), "A changed brief");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask.mock.calls[1]![1]).not.toBe(createTask.mock.calls[0]![1]);
    expect(createTask.mock.calls[1]![0]).toMatchObject({ description: "A changed brief" });
  });

  it("starts a fresh creation identity when a new dialog repeats an earlier brief", async () => {
    const createTask = vi
      .fn()
      .mockResolvedValue({ task: taskFixture({ id: "created", title: "Repeatable brief", status: "backlog" }) });
    const client = fakeApi({ createTask });
    const first = renderWithProviders(<CreateTaskModal projectId="proj_artoo" onClose={() => undefined} />, { client });
    await userEvent.type(screen.getByLabelText("Title"), "Repeatable brief");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    first.unmount();
    renderWithProviders(<CreateTaskModal projectId="proj_artoo" onClose={() => undefined} />, { client });
    await userEvent.type(screen.getByLabelText("Title"), "Repeatable brief");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    expect(createTask).toHaveBeenCalledTimes(2);
    expect(createTask.mock.calls[1]![0]).toEqual(createTask.mock.calls[0]![0]);
    expect(createTask.mock.calls[1]![1]).not.toBe(createTask.mock.calls[0]![1]);
  });
  it("submits a CreateTaskRequest with title + criteria and an idempotency key", async () => {
    const createTask = vi
      .fn()
      .mockResolvedValue({ task: taskFixture({ id: "task_new", title: "Build inbox", status: "backlog" }) });
    const onClose = vi.fn();
    const onCreated = vi.fn();
    const client = fakeApi({ createTask });

    renderWithProviders(<CreateTaskModal projectId="proj_artoo" onClose={onClose} onCreated={onCreated} />, { client });

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
    expect(request).not.toHaveProperty("delegation");
    expect(typeof idempotencyKey).toBe("string");
    expect(idempotencyKey.length).toBeGreaterThan(0);
    expect(onCreated).toHaveBeenCalledWith("task_new");
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Task created.");
  });

  it("disables submit until a title is entered", async () => {
    const client = fakeApi({ createTask: vi.fn() });
    renderWithProviders(<CreateTaskModal projectId="proj_artoo" onClose={() => undefined} />, { client });

    expect(screen.getByRole("button", { name: "Create task" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Title"), "x");
    expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled();
  });

  it("focuses the brief, supports keyboard submission, and preserves selected routing fields", async () => {
    const createTask = vi
      .fn()
      .mockResolvedValue({ task: taskFixture({ id: "new", title: "Improve search", status: "backlog" }) });
    renderWithProviders(<CreateTaskModal projectId="proj_artoo" onClose={() => undefined} />, {
      client: fakeApi({ createTask }),
    });

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

    expect(createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Improve search",
        description: "Keep keyboard navigation working",
        priority: "p1",
        required_capabilities: ["code.modify", "test.run"],
      }),
      expect.any(String),
    );
  });

  it("closes with Escape without creating work", async () => {
    const onClose = vi.fn();
    const createTask = vi.fn();
    renderWithProviders(<CreateTaskModal projectId="proj_artoo" onClose={onClose} />, {
      client: fakeApi({ createTask }),
    });
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(createTask).not.toHaveBeenCalled();
  });
});
