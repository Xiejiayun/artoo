import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const PROJECT_ID = "proj_artoo";
const NODE_ID = "computer_local_mock";
const SERVER_PORT = process.env.ARTOO_PORT ?? "4010";

interface TaskRow {
  id: string;
  title: string;
  status: string;
}

interface RunRow {
  id: string;
  status: string;
}

interface ApprovalRow {
  id: string;
  status: string;
  summary: string;
}

interface ArtifactRow {
  id: string;
  type: string;
}

interface TaskSnapshot {
  task: TaskRow;
  runs: RunRow[];
  approvals: ApprovalRow[];
  artifacts: ArtifactRow[];
}

interface RuntimeRow {
  runtime: string;
  capabilities: string[];
}

interface RunStartCommand {
  kind: "command";
  id: string;
  type: "run.start";
  payload: { run_id: string };
}

let uniqueCounter = 0;

function uniqueTitle(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix} ${Date.now()} ${uniqueCounter}`;
}

function e2eKey(prefix: string): string {
  uniqueCounter += 1;
  return `e2e-${prefix}-${Date.now()}-${uniqueCounter}`;
}

async function createTaskViaUi(page: Page, request: APIRequestContext, title: string): Promise<string> {
  await page.getByRole("button", { name: "New Task" }).click();
  const dialog = page.getByRole("dialog", { name: "Create task" });
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Acceptance criteria (one per line)").fill("works end to end");
  await dialog.getByRole("button", { name: "Create task" }).click();

  await expect(page.getByRole("heading", { name: title, level: 2 })).toBeVisible();
  return resolveTaskId(request, title);
}

async function createTaskViaApi(request: APIRequestContext, title: string): Promise<string> {
  const res = await request.post("/api/v1/tasks", {
    headers: { "Idempotency-Key": e2eKey("create") },
    data: {
      project_id: PROJECT_ID,
      title,
      acceptance_criteria: ["done"],
      required_capabilities: [],
    },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { task: TaskRow };
  return body.task.id;
}

async function resolveTaskId(request: APIRequestContext, title: string): Promise<string> {
  let taskId = "";
  await expect
    .poll(async () => {
      const res = await request.get(`/api/v1/tasks?project_id=${PROJECT_ID}`);
      const body = (await res.json()) as { tasks: TaskRow[] };
      const found = body.tasks.find((t) => t.title === title);
      taskId = found?.id ?? "";
      return taskId;
    })
    .not.toBe("");
  return taskId;
}

async function taskSnapshot(request: APIRequestContext, taskId: string): Promise<TaskSnapshot> {
  const res = await request.get(`/api/v1/tasks/${taskId}`);
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as TaskSnapshot;
}

async function waitForTaskStatus(
  request: APIRequestContext,
  taskId: string,
  status: string,
): Promise<void> {
  await expect.poll(async () => (await taskSnapshot(request, taskId)).task.status).toBe(status);
}

async function waitForRunCount(
  request: APIRequestContext,
  taskId: string,
  count: number,
): Promise<RunRow[]> {
  let runs: RunRow[] = [];
  await expect
    .poll(async () => {
      runs = (await taskSnapshot(request, taskId)).runs;
      return runs.length;
    })
    .toBeGreaterThanOrEqual(count);
  return runs;
}

async function mockExecute(
  request: APIRequestContext,
  runId: string,
  outcome: "completed" | "failed" = "completed",
): Promise<void> {
  const suffix = outcome === "failed" ? "?outcome=failed" : "";
  const res = await request.post(`/api/v1/dev/runs/${runId}/mock-execute${suffix}`, {
    headers: { "Idempotency-Key": e2eKey(`mock-${runId}`) },
  });
  expect(res.ok()).toBeTruthy();
}

async function selectTask(page: Page, title: string): Promise<void> {
  await page.getByRole("heading", { name: "artoo", level: 1 }).waitFor();
  await page.getByRole("button", { name: title, exact: false }).click();
  await expect(page.getByRole("heading", { name: title, level: 2 })).toBeVisible();
}

async function expectDetailStatus(page: Page, status: string): Promise<void> {
  await expect(page.locator(`.task-detail dd[data-status="${status}"]`)).toBeVisible();
}

async function connectManualNode(request: APIRequestContext): Promise<{
  waitForRunStart: () => Promise<RunStartCommand>;
  startRun: (command: RunStartCommand) => void;
  close: () => void;
}> {
  const marker = e2eKey("node-ready");
  const socket = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/api/v1/node?token=dev`);
  const commands: RunStartCommand[] = [];
  const waiters: Array<(command: RunStartCommand) => void> = [];

  socket.addEventListener("message", (event) => {
    const parsed = JSON.parse(String(event.data)) as unknown;
    if (isRunStartCommand(parsed)) {
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter(parsed);
      } else {
        commands.push(parsed);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("manual node did not open")), 10_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("manual node socket error"));
    });
  });

  sendNodeMessage(socket, {
    kind: "node.hello",
    node_id: NODE_ID,
    protocol_version: "2026-06-11",
    artood_version: "0.1.0-e2e",
    machine: { hostname: "playwright", os: "windows", arch: "x64" },
  });
  sendNodeMessage(socket, {
    kind: "node.heartbeat",
    node_id: NODE_ID,
    sequence: 0,
    resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 1 },
    runtimes: [{ runtime: "mock", status: "available", version: "0.1.0", capabilities: [marker] }],
    running_instances: [],
  });

  await expect
    .poll(async () => {
      const res = await request.get(`/api/v1/computers/${NODE_ID}/runtimes`);
      const body = (await res.json()) as { runtimes: RuntimeRow[] };
      return body.runtimes.some((runtime) => runtime.runtime === "mock" && runtime.capabilities.includes(marker));
    })
    .toBe(true);

  return {
    waitForRunStart: async () => {
      const existing = commands.shift();
      if (existing !== undefined) {
        return existing;
      }
      return new Promise<RunStartCommand>((resolve) => waiters.push(resolve));
    },
    startRun: (command) => {
      sendNodeMessage(socket, {
        kind: "command.ack",
        node_id: NODE_ID,
        command_id: command.id,
        status: "accepted",
      });
      sendNodeMessage(socket, {
        kind: "run.event",
        node_id: NODE_ID,
        run_id: command.payload.run_id,
        sequence: 0,
        event: { type: "run.lifecycle", payload: { phase: "started" } },
      });
    },
    close: () => socket.close(),
  };
}

