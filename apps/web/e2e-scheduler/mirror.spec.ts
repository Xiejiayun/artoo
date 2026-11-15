import { expect, test } from "@playwright/test";
import { selectProject } from "../e2e/navigation.js";

test("enabled mirror preserves browser submission and human review through reload", async ({
  page,
  request,
}, testInfo) => {
  const node = new WebSocket(`ws://127.0.0.1:${process.env.ARTOO_PORT ?? "4010"}/api/v1/node?token=dev`);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Controlled scheduler node did not connect")), 10_000);
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
          reject(new Error("Controlled scheduler node failed"));
        },
        { once: true },
      );
    });
    node.send(
      JSON.stringify({
        kind: "node.hello",
        node_id: "computer_local_mock",
        protocol_version: "2026-06-11",
        artood_version: "controlled-scheduler-e2e",
        machine: { hostname: "scheduler-test", os: "windows", arch: "x64" },
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
    const title = `Scheduler mirror ${Date.now()}`;
    // This suite now also runs source-enqueue scenarios on the same server.
    // Assert this scenario adds exactly one record to both real inventories.
    const baselineResponse = await request.post("/api/v1/projects/proj_artoo/scheduler-reconciliations", {
      data: { repair: false },
    });
    expect(baselineResponse.ok(), await baselineResponse.text()).toBe(true);
    const baseline = (await baselineResponse.json()).reconciliation;
    expect(baseline).toMatchObject({ mismatchesBefore: 0, mismatchesAfter: 0, repaired: 0 });
    await page.goto("/");
    await selectProject(page);
    await page.getByRole("button", { name: "New task", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create task" });
    await dialog.getByLabel("Title", { exact: true }).fill(title);
    await dialog
      .getByLabel("Acceptance criteria (one per line)")
      .fill("Human review and real persisted attempt count survive reload");
    await dialog.getByRole("button", { name: "Create task", exact: true }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    const detail = page.getByRole("complementary", { name: "Task detail" });
    await detail.getByRole("button", { name: "Mark ready", exact: true }).click();
    await expect(detail.getByRole("button", { name: "Assign", exact: true })).toBeVisible();
    const list = await (await request.get("/api/v1/tasks?project_id=proj_artoo")).json();
    const task = list.tasks.find((row: { title: string }) => row.title === title);
    expect(task).toBeDefined();
    const policyInput = { version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 1 };
    const policy = await request.put("/api/v1/projects/proj_artoo/scheduling-policy", { data: policyInput });
    expect(policy.ok(), await policy.text()).toBe(true);
    expect((await policy.json()).active).toBe(false);
    const assigned = await request.post(`/api/v1/tasks/${task.id}/assign`, { data: { mode: "auto" } });
    expect(assigned.ok(), await assigned.text()).toBe(true);
    const runId = (await assigned.json()).run.id;
    const execution = await request.post(`/api/v1/dev/runs/${runId}/mock-execute`);
    expect(execution.ok(), await execution.text()).toBe(true);
    await page.reload();
    await selectProject(page);
    await page.getByRole("button", { name: new RegExp(title) }).click();
    await expect(detail.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "Accept", exact: true }).click();
    await expect
      .poll(async () => (await (await request.get(`/api/v1/tasks/${task.id}`)).json()).task.status)
      .toBe("done");
    const snapshot = await (await request.get(`/api/v1/tasks/${task.id}`)).json();
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0].id).toBe(runId);
    const reconcile = await request.post("/api/v1/projects/proj_artoo/scheduler-reconciliations", {
      data: { repair: false },
    });
    expect(reconcile.ok(), await reconcile.text()).toBe(true);
    expect((await reconcile.json()).reconciliation).toMatchObject({
      sourceCount: baseline.sourceCount + 1,
      projectionCount: baseline.projectionCount + 1,
      mismatchesBefore: 0,
      mismatchesAfter: 0,
      repaired: 0,
    });
    await page.reload();
    const savedPolicy = await (await request.get("/api/v1/projects/proj_artoo/scheduling-policy")).json();
    expect(savedPolicy).toMatchObject({
      active: false,
      policy: { policy: policyInput, updatedByUserId: "user_owner" },
    });
    const history = await (await request.get("/api/v1/projects/proj_artoo/scheduler-reconciliations")).json();
    expect(history.reconciliations[0].mismatchesBefore).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("scheduler-mirror-human-review.png"), fullPage: true });
  } finally {
    node.close();
  }
});
