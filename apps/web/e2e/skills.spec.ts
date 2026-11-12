import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { expect, test } from "@playwright/test";
import { createNativeSkillSampler } from "../../artood/dist/native-skills.js";
import { createRegistryHeartbeat } from "../../artood/dist/heartbeat.js";

test("discovered SKILL.md metadata reaches Skills search and the matching Agent through a real heartbeat", async ({ page, request }, testInfo) => {
  // Controlled metadata fixture, real pairing/WS/storage/UI; no provider invocation.
  const home = mkdtempSync(join(tmpdir(), "artoo-skills-e2e-"));
  const directory = join(home, ".codex", "skills", "browser-testing");
  mkdirSync(directory, { recursive: true });
  const name = `Browser testing ${Date.now()}`;
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${JSON.stringify(name)}\ndescription: "运行浏览器测试 and inspect screenshots"\n---\nPRIVATE BODY MUST STAY LOCAL\n`);
  let socket: WebSocket | undefined;
  let deviceId: string | undefined;
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  try {
    const pairing = await request.post("/api/v1/devices/pairings", { data: {} });
    expect(pairing.ok()).toBe(true);
    const claimedResponse = await request.post("/api/v1/devices/claim", { data: { code: (await pairing.json()).code, platform, app_version: "skills-fixture", display_name: "Skill discovery fixture" } });
    expect(claimedResponse.ok()).toBe(true);
    const claimed = await claimedResponse.json(); deviceId = claimed.device.id;
    const enrolledResponse = await request.post(`/api/v1/devices/${deviceId}/enroll`, { data: {} });
    expect(enrolledResponse.ok()).toBe(true);
    const { computer_id: computerId } = await enrolledResponse.json();
    const server = `ws://127.0.0.1:${process.env.ARTOO_PORT ?? "4010"}`;
    socket = new WebSocket(`${server}/api/v1/node?token=${encodeURIComponent(claimed.node_token)}`);
    await once(socket, "open", { signal: AbortSignal.timeout(10000) });
    socket.send(JSON.stringify({ kind: "node.hello", node_id: computerId, protocol_version: "2026-06-11", artood_version: "0.1.0",
      machine: { hostname: "skills-fixture", os: platform, arch: "x64" }, workspace_roots: { version: 1, paths: [home] } }));
    const heartbeat = createRegistryHeartbeat({ nodeId: computerId,
      registry: { resolve: () => undefined, runtimes: () => [{ runtime: "codex", capabilities: [] }] },
      nativeSkillsForRuntime: createNativeSkillSampler({ home, env: {}, workspaceRoots: [home] }) });
    socket.send(JSON.stringify(heartbeat()));
    await expect.poll(async () => {
      const response = await request.get(`/api/v1/computers/${computerId}/runtimes`);
      const body = await response.json();
      expect(JSON.stringify(body)).not.toContain("PRIVATE BODY MUST STAY LOCAL");
      return body.runtimes?.[0]?.native_skills?.skills?.[0]?.name;
    }).toBe(name);
    const registered = await request.post(`/api/v1/computers/${computerId}/instances`, { data: {
      runtime: "codex", workspace_root: home, display_name: "Skill Catalog Agent",
    } });
    expect(registered.ok()).toBe(true);

    await page.goto("/skills");
    const search = page.getByRole("searchbox", { name: "Search skills" });
    await search.fill("screenshots browser");
    const card = page.getByRole("article", { name, exact: true });
    await expect(card).toBeVisible();
    await expect(card).toContainText("运行浏览器测试");
    await expect(card.getByText("Native", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("skills-native-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(card).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("skills-native-mobile.png"), fullPage: true });
    await card.getByRole("link", { name: "Skill Catalog Agent" }).click();
    const agent = page.getByRole("article", { name: "Skill Catalog Agent", exact: true });
    await expect(agent.getByRole("region", { name: "Agent skills" })).toContainText(name);
    await page.getByRole("searchbox", { name: "Search agents" }).fill("运行浏览器测试");
    await expect(agent).toBeVisible();
  } finally {
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const closed = once(socket, "close", { signal: AbortSignal.timeout(5000) });
      socket.close(); await closed;
    }
    if (deviceId) {
      const revoked = await request.post(`/api/v1/devices/${deviceId}/revoke`, { data: {} });
      expect(revoked.ok()).toBe(true);
    }
    rmSync(home, { recursive: true, force: true });
  }
});
