import { expect, test } from "@playwright/test";

const PROJECT_ID = "proj_artoo";

interface TaskRow {
  id: string;
  title: string;
}

/**
 * Full v0.1 happy path against the real server:
 * create → ready → assign (UI) → drive the run server-side via dev mock-execute
 * → WS realtime refreshes the UI to review + artifact → accept → done.
 *
 * No real agent/node is connected; `dev/runs/:id/mock-execute` simulates the run
 * server-side (workspace-safe).
 */
test("create → ready → assign → mock run → review → accept → done", async ({ page, request }) => {
  await page.goto("/");

  // Workspace loads with the seeded project.
  await expect(page.getByRole("heading", { name: "artoo", level: 1 })).toBeVisible();

  // Create a uniquely-titled task.
  const title = `E2E happy path ${Date.now()}`;
  await page.getByRole("button", { name: "New Task" }).click();
  const dialog = page.getByRole("dialog", { name: "Create task" });
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Acceptance criteria (one per line)").fill("works end to end");
  await dialog.getByRole("button", { name: "Create task" }).click();

  // Created task is auto-selected → detail heading.
  await expect(page.getByRole("heading", { name: title, level: 2 })).toBeVisible();

  // Resolve the new task id from the API.
  let taskId = "";
  await expect
    .poll(async () => {
      const res = await request.get(`/api/v1/tasks?project_id=${PROJECT_ID}`);
      const body = (await res.json()) as { tasks: TaskRow[] };
      const found = body.tasks.find((t) => t.title === title);
      if (found) {
        taskId = found.id;
      }
      return Boolean(found);
    })
    .toBe(true);

  // Drive the lifecycle via the UI.
  await page.getByRole("button", { name: "Mark ready" }).click();
  await page.getByRole("button", { name: "Assign" }).click();

  // Wait for the assigned run, then drive it to completion server-side.
  let runId = "";
  await expect
    .poll(async () => {
      const res = await request.get(`/api/v1/tasks/${taskId}`);
      const snap = (await res.json()) as { runs: Array<{ id: string }> };
      if (snap.runs[0]) {
        runId = snap.runs[0].id;
      }
      return snap.runs.length;
    })
    .toBeGreaterThan(0);

  const mock = await request.post(`/api/v1/dev/runs/${runId}/mock-execute`, {
    headers: { "Idempotency-Key": `e2e-${runId}` },
  });
  expect(mock.ok()).toBeTruthy();

  // Reload to deterministically observe the post-run state (review + artifact);
  // WS realtime push→invalidate is covered separately in RealtimeContext unit tests.
  await page.reload();
  await page.getByRole("heading", { name: "artoo", level: 1 }).waitFor();
  await page.getByRole("button", { name: title, exact: false }).click();

  // Detail pane is now review: artifact present and Accept available.
  await expect(page.getByRole("heading", { name: title, level: 2 })).toBeVisible();
  await expect(page.locator('.artifact[data-type="report"]')).toBeVisible();

  // Accept → done.
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(page.locator('.task-detail dd[data-status="done"]')).toBeVisible();
});
