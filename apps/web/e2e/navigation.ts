import { expect, type Page } from "@playwright/test";

export async function openSidebar(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Toggle navigation", exact: true });
  if (await toggle.isVisible() && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}

/** Use the product's actual navigation; a page reload would lose project selection. */
export async function selectProject(page: Page, view: "tasks" | "plan" | "thread" | "release" = "tasks", name = "artoo"): Promise<void> {
  await openSidebar(page);
  const project = page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("button", { name, exact: true });
  await project.click();
  await expect(project).toHaveAttribute("aria-pressed", "true");
  if (view === "thread") return;
  const views = page.getByRole("navigation", { name: "Project views", exact: true });
  await views.getByRole("link", { name: view === "plan" ? "Plan" : view === "release" ? "Release" : "Board", exact: true }).click();
  if (view === "tasks") await page.getByRole("link", { name: "Task list", exact: true }).click();
}
