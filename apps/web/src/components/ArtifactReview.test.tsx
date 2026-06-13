// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { artifactFixture, fakeApi, renderWithProviders, taskFixture } from "../test/utils.js";
import { ArtifactReview } from "./ArtifactReview.js";

describe("ArtifactReview", () => {
  it("lists artifacts and accepts a task in review", async () => {
    const reviewTask = vi
      .fn()
      .mockResolvedValue({ task: taskFixture({ id: "task_1", title: "T", status: "done" }) });
    const client = fakeApi({ reviewTask });

    renderWithProviders(
      <ArtifactReview
        task={taskFixture({ id: "task_1", title: "T", status: "review" })}
        artifacts={[artifactFixture({ id: "art_1", type: "patch", uri: "fix.patch" })]}
      />,
      { client },
    );

    expect(screen.getByText("fix.patch")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));

    expect(reviewTask).toHaveBeenCalledTimes(1);
    const [id, body, key] = reviewTask.mock.calls[0] as [string, { outcome: string }, string];
    expect(id).toBe("task_1");
    expect(body.outcome).toBe("accepted");
    expect(key.length).toBeGreaterThan(0);
  });

  it("requests changes and shows an empty artifact state", async () => {
    const reviewTask = vi
      .fn()
      .mockResolvedValue({ task: taskFixture({ id: "task_1", title: "T", status: "ready" }) });
    const client = fakeApi({ reviewTask });

    renderWithProviders(
      <ArtifactReview
        task={taskFixture({ id: "task_1", title: "T", status: "review" })}
        artifacts={[]}
      />,
      { client },
    );

    expect(screen.getByText("No artifacts yet.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Request changes" }));
    const [, body] = reviewTask.mock.calls[0] as [string, { outcome: string }, string];
    expect(body.outcome).toBe("changes_requested");
  });

  it("hides review actions when the task is not in review", () => {
    const client = fakeApi({});
    renderWithProviders(
      <ArtifactReview
        task={taskFixture({ id: "task_1", title: "T", status: "running" })}
        artifacts={[]}
      />,
      { client },
    );
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request changes" })).toBeNull();
  });
});
