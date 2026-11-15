import type { TaskDelegationTreeV1 } from "@artoo/domain";
import { expect, test } from "@playwright/test";
import { selectProject } from "../e2e/navigation.js";

test("explicit delegation preserves briefs, tree navigation, limits and live status through reload", async ({
  page,
  request,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const title = `Delegation ${Date.now()}`;
  const rootResponse = await request.post("/api/v1/tasks", {
    data: { project_id: "proj_artoo", title, acceptance_criteria: ["Human acceptance remains required"] },
  });
  expect(rootResponse.ok(), await rootResponse.text()).toBe(true);
  const rootId: string = (await rootResponse.json()).task.id;
  const readTree = async (): Promise<TaskDelegationTreeV1> => {
    const response = await request.get(`/api/v1/tasks/${rootId}/delegation-tree`);
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await page.goto("/");
  await selectProject(page);
  await page.getByRole("button", { name: new RegExp(title) }).click();
  const detail = page.getByRole("complementary", { name: "Task detail" });
  const panel = detail.getByRole("region", { name: "Task delegation" });
  await panel.getByRole("button", { name: "Show delegation tree" }).click();
  await expect(panel.getByText("1 / 30 tasks · Selected depth 0 / 3")).toBeVisible();
  let parentId = rootId;
  const childIds: string[] = [];
  for (let depth = 1; depth <= 3; depth++) {
    await panel.getByRole("button", { name: "Delegate task", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create delegated task" });
    await dialog.getByLabel("Title", { exact: true }).fill(`${title} child ${depth}`);
    await dialog.getByLabel("Description", { exact: true }).fill(`Keep the brief for depth ${depth}`);
    await dialog
      .getByLabel("Acceptance criteria (one per line)")
      .fill(`Review child ${depth} before accepting its parent`);
    await dialog.getByLabel("Priority", { exact: true }).selectOption("p1");
    await dialog.getByRole("button", { name: "Create task", exact: true }).click();
    await expect(detail.getByRole("heading", { name: `${title} child ${depth}`, exact: true })).toBeVisible();
    await expect(panel.getByText(`${depth + 1} / 30 tasks · Selected depth ${depth} / 3`)).toBeVisible();
    const data = await readTree();
    const child = data.nodes.find((node) => node.title === `${title} child ${depth}`)!;
    expect(child).toMatchObject({ parent_task_id: parentId, depth, status: "backlog" });
    const snapshotResponse = await request.get(`/api/v1/tasks/${child.task_id}`);
    expect(snapshotResponse.ok(), await snapshotResponse.text()).toBe(true);
    const snapshot = await snapshotResponse.json();
    expect(snapshot.task).toMatchObject({
      parent_task_id: parentId,
      description: `Keep the brief for depth ${depth}`,
      priority: "p1",
      acceptance_criteria: [`Review child ${depth} before accepting its parent`],
    });
    expect(snapshot.runs).toEqual([]);
    childIds.push(child.task_id);
    parentId = child.task_id;
  }
  await expect(panel.getByRole("button", { name: "Delegate task", exact: true })).toBeDisabled();
  await expect(panel.getByText("This task is at the maximum delegation depth of 3.")).toBeVisible();
  const tooDeep = await request.post("/api/v1/tasks", {
    data: {
      project_id: "proj_artoo",
      title: `${title} forbidden`,
      delegation: { version: 1, parent_task_id: parentId },
    },
  });
  expect(tooDeep.status()).toBe(409);
  expect((await tooDeep.json()).error.details.reason).toBe("delegation_depth_exceeded");
  expect((await readTree()).nodes).toHaveLength(4);
  const taskListResponse = await request.get(`/api/v1/tasks?project_id=proj_artoo&q=${encodeURIComponent(title)}`);
  expect(taskListResponse.ok(), await taskListResponse.text()).toBe(true);
  expect((await taskListResponse.json()).tasks).toHaveLength(4);
  await panel
    .getByRole("list", { name: "Delegation tree", exact: true })
    .getByRole("button", { name: title, exact: true })
    .click();
  await expect(detail.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(panel.getByText("4 / 30 tasks · Selected depth 0 / 3")).toBeVisible();
  const readyResponse = await request.post(`/api/v1/tasks/${childIds[0]}/ready`);
  expect(readyResponse.ok(), await readyResponse.text()).toBe(true);
  const firstChild = panel
    .getByRole("list", { name: "Delegation tree", exact: true })
    .getByRole("button", { name: `${title} child 1`, exact: true });
  await expect(firstChild.locator("..").getByText("ready", { exact: true })).toBeVisible();
  await page.reload();
  await selectProject(page);
  await page.getByRole("button", { name: new RegExp(`${title} child 3`) }).click();
  await panel.getByRole("button", { name: "Show delegation tree" }).click();
  await expect(panel.getByText("4 / 30 tasks · Selected depth 3 / 3")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Delegate task", exact: true })).toBeDisabled();
  await expect(panel.getByRole("button", { name: `${title} child 3`, exact: true })).toHaveAttribute(
    "aria-current",
    "true",
  );
  expect((await readTree()).nodes.map((node) => node.task_id).sort()).toEqual([rootId, ...childIds].sort());
  expect(browserErrors).toEqual([]);
  const screenshot = testInfo.outputPath("explicit-delegation-depth-three.png");
  await panel.screenshot({ path: screenshot });
  await testInfo.attach("Explicit delegation at depth three", { path: screenshot, contentType: "image/png" });
});
