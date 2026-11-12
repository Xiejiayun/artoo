import { expect, test } from "@playwright/test";

test("resource deletion confirms scope, refreshes inventory and closes the paired node", async ({ page, request }, testInfo) => {
  const name = `Lifecycle computer ${Date.now()}`, agentName = `Lifecycle Agent ${Date.now()}`;
  const pairing = await (await request.post("/api/v1/devices/pairings", { data: { intended_platform: "windows" } })).json();
  const claimResponse = await request.post("/api/v1/devices/claim", { data: { code: pairing.code, platform: "windows", app_version: "controlled-e2e", display_name: name } });
  expect(claimResponse.ok()).toBe(true);
  const claim = await claimResponse.json();
  const enrolled = await (await request.post(`/api/v1/devices/${claim.device.id}/enroll`, { data: {} })).json();
  const computerId = enrolled.computer_id;
  const node = new WebSocket(`ws://127.0.0.1:${process.env.ARTOO_PORT ?? "4010"}/api/v1/node?token=${encodeURIComponent(claim.node_token)}`);
  const closed = new Promise<number>((resolve) => node.addEventListener("close", (event) => resolve(event.code)));
  let sequence = 0;
  const heartbeat = () => node.send(JSON.stringify({ kind: "node.heartbeat", node_id: computerId, sequence: sequence++, resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 10 },
    runtimes: [{ runtime: "mock", status: "available", capabilities: ["code.modify"] }], running_instances: [] }));
  await new Promise<void>((resolve) => node.addEventListener("open", () => {
    node.send(JSON.stringify({ kind: "node.hello", node_id: computerId, protocol_version: "2026-06-11", artood_version: "controlled-e2e", machine: { hostname: "local-test", os: "windows", arch: "x64" } }));
    heartbeat(); resolve();
  }));
  const timer = setInterval(() => { if (node.readyState === WebSocket.OPEN) heartbeat(); }, 5000);
  try {
    await expect.poll(async () => (await (await request.get(`/api/v1/computers/${computerId}/runtimes`)).json()).runtimes?.[0]?.status).toBe("available");
    const firstResponse = await request.post(`/api/v1/computers/${computerId}/instances`, { data: { runtime: "mock", workspace_root: "C:/lifecycle-first", display_name: agentName } });
    expect(firstResponse.status()).toBe(201);
    const first = await firstResponse.json();
    const secondResponse = await request.post(`/api/v1/computers/${computerId}/instances`, { data: { runtime: "mock", workspace_root: "C:/lifecycle-second", agent_id: first.agent.id } });
    expect(secondResponse.status()).toBe(201);
    await page.goto(`/agents?instance=${encodeURIComponent(first.agent_instance.id)}`);
    const instance = page.getByRole("article", { name: agentName, exact: true });
    await expect(instance.getByText("After 30 days offline")).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: testInfo.outputPath("agents-lifecycle-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("agents-lifecycle-mobile.png"), fullPage: true });
    await instance.getByRole("button", { name: "Delete instance", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Delete instance", exact: true });
    await expect(dialog).toContainText("reusable Agent stays in your library");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(instance).toBeVisible();
    await instance.getByRole("button", { name: "Delete instance", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Confirm deletion" }).click();
    await expect(instance).toHaveCount(0);
    await page.goto("/agents");
    const library = page.getByRole("region", { name: "Agent library" });
    const identity = library.locator(".agent-library__list > div").filter({ hasText: agentName });
    await expect(identity).toContainText("1 instances");
    await identity.getByRole("button", { name: "Delete agent", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Delete agent", exact: true });
    await expect(dialog).toContainText("all its instances");
    await dialog.getByRole("button", { name: "Confirm deletion" }).click();
    await expect(identity).toHaveCount(0);
    await expect(page.getByRole("article", { name: agentName, exact: true })).toHaveCount(0);
    await page.goto("/computers");
    const computer = page.getByRole("article", { name, exact: true });
    await expect(computer.getByText("After 30 days offline")).toBeHidden();
    await expect(computer.getByRole("button", { name: "Delete computer", exact: true })).toBeHidden();
    await computer.getByText("Computer details", { exact: true }).click();
    await expect(computer.getByText("After 30 days offline")).toBeVisible();
    await computer.getByRole("button", { name: "Delete computer", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Delete computer", exact: true });
    await expect(dialog).toContainText("revokes its device credentials");
    await dialog.getByRole("button", { name: "Confirm deletion" }).click();
    await expect(computer).toHaveCount(0);
    expect(await closed).toBe(1008);
    expect((await request.post(`/api/v1/devices/${claim.device.id}/enroll`, { data: {} })).status()).toBe(409);
  } finally { clearInterval(timer); node.close(); }
});
