import { ContextPackSchema, RunStartPayloadSchema, type Artifact, type ProjectControlViewV1, type Run, type RunStartPayload, type Task, type TaskReview } from "@artoo/domain";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";

interface Snapshot { task: Task; runs: Run[]; artifacts: Artifact[]; reviews: TaskReview[]; version_cursor: number }
interface Start { id: string; payload: RunStartPayload }
interface ControlledNode {
  computerId: string;
  agentId: string;
  instanceId: string;
  commands: Map<string, Start>;
  start: (run: Run) => Promise<Start>;
  complete: (run: Run) => Promise<void>;
  upload: (run: Run, filename: string, text: string) => Promise<{ id: string; uri: string; checksum: string }>;
  close: () => void;
}
async function post<T>(request: APIRequestContext, path: string, data?: unknown): Promise<T> {
  const response = await request.post(`/api/v1${path}`, { data, headers: { "Idempotency-Key": randomUUID() } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}
async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`/api/v1${path}`);
  expect(response.ok(), await response.text()).toBe(true);
  return response.json() as Promise<T>;
}
const snapshot = (request: APIRequestContext, task: Task): Promise<Snapshot> => get(request, `/tasks/${task.id}`);

/** An authenticated protocol fixture, with no CLI or physical process. It waits
 * for explicit test actions before emitting controlled execution lifecycle facts. */
async function connectControlledNode(request: APIRequestContext, projectId: string, marker: string, role: string, cleanup: (() => void)[]): Promise<ControlledNode> {
  const name = `Controlled ${role} ${marker}`;
  const pairing = await post<{ code: string }>(request, "/devices/pairings", { intended_platform: "windows" });
  const claim = await post<{ device: { id: string }; node_token: string }>(request, "/devices/claim", { code: pairing.code, platform: "windows", app_version: "controlled-collaboration-e2e", display_name: name });
  const { computer_id: computerId } = await post<{ computer_id: string }>(request, `/devices/${claim.device.id}/enroll`, { display_name: name, os: "windows" });
  const socket = new WebSocket(`ws://127.0.0.1:${process.env.ARTOO_PORT ?? "4010"}/api/v1/node?token=${encodeURIComponent(claim.node_token)}`);
  const commands = new Map<string, Start>();
  const running = new Set<string>();
  let heartbeatSequence = 0;
  const send = (value: unknown): void => socket.send(JSON.stringify(value));
  const heartbeat = (): void => send({ kind: "node.heartbeat", node_id: computerId, sequence: heartbeatSequence++,
    resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 10 },
    runtimes: [{ runtime: "mock", status: "available", version: marker, capabilities: ["code.modify"] }], running_instances: [...running] });
  let timer: ReturnType<typeof setInterval> | undefined;
  const close = (): void => { if (timer) clearInterval(timer); socket.close(); };
  cleanup.push(close);
  socket.addEventListener("message", (event) => {
    const command = JSON.parse(String(event.data)) as { kind?: string; type?: string; id: string; payload: unknown };
    if (command.kind !== "command" || command.type !== "run.start") return;
    const parsed = RunStartPayloadSchema.safeParse(command.payload);
    if (parsed.success) commands.set(parsed.data.run_id, { id: command.id, payload: parsed.data });
  });
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Controlled collaboration node did not connect")), 10_000);
    socket.addEventListener("open", () => { clearTimeout(deadline); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(deadline); reject(new Error("Controlled collaboration node failed")); }, { once: true });
  });
  const workspace = `C:/controlled-${role}-${marker}`;
  send({ kind: "node.hello", node_id: computerId, protocol_version: "2026-06-11", artood_version: "controlled-collaboration-e2e",
    machine: { hostname: name, os: "windows", arch: "x64" }, workspace_roots: { version: 1, paths: [workspace] } });
  heartbeat();
  timer = setInterval(() => { if (socket.readyState === WebSocket.OPEN) heartbeat(); }, 5000);
  await expect.poll(async () => (await get<{ runtimes: { version: string }[] }>(request, `/computers/${computerId}/runtimes`)).runtimes.some((runtime) => runtime.version === marker)).toBe(true);
  const registered = await post<{ agent: { id: string }; agent_instance: { id: string } }>(request, `/computers/${computerId}/instances`, {
    project_id: projectId, runtime: "mock", workspace_root: workspace, display_name: name,
  });
  const instanceId = registered.agent_instance.id;
  const lifecycle = (run: Run, sequence: number, phase: "started" | "completed"): void => send({ kind: "run.event", node_id: computerId, run_id: run.id, sequence, event: { type: "run.lifecycle", payload: { phase } } });
  return {
    computerId, instanceId, agentId: registered.agent.id, commands, close,
    start: async (run) => {
      expect(run.computer_id).toBe(computerId);
      expect(run.agent_instance_id).toBe(instanceId);
      await expect.poll(() => commands.has(run.id)).toBe(true);
      const command = commands.get(run.id)!;
      send({ kind: "command.ack", node_id: computerId, command_id: command.id, status: "accepted" });
      running.add(instanceId);
      lifecycle(run, 0, "started");
      await expect.poll(async () => (await get<{ run: Run }>(request, `/runs/${run.id}`)).run.status).toBe("running");
      return command;
    },
    complete: async (run) => {
      send({ kind: "run.event", node_id: computerId, run_id: run.id, sequence: 1,
        event: { type: "run.output", payload: { stream: "stdout", text: `Controlled mock execution ${run.id}\n` } } });
      lifecycle(run, 2, "completed");
      await expect.poll(async () => (await get<{ run: Run }>(request, `/runs/${run.id}`)).run.status).toBe("completed");
      running.delete(instanceId);
    },
    upload: async (run, filename, text) => {
      const bytes = Buffer.from(text, "utf8");
      const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const response = await request.put(`/api/v1/node/runs/${run.id}/artifacts?type=report&path=${encodeURIComponent(filename)}`, {
        headers: { authorization: `Bearer ${claim.node_token}`, "content-type": "application/octet-stream", "x-artoo-checksum": checksum }, data: bytes,
      });
      expect(response.status(), await response.text()).toBe(201);
      return (await response.json()).artifact;
    },
  };
}

