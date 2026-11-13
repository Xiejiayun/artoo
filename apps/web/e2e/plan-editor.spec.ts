import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { selectProject } from "./navigation.js";

async function selectGoal(page: Page, goal: { title: string }) {
  // Other workflows create projects on this shared server. Select this goal's
  // project explicitly, including after reload resets the in-memory selection.
  await selectProject(page, "plan");
  await page
    .getByRole("navigation", { name: "Goal list", exact: true })
    .getByRole("button")
    .filter({ has: page.getByText(goal.title, { exact: true }) })
    .click();
}

async function createGoal(request: APIRequestContext, title: string) {
  const response = await request.post("/api/v1/goals", {
    headers: { "Idempotency-Key": title },
    data: {
      project_id: "proj_artoo",
      title,
      objective: "Controlled manual plan editor validation",
      priority: "p2",
      acceptance_criteria: ["Preserve task identity and dependency edges"],
    },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).goal;
}
async function task(page: Page, index: number, title: string) {
  await page.getByLabel(`Task ${index} title`, { exact: true }).fill(title);
  await page.getByLabel(`Task ${index} acceptance criteria`, { exact: true }).fill(`Verify ${title}`);
}
const group = (page: Page, index: number) => page.getByRole("group", { name: `Task ${index}`, exact: true });

test("manual plan drafts survive reload and submit correct edges after middle deletion and reordering", async ({
  page,
  request,
}, testInfo) => {
  const goal = await createGoal(request, `Plan editor ${Date.now()}`);
  await page.goto(`/goals?goal=${encodeURIComponent(goal.id)}`);
  await selectGoal(page, goal);
  await page.getByRole("button", { name: "Propose plan", exact: true }).click();
  await page.getByLabel("Plan rationale", { exact: true }).fill("Implement then review, regardless of display order");
  await task(page, 1, "Implement");
  await page.getByLabel("Task 1 description", { exact: true }).fill("Preserve the original request\n\nand spacing");
  await page.getByRole("button", { name: "Add plan task", exact: true }).click();
  await task(page, 2, "Intermediate");
  await group(page, 2).getByRole("checkbox", { name: "Implement", exact: true }).check();
  await page.getByRole("button", { name: "Add plan task", exact: true }).click();
  await task(page, 3, "Review");
  await group(page, 3).getByRole("checkbox", { name: "Implement", exact: true }).check();
  await group(page, 3).getByRole("checkbox", { name: "Intermediate", exact: true }).check();
  await page.getByRole("button", { name: "Remove task 2", exact: true }).click();
  await expect(page.getByLabel("Task 2 title", { exact: true })).toBeFocused();
  const move = page.getByRole("button", { name: "Move task 2 up", exact: true });
  await move.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Task 1 title", { exact: true })).toHaveValue("Review");
  await page.reload();
  await selectGoal(page, goal);
  await page.getByRole("button", { name: "Propose plan", exact: true }).click();
  await expect(page.getByText("Restored your saved plan draft.", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Task 1 title", { exact: true })).toHaveValue("Review");
  await expect(group(page, 1).getByRole("checkbox", { name: "Implement", exact: true })).toBeChecked();
  await expect(page.getByLabel("Task 2 description", { exact: true })).toHaveValue(
    "Preserve the original request\n\nand spacing",
  );
  await expect(page.getByRole("checkbox", { name: "Intermediate", exact: true })).toHaveCount(0);
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("form", { name: "Plan editor", exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`plan-draft-${width}.png`) });
  }
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/goals/${goal.id}/plans`,
  );
  await page.getByRole("button", { name: "Submit plan for review", exact: true }).click();
  const response = await submitted;
  expect(response.ok()).toBe(true);
  const { plan } = await response.json();
  expect(
    plan.task_specs.map((spec: { title: string; dependencies: unknown }) => ({
      title: spec.title,
      dependencies: spec.dependencies,
    })),
  ).toEqual([
    { title: "Review", dependencies: [{ ref: "1", type: "blocks" }] },
    { title: "Implement", dependencies: [] },
  ]);
  await expect(page.getByRole("form", { name: "Plan editor", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Propose plan", exact: true }).click();
  await expect(page.getByLabel("Plan rationale", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Task 1 title", { exact: true })).toHaveValue("");
});

test("a real cyclic-plan rejection retains the draft and allows correction", async ({ page, request }) => {
  const goal = await createGoal(request, `Cyclic draft ${Date.now()}`);
  await page.goto(`/goals?goal=${encodeURIComponent(goal.id)}`);
  await selectGoal(page, goal);
  await page.getByRole("button", { name: "Propose plan", exact: true }).click();
  await page.getByLabel("Plan rationale", { exact: true }).fill("Exercise server graph validation");
  await task(page, 1, "First");
  await page.getByRole("button", { name: "Add plan task", exact: true }).click();
  await task(page, 2, "Second");
  await group(page, 1).getByRole("checkbox", { name: "Second", exact: true }).check();
  await group(page, 2).getByRole("checkbox", { name: "First", exact: true }).check();
  const rejected = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/goals/${goal.id}/plans`,
  );
  await page.getByRole("button", { name: "Submit plan for review", exact: true }).click();
  expect((await rejected).status()).toBe(409);
  await expect(page.getByRole("form", { name: "Plan editor", exact: true }).getByRole("alert")).toContainText("cycle");
  await page.reload();
  await selectGoal(page, goal);
  await page.getByRole("button", { name: "Propose plan", exact: true }).click();
  await expect(group(page, 2).getByRole("checkbox", { name: "First", exact: true })).toBeChecked();
  await group(page, 1).getByRole("checkbox", { name: "Second", exact: true }).uncheck();
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === `/api/v1/goals/${goal.id}/plans`,
  );
  await page.getByRole("button", { name: "Submit plan for review", exact: true }).click();
  expect((await accepted).ok()).toBe(true);
  await expect(page.getByRole("form", { name: "Plan editor", exact: true })).toHaveCount(0);
});

test("a delayed confirmed submission preserves newer edits from a reopened editor", async ({ page, request }) => {
  const goal = await createGoal(request, `Late plan receipt ${Date.now()}`);
  let release!: () => void, arrived!: () => void, finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let intercepted = false;
  await page.route(`**/api/v1/goals/${goal.id}/plans`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    intercepted = true;
    try {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      arrived();
      await gate;
      await route.fulfill({ response });
    } finally {
      finish();
    }
  });
  try {
    await page.goto(`/goals?goal=${encodeURIComponent(goal.id)}`);
    await selectGoal(page, goal);
    await page.getByRole("button", { name: "Propose plan", exact: true }).click();
    await page.getByLabel("Plan rationale", { exact: true }).fill("Original submission");
    await task(page, 1, "Original task");
    await page.getByRole("button", { name: "Submit plan for review", exact: true }).click();
    await received;
    await page.getByRole("button", { name: "Close plan editor", exact: true }).click();
    await page.getByRole("button", { name: "Propose plan", exact: true }).click();
    await page.getByLabel("Plan rationale", { exact: true }).fill("Newer review notes");
    release();
    await finished;
    await expect(page.getByLabel("Plan rationale", { exact: true })).toHaveValue("Newer review notes");
    await page.reload();
    await selectGoal(page, goal);
    await page.getByRole("button", { name: "Propose plan", exact: true }).click();
    await expect(page.getByLabel("Plan rationale", { exact: true })).toHaveValue("Newer review notes");
  } finally {
    release();
    if (intercepted) await finished;
  }
});
