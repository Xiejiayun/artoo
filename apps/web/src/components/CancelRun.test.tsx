// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Run } from "@artoo/domain";
import type { ApiClient } from "../api/client.js";
import { fakeApi, renderWithProviders, runFixture } from "../test/utils.js";
import { CancelRun } from "./CancelRun.js";

const first = runFixture({ id: "first-run", status: "running" });
const second = runFixture({ id: "second-run", status: "running", sequence: 1 });

function UpdatingRun() {
  const [runs, setRuns] = useState<Run[]>([first]);
  return <>
    <button onClick={() => setRuns([{ ...first, status: "completed" }])}>First run completed</button>
    <button onClick={() => setRuns([{ ...first, status: "completed" }, second])}>Second run started</button>
    <CancelRun runs={runs} taskId={first.task_id} projectId="proj_artoo" />
  </>;
}

describe("run cancellation confirmation identity", () => {
  it.each([true, false])("requires a new confirmation after the active run changes, with an observed completion gap: %s", async (completionGap) => {
    const cancelRun = vi.fn<ApiClient["cancelRun"]>().mockResolvedValue({ run: { ...second, status: "cancelled" } });
    renderWithProviders(<UpdatingRun />, { client: fakeApi({ cancelRun }) });
    await userEvent.click(screen.getByRole("button", { name: "Stop run" }));
    expect(screen.getByRole("group", { name: "Confirm cancellation" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Confirm cancellation" })).toHaveTextContent(first.id);
    if (completionGap) {
      await userEvent.click(screen.getByRole("button", { name: "First run completed" }));
      expect(screen.queryByRole("region", { name: "Run control" })).not.toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole("button", { name: "Second run started" }));
    expect(screen.queryByRole("button", { name: "Confirm stop" })).not.toBeInTheDocument();
    expect(cancelRun).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Stop run" }));
    expect(screen.getByRole("group", { name: "Confirm cancellation" })).toHaveTextContent("cancel its task");
    expect(screen.getByRole("group", { name: "Confirm cancellation" })).toHaveTextContent(second.id);
    expect(screen.getByRole("group", { name: "Confirm cancellation" })).not.toHaveTextContent(first.id);
    await userEvent.click(screen.getByRole("button", { name: "Confirm stop" }));
    await waitFor(() => expect(cancelRun).toHaveBeenCalledTimes(1));
    expect(cancelRun).toHaveBeenCalledWith(second.id, expect.any(String));
  });

  it("lets the user keep running without sending a cancellation", async () => {
    const cancelRun = vi.fn<ApiClient["cancelRun"]>();
    renderWithProviders(<UpdatingRun />, { client: fakeApi({ cancelRun }) });
    await userEvent.click(screen.getByRole("button", { name: "Stop run" }));
    expect(screen.getByRole("group", { name: "Confirm cancellation" })).toHaveTextContent("Work already written to the workspace is retained.");
    await userEvent.click(screen.getByRole("button", { name: "Keep running" }));
    expect(screen.queryByRole("button", { name: "Confirm stop" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop run" })).toBeEnabled();
    expect(cancelRun).not.toHaveBeenCalled();
  });

  it("keeps a submitted cancellation bound to its confirmed run while the next run appears", async () => {
    let resolveCancel!: (value: Awaited<ReturnType<ApiClient["cancelRun"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<ApiClient["cancelRun"]>>>((resolve) => { resolveCancel = resolve; });
    const cancelRun = vi.fn<ApiClient["cancelRun"]>().mockReturnValue(pending);
    renderWithProviders(<UpdatingRun />, { client: fakeApi({ cancelRun }) });
    await userEvent.click(screen.getByRole("button", { name: "Stop run" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm stop" }));
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith(first.id, expect.any(String)));
    await userEvent.click(screen.getByRole("button", { name: "Second run started" }));
    expect(screen.queryByRole("button", { name: "Confirm stop" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop run" })).toBeDisabled();
    resolveCancel({ run: { ...first, status: "cancelled" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop run" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Confirm stop" })).not.toBeInTheDocument();
    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(cancelRun).toHaveBeenLastCalledWith(first.id, expect.any(String));
  });
});
