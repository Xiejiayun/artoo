// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { fakeApi, renderWithProviders, runFixture } from "../test/utils.js";
import { RunTimeline } from "./RunTimeline.js";

const client = fakeApi({});

describe("RunTimeline", () => {
  it("shows an empty state with no runs", () => {
    renderWithProviders(<RunTimeline runs={[]} />, { client });
    expect(screen.getByText("No runs yet.")).toBeInTheDocument();
  });

  it("orders runs newest-first and surfaces failure reasons", () => {
    renderWithProviders(
      <RunTimeline
        runs={[
          runFixture({
            id: "run_1",
            status: "failed",
            created_at: "2026-06-13T00:00:00Z",
            failure_reason: "boom",
          }),
          runFixture({ id: "run_2", status: "completed", created_at: "2026-06-13T01:00:00Z" }),
        ]}
      />,
      { client },
    );
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0] as HTMLElement).toHaveTextContent("completed");
    expect(items[1] as HTMLElement).toHaveTextContent("failed");
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("collapses output behind a details summary", () => {
    renderWithProviders(
      <RunTimeline
        runs={[runFixture({ id: "run_1", status: "running" })]}
        outputsByRun={{ run_1: ["line a", "line b"] }}
      />,
      { client },
    );
    expect(screen.getByText("2 output lines")).toBeInTheDocument();
  });

  it("binds displayed origin, time and output to exact IDs even when historical runs arrive out of order", () => {
    const old = runFixture({ id: "run_failed_worktree", status: "failed", created_at: "2026-10-01T01:00:00Z" });
    const next = runFixture({ id: "run_corrected_worktree", status: "completed", created_at: "2026-10-01T02:00:00Z" });
    renderWithProviders(<RunTimeline runs={[old, next]} outputsByRun={{ [old.id]: ["Retained old worktree"], [next.id]: ["Uploaded corrected report"] }} />, { client });
    const previous = screen.getByRole("listitem", { name: `Run ${old.id}` });
    const corrected = screen.getByRole("listitem", { name: `Run ${next.id}` });
    expect(previous).toHaveAttribute("data-run-id", old.id);
    expect(previous).toHaveTextContent(old.id);
    expect(previous).toHaveTextContent("Retained old worktree");
    expect(previous).not.toHaveTextContent("Uploaded corrected report");
    expect(previous.querySelector("time")).toHaveAttribute("datetime", old.created_at);
    expect(corrected).toHaveAttribute("data-status", "completed");
    expect(corrected).toHaveTextContent(next.id);
    expect(corrected).toHaveTextContent("Uploaded corrected report");
    expect(corrected.querySelector("time")).toHaveAttribute("datetime", next.created_at);
  });
});
