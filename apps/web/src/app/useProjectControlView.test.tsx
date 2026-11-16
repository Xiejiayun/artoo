// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { fakeApi, renderWithProviders, taskFixture } from "../test/utils.js";
import { controlViewFixture } from "../test/controlViewFixture.js";
import { useProjectControlView } from "./useProjectControlView.js";

const entry = (id: string) => ({ task: taskFixture({ id }), latest_run: null, execution_lease: null, execution_request: null, queue_metadata: null, last_assignment: null });
function Probe() {
  const query = useProjectControlView("proj_artoo");
  return <><output>{query.entries.map((item) => item.task.id).join(",")}</output><button disabled={!query.hasNextPage} onClick={() => void query.fetchNextPage()}>More</button></>;
}
it("keeps the server cursor, de-duplicates overlapping pages and does not request capacity per task", async () => {
  const getProjectControlView = vi.fn().mockResolvedValueOnce(controlViewFixture({ tasks: [entry("t2"), entry("t1")], page: { limit: 100, next_after: "t1", has_more: true, order: "task_id_desc" } })).mockResolvedValue(controlViewFixture({ tasks: [entry("t1"), entry("t0")] }));
  renderWithProviders(<Probe />, { client: fakeApi({ getProjectControlView }) });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("t2,t1"));
  await userEvent.click(screen.getByRole("button", { name: "More" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("t2,t1,t0"));
  expect(getProjectControlView).toHaveBeenNthCalledWith(1, "proj_artoo", { limit: 100 });
  expect(getProjectControlView).toHaveBeenNthCalledWith(2, "proj_artoo", { limit: 100, after: "t1" });
  expect(screen.getByRole("button", { name: "More" })).toBeDisabled();
});
