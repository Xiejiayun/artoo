import { expect, test } from "@playwright/test";
import { openSidebar, selectProject } from "./navigation.js";

test("project views, saved theme, and mobile navigation stay usable", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/channels");
  await selectProject(page, "thread");
  await expect(page).toHaveTitle("ARTOO");
  await expect(page.getByRole("link", { name: "ARTOO home", exact: true })).toHaveText("ARTOO");
  await expect(page.getByRole("button", { name: "artoo", exact: true })).toHaveAccessibleDescription(/\S+/);
  await expect(page.getByText("Conversations in artoo", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("projects-dark-desktop.png"), fullPage: true });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const views = page.getByRole("navigation", { name: "Project views", exact: true });
  for (const [label, pathname, heading] of [["Plan", "/goals", "Plan"], ["Board", "/board", /^Board/], ["Release", "/release", "Release"]] as const) {
    await views.getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${pathname}$`));
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(views.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
  }
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: testInfo.outputPath("release-light-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await openSidebar(page);
  const primary = page.getByRole("navigation", { name: "Primary", exact: true });
  await expect(primary.getByRole("link", { name: "Connect Local Node" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Toggle navigation" })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Toggle navigation" })).toBeFocused();
  await openSidebar(page);
  await primary.getByRole("link", { name: "Machines", exact: true }).click();
  await expect(page).toHaveURL(/\/computers$/);
  await expect(page.getByRole("heading", { name: "Machines & agents", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Toggle navigation" })).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("machines-dark-mobile.png"), fullPage: true });
});

test("Release shows a real goal without claiming it has been published", async ({ page, request }, testInfo) => {
  const title = `Release evidence ${Date.now()}`;
  const response = await request.post("/api/v1/goals", { headers: { "Idempotency-Key": title }, data: { project_id: "proj_artoo", title, objective: "Controlled local test of publication evidence", priority: "p2", acceptance_criteria: ["Only confirmed executor evidence permits a product link"] } });
  expect(response.ok()).toBe(true);
  await page.goto("/release");
  await selectProject(page, "release");
  await page.getByRole("navigation", { name: "Release goals" }).getByRole("button", { name: new RegExp(title) }).click();
  const overview = page.getByRole("region", { name: "Publication overview" });
  await expect(overview.getByRole("heading", { name: title })).toBeVisible();
  await expect(overview).toContainText("Not published");
  await expect(page.getByRole("region", { name: "Release checks" }).getByText("Pending", { exact: true })).toHaveCount(3);
  await expect(overview.getByRole("link", { name: "Open published product" })).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(overview.getByRole("heading", { name: title })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`release-pending-${width}.png`), fullPage: true });
  }
});

test("the outcome composer reviews setup before creating a goal and keeps release navigation scoped", async ({ page, request }) => {
  await page.goto("/goals");
  await selectProject(page, "plan");
  const outcome = `A reviewable product ${Date.now()}`;
  let createRequests = 0;
  page.on("request", (item) => { if (item.method() === "POST" && new URL(item.url()).pathname === "/api/v1/goals") createRequests++; });
  await page.getByLabel("Outcome to plan").fill(outcome);
  await page.getByRole("button", { name: "Review setup", exact: true }).click();
  const setup = page.getByRole("dialog", { name: "New goal", exact: true });
  await expect(setup.getByLabel("Objective", { exact: true })).toHaveValue(outcome);
  await expect(setup.getByLabel("Goal title", { exact: true })).toHaveValue(outcome);
  expect(createRequests).toBe(0);
  await setup.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Outcome to plan")).toHaveValue(outcome);
  expect(createRequests).toBe(0);
  await page.getByRole("button", { name: "Review setup", exact: true }).click();
  await setup.getByLabel("Goal acceptance criteria", { exact: true }).fill("Review the plan before creating tasks");
  await setup.getByRole("button", { name: "Create goal", exact: true }).click();
  await expect(page.getByRole("heading", { name: outcome, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
  expect(createRequests).toBe(1);
  const goals = (await (await request.get("/api/v1/goals?project_id=proj_artoo")).json()).goals;
  const goal = goals.find((item: { title: string }) => item.title === outcome);
  expect(goal.objective).toBe(outcome);
  await page.getByRole("link", { name: "Release details", exact: true }).click();
  await expect(page.getByRole("region", { name: "Publication overview" }).getByRole("heading", { name: outcome })).toBeVisible();
  await page.getByRole("link", { name: "Manage in Plan", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Goal list" }).getByRole("button", { name: new RegExp(outcome) })).toHaveAttribute("aria-pressed", "true");
});
