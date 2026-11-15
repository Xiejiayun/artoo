// @vitest-environment jsdom
import type { SchedulerObservationsV1 } from "@artoo/domain";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fakeApi, renderWithProviders } from "../test/utils.js";
import { SchedulerBaseline } from "./SchedulerBaseline.js";

const measurement: SchedulerObservationsV1 = {
  version: 1,
  project_id: "proj_artoo",
  observed_at: "2026-11-15T00:00:00Z",
  window: { from: "2026-11-08T00:00:00Z", to: "2026-11-15T00:00:00Z" },
  hanging_after_ms: 3600000,
  queue: { assignments: 0, samples: 0, mean_ms: null, max_ms: null },
  execution: { samples: 0, mean_ms: null, max_ms: null },
  failure: { terminal_runs: 0, failed_runs: 0, rate: null },
  current: { hanging_tasks: 0, unconfirmed_disconnect_runs: 2 },
};

describe("scheduler baseline panel", () => {
  it("loads only on opening, renders unknown samples and refreshes its project", async () => {
    const read = vi.fn(async () => measurement);
    renderWithProviders(<SchedulerBaseline projectId="proj_artoo" />, {
      client: fakeApi({ getSchedulerObservations: read }),
    });
    expect(read).not.toHaveBeenCalled();
    const details = screen.getByText("Scheduler baseline · last seven days").parentElement as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(await screen.findByText("Disconnected processes awaiting closure")).toBeInTheDocument();
    expect(read).toHaveBeenCalledWith("proj_artoo");
    expect(screen.getByText("No samples · 0 samples")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Refresh baseline" }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });
  it("shows a failed observation read without fabricated metric values", async () => {
    renderWithProviders(<SchedulerBaseline projectId="proj_artoo" />, {
      client: fakeApi({
        getSchedulerObservations: async () => {
          throw new Error("Read failed");
        },
      }),
    });
    const details = screen.getByText("Scheduler baseline · last seven days").parentElement as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(await screen.findByText("Read failed")).toBeInTheDocument();
    expect(screen.queryByText("Mean queue time")).not.toBeInTheDocument();
  });
});
