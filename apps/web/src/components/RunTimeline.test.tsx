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
});
