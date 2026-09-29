import { expect, test, type APIRequestContext } from "@playwright/test";
import type { Discussion, Message, RunStartPayload } from "@artoo/domain";

async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(`/api/v1${path}`, { data });
  expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

test("a real discussion exposes a suggested plan in its thread and exact historical reply", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const nodeId = "computer_local_mock";
  const marker = `plan-browser-${Date.now()}`;
  const plan = {
    rationale: "Implement the endpoint before reviewing its contract.",
    task_specs: [
      { title: "Implement the preview endpoint", description: "Add the agreed response contract.", acceptance_criteria: ["The endpoint returns the documented response", "Unauthenticated requests are rejected"], required_capabilities: ["code.read"], expected_artifacts: [{ type: "report", description: "Contract verification evidence" }] },
      { title: "Review the preview endpoint", acceptance_criteria: ["All contract checks pass"], dependencies: [{ ref: "0", type: "blocks" }] },
    ],
  };
  const original = `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``;
  const instances: string[] = [];
  const answered = new Set<string>();
  let discussion: Discussion | undefined;
  let nodeFailure: Error | undefined;
  // This fixture speaks the real node protocol. It returns deterministic
  // answers; the production dispatcher, persistence and metadata mapping run.
  const node = new WebSocket(`ws://127.0.0.1:${process.env.ARTOO_PORT ?? "4010"}/api/v1/node?token=dev`);
  const send = (value: unknown) => node.send(JSON.stringify(value));
  node.addEventListener("message", (event) => {
    try {
      const command = JSON.parse(String(event.data)) as { kind?: string; id: string; type?: string; payload: RunStartPayload };
      if (command.kind !== "command" || command.type !== "run.start" || !instances.includes(command.payload.agent_instance_id)) return;
      send({ kind: "command.ack", node_id: nodeId, command_id: command.id, status: "accepted" });
      if (answered.has(command.payload.run_id)) return;
      answered.add(command.payload.run_id);
      const body = answered.size === 1 ? "Implement the documented endpoint first."
        : answered.size === 2 ? "Review the endpoint contract after implementation." : original;
      for (const [sequence, runEvent] of [
        { type: "run.lifecycle", payload: { phase: "started" } },
        { type: "run.answer", payload: { text: body } },
        { type: "run.lifecycle", payload: { phase: "completed" } },
      ].entries()) send({ kind: "run.event", node_id: nodeId, run_id: command.payload.run_id, sequence, event: runEvent });
    } catch (error) { nodeFailure = error instanceof Error ? error : new Error(String(error)); }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Planning fixture node did not connect")), 10_000);
      node.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      node.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Planning fixture node failed")); }, { once: true });
    });
    send({ kind: "node.hello", node_id: nodeId, protocol_version: "2026-06-11", artood_version: "0.1.0-e2e", machine: { hostname: "planning-browser", os: "windows", arch: "x64" } });
    send({ kind: "node.heartbeat", node_id: nodeId, sequence: 0, resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 1 }, runtimes: [{ runtime: "mock", status: "available", version: marker, capabilities: ["code.read", "code.modify", "test.run"] }], running_instances: [] });
    await expect.poll(async () => (await (await request.get(`/api/v1/computers/${nodeId}/runtimes`)).json()).runtimes.some((runtime: { version: string }) => runtime.version === marker)).toBe(true);
    for (const name of ["Plan author", "Plan reviewer"]) {
      const created = await post<{ agent_instance: { id: string } }>(request, `/computers/${nodeId}/instances`, { display_name: `${name} ${marker}`, runtime: "mock", workspace_root: "/tmp/artoo-plan-browser", capabilities: ["code.read"] });
      instances.push(created.agent_instance.id);
    }
    const { goal } = await post<{ goal: { id: string } }>(request, "/goals", { project_id: "proj_artoo", title: marker, objective: "Deliver a reviewable endpoint", acceptance_criteria: ["The endpoint is verified"] });
    ({ discussion } = await post<{ discussion: Discussion }>(request, `/goals/${goal.id}/discussions`, { participants: instances.map((agent_instance_id, index) => ({ agent_instance_id, role: index === 0 ? "Design and synthesis" : "Review" })), rounds: 1, max_minutes: 5 }));
    const active = discussion;
    await expect.poll(async () => {
      if (nodeFailure) throw nodeFailure;
      return (await (await request.get(`/api/v1/discussions/${active.id}`)).json()).discussion.status;
    }, { timeout: 45_000 }).toBe("ready");
    expect(answered.size).toBe(3);
    const history = (await (await request.get(`/api/v1/rooms/${active.room_id}/messages?thread_root_id=${active.thread_root_id}`)).json()).messages as Message[];
    const final = history.find((message) => message.actor_type === "agent" && message.body === original)!;
    expect(final).toBeDefined();
    expect(final.payload.discussion_plan).toMatchObject({ version: 1, discussion_id: active.id, goal_id: goal.id, rationale: plan.rationale });

    const threadUrl = `/channels?room=${active.room_id}&thread=${active.thread_root_id}`;
    await page.goto(threadUrl);
    const thread = page.getByRole("complementary", { name: "Thread", exact: true });
    const preview = thread.getByRole("region", { name: "Suggested plan", exact: true });
    await expect(preview).toBeVisible();
    await expect(preview.getByRole("heading", { name: "1. Implement the preview endpoint" })).toBeVisible();
    await expect(preview.getByRole("heading", { name: "2. Review the preview endpoint" })).toBeVisible();
    await expect(preview).toContainText("Unauthenticated requests are rejected");
    await expect(preview).toContainText("Depends on: Implement the preview endpoint");
    await expect(preview).toContainText("Required capabilities: code.read");
    await expect(preview).toContainText("Contract verification evidence");
    await expect(preview.locator("pre")).not.toBeVisible();
    await preview.getByText("Show original reply", { exact: true }).click();
    await expect(preview.locator("pre")).toBeVisible();
    expect(await preview.locator("pre").textContent()).toBe(original);
    await preview.getByText("Show original reply", { exact: true }).click();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(preview).toBeVisible();
      expect(await preview.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await preview.screenshot({ path: testInfo.outputPath(`suggested-plan-${width}.png`) });
    }
    // A user can post identical JSON and arbitrary payloads, but cannot acquire
    // the server-assigned agent identity that activates the plan renderer.
    await post(request, `/rooms/${active.room_id}/messages`, { kind: "text", body: original, thread_root_id: active.thread_root_id, payload: { discussion_plan: final.payload.discussion_plan } });
    await page.reload();
    await expect(preview).toHaveCount(1);
    await expect(thread.getByRole("list", { name: "Messages", exact: true }).locator(".msg__text").filter({ hasText: original })).toBeVisible();
    expect((await (await request.get(`/api/v1/goals/${goal.id}/plans`)).json()).plans).toHaveLength(0);

    for (let index = 0; index < 51; index++) await post(request, `/rooms/${active.room_id}/messages`, { kind: "text", body: `Later discussion reply ${index}`, thread_root_id: active.thread_root_id });
    const newest = (await (await request.get(`/api/v1/rooms/${active.room_id}/messages?thread_root_id=${active.thread_root_id}&limit=50`)).json()).messages as Message[];
    expect(newest.some((message) => message.id === final.id)).toBe(false);
    await page.goto(`${threadUrl}&message=${final.id}`);
    const historical = thread.getByRole("region", { name: "Mentioned reply", exact: true });
    await expect(historical.getByRole("region", { name: "Suggested plan", exact: true })).toBeVisible();
    await expect(historical).toContainText("Depends on: Implement the preview endpoint");
    await expect(thread.getByRole("region", { name: "Thread replies", exact: true }).getByRole("region", { name: "Suggested plan", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(historical.getByRole("region", { name: "Suggested plan", exact: true })).toBeVisible();
    expect((await (await request.get(`/api/v1/goals/${goal.id}/plans`)).json()).plans).toHaveLength(0);
  } finally {
    node.close();
    // Do not leave fixture instances available to later scheduler scenarios.
    for (const id of instances) {
      const response = await request.patch(`/api/v1/agent-instances/${id}`, { data: { enabled: false } });
      expect(response.ok(), `Disable planning fixture instance: ${await response.text()}`).toBe(true);
    }
  }
});
