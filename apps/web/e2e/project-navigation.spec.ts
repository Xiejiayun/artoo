import { expect, test } from "@playwright/test";
import { openSidebar } from "./navigation.js";

test("leaving the selected project closes its content without selecting another project", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/channels");
  const projects = page.getByRole("navigation", { name: "Primary", exact: true });
  const project = projects.getByRole("button", { name: "artoo", exact: true });
  await project.click();
  await expect(project).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Conversations in artoo", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "ARTOO home", exact: true }).hover();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(projects.locator('[aria-pressed="true"]')).toHaveCount(0);
  await expect(page.getByText("Select a project", { exact: true })).toBeVisible();
  await expect(page.getByText("Conversations in artoo", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Project views", exact: true })).toHaveCount(0);
  // Keyboard activation keeps the workspace available without moving the mouse
  // across a selected row on the way to its content.
  await project.focus();
  await project.press("Enter");
  await expect(page).toHaveURL(/\/board$/);
  await expect(project).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("link", { name: "Thread", exact: true }).click();
  await expect(page.getByText("Conversations in artoo", { exact: true })).toBeVisible();
});

test("touch activation remains selected after the touch pointer leaves", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto(test.info().project.use.baseURL + "/channels");
    await openSidebar(page);
    const project = page
      .getByRole("navigation", { name: "Primary", exact: true })
      .getByRole("button", { name: "artoo", exact: true });
    await project.tap();
    await expect(page.getByText("Conversations in artoo", { exact: true })).toBeVisible();
    await openSidebar(page);
    await expect(project).toHaveAttribute("aria-pressed", "true");
  } finally {
    await context.close();
  }
});

for (const width of [1440, 390]) {
  test(`project plus opens creation and saves a selected project at width ${width}`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/channels");
    await openSidebar(page);
    const plus = page
      .getByRole("navigation", { name: "Primary", exact: true })
      .getByRole("link", { name: "New project", exact: true });
    await plus.click();
    const dialog = page.getByRole("dialog", { name: "New project", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings$/);
    await openSidebar(page);
    await plus.click();
    await expect(dialog).toBeVisible();
    const name = `Project plus ${width} ${Date.now()}`;
    await dialog.getByLabel("Project name", { exact: true }).fill(name);
    await dialog.getByLabel("Default workspace", { exact: true }).fill("C:/workspace/project-plus");
    await dialog.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("form", { name: "Edit project" }).getByLabel("Project name")).toHaveValue(name);
    const bootstrap = await (await request.get("/api/v1/bootstrap")).json();
    expect(bootstrap.projects.find((project: { name: string }) => project.name === name)).toMatchObject({
      name,
      default_workspace: "C:/workspace/project-plus",
    });
    await openSidebar(page);
    await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
  });
}
