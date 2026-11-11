import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function waitForInstalledShell(page) {
  // firstWindow can initially be about:blank. Wait for the authenticated shell
  // before deciding whether its responsive navigation needs to be opened.
  await expect(page.locator("#primary-navigation")).toBeAttached({ timeout: 45_000 });
  await expect(page.locator(".os-header")).toBeVisible({ timeout: 45_000 });
}

export async function openInstalledSidebar(page) {
  await waitForInstalledShell(page);
  const toggle = page.getByRole("button", { name: "Toggle navigation", exact: true });
  if (await toggle.isVisible() && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  const navigation = page.locator("#primary-navigation");
  await expect(navigation).toBeVisible();
  return navigation;
}

export async function openInstalledAccount(page) {
  const navigation = await openInstalledSidebar(page);
  const account = navigation.locator("details.os-account");
  if (await account.getAttribute("open") === null) await account.locator("summary").click();
  return account;
}

export async function openInstalledSettings(page) {
  const account = await openInstalledAccount(page);
  await account.getByRole("link", { name: "Settings", exact: true }).click();
}

export function installedProjectButton(page, name) {
  // A project click closes the narrow sidebar; retain the same control for the
  // selected-state assertion without reopening and obscuring the task view.
  return page.locator("#primary-navigation").getByRole("button", { name, exact: true, includeHidden: true });
}

export async function selectInstalledProject(page, name = "artoo", view = "tasks") {
  assert.ok(["tasks", "plan", "thread"].includes(view));
  await openInstalledSidebar(page);
  const project = installedProjectButton(page, name);
  await project.click();
  await expect(project).toHaveAttribute("aria-pressed", "true");
  if (view === "thread") return;
  await page.getByRole("navigation", { name: "Project views", exact: true })
    .getByRole("link", { name: view === "plan" ? "Plan" : "Board", exact: true }).click();
  if (view === "tasks") await page.getByRole("link", { name: "Task list", exact: true }).click();
}

export async function openInstalledNewAgentForm(page, computerId) {
  const navigation = await openInstalledSidebar(page);
  await navigation.getByRole("link", { name: "Machines", exact: true }).click();
  const computer = page.getByRole("article").filter({ has: page.getByText(computerId, { exact: true }) });
  await expect(computer).toHaveCount(1);
  await computer.getByRole("button", { name: "Create instance", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Create agent instance", exact: true });
  // These fixture participants require separate identities, rather than the
  // default existing Agent selected by the new instance form.
  await form.getByLabel("Agent", { exact: true }).selectOption("__new__");
  return form;
}
