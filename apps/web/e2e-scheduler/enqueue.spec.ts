import { expect, test } from "@playwright/test";
import { selectProject } from "../e2e/navigation.js";

test("source comments deduplicate visibly and late comments require a fresh human review cycle", async ({
  page,
  request,
}, testInfo) => {
  const node = new WebSocket(`ws://127.0.0.1:${process.env.ARTOO_PORT ?? "4010"}/api/v1/node?token=dev`);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Controlled enqueue node did not connect")), 10000);
      node.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      node.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Controlled enqueue node failed"));
        },
        { once: true },
      );
    });
    node.send(
      JSON.stringify({
        kind: "node.hello",
        node_id: "computer_local_mock",
        protocol_version: "2026-06-11",
        artood_version: "controlled-enqueue-e2e",
        machine: { hostname: "enqueue-test", os: "windows", arch: "x64" },
      }),
    );
    node.send(
      JSON.stringify({
        kind: "node.heartbeat",
        node_id: "computer_local_mock",
        sequence: 0,
        resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 10 },
        runtimes: [
          { runtime: "mock", status: "available", version: "0.1.0", capabilities: ["code.read", "code.modify"] },
        ],
        running_instances: [],
      }),
    );
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/v1/bootstrap")).json()).computers.find(
            (computer: { id: string }) => computer.id === "computer_local_mock",
          )?.status,
      )
      .toBe("online");
    const title = `Enqueue source ${Date.now()}`;
    async function enqueue(event: string, comment: string) {
      const response = await request.post("/api/v1/tasks", {
        data: {
          project_id: "proj_artoo",
          title,
          description: "Preserve the original task intent",
          acceptance_criteria: ["All source comments addressed"],
          required_capabilities: ["code.modify"],
          enqueue_source: { version: 1, kind: "issue", key: title, event_id: event, comment },
        },
      });
      expect(response.ok(), await response.text()).toBe(true);
      return (await response.json()).task.id as string;
    }
    const taskId = await enqueue("one", "Source comment one");
    expect(await enqueue("two", "Source comment two")).toBe(taskId);
    expect(await enqueue("three", "Source comment three")).toBe(taskId);
    expect(await enqueue("two", "Source comment two")).toBe(taskId);
    const list = (await (await request.get("/api/v1/tasks?project_id=proj_artoo")).json()).tasks;
    expect(list.filter((task: { title: string }) => task.title === title)).toHaveLength(1);
    await page.goto("/");
    await selectProject(page);
    await page.getByRole("button", { name: new RegExp(title) }).click();
    for (const text of ["Source comment one", "Source comment two", "Source comment three"])
      await expect(page.getByText(text, { exact: true })).toBeVisible();
    const detail = page.getByRole("complementary", { name: "Task detail" });
    await detail.getByRole("button", { name: "Mark ready", exact: true }).click();
    await expect(detail.getByRole("button", { name: "Assign", exact: true })).toBeVisible();
    const assigned = await request.post(`/api/v1/tasks/${taskId}/assign`, { data: { mode: "auto" } });
    expect(assigned.ok(), await assigned.text()).toBe(true);
    const runId = (await assigned.json()).run.id;
    await enqueue("late", "Late source comment");
    const execute = await request.post(`/api/v1/dev/runs/${runId}/mock-execute`);
    expect(execute.ok(), await execute.text()).toBe(true);
    await page.reload();
    await selectProject(page);
    await page.getByRole("button", { name: new RegExp(title) }).click();
    await expect(page.getByText("Late source comment", { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(page.getByText(/Source comments changed after the latest execution context/)).toBeVisible();
    expect((await (await request.get(`/api/v1/tasks/${taskId}`)).json()).task.status).toBe("review");
    await detail.getByLabel("Review comment", { exact: true }).fill("Address the late comment in a new attempt");
    await detail.getByRole("button", { name: "Request changes", exact: true }).click();
    await expect(detail.getByRole("button", { name: "Assign", exact: true })).toBeVisible();
    const reassigned = await request.post(`/api/v1/tasks/${taskId}/assign`, { data: { mode: "auto" } });
    expect(reassigned.ok(), await reassigned.text()).toBe(true);
    const secondRun = (await reassigned.json()).run.id;
    const reexecute = await request.post(`/api/v1/dev/runs/${secondRun}/mock-execute`);
    expect(reexecute.ok(), await reexecute.text()).toBe(true);
    await page.reload();
    await selectProject(page);
    await page.getByRole("button", { name: new RegExp(title) }).click();
    await detail.getByRole("button", { name: "Accept", exact: true }).click();
    await expect
      .poll(async () => (await (await request.get(`/api/v1/tasks/${taskId}`)).json()).task.status)
      .toBe("done");
    const snapshot = await (await request.get(`/api/v1/tasks/${taskId}`)).json();
    expect(snapshot.runs.map((run: { id: string }) => run.id)).toEqual([runId, secondRun]);
    await page.screenshot({ path: testInfo.outputPath("enqueue-source-human-review.png"), fullPage: true });
  } finally {
    node.close();
  }
});