async function openReview(page: Page, task: Task, projectId: string): Promise<void> {
  await page.goto(`/review?project=${encodeURIComponent(projectId)}&task=${encodeURIComponent(task.id)}`);
  await expect(page.getByRole("region", { name: "Selected review evidence" }).getByRole("heading", { name: task.title, exact: true })).toBeVisible();
}

test("controlled multi-node collaboration keeps parallel occupancy, latest inputs, human revisions and handoffs durable", async ({ page, request }) => {
  // Real browser, API, database, artifact bytes and WebSockets. The two paired
  // node fixtures emit mock execution events: no CLI, physical second machine,
  // protected scheduler launch or independent Agent review is established here.
  const marker = `${Date.now()}-${test.info().workerIndex}`;
  const project = (await post<{ project: { id: string } }>(request, "/projects", { name: `Collaboration ${marker}`, default_workspace: `C:/controlled-collaboration-${marker}` })).project;
  const cleanup: (() => void)[] = [];
  let browserSockets = 0;
  page.on("websocket", (socket) => { if (new URL(socket.url()).pathname === "/api/v1/ws") browserSockets++; });
  try {
    const author = await connectControlledNode(request, project.id, marker, "author", cleanup);
    const peer = await connectControlledNode(request, project.id, marker, "peer", cleanup);
    const squad = await request.put(`/api/v1/projects/${project.id}/squad`, { data: { version: 1, expected_revision: 0, agent_ids: [author.agentId, peer.agentId] } });
    expect(squad.ok(), await squad.text()).toBe(true);
    const create = async (title: string): Promise<Task> => (await post<{ task: Task }>(request, "/tasks", { project_id: project.id, title, acceptance_criteria: ["Shared evidence accepted"], required_capabilities: ["code.modify"] })).task;
    const upstream = await create(`Shared author ${marker}`);
    const parallel = await create(`Independent peer work ${marker}`);
    const downstream = await create(`Consume accepted source ${marker}`);
    await post(request, `/tasks/${downstream.id}/dependencies`, { depends_on_task_id: upstream.id, type: "artifact_required" });
    expect((await request.post(`/api/v1/tasks/${downstream.id}/ready`)).status()).toBe(409);
    const assign = async (task: Task, node: ControlledNode): Promise<Run> => (await post<{ run: Run }>(request, `/tasks/${task.id}/assign`, { mode: "manual", agent_instance_id: node.instanceId })).run;
    await post(request, `/tasks/${upstream.id}/ready`);
    await post(request, `/tasks/${parallel.id}/ready`);
    const first = await assign(upstream, author);
    await author.start(first);
    const independent = await assign(parallel, peer);
    await peer.start(independent);
    const occupied = await get<ProjectControlViewV1>(request, `/projects/${project.id}/control-view?limit=100&capacity=true`);
    expect(occupied.summary.total_tasks).toBe(3);
    expect(occupied.summary.runs_by_status.running).toBe(2);
    expect(occupied.capacity.occupied).toBe(2);
    expect(new Set(occupied.tasks.flatMap((entry) => entry.latest_run?.status === "running" ? [entry.latest_run.computer_id] : [])).size).toBe(2);

    const oldArtifact = await author.upload(first, "source-v1.txt", `Controlled first draft ${marker}\n`);
    await author.complete(first);
    expect((await snapshot(request, upstream)).task.status).toBe("review");
    expect((await snapshot(request, downstream)).task.status).toBe("backlog");
    await openReview(page, upstream, project.id);
    await expect.poll(() => browserSockets).toBeGreaterThan(0);
    const feedback = `Revise the shared interface before downstream use ${marker}`;
    await page.getByLabel("Review comment", { exact: true }).fill(feedback);
    await page.getByRole("button", { name: "Request changes", exact: true }).click();
    await expect.poll(async () => (await snapshot(request, upstream)).task.status).toBe("ready");
    const rejected = (await snapshot(request, upstream)).reviews.find((review) => review.outcome === "changes_requested");
    expect(rejected).toMatchObject({ comment: feedback, artifact_ids: [oldArtifact.id] });
    await page.reload();
    const reviewHistory = page.getByRole("region", { name: "Review history", exact: true });
    await expect(reviewHistory.getByText(feedback, { exact: true })).toBeVisible();
    expect((await request.post(`/api/v1/tasks/${downstream.id}/ready`)).status()).toBe(409);

    const retry = await assign(upstream, author);
    expect(retry.id).not.toBe(first.id);
    const retryStart = await author.start(retry);
    const retryContext = ContextPackSchema.parse(retryStart.payload.context_pack.payload);
    expect(retryContext.review_feedback?.entries).toEqual(expect.arrayContaining([expect.objectContaining({ event_id: rejected!.event_id, comment: feedback, artifact_ids: [oldArtifact.id] })]));
    const latestText = `Controlled revised source ${marker}\n`;
    const latestArtifact = await author.upload(retry, "source-v2.txt", latestText);
    await author.complete(retry);
    expect((await snapshot(request, downstream)).task.status).toBe("backlog");
    await openReview(page, upstream, project.id);
    const revisedEvidence = page.getByRole("region", { name: "Selected review evidence" }).locator(`[data-artifact-id='${latestArtifact.id}']`);
    await revisedEvidence.getByRole("button", { name: "Preview artifact text", exact: true }).click();
    await expect(revisedEvidence.getByLabel(`Artifact ${latestArtifact.id} recorded text`, { exact: true })).toHaveText(latestText);
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await expect.poll(async () => (await snapshot(request, upstream)).task.status).toBe("done");
    await expect.poll(async () => (await snapshot(request, downstream)).task.status).toBe("ready");
    await page.reload();
    const persistedHistory = page.getByRole("region", { name: "Review history", exact: true });
    await expect(persistedHistory.getByText(feedback, { exact: true })).toBeVisible();
    await expect(persistedHistory.getByText("Accepted", { exact: true })).toBeVisible();
    const reviews = (await snapshot(request, upstream)).reviews;
    expect(reviews.map((review) => review.outcome)).toEqual(["changes_requested", "accepted"]);
    expect(reviews[1]!.artifact_ids).toEqual(expect.arrayContaining([oldArtifact.id, latestArtifact.id]));

    await peer.complete(independent);
    const second = await assign(downstream, peer);
    const downstreamStart = await peer.start(second);
    const input = ContextPackSchema.parse(downstreamStart.payload.context_pack.payload).dependency_context?.entries.find((entry) => entry.task_id === upstream.id);
    expect(input).toMatchObject({ run_id: retry.id, status: "done" });
    expect(input!.artifacts.map((artifact) => artifact.id)).toEqual([latestArtifact.id]);
    expect(input!.artifacts.some((artifact) => artifact.run_id === first.id)).toBe(false);
    // This checks the pinned bytes through the authorized control download.
    // Paired-node dependency transfer has its separate server integration suite.
    const inputResponse = await request.get(input!.artifacts[0]!.content_path);
    expect(inputResponse.ok()).toBe(true);
    expect(await inputResponse.text()).toBe(latestText);
    expect(input!.artifacts[0]!.checksum).toBe(latestArtifact.checksum);

    await page.goto(`/board?project=${encodeURIComponent(project.id)}&task=${encodeURIComponent(downstream.id)}`);
    const drawer = page.getByRole("dialog", { name: "Task workspace" });
    await expect(drawer.getByRole("heading", { name: downstream.title, exact: true })).toBeVisible();
    await drawer.getByRole("button", { name: "Conversation", exact: true }).click();
    const collaboration = drawer.getByRole("region", { name: "Team collaboration" });
    await collaboration.getByText("Add decision, handoff, or blocker", { exact: true }).click();
    await collaboration.getByLabel("Record type").selectOption("handoff");
    await collaboration.getByLabel("Recipient", { exact: true }).selectOption(`agent:${author.agentId}`);
    await collaboration.getByLabel("Source execution", { exact: true }).selectOption(second.id);
    const action = `Confirm revised input ${marker}`;
    await collaboration.getByLabel("Expected action", { exact: true }).fill(action);
    await collaboration.getByRole("button", { name: "Save record", exact: true }).click();
    await expect(collaboration.getByRole("article").filter({ hasText: action })).toBeVisible();
    await page.reload();
    await page.getByRole("dialog", { name: "Task workspace" }).getByRole("button", { name: "Conversation", exact: true }).click();
    const persisted = page.getByRole("region", { name: "Team collaboration" }).getByRole("article").filter({ hasText: action });
    await expect(persisted.getByRole("link", { name: "Open linked task & execution evidence ↗" })).toHaveAttribute("href", `/runs?task=${downstream.id}&run=${second.id}`);
    await persisted.getByRole("button", { name: "Accept handoff", exact: true }).click();
    await persisted.getByRole("button", { name: "Complete handoff", exact: true }).click();
    await expect(persisted.getByText("completed", { exact: true })).toBeVisible();
    await peer.upload(second, "consumer-result.txt", `Consumed ${latestArtifact.id}\n`);
    await peer.complete(second);
    await openReview(page, downstream, project.id);
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await expect.poll(async () => (await snapshot(request, downstream)).task.status).toBe("done");
  } finally { for (const close of cleanup) close(); }
});
