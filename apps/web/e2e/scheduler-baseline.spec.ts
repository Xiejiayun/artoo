import { expect, test } from "@playwright/test";

test("project baseline preserves unknown measurements across refresh and reload", async ({ page, request }) => {
  const projectResponse = await request.post("/api/v1/projects", { data: { name: `Baseline ${Date.now()}` } });
  expect(projectResponse.ok()).toBe(true);
  const projectId = (await projectResponse.json()).project.id;
  const baseline = await request.get(`/api/v1/projects/${projectId}/scheduler-observations`);
  expect(baseline.ok()).toBe(true);
  expect((await baseline.json()).failure.rate).toBeNull();
  await page.goto("/settings");
  const button = page.getByRole("button", { name: (await projectResponse.json()).project.name, exact: true });
  await button.click();
  await page.goto("/settings");
  await page.getByText("Scheduler baseline · last seven days", { exact: true }).click();
  await expect(page.getByText("No samples · 0 samples", { exact: true })).toBeVisible();
  await expect(page.getByText("0 failed / 0 terminal runs", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Refresh baseline" }).click();
  await expect(page.getByText("Mean queue time", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByText("Scheduler baseline · last seven days", { exact: true }).click();
  await expect(page.getByText("Disconnected processes awaiting closure", { exact: true })).toBeVisible();
});
