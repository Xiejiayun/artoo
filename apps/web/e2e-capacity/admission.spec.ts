import { expect, test } from "@playwright/test";
import { selectProject } from "../e2e/navigation.js";

test("capacity rejection preserves ready work and permits assignment after the occupied run closes", async ({
  page,
  request,
}, testInfo) => {
  const node = new WebSocket(`ws://127.0.0.1:${process.env.ARTOO_PORT ?? "4010"}/api/v1/node?token=dev`);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Controlled capacity node did not connect")), 10_000);
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
          reject(new Error("Controlled capacity node failed"));
        },
        { once: true },
      );
    });
    node.send(
      JSON.stringify({
        kind: "node.hello",
        node_id: "computer_local_mock",
        protocol_version: "2026-06-11",
        artood_version: "controlled-capacity-e2e",
        machine: { hostname: "capacity-test", os: "windows", arch: "x64" },
      }),
    );
    let sequence = 0;
    const pulse = () =>
      node.send(
        JSON.stringify({
          kind: "node.heartbeat",
          node_id: "computer_local_mock",
          sequence: sequence++,
          resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 10 },
          runtimes: [
            { runtime: "mock", status: "available", version: "0.1.0", capabilities: ["code.read", "code.modify"] },
          ],
          running_instances: [],
        }),
      );
    pulse();
    heartbeat = setInterval(pulse, 5000);
    await expect
      .poll(
        async () =>
          (await (await request.get("/api/v1/bootstrap")).json()).computers.find(
            (row: { id: string }) => row.id === "computer_local_mock",
          )?.status,
      )
      .toBe("online");

    // A second real instance avoids mistaking legacy per-instance capacity for
    // the new shared project quota. No local process is started by this fixture.
    const configured = await request.post("/api/v1/computers/computer_local_mock/instances", {
      data: {
        project_id: "proj_artoo",
        agent_id: "agent_mock_coder",
        runtime: "mock",
        workspace_root: "C:/controlled-capacity/second",
      },
    });
    expect(configured.ok(), await configured.text()).toBe(true);
    const secondInstanceId = (await configured.json()).agent_instance.id;
    const projectPolicy = { version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 1 };
    for (const [resource, id, policy] of [
      ["projects", "proj_artoo", projectPolicy],
      [
        "agents",
        "agent_mock_coder",
        { version: 1, max_concurrent_runs: 64, pinned_computer_id: null, required_runtimes: [], required_labels: [] },
      ],
      ["computers", "computer_local_mock", { version: 1, max_concurrent_runs: 64, labels: [] }],
    ] as const) {
      const saved = await request.put(`/api/v1/${resource}/${id}/scheduling-policy`, { data: policy });
      expect(saved.ok(), await saved.text()).toBe(true);
    }
    expect(await (await request.get("/api/v1/projects/proj_artoo/scheduling-policy")).json()).toMatchObject({
      active: false,
      capacity_admission: { version: 1, shared_quotas_enabled: true, project_quota_enabled: true },
    });
    async function ready(title: string) {
      const created = await request.post("/api/v1/tasks", {
        data: {
          project_id: "proj_artoo",
          title,
          acceptance_criteria: ["Capacity rejection and recovery survive reload"],
          required_capabilities: ["code.modify"],
        },
      });
      expect(created.ok(), await created.text()).toBe(true);
      const id = (await created.json()).task.id as string;
      const marked = await request.post(`/api/v1/tasks/${id}/ready`);
      expect(marked.ok(), await marked.text()).toBe(true);
      return id;
    }
    const first = await ready("Controlled capacity occupant");
    const title = `Capacity waiting ${Date.now()}`,
      second = await ready(title);
    const assigned = await request.post(`/api/v1/tasks/${first}/assign`, {
      data: { mode: "manual", agent_instance_id: "instance_mock_coder" },
    });
    expect(assigned.ok(), await assigned.text()).toBe(true);
    const firstRun = (await assigned.json()).run.id;
    await page.goto("/");
    await selectProject(page);
    await page.getByRole("button", { name: new RegExp(title) }).click();
    const detail = page.getByRole("complementary", { name: "Task detail" });
    await detail.getByLabel("Assignment", { exact: true }).selectOption(secondInstanceId);
    const rejected = page.waitForResponse(
      (response) => response.url().endsWith(`/api/v1/tasks/${second}/assign`) && response.request().method() === "POST",
    );
    await detail.getByRole("button", { name: "Assign", exact: true }).click();
    expect((await rejected).status()).toBe(409);
    expect(await (await rejected).json()).toMatchObject({
      error: { details: { reason: "scheduler_capacity_exceeded", kind: "project" } },
    });
    await expect(page.getByText("Scheduling project capacity is exhausted", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("capacity-rejected.png"), fullPage: true });
    const unchanged = await (await request.get(`/api/v1/tasks/${second}`)).json();
    expect(unchanged.task.status).toBe("ready");
    expect(unchanged.runs).toEqual([]);
    const finished = await request.post(`/api/v1/dev/runs/${firstRun}/mock-execute`);
    expect(finished.ok(), await finished.text()).toBe(true);
    await page.reload();
    await selectProject(page);
    await page.getByRole("button", { name: new RegExp(title) }).click();
    await detail.getByLabel("Assignment", { exact: true }).selectOption(secondInstanceId);
    await detail.getByRole("button", { name: "Assign", exact: true }).click();
    await expect.poll(async () => (await (await request.get(`/api/v1/tasks/${second}`)).json()).runs.length).toBe(1);
    const result = await (await request.get(`/api/v1/tasks/${second}`)).json();
    const complete = await request.post(`/api/v1/dev/runs/${result.runs[0].id}/mock-execute`);
    expect(complete.ok(), await complete.text()).toBe(true);
    await page.reload();
    await selectProject(page);
    await page.getByRole("button", { name: new RegExp(title) }).click();
    await detail.getByRole("button", { name: "Accept", exact: true }).click();
    await expect
      .poll(async () => (await (await request.get(`/api/v1/tasks/${second}`)).json()).task.status)
      .toBe("done");
    await page.screenshot({ path: testInfo.outputPath("capacity-human-accepted.png"), fullPage: true });
  } finally {
    clearInterval(heartbeat);
    node.close();
  }
});
