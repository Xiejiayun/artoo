import { expect, test, type APIRequestContext } from "@playwright/test";

interface Task { id: string; title: string; status: string }
interface Run { id: string; status: string; agent_instance_id: string; computer_id: string }
async function post<T>(request: APIRequestContext, path: string, data?: unknown): Promise<T> {
  const response = await request.post(`/api/v1${path}`, { data });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}

test("controlled multi-node collaboration keeps dependency review and handoff durable", async ({ page, request }) => {
  // Real browser/server/WS/API flow with simulated execution. This is not a
  // physical two-computer, protected scheduler or live-Provider acceptance run.
  const marker = `${Date.now()}-${test.info().workerIndex}`;
  const project = (await post<{ project: { id: string; name: string } }>(request, "/projects", {
    name: `Collaboration ${marker}`, default_workspace: `C:/controlled-collaboration-${marker}`,
  })).project;
  const sockets: WebSocket[] = [];
  try {
    const team: { agentId: string; instanceId: string; computerId: string }[] = [];
    for (const role of ["author", "reviewer"]) {
      const computerId = `collab-${role}-${marker}`;
      const socket = new WebSocket(`ws://127.0.0.1:${process.env.ARTOO_PORT ?? "4010"}/api/v1/node?token=dev`);
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Controlled collaboration node did not connect")), 10_000);
        socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Controlled collaboration node failed")); }, { once: true });
      });
      socket.send(JSON.stringify({ kind: "node.hello", node_id: computerId, protocol_version: "2026-06-11",
        artood_version: "controlled-collaboration-e2e", machine: { hostname: computerId, os: "windows", arch: "x64" } }));
      socket.send(JSON.stringify({ kind: "node.heartbeat", node_id: computerId, sequence: 0,
        resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 10 },
        runtimes: [{ runtime: "mock", status: "available", version: marker, capabilities: ["code.modify"] }], running_instances: [] }));
      await expect.poll(async () => {
        const response = await request.get(`/api/v1/computers/${computerId}/runtimes`);
        return response.ok() && (await response.json()).runtimes.some((runtime: { version: string }) => runtime.version === marker);
      }).toBe(true);
      const registered = await post<{ agent: { id: string }; agent_instance: { id: string } }>(request, `/computers/${computerId}/instances`, {
        project_id: project.id, runtime: "mock", workspace_root: `C:/controlled-${role}-${marker}`, display_name: `Team ${role} ${marker}`,
      });
      team.push({ agentId: registered.agent.id, instanceId: registered.agent_instance.id, computerId });
    }
    const squad = await request.put(`/api/v1/projects/${project.id}/squad`, { data: {
      version: 1, expected_revision: 0, agent_ids: team.map((member) => member.agentId),
    } });
    expect(squad.ok(), await squad.text()).toBe(true);
    const create = async (title: string) => (await post<{ task: Task }>(request, "/tasks", {
      project_id: project.id, title, acceptance_criteria: ["Shared evidence accepted"], required_capabilities: ["code.modify"],
    })).task;
    const upstream = await create(`Shared author ${marker}`), downstream = await create(`Shared reviewer ${marker}`);
    await post(request, `/tasks/${downstream.id}/dependencies`, { depends_on_task_id: upstream.id, type: "artifact_required" });
    expect((await request.post(`/api/v1/tasks/${downstream.id}/ready`)).status()).toBe(409);
    await post(request, `/tasks/${upstream.id}/ready`);
    const first = (await post<{ run: Run }>(request, `/tasks/${upstream.id}/assign`, { mode: "manual", agent_instance_id: team[0]!.instanceId })).run;
    await post(request, `/dev/runs/${first.id}/mock-execute`);
    const awaiting = await (await request.get(`/api/v1/tasks/${downstream.id}`)).json();
    expect(awaiting.task.status).toBe("backlog");
    await post(request, `/tasks/${upstream.id}/review`, { outcome: "accepted" });
    const unlocked = await (await request.get(`/api/v1/tasks/${downstream.id}`)).json();
    expect(unlocked.task.status).toBe("ready");
    const second = (await post<{ run: Run }>(request, `/tasks/${downstream.id}/assign`, { mode: "manual", agent_instance_id: team[1]!.instanceId })).run;
    expect(second.computer_id).not.toBe(first.computer_id);
    expect(second.agent_instance_id).not.toBe(first.agent_instance_id);
    const control = await (await request.get(`/api/v1/projects/${project.id}/control-view?limit=100`)).json();
    expect(control.summary.total_tasks).toBe(2);
    expect(control.tasks.find((entry: { task: Task }) => entry.task.id === downstream.id).latest_run.id).toBe(second.id);

    await page.goto(`/board?project=${encodeURIComponent(project.id)}&task=${encodeURIComponent(downstream.id)}`);
    const drawer = page.getByRole("dialog", { name: "Task workspace" });
    await expect(drawer.getByRole("heading", { name: downstream.title, exact: true })).toBeVisible();
    await drawer.getByRole("button", { name: "Conversation", exact: true }).click();
    const collaboration = drawer.getByRole("region", { name: "Team collaboration" });
    await collaboration.getByText("Add decision, handoff, or blocker", { exact: true }).click();
    await collaboration.getByLabel("Record type").selectOption("handoff");
    await collaboration.getByLabel("Recipient", { exact: true }).selectOption(`agent:${team[0]!.agentId}`);
    await collaboration.getByLabel("Expected action", { exact: true }).fill(`Review source evidence ${marker}`);
    await collaboration.getByRole("button", { name: "Save record", exact: true }).click();
    const handoff = collaboration.getByRole("article").filter({ hasText: `Review source evidence ${marker}` });
    await expect(handoff).toBeVisible();
    await page.reload();
    await page.getByRole("dialog", { name: "Task workspace" }).getByRole("button", { name: "Conversation", exact: true }).click();
    const persisted = page.getByRole("region", { name: "Team collaboration" }).getByRole("article").filter({ hasText: `Review source evidence ${marker}` });
    await expect(persisted).toBeVisible();
    await persisted.getByRole("button", { name: "Accept handoff", exact: true }).click();
    await persisted.getByRole("button", { name: "Complete handoff", exact: true }).click();
    await expect(persisted.getByText("completed", { exact: true })).toBeVisible();
    await post(request, `/dev/runs/${second.id}/mock-execute`);
    await post(request, `/tasks/${downstream.id}/review`, { outcome: "accepted" });
    expect((await (await request.get(`/api/v1/tasks/${downstream.id}`)).json()).task.status).toBe("done");
  } finally { for (const socket of sockets) socket.close(); }
});
