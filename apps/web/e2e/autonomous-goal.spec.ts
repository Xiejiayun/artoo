import { selectProject } from "./navigation.js";
import { expect, test } from "@playwright/test";

test("one objective persists autonomous resource waiting and supports pause/resume/cancel", async ({ page, request }, testInfo) => {
  // No provider or verifier is impersonated here. This development server has
  // no eligible execution node, so the truthful expected outcome is waiting.
  await page.setViewportSize({ width: 1100, height: 850 });
  await page.goto("/goals");
  await selectProject(page, "plan");
  await page.getByRole("button", { name: "New goal" }).click();
  await page.getByLabel("Execution mode").selectOption("autonomous");
  const objective = `Autonomous journal ${Date.now()}: preserve entries offline`;
  await page.getByLabel("Objective", { exact: true }).fill(objective);
  await expect(page.getByLabel("Goal title", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Start autonomous goal" }).click();
  await expect(page.getByRole("heading", { name: objective, exact: true })).toBeVisible();
  const goals = await (await request.get("/api/v1/goals?project_id=proj_artoo")).json();
  const goal = goals.goals.find((item: { objective: string }) => item.objective === objective);
  expect(goal).toBeTruthy();
  await expect.poll(async () => (await (await request.get(`/api/v1/goals/${goal.id}/automation`)).json()).automation.status).toBe("waiting");
  await page.reload();
  await page.getByRole("button", { name: new RegExp(objective.split(":")[0]!) }).click();
  const progress = page.getByRole("region", { name: "Autonomous progress" });
  await expect(progress).toContainText("waiting");
  await expect(page.getByRole("button", { name: "Propose plan", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Pause goal", exact: true }).click();
  await expect(progress).toContainText("paused");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Resume goal", exact: true })).toBeVisible();
  await progress.scrollIntoViewIfNeeded();
  await progress.screenshot({ path: testInfo.outputPath("autonomous-goal-mobile.png") });
  await page.getByRole("button", { name: "Resume goal", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause goal", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel goal", exact: true }).click();
  await page.getByRole("button", { name: "Confirm cancel goal", exact: true }).click();
  await expect.poll(async () => (await (await request.get(`/api/v1/goals/${goal.id}`)).json()).goal.status).toBe("cancelled");
  expect((await (await request.get(`/api/v1/goals/${goal.id}/plans`)).json()).plans).toHaveLength(0);
});
