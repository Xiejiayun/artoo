// @vitest-environment jsdom
import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useNavigate } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { bootstrapFixture, fakeApi, renderWithProviders } from "../test/utils.js";
import { useProject } from "./useProject.js";
import { useProjectLink } from "./useProjectLink.js";

const first = { id: "first", name: "First", default_workspace: null };
const target = { id: "target", name: "Target", default_workspace: null };
const snapshot = () => bootstrapFixture({ projects: [first, target] });

function Probe() {
  useProjectLink();
  const { projectId, setSelectedProjectId } = useProject();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="Selected project">{projectId ?? "none"}</output>
      <button onClick={() => navigate("/board?project=first")}>Open first</button>
      <button onClick={() => navigate("/board?project=target")}>Open target</button>
      <button onClick={() => navigate(-1)}>Back</button>
      <button
        onClick={() => {
          setSelectedProjectId(first.id);
          navigate("/board");
        }}
      >
        Choose first
      </button>
      <button onClick={() => navigate("/board")}>Leave link</button>
    </>
  );
}

it("restores an authorized project-only link when bootstrap ordering differs", async () => {
  renderWithProviders(<Probe />, {
    route: "/?project=target",
    client: fakeApi({ bootstrap: async () => snapshot() }),
  });
  await waitFor(() => expect(screen.getByLabelText("Selected project")).toHaveTextContent("target"));
  await userEvent.click(screen.getByRole("button", { name: "Choose first" }));
  expect(screen.getByLabelText("Selected project")).toHaveTextContent("first");
});

it("resolves project links on navigation and browser history", async () => {
  renderWithProviders(<Probe />, {
    route: "/?project=target",
    client: fakeApi({ bootstrap: async () => snapshot() }),
  });
  await waitFor(() => expect(screen.getByLabelText("Selected project")).toHaveTextContent("target"));
  await userEvent.click(screen.getByRole("button", { name: "Open first" }));
  await waitFor(() => expect(screen.getByLabelText("Selected project")).toHaveTextContent("first"));
  await userEvent.click(screen.getByRole("button", { name: "Open target" }));
  await waitFor(() => expect(screen.getByLabelText("Selected project")).toHaveTextContent("target"));
  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  await waitFor(() => expect(screen.getByLabelText("Selected project")).toHaveTextContent("first"));
});

it.each([
  "/?project=unknown",
  ...[
    "task",
    "goal",
    "room",
    "thread",
    "message",
    "notification",
    "run",
    "instance",
    "agent",
    "create",
    "instance_id",
    "project_id",
    "run_id",
    "future_resource",
  ].map((key) => `/?project=target&${key}=unverified`),
])("does not select an unknown project or bypass resource verification at %s", async (route) => {
  const bootstrap = vi.fn(async () => snapshot());
  renderWithProviders(<Probe />, { route, client: fakeApi({ bootstrap }) });
  await waitFor(() => expect(screen.getByLabelText("Selected project")).toHaveTextContent("first"));
  expect(bootstrap).toHaveBeenCalledTimes(1);
});

it("does not apply a late bootstrap response after leaving the link", async () => {
  let finish!: (value: ReturnType<typeof snapshot>) => void;
  const bootstrap = vi.fn(
    () =>
      new Promise<ReturnType<typeof snapshot>>((resolve) => {
        finish = resolve;
      }),
  );
  renderWithProviders(<Probe />, { route: "/?project=target", client: fakeApi({ bootstrap }) });
  await waitFor(() => expect(bootstrap).toHaveBeenCalledTimes(1));
  await userEvent.click(screen.getByRole("button", { name: "Leave link" }));
  await act(async () => {
    finish(snapshot());
  });
  await waitFor(() => expect(screen.getByLabelText("Selected project")).toHaveTextContent("first"));
});
