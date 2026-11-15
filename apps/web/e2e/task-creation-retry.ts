import { expect, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { selectProject } from "./navigation.js";

/** Abort only response delivery, after the actual server committed and cached success. */
export async function verifyLostTaskCreationResponse(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  delegated: boolean,
) {
  const title = `Creation response retry ${delegated ? "child" : "ordinary"} ${Date.now()}`;
  let parentId: string | undefined;
  if (delegated) {
    const parent = await request.post("/api/v1/tasks", {
      data: { project_id: "proj_artoo", title: `Parent for ${title}` },
    });
    expect(parent.ok(), await parent.text()).toBe(true);
    parentId = (await parent.json()).task.id;
  }
  await page.goto("/");
  await selectProject(page);
  if (delegated) {
    await page.getByRole("button", { name: new RegExp(`Parent for ${title}`) }).click();
    const panel = page.getByRole("region", { name: "Task delegation" });
    await panel.getByRole("button", { name: "Show delegation tree" }).click();
    await panel.getByRole("button", { name: "Delegate task", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "New task", exact: true }).click();
  }
  const keys: (string | undefined)[] = [];
  const responseIds: string[] = [];
  await page.route("**/api/v1/tasks", async (route) => {
    if (route.request().method() !== "POST" || route.request().postDataJSON().title !== title) return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    const response = await route.fetch();
    expect(response.ok(), await response.text()).toBe(true);
    responseIds.push((await response.json()).task.id);
    if (responseIds.length === 1) await route.abort("failed");
    else await route.fulfill({ response });
  });
  const dialog = page.getByRole("dialog", { name: delegated ? "Create delegated task" : "Create task", exact: true });
  await dialog.getByLabel("Title", { exact: true }).fill(title);
  await dialog
    .getByLabel("Description", { exact: true })
    .fill("Preserve this brief when the accepted response is lost");
  await dialog.getByLabel("Acceptance criteria (one per line)").fill("One durable task after retry");
  await dialog.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Failed to create task");
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue(title);
  await dialog.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("complementary", { name: "Task detail" }).getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  const taskListResponse = await request.get(`/api/v1/tasks?project_id=proj_artoo&q=${encodeURIComponent(title)}`);
  expect(taskListResponse.ok(), await taskListResponse.text()).toBe(true);
  const matchingTasks = (await taskListResponse.json()).tasks.filter((task: { title: string }) => task.title === title);
  let tree: { nodes: { task_id: string }[] } | undefined;
  if (parentId) {
    const treeResponse = await request.get(`/api/v1/tasks/${parentId}/delegation-tree`);
    expect(treeResponse.ok(), await treeResponse.text()).toBe(true);
    tree = await treeResponse.json();
  }
  await testInfo.attach("Actual committed creation retry evidence", {
    body: JSON.stringify(
      { delegated, keys, responseIds, matchingTasks: matchingTasks.map((task: { id: string }) => task.id), tree },
      null,
      2,
    ),
    contentType: "application/json",
  });
  expect(matchingTasks).toHaveLength(1);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(responseIds).toEqual([matchingTasks[0]!.id, matchingTasks[0]!.id]);
  if (tree) expect(tree.nodes.map((node) => node.task_id).sort()).toEqual([parentId!, matchingTasks[0]!.id].sort());
}
