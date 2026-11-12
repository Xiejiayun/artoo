import { expect, test, type APIRequestContext } from "@playwright/test";
import { openSidebar } from "./navigation.js";

async function post(request: APIRequestContext, path: string, data: unknown) {
  const response = await request.post(`/api/v1${path}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test("project squads stay separate across navigation and persist explicit membership changes", async ({ page, request }, testInfo) => {
  const marker = Date.now(), agentName = `Squad Agent ${marker}`;
  const first = (await post(request, "/projects", { name: `Squad One ${marker}`, default_workspace: "C:/squad-first" })).project;
  const second = (await post(request, "/projects", { name: `Squad Two ${marker}`, default_workspace: "C:/squad-second" })).project;
  const node = new WebSocket(`ws://127.0.0.1:${process.env.ARTOO_PORT ?? "4010"}/api/v1/node?token=dev`);
  const computerId = "computer_local_mock";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Squad fixture node did not connect")), 10_000);
      node.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      node.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Squad fixture node failed")); }, { once: true });
    });
    node.send(JSON.stringify({ kind: "node.hello", node_id: computerId, protocol_version: "2026-06-11", artood_version: "controlled-squad-e2e",
      machine: { hostname: "squad-test", os: "windows", arch: "x64" } }));
    node.send(JSON.stringify({ kind: "node.heartbeat", node_id: computerId, sequence: 0, resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 10 },
      runtimes: [{ runtime: "mock", status: "available", version: String(marker), capabilities: ["code.modify"] }], running_instances: [] }));
    await expect.poll(async () => (await (await request.get(`/api/v1/computers/${computerId}/runtimes`)).json()).runtimes.some((runtime: { version: string }) => runtime.version === String(marker))).toBe(true);
    const registered = await post(request, `/computers/${computerId}/instances`, { project_id: first.id, runtime: "mock", workspace_root: "C:/squad-first", display_name: agentName });
    const other = await post(request, `/computers/${computerId}/instances`, { project_id: second.id, runtime: "mock", workspace_root: "C:/squad-second", agent_id: registered.agent.id });
    await page.goto("/channels");
    await page.getByRole("button", { name: first.name, exact: true }).click();
    const squad = page.getByRole("region", { name: "Agent Squad" });
    await expect(squad.locator(".os-squad-agent")).toHaveCount(1);
    await expect(squad.locator(".os-squad-agent")).toHaveAttribute("href", `/agents?instance=${registered.agent_instance.id}`);
    await expect(squad.locator(`a[href='/agents?instance=${other.agent_instance.id}']`)).toHaveCount(0);
    await squad.getByRole("link", { name: "Manage project squad" }).click();
    await expect(page.getByLabel("Project scope", { exact: true })).toHaveValue(first.id);
    await expect(page.getByRole("article", { name: agentName, exact: true })).toHaveCount(1);
    await page.goto(`/agents?instance=${registered.agent_instance.id}`);
    const card = page.getByRole("article", { name: agentName, exact: true });
    await card.getByLabel("Project squad", { exact: true }).selectOption(second.id);
    await card.getByRole("button", { name: "Save project squad" }).click();
    await expect(card.getByRole("button", { name: "Save project squad" })).toBeDisabled();
    await expect(squad.getByText("No agents assigned. Set up this project's squad.")).toBeVisible();
    await page.getByRole("button", { name: second.name, exact: true }).click();
    await expect(squad.locator(".os-squad-agent")).toHaveCount(2);
    await page.reload();
    await page.getByRole("button", { name: second.name, exact: true }).click();
    await expect(squad.locator(".os-squad-agent")).toHaveCount(2);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: testInfo.outputPath("project-squad-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await openSidebar(page);
    await expect(squad.locator(".os-squad-agent")).toHaveCount(2);
    await expect(squad.getByText(`Agents assigned to ${second.name}`)).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("project-squad-mobile.png"), fullPage: true });
  } finally { node.close(); }
});
