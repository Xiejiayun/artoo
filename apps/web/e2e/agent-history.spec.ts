import { expect, test, type APIRequestContext } from "@playwright/test";
import { createNodeClient, createProcessAdapter, createWebSocketTransport } from "@artoo/artood";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function post(request: APIRequestContext, path: string, data: unknown = {}) {
  const response = await request.post(`/api/v1${path}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test("Agent history retains controlled CLI requests, tool results and failures across reload and deletion", async ({ page, request }, testInfo) => {
  const workspace = await mkdtemp(join(tmpdir(), "artoo-history-e2e-"));
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const marker = Date.now(), name = `History Agent ${marker}`;
  const pairing = await post(request, "/devices/pairings", { intended_platform: platform });
  const claim = await post(request, "/devices/claim", { code: pairing.code, platform, display_name: name, app_version: "controlled-history-e2e" });
  const computer = await post(request, `/devices/${claim.device.id}/enroll`, { display_name: name, os: platform });
  let closed!: () => void;
  const socketClosed = new Promise<void>(resolve => { closed = resolve; });
  class TrackedSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("close", closed, { once: true });
    }
  }
  let heartbeatSequence = 0;
  const transport = createWebSocketTransport({
    url: `ws://127.0.0.1:${process.env.ARTOO_PORT ?? "4010"}/api/v1/node?token=${encodeURIComponent(claim.node_token)}`,
    hello: { kind: "node.hello", node_id: computer.computer_id, protocol_version: "2026-06-11", artood_version: "controlled-history-e2e",
      machine: { hostname: "history-e2e", os: platform, arch: process.arch } },
    WebSocketImpl: TrackedSocket, acknowledgeRunEvents: true, reconnect: false, heartbeatIntervalMs: 1000,
    heartbeat: () => ({ kind: "node.heartbeat", node_id: computer.computer_id, sequence: heartbeatSequence++,
      resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 10 },
      runtimes: [{ runtime: "history-fixture", status: "available", version: String(marker), capabilities: ["code.modify", "test.run"] }], running_instances: [] }),
  });
  // A real subprocess emits controlled provider JSONL; no external model is invoked.
  const script = `const fs=require('node:fs'); const fail=fs.readFileSync('context_pack.md','utf8').includes('FAIL_CASE');
    for(let i=0;i<55;i++)console.log('history-line-'+i);
    const print=value=>console.log(JSON.stringify(value));
    print({type:'item.started',item:{id:'cmd-history',type:'command_execution',command:'node --version',status:'in_progress'}});
    print({type:'item.completed',item:{id:'cmd-history',type:'command_execution',command:'node --version',aggregated_output:'tool response 中文',exit_code:0,status:'completed'}});
    if(fail){console.error('controlled execution failed');process.exitCode=1;}
    else {print({type:'item.completed',item:{type:'agent_message',text:'History final answer 中文'}});print({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}});}`;
  const adapter = createProcessAdapter({ runtimeId: "history-fixture", command: [process.execPath, "-e", script], outputFormat: "codex-json", allowedRoots: [workspace] });
  const node = createNodeClient({ nodeId: computer.computer_id, transport, adapter, workspace: { allowedRoots: [workspace] } });
  let registered: { agent: { id: string }; agent_instance: { id: string } } | undefined;
  let caseError: unknown;
  try {
    node.start(); await transport.ready;
    await expect.poll(async () => (await (await request.get(`/api/v1/computers/${computer.computer_id}/runtimes`)).json()).runtimes.some((value: { runtime: string; status: string }) => value.runtime === "history-fixture" && value.status === "available")).toBe(true);
    // Keep the shared server's project inventory stable for later reload tests.
    // The instance still uses its own temporary workspace and paired computer.
    const bootstrap = await (await request.get("/api/v1/bootstrap")).json();
    const project = bootstrap.projects.find((value: { id: string }) => value.id === "proj_artoo");
    expect(project).toBeTruthy();
    registered = await post(request, `/computers/${computer.computer_id}/instances`, { runtime: "history-fixture", workspace_root: workspace, project_id: project.id, display_name: name });
    const runTask = async (title: string, expected: string) => {
      const task = (await post(request, "/tasks", { project_id: project.id, title, description: "Original history request 原文", acceptance_criteria: ["Keep requests and results"], required_capabilities: ["code.modify"] })).task;
      await post(request, `/tasks/${task.id}/ready`);
      const { run } = await post(request, `/tasks/${task.id}/assign`, { mode: "manual", agent_instance_id: registered!.agent_instance.id });
      await expect.poll(async () => (await (await request.get(`/api/v1/runs/${run.id}`)).json()).run.status).toBe(expected);
      return run;
    };
    const completed = await runTask(`History success ${marker}`, "completed");
    const failed = await runTask(`FAIL_CASE ${marker}`, "failed");
    await page.goto(`/agents?instance=${registered.agent_instance.id}`);
    await page.getByRole("article", { name, exact: true }).getByRole("link", { name: "Instance history" }).click();
    await expect(page.getByLabel("History instance")).toHaveValue(registered.agent_instance.id);
    const executions = page.getByRole("region", { name: "Agent executions" });
    await expect(executions.getByRole("button")).toHaveCount(2);
    await executions.getByRole("button", { name: new RegExp(`History success ${marker}`) }).click();
    const detail = page.getByRole("region", { name: "Execution history", exact: true });
    await expect(detail.getByText("Original history request 原文", { exact: true })).toBeVisible();
    const tool = detail.locator(".history-event").filter({ hasText: "Tool activity" }).filter({ hasText: "tool response 中文" });
    await tool.locator(":scope > details > summary").click();
    await expect(tool.getByText("node --version", { exact: true })).toBeVisible();
    await expect(tool.getByText("tool response 中文", { exact: true })).toBeVisible();
    await detail.getByText("Final answer", { exact: true }).click();
    await expect(detail.getByText("History final answer 中文", { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "Load older events" }).click();
    await expect(detail.getByText("run.started", { exact: true })).toBeVisible();
    await page.reload();
    await expect(detail.getByText("Original history request 原文", { exact: true })).toBeVisible();
    await page.getByLabel("History status").selectOption("failed");
    await expect(executions.getByRole("button")).toHaveCount(1);
    await executions.getByRole("button", { name: new RegExp(`FAIL_CASE ${marker}`) }).click();
    await expect(detail.getByText("exit 1", { exact: true })).toBeVisible();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const screenshot = testInfo.outputPath(`history-${width}.png`);
      await page.screenshot({ path: screenshot });
      await testInfo.attach(`Agent history ${width}`, { path: screenshot, contentType: "image/png" });
    }
    expect((await request.delete(`/api/v1/agent-instances/${registered.agent_instance.id}`)).ok()).toBe(true);
    expect((await request.delete(`/api/v1/agents/${registered.agent.id}`)).ok()).toBe(true);
    await page.reload();
    await expect(detail.getByText("Original history request 原文", { exact: true })).toBeVisible();
    expect((await (await request.get(`/api/v1/agents/${registered.agent.id}/history/${completed.id}`)).json()).execution.run.status).toBe("completed");
    expect((await (await request.get(`/api/v1/agents/${registered.agent.id}/history/${failed.id}`)).json()).execution.run.status).toBe("failed");
  } catch (error) { caseError = error; }
  try {
    await node.stop(true);
    await transport.close(); await socketClosed;
    if (registered) {
      expect((await request.delete(`/api/v1/agent-instances/${registered.agent_instance.id}`)).ok()).toBe(true);
      expect((await request.delete(`/api/v1/agents/${registered.agent.id}`)).ok()).toBe(true);
    }
    expect((await request.delete(`/api/v1/computers/${computer.computer_id}`)).ok()).toBe(true);
    await rm(workspace, { recursive: true, force: true });
  } catch (cleanupError) {
    if (caseError) throw new AggregateError([caseError, cleanupError], "Agent history case and cleanup failed");
    throw cleanupError;
  }
  if (caseError) throw caseError;
});