function sendNodeMessage(socket: WebSocket, message: unknown): void {
  socket.send(JSON.stringify(message));
}

function isRunStartCommand(value: unknown): value is RunStartCommand {
  const message = value as Partial<RunStartCommand>;
  return message.kind === "command" && message.type === "run.start" && message.payload?.run_id !== undefined;
}

/**
 * Full v0.1 happy path against the real server:
 * create → ready → assign (UI) → drive the run server-side via dev mock-execute
 * → WS realtime refreshes the UI to review + artifact → accept → done.
 *
 * No real agent/node is connected; `dev/runs/:id/mock-execute` simulates the run
 * server-side (workspace-safe).
 */
test("create → ready → assign → mock run → review → accept → done", async ({ page, request }) => {
  await page.goto("/");

  // Workspace loads with the seeded project.
  await expect(page.getByRole("heading", { name: "artoo", level: 1 })).toBeVisible();

  // Create a uniquely-titled task.
  const title = uniqueTitle("E2E happy path");
  const taskId = await createTaskViaUi(page, request, title);

  // Drive the lifecycle via the UI.
  await page.getByRole("button", { name: "Mark ready", exact: true }).click();
  await page.getByRole("button", { name: "Assign", exact: true }).click();

  // Wait for the assigned run, then drive it to completion server-side.
  const [run] = await waitForRunCount(request, taskId, 1);
  await mockExecute(request, run.id);

  // Reload to deterministically observe the post-run state (review + artifact);
  // WS realtime push→invalidate is covered separately in RealtimeContext unit tests.
  await page.reload();
  await selectTask(page, title);

  // Detail pane is now review: artifact present and Accept available.
  await expect(page.locator('.artifact[data-type="report"]')).toBeVisible();

  // Accept → done.
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expectDetailStatus(page, "done");
});

