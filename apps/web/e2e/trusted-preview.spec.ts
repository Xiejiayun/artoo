import { expect, test, type Page } from "@playwright/test";

const unique = (prefix: string): string => `${prefix} ${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

async function createTask(page: Page, title: string, criteria = "Verified outcome"): Promise<void> {
  await page.getByRole("button", { name: "New task", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create task" });
  await dialog.getByLabel("Title", { exact: true }).fill(title);
  await dialog.getByLabel("Acceptance criteria (one per line)").fill(criteria);
  await dialog.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
}

test("narrow workspace supports messaging, decisions, handoffs, blockers and dependency errors", async ({ page, request }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto("/");
  // Other specs create projects on this shared server; select the project used
  // by the API assertions instead of relying on bootstrap's alphabetical order.
  await page.getByRole("combobox", { name: "Project", exact: true }).selectOption("proj_artoo");
  const prerequisite = unique("Prerequisite");
  const dependent = unique("Dependent");
  await createTask(page, prerequisite);
  await createTask(page, dependent);
  const detail = page.getByRole("complementary", { name: "Task detail" });
  await expect(detail.getByRole("button", { name: "Mark ready" })).toBeVisible();
  const tasks = await (await request.get("/api/v1/tasks?project_id=proj_artoo")).json();
  const before = tasks.tasks.find((task: { title: string }) => task.title === prerequisite);
  const after = tasks.tasks.find((task: { title: string }) => task.title === dependent);
  await page.getByLabel("Prerequisite task").selectOption(before.id);
  await page.getByRole("button", { name: "Add dependency", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove dependency" })).toBeVisible();
  await detail.getByRole("button", { name: "Mark ready" }).click();
  await expect(detail.getByRole("alert")).toBeVisible();
  expect((await (await request.get(`/api/v1/tasks/${after.id}`)).json()).task.status).toBe("backlog");
  await page.getByRole("button", { name: "Remove dependency" }).click();
  await detail.getByRole("button", { name: "Mark ready" }).click();
  await expect(detail.getByRole("button", { name: "Assign", exact: true })).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("Please verify the mobile layout.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("list", { name: "Messages" })).toContainText("Please verify the mobile layout.");
  const collaboration = page.getByRole("region", { name: "Team collaboration" });
  await collaboration.getByText("Add decision, handoff, or blocker", { exact: true }).click();
  await collaboration.getByLabel("Summary", { exact: true }).fill("Ship the preview after review");
  await collaboration.getByLabel("Rationale").fill("The acceptance criteria are agreed");
  await collaboration.getByRole("button", { name: "Save record" }).click();
  await collaboration.getByRole("button", { name: "Accept decision" }).click();
  await expect(collaboration.getByRole("article").filter({ hasText: "Ship the preview after review" })).toContainText("accepted");
  await collaboration.getByLabel("Record type").selectOption("handoff");
  await collaboration.getByLabel("Expected action").fill("Review the final preview");
  await collaboration.getByLabel("Recipient").selectOption({ index: 1 });
  await collaboration.getByRole("button", { name: "Save record" }).click();
  await collaboration.getByRole("button", { name: "Accept handoff" }).click();
  await collaboration.getByRole("button", { name: "Complete handoff" }).click();
  await expect(collaboration.getByRole("article").filter({ hasText: "Review the final preview" })).toContainText("completed");
  await collaboration.getByLabel("Record type").selectOption("blocker");
  await collaboration.getByLabel("Summary", { exact: true }).fill("Need review evidence");
  await collaboration.getByLabel("Next action").fill("Attach test results");
  await collaboration.getByRole("button", { name: "Save record" }).click();
  await collaboration.getByRole("button", { name: "Resolve blocker" }).click();
  await expect(collaboration.getByRole("article").filter({ hasText: "Need review evidence" })).toContainText("resolved");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(detail.getByRole("button", { name: "Assign", exact: true })).toBeVisible();
  const room = (await (await request.get(`/api/v1/tasks/${after.id}`)).json()).room.id;
  expect((await (await request.get(`/api/v1/rooms/${room}/messages`)).json()).messages.filter((message: { body: string }) => message.body === "Please verify the mobile layout.")).toHaveLength(1);
});

test("goals materialize a reviewed dependent plan and preserve pause/resume checkpoints", async ({ page, request }) => {
  await page.goto("/goals");
  await page.getByRole("combobox", { name: "Project", exact: true }).selectOption("proj_artoo");
  const title = unique("Preview goal");
  await page.getByRole("button", { name: "New goal" }).click();
  await page.getByLabel("Goal title").fill(title);
  await page.getByLabel("Objective", { exact: true }).fill("Deliver an auditable preview");
  await page.getByLabel("Goal acceptance criteria").fill("Tests pass\nEvidence reviewed");
  await page.getByRole("button", { name: "Create goal", exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Propose plan", exact: true }).click();
  await page.getByLabel("Plan rationale").fill("Verify before release");
  await page.getByLabel("Task 1 title", { exact: true }).fill("Implement the preview");
  await page.getByLabel("Task 1 acceptance criteria", { exact: true }).fill("Feature complete");
  await page.getByRole("button", { name: "Add plan task" }).click();
  await page.getByLabel("Task 2 title", { exact: true }).fill("Review the preview");
  await page.getByLabel("Task 2 acceptance criteria", { exact: true }).fill("All evidence checked");
  await page.getByRole("checkbox", { name: "Implement the preview" }).check();
  await page.getByRole("button", { name: "Submit plan for review" }).click();
  await page.getByRole("button", { name: "Accept plan and create tasks" }).click();
  await expect(page.getByRole("button", { name: "Pause goal" })).toBeVisible();
  const goals = (await (await request.get("/api/v1/goals?project_id=proj_artoo")).json()).goals;
  const goal = goals.find((item: { title: string }) => item.title === title);
  const plans = (await (await request.get(`/api/v1/goals/${goal.id}/plans`)).json()).plans;
  expect(plans[0].status).toBe("accepted");
  expect(plans[0].task_specs[1].dependencies).toEqual([{ ref: "0", type: "blocks" }]);
  await expect(page.getByRole("region", { name: "Checkpoints" })).toContainText("dag materialized");
  await page.getByRole("button", { name: "Pause goal" }).click();
  await page.getByRole("button", { name: "Resume goal" }).click();
  await expect(page.getByRole("button", { name: "Pause goal" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel goal", exact: true }).click();
  await page.getByRole("button", { name: "Confirm cancel goal" }).click();
  await expect(page.getByRole("navigation", { name: "Goal list" })).toContainText("cancelled");
  const checkpoints = (await (await request.get(`/api/v1/goals/${goal.id}/checkpoints`)).json()).checkpoints;
  expect(checkpoints.map((checkpoint: { type: string }) => checkpoint.type)).toEqual(expect.arrayContaining(["paused", "resumed", "dag_materialized"]));
});

test("project management, device pairing/revocation and reviewed skill installation persist", async ({ page, request }) => {
  await page.goto("/settings");
  const name = unique("Team project");
  await page.getByRole("button", { name: "New project" }).click();
  const create = page.getByRole("form", { name: "Create project" });
  await create.getByLabel("Project name").fill(name);
  await create.getByLabel("Default workspace").fill("C:/workspace/preview");
  await create.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("combobox", { name: "Project", exact: true })).toHaveValue(/proj_/);
  const edit = page.getByRole("form", { name: "Edit project" });
  await expect(edit.getByLabel("Project name")).toHaveValue(name);
  await edit.getByLabel("Project name").fill(`${name} renamed`);
  await edit.getByRole("button", { name: "Save project" }).click();
  await expect(edit.getByRole("status")).toContainText("Project saved");
  await page.getByRole("link", { name: "Workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: `${name} renamed`, exact: true })).toBeVisible();
  await createTask(page, unique("Isolated project task"));
  await page.getByRole("combobox", { name: "Project", exact: true }).selectOption("proj_artoo");
  await expect(page.getByText("No task selected", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Generate pairing code" }).click();
  const code = await page.getByRole("region", { name: "Device pairing" }).locator("strong").textContent();
  const deviceName = unique("Preview Windows");
  const claim = await request.post("/api/v1/devices/claim", { data: { code, platform: "windows", display_name: deviceName, app_version: "e2e" } });
  expect(claim.status()).toBe(201);
  const claimed = await claim.json();
  const session = await request.get("/auth/session", { headers: { Authorization: `Bearer ${claimed.control_token}` } });
  expect(session.ok()).toBeTruthy();
  await page.reload();
  const device = page.getByRole("article").filter({ hasText: deviceName });
  await device.getByRole("button", { name: "Revoke device", exact: true }).click();
  await device.getByRole("button", { name: "Confirm revoke" }).click();
  await expect(device).toContainText("revoked");
  expect((await request.get("/auth/session", { headers: { Authorization: `Bearer ${claimed.control_token}` } })).status()).toBe(401);
  await page.getByRole("link", { name: "Skills", exact: true }).click();
  await page.getByText("Install a skill manifest", { exact: true }).click();
  const skillName = unique("Preview tests skill");
  await page.getByLabel("Skill manifest (JSON)").fill(JSON.stringify({ api_version: "v1alpha1", id: unique("preview-skill").replaceAll(" ", "-"), name: skillName, version: "1.0.0", capabilities: ["test.run"], compatible_runtimes: ["codex"], permissions: { filesystem: { read: ["src"], write: [] } } }));
  await page.getByRole("button", { name: "Review manifest" }).click();
  await page.getByRole("button", { name: "Install reviewed skill" }).click();
  await expect(page.getByRole("article", { name: skillName })).toBeVisible();
});

test("review controls remain usable at desktop, tablet and phone widths", async ({ page, request }, testInfo) => {
  // Earlier tests deliberately disconnect their node. Own this fixture's
  // connection instead of relying on the seed computer remaining online.
  const node = new WebSocket(`ws://127.0.0.1:${process.env.ARTOO_PORT ?? "4010"}/api/v1/node?token=dev`);
  await new Promise<void>((resolve, reject) => { node.addEventListener("open", () => resolve(), { once: true }); node.addEventListener("error", () => reject(new Error("Responsive fixture node failed to connect")), { once: true }); });
  node.send(JSON.stringify({ kind: "node.hello", node_id: "computer_local_mock", protocol_version: "2026-06-11", artood_version: "0.1.0-e2e", machine: { hostname: "playwright", os: "windows", arch: "x64" } }));
  node.send(JSON.stringify({ kind: "node.heartbeat", node_id: "computer_local_mock", sequence: 0, resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 1 }, runtimes: [{ runtime: "mock", status: "available", version: "0.1.0", capabilities: ["code.read", "code.modify"] }], running_instances: [] }));
  try {
  await expect.poll(async () => (await (await request.get("/api/v1/bootstrap")).json()).computers.find((computer: { id: string; status: string }) => computer.id === "computer_local_mock")?.status).toBe("online");
  const title = unique("Responsive review");
  await page.goto("/");
  await page.getByRole("combobox", { name: "Project", exact: true }).selectOption("proj_artoo");
  await createTask(page, title);
  await page.getByRole("button", { name: "Mark ready", exact: true }).click();
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  const tasks = (await (await request.get("/api/v1/tasks?project_id=proj_artoo")).json()).tasks;
  const taskId = tasks.find((task: { title: string }) => task.title === title).id;
  let runId = "";
  await expect.poll(async () => {
    const snapshot = await (await request.get(`/api/v1/tasks/${taskId}`)).json();
    runId = snapshot.runs[0]?.id ?? ""; return runId;
  }).not.toBe("");
  expect((await request.post(`/api/v1/dev/runs/${runId}/mock-execute`, { headers: { "Idempotency-Key": unique("responsive-execute") } })).ok()).toBeTruthy();
  await page.reload();
  await page.getByRole("combobox", { name: "Project", exact: true }).selectOption("proj_artoo");
  await page.getByRole("button", { name: new RegExp(title) }).click();
  for (const width of [1280, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const detail = page.getByRole("complementary", { name: "Task detail" });
    await expect(detail.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: "Request changes", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await page.locator(".pane").evaluateAll((panes) => panes.every((pane) => pane.scrollWidth <= pane.clientWidth + 1))).toBe(true);
    const messages = await page.getByRole("list", { name: "Messages" }).boundingBox();
    const composer = await page.locator(".message-composer").boundingBox();
    expect(composer!.y).toBeGreaterThanOrEqual(messages!.y + messages!.height);
    await page.locator(".pane-center").evaluate((pane) => { pane.scrollTop = 0; });
    await page.locator(".app-main").evaluate((main) => { main.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath(`workspace-${width}.png`), fullPage: true });
    await detail.getByRole("button", { name: "Accept", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`workspace-review-${width}.png`), fullPage: true });
  }
  await page.getByLabel("Review comment", { exact: true }).fill("Reviewed on desktop, tablet and phone");
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.locator(".task-detail .ui-badge--status")).toHaveText("done");
  } finally { node.close(); }
});
