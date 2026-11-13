import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const triggerName = "Open commands (Ctrl or Command + K)";
async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`/api/v1${path}`, { data, headers: { "Idempotency-Key": randomUUID() } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function palette(page: Page, term: string) {
  await page.getByRole("button", { name: triggerName, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Commands", exact: true });
  await expect(dialog.getByRole("combobox", { name: "Search commands" })).toBeFocused();
  await dialog.getByRole("combobox", { name: "Search commands" }).fill(term);
  return dialog;
}

test("commands navigate actual tasks, goals, channels and agents across an explicit project scope", async ({
  page,
  request,
}) => {
  const suffix = Date.now();
  const project = (await post(request, "/projects", { name: `Palette scope ${suffix}` })).project;
  const title = `Palette task ${suffix}`;
  const task = (
    await post(request, "/tasks", { project_id: project.id, title, acceptance_criteria: ["Open through commands"] })
  ).task;
  const goal = (
    await post(request, "/goals", {
      project_id: project.id,
      title: `Palette goal ${suffix}`,
      objective: "Navigate the actual goal",
      acceptance_criteria: ["Correct scope"],
    })
  ).goal;
  const channel = (await post(request, "/channels", { project_id: project.id, name: `palette-${suffix}` })).channel;
  const bootstrap = await (await request.get("/api/v1/bootstrap")).json();
  await page.goto("/channels");
  await expect(page.getByRole("button", { name: triggerName, exact: true })).toBeVisible();
  await page.keyboard.press("Control+k");
  let dialog = page.getByRole("dialog", { name: "Commands", exact: true });
  await dialog.getByLabel("Search in project").selectOption(project.id);
  await dialog.getByRole("combobox", { name: "Search commands" }).fill(title);
  await expect(dialog.getByRole("option", { name: `Task ${title}`, exact: true })).toBeVisible();
  await dialog.getByRole("combobox", { name: "Search commands" }).press("Enter");
  await expect(page.getByRole("heading", { name: title, exact: true, level: 2 })).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Primary", exact: true })
      .getByRole("button", { name: project.name, exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(task.project_id).toBe(project.id);

  dialog = await palette(page, goal.title);
  await expect(dialog.getByLabel("Search in project")).toHaveValue(project.id);
  await dialog.getByRole("option", { name: `Goal ${goal.title}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/goals\\?goal=${goal.id}$`));
  await expect(page.getByRole("heading", { name: goal.title, exact: true })).toBeVisible();

  dialog = await palette(page, channel.name);
  await dialog.getByRole("option", { name: `Channel ${channel.name}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: `# ${channel.name}`, exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("project")).toBe(project.id);
  expect(new URL(page.url()).searchParams.get("room")).toBe(channel.id);

  const agent = bootstrap.agents[0];
  expect(agent).toBeDefined();
  dialog = await palette(page, agent.display_name);
  await dialog.getByRole("option", { name: `Agent history ${agent.display_name}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${agent.id}/history$`));
  dialog = await palette(page, "Project artoo");
  await dialog.getByRole("option", { name: "Project artoo", exact: true }).click();
  await expect(page).toHaveURL(/\/channels$/);
  await expect(page.getByText("Conversations in artoo", { exact: true })).toBeVisible();
});

test("creation and connection commands open existing flows and write only after form confirmation", async ({
  page,
  request,
}) => {
  await page.goto("/channels");
  const bootstrap = await (await request.get("/api/v1/bootstrap")).json();
  let taskWrites = 0,
    goalWrites = 0;
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (new URL(request.url()).pathname === "/api/v1/tasks") taskWrites++;
    if (new URL(request.url()).pathname === "/api/v1/goals") goalWrites++;
  });
  let dialog = await palette(page, "New task");
  await dialog.getByLabel("Search in project").selectOption("proj_artoo");
  await dialog.getByRole("option", { name: "Create New task", exact: true }).click();
  const taskForm = page.getByRole("dialog", { name: "Create task", exact: true });
  await expect(taskForm).toBeVisible();
  expect(taskWrites).toBe(0);
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Commands", exact: true })).toHaveCount(0);
  const title = `Command-created task ${Date.now()}`;
  await taskForm.getByLabel("Title", { exact: true }).fill(title);
  await taskForm.getByLabel("Acceptance criteria (one per line)").fill("Keep explicit confirmation");
  await taskForm.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true, level: 2 })).toBeVisible();
  expect(taskWrites).toBe(1);

  dialog = await palette(page, "New goal");
  await dialog.getByRole("option", { name: "Create New goal", exact: true }).click();
  const goalForm = page.getByRole("dialog", { name: "New goal", exact: true });
  await expect(goalForm).toBeVisible();
  expect(goalWrites).toBe(0);
  const objective = `Command-created goal ${Date.now()}`;
  await goalForm.getByLabel("Objective", { exact: true }).fill(objective);
  await goalForm.getByLabel("Goal acceptance criteria").fill("Confirmed creation only");
  const saved = page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/goals",
  );
  await goalForm.getByRole("button", { name: "Create goal", exact: true }).click();
  const response = await saved;
  expect(response.ok()).toBe(true);
  const created = (await response.json()).goal;
  expect(created.project_id).toBe("proj_artoo");
  expect(created.owner_user_id).toBe(bootstrap.user.id);
  await expect(page.getByRole("heading", { name: objective, exact: true })).toBeVisible();
  expect(goalWrites).toBe(1);

  dialog = await palette(page, "Connect Local Node");
  await dialog.getByRole("option", { name: "Connect Connect Local Node", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Connect Local Node", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate connection command", exact: true })).toBeVisible();
});

test("commands retain focus, avoid the mobile drawer and fit short narrow screens in both themes", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("/channels");
  await page.getByRole("button", { name: "Toggle navigation", exact: true }).click();
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Commands", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const trigger = page.getByRole("button", { name: triggerName, exact: true });
  for (const theme of ["dark", "light"] as const) {
    const switcher = page.getByRole("button", { name: `Switch to ${theme} theme`, exact: true });
    if (await switcher.count()) await switcher.click();
    const dialog = await palette(page, "Go to");
    const input = dialog.getByRole("combobox", { name: "Search commands" });
    await input.press("ArrowDown");
    await expect(dialog.getByRole("option", { name: "Go to Channels", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await input.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(input).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(dialog).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`commands-${theme}-320.png`), fullPage: true });
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const dialog = await palette(page, "");
  await expect(dialog).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath("commands-light-1440.png"), fullPage: true });
});