test("request changes returns ready, and retry recovers a failed run", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "artoo", level: 1 })).toBeVisible();

  const title = uniqueTitle("E2E retry path");
  const taskId = await createTaskViaUi(page, request, title);

  await page.getByRole("button", { name: "Mark ready", exact: true }).click();
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  const [firstRun] = await waitForRunCount(request, taskId, 1);
  await mockExecute(request, firstRun.id);

  await page.reload();
  await selectTask(page, title);
  await expect(page.locator('.artifact[data-type="report"]')).toBeVisible();
  await page.getByRole("button", { name: "Request changes", exact: true }).click();
  await expectDetailStatus(page, "ready");
  await waitForTaskStatus(request, taskId, "ready");

  await page.getByRole("button", { name: "Assign", exact: true }).click();
  const runsAfterRetryAssign = await waitForRunCount(request, taskId, 2);
  await mockExecute(request, runsAfterRetryAssign.at(-1)!.id, "failed");

  await page.reload();
  await selectTask(page, title);
  await expectDetailStatus(page, "blocked");
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expectDetailStatus(page, "ready");
  await waitForTaskStatus(request, taskId, "ready");
});

test("DAG unlock marks a dependent task ready after its prerequisite is accepted", async ({
  page,
  request,
}) => {
  const prereqTitle = uniqueTitle("E2E DAG prerequisite");
  const dependentTitle = uniqueTitle("E2E DAG dependent");
  const prereqId = await createTaskViaApi(request, prereqTitle);
  const dependentId = await createTaskViaApi(request, dependentTitle);

  const dep = await request.post(`/api/v1/tasks/${dependentId}/dependencies`, {
    headers: { "Idempotency-Key": e2eKey("dependency") },
    data: { depends_on_task_id: prereqId, type: "blocks" },
  });
  expect(dep.ok()).toBeTruthy();

  const earlyReady = await request.post(`/api/v1/tasks/${dependentId}/ready`, {
    headers: { "Idempotency-Key": e2eKey("early-ready") },
  });
  expect(earlyReady.status()).toBe(409);
  await waitForTaskStatus(request, dependentId, "backlog");

  const ready = await request.post(`/api/v1/tasks/${prereqId}/ready`, {
    headers: { "Idempotency-Key": e2eKey("prereq-ready") },
  });
  expect(ready.ok()).toBeTruthy();
  const assigned = await request.post(`/api/v1/tasks/${prereqId}/assign`, {
    headers: { "Idempotency-Key": e2eKey("prereq-assign") },
    data: { mode: "auto" },
  });
  expect(assigned.ok()).toBeTruthy();
  const assignedBody = (await assigned.json()) as { run: RunRow };
  await mockExecute(request, assignedBody.run.id);
  const reviewed = await request.post(`/api/v1/tasks/${prereqId}/review`, {
    headers: { "Idempotency-Key": e2eKey("prereq-review") },
    data: { outcome: "accepted" },
  });
  expect(reviewed.ok()).toBeTruthy();

  await waitForTaskStatus(request, prereqId, "done");
  await waitForTaskStatus(request, dependentId, "ready");

  await page.goto("/");
  await selectTask(page, dependentTitle);
  await expectDetailStatus(page, "ready");
  await expect(page.getByRole("button", { name: "Assign", exact: true })).toBeVisible();
});

test("approval gate moves a running task to awaiting approval and back to running", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "artoo", level: 1 })).toBeVisible();

  const title = uniqueTitle("E2E approval gate");
  const taskId = await createTaskViaUi(page, request, title);
  const node = await connectManualNode(request);
  try {
    await page.getByRole("button", { name: "Mark ready", exact: true }).click();
    await page.getByRole("button", { name: "Assign", exact: true }).click();

    const command = await node.waitForRunStart();
    node.startRun(command);
    await waitForTaskStatus(request, taskId, "running");

    const requested = await request.post(`/api/v1/dev/tasks/${taskId}/request-approval`, {
      headers: { "Idempotency-Key": e2eKey("approval-request") },
      data: {
        action: "git.push",
        risk: "high",
        summary: "Push release branch",
        run_id: command.payload.run_id,
      },
    });
    expect(requested.ok()).toBeTruthy();
    const requestedBody = (await requested.json()) as { approval: ApprovalRow };
    expect(requestedBody.approval.status).toBe("pending");
    await waitForTaskStatus(request, taskId, "awaiting_approval");

    await page.reload();
    await selectTask(page, title);
    await expectDetailStatus(page, "awaiting_approval");
    await expect(page.locator(".approval-summary", { hasText: "Push release branch" })).toBeVisible();

    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expectDetailStatus(page, "running");
    await waitForTaskStatus(request, taskId, "running");
  } finally {
    node.close();
  }
});
