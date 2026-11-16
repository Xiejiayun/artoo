// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { artifactFixture, fakeApi, renderWithProviders, taskFixture } from "../test/utils.js";
import { ArtifactReview } from "./ArtifactReview.js";

describe("ArtifactReview", () => {
  it("previews stored artifact text only on request and keeps markup escaped", async () => {
    const downloadArtifact = vi.fn().mockResolvedValue(new NodeBlob(["<img src=x onerror=alert(1)>\n+recorded patch"]));
    const { container } = renderWithProviders(
      <ArtifactReview
        task={taskFixture({ id: "task_1", title: "T", status: "review" })}
        artifacts={[
          artifactFixture({ id: "artifact_text", type: "patch", uri: "/api/v1/artifacts/artifact_text/content" }),
        ]}
      />,
      { client: fakeApi({ downloadArtifact }) },
    );
    expect(downloadArtifact).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Preview artifact text" }));
    expect(await screen.findByLabelText("Artifact artifact_text recorded text")).toHaveTextContent(
      "<img src=x onerror=alert(1)>",
    );
    expect(container.querySelector("img")).toBeNull();
    expect(downloadArtifact).toHaveBeenCalledWith("artifact_text");
  });
  it("lists artifacts and accepts a task in review", async () => {
    const reviewTask = vi.fn().mockResolvedValue({ task: taskFixture({ id: "task_1", title: "T", status: "done" }) });
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
    const reviewTask = vi.fn().mockResolvedValue({ task: taskFixture({ id: "task_1", title: "T", status: "ready" }) });
    const client = fakeApi({ reviewTask });

    renderWithProviders(
      <ArtifactReview task={taskFixture({ id: "task_1", title: "T", status: "review" })} artifacts={[]} />,
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
      <ArtifactReview task={taskFixture({ id: "task_1", title: "T", status: "running" })} artifacts={[]} />,
      { client },
    );
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request changes" })).toBeNull();
  });
});
