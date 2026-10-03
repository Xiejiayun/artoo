import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { hasCompletePNGPixelStream } from "../../../scripts/png-evidence.mjs";
import { assertMacCorrectionAssignment, assertMacCorrectionRetention } from "./installed-mac-correction.mjs";
import { inspectInstalledMacRetention } from "./installed-mac-retention-ui.mjs";

export const macZeroArtifactImageNames = [
  "macos-zero-artifact-worktree-settings.png", "macos-zero-artifact-completed-empty.png",
  "macos-zero-artifact-completed-retention.png", "macos-zero-artifact-reloaded-empty.png",
  "macos-zero-artifact-reloaded-retention.png",
];

export function assertMacZeroArtifactCommands({ commands, taskId, approvalId, instanceId, fixture }) {
  assert.deepEqual(commands.map(({ method, path }) => ({ method, path })), [
    "/api/v1/tasks", `/api/v1/tasks/${taskId}/ready`, `/api/v1/tasks/${taskId}/execution-approval`,
    `/api/v1/approvals/${approvalId}/resolve`, `/api/v1/tasks/${taskId}/assign`,
  ].map((path) => ({ method: "POST", path })));
  assert.ok(commands.every(({ status }) => status >= 200 && status < 300));
  assert.equal(commands[0].body.project_id, fixture.project_id); assert.equal(commands[0].body.title, fixture.task_title);
  assert.deepEqual(commands[0].body.acceptance_criteria, fixture.acceptance_criteria);
  assert.deepEqual(commands[0].body.required_capabilities, ["code.modify"]);
  assert.equal(commands[2].body.summary, fixture.approval_summary);
  assert.equal(commands[3].body.decision, "approved");
  assert.deepEqual(commands[4].body, { mode: "manual", agent_instance_id: instanceId, branch_backed: true });
}

export async function captureMacZeroArtifactScreenshot(snapshot, { filename, caption, evidence }) {
  assert.ok(macZeroArtifactImageNames.includes(filename));
  const image = await snapshot(filename, caption);
  assert.ok(image?.path && basename(image.path) === filename && image.caption === caption);
  assert.ok(existsSync(image.path) && hasCompletePNGPixelStream(readFileSync(image.path)));
  evidence.screenshots.push(image); return image;
}

export function assertMacZeroArtifactScreenshots(screenshots) {
  assert.deepEqual(screenshots.map(({ path }) => basename(path)).sort(), [...macZeroArtifactImageNames].sort());
}

/** A separate task executed only by the actual installed worker. The scenario
 * is a passive observer bound to that computer/instance, never a helper node. */
export async function runInstalledMacZeroArtifact({ page: initialPage, electronApp: initialApp, api, scenario,
  restartWithoutArtifacts, snapshot, check, onEvidence = () => {} }) {
  assert.equal(process.platform, "darwin");
  const { expect } = await import("@playwright/test");
  let page = initialPage, electronApp = initialApp, taskId, approvalId;
  const fixture = scenario.fields;
  const evidence = { passed: false, scope: "Separate installed Mac UI task; actual paired app worker and process CLI with artifact collection disabled; no live-provider claim",
    screenshots: [], ui_commands: [], retention_ui: [], observations: {} };
  onEvidence(evidence);
  const detail = () => page.getByRole("complementary", { name: "Task detail", exact: true });
  const state = async (status) => {
    await expect(detail().getByRole("heading", { name: fixture.task_title, exact: true })).toBeVisible();
    await expect(detail().locator(".task-detail__meta .ui-badge--status")).toHaveText(status);
  };
  const capture = async (target, index, caption) => {
    for (const label of ["Pairing code", "Model API key"]) {
      const input = page.getByLabel(label, { exact: true });
      if (await input.count() && await input.isVisible()) assert.equal(await input.inputValue(), "");
    }
    await target.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
    await expect(target).toBeVisible(); await expect(target).toBeInViewport({ ratio: 1 });
    return captureMacZeroArtifactScreenshot(snapshot, { filename: macZeroArtifactImageNames[index], caption, evidence });
  };
  const uiPost = async (path, action) => {
    const pending = page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === "POST", { timeout: 45_000 });
    void pending.catch(() => {});
    await action(); const response = await pending;
    assert.ok(response.ok(), `Zero-artifact UI request failed: ${path} HTTP ${response.status()}`);
    evidence.ui_commands.push({ method: "POST", path, status: response.status(), body: response.request().postDataJSON() });
    return response.json();
  };
  const emptyArtifacts = async (index, caption) => {
    const artifacts = detail().getByRole("region", { name: "Artifacts", exact: true });
    await expect(artifacts.getByText("No artifacts yet.", { exact: true })).toBeVisible();
    await expect(artifacts.locator("[data-artifact-id]")).toHaveCount(0);
    await expect(artifacts.getByRole("button", { name: "Download artifact", exact: true })).toHaveCount(0);
    await capture(artifacts, index, caption);
  };
  const recovery = async (observation, runId, index, boundary, caption) => {
    const result = await inspectInstalledMacRetention({ page, electronApp, api, taskId, runId,
      identity: assertMacCorrectionRetention(observation, runId) });
    await capture(result.card, index, caption);
    evidence.retention_ui.push({ ...result.evidence, boundary, screenshot: macZeroArtifactImageNames[index] });
  };
  let stage = "restart the actual installed app with local artifact collection disabled";
  try {
    const connection = await page.evaluate(() => window.artooDesktop.getConnection());
    assert.equal(connection.paired, true); assert.equal(connection.computerId, fixture.computer_id);
    const previousConfig = (await page.evaluate(() => window.artooDesktop.daemonStatus())).config;
    ({ page, electronApp } = await restartWithoutArtifacts());
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible({ timeout: 45_000 });
    assert.deepEqual(await page.evaluate(() => window.artooDesktop.getConnection()), connection);
    assert.equal(await electronApp.evaluate(() => process.env.ARTOO_REPORT_ARTIFACTS), "none");
    stage = "configure the separate Git base through installed Settings";
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    if ((await page.evaluate(() => window.artooDesktop.daemonStatus())).state !== "stopped") {
      await page.getByRole("button", { name: "Stop worker", exact: true }).click();
      await expect.poll(async () => (await page.evaluate(() => window.artooDesktop.daemonStatus())).state, { timeout: 30_000 }).toBe("stopped");
    }
    const roots = [...new Set([...previousConfig.allowedRoots, fixture.workspace_parent])];
    await page.getByLabel("Allowed workspace folders", { exact: true }).fill(roots.join("\n"));
    await page.getByLabel("Git repository for isolated worktrees (optional)", { exact: true }).fill(fixture.base_repository);
    await page.getByRole("checkbox", { name: "Allow execution of trusted team tasks on this computer", exact: true }).check();
    await page.getByRole("button", { name: "Save worker configuration", exact: true }).click();
    await expect(page.getByText("Worker configuration saved.", { exact: true })).toBeVisible();
    const configured = (await page.evaluate(() => window.artooDesktop.daemonStatus())).config;
    assert.deepEqual(configured.codex, previousConfig.codex); assert.deepEqual(configured.allowedRoots, roots);
    assert.equal(configured.worktreeBaseRepo, fixture.base_repository);
    await page.getByRole("button", { name: "Start worker", exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.artooDesktop.daemonStatus())).state, { timeout: 45_000 }).toBe("running");
    await expect.poll(async () => (await api("/api/v1/daemons")).daemons.some((daemon) => daemon.computer_id === fixture.computer_id
      && daemon.status === "online" && daemon.connected && daemon.runtimes.some((runtime) => runtime.runtime === fixture.runtime_id && runtime.status === "available")), { timeout: 65_000 }).toBe(true);
    evidence.worker = { computer_id: fixture.computer_id, instance_id: fixture.instance_id, runtime_id: fixture.runtime_id,
      artifact_collection: "none", base_repository: fixture.base_repository, allowed_roots: roots, original_cli_configuration_preserved: true };
    await capture(page.getByLabel("Git repository for isolated worktrees (optional)", { exact: true }), 0,
      "Installed Mac: the same paired worker uses a separate disposable Git base for the zero-artifact task");

    stage = "create and approve one separate task through the installed UI";
    assert.equal((await scenario.observe()).snapshot, null);
    await page.getByRole("link", { name: "Workspace", exact: true }).click();
    await page.getByLabel("Project", { exact: true }).selectOption(fixture.project_id);
    await page.getByRole("button", { name: "New task", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create task", exact: true });
    await dialog.getByLabel("Title", { exact: true }).fill(fixture.task_title);
    await dialog.getByLabel("Description", { exact: true }).fill("Complete local changes without a report artifact, then recover the original execution location after reopening.");
    await dialog.getByLabel("Acceptance criteria (one per line)", { exact: true }).fill(fixture.acceptance_criteria.join("\n"));
    await dialog.locator("summary").filter({ hasText: "Required capabilities" }).click();
    await dialog.getByRole("checkbox", { name: "Write code", exact: true }).check();
    taskId = (await uiPost("/api/v1/tasks", () => dialog.getByRole("button", { name: "Create task", exact: true }).click())).task.id;
    evidence.task_id = taskId; await state("backlog");
    await uiPost(`/api/v1/tasks/${taskId}/ready`, () => detail().getByRole("button", { name: "Mark ready", exact: true }).click());
    await state("ready");
    const form = detail().getByRole("form", { name: "Request execution approval", exact: true });
    if (!await form.isVisible()) await detail().getByText("Require approval before execution", { exact: true }).click();
    await form.getByLabel("Execution approval summary", { exact: true }).fill(fixture.approval_summary);
    approvalId = (await uiPost(`/api/v1/tasks/${taskId}/execution-approval`, () => form.getByRole("button", { name: "Request execution approval", exact: true }).click())).approval.id;
    const assign = detail().getByRole("button", { name: "Assign", exact: true }); await expect(assign).toBeDisabled();
    const approval = detail().getByRole("region", { name: "Approvals", exact: true }).getByRole("listitem")
      .filter({ has: page.getByText(fixture.approval_summary, { exact: true }) });
    await expect(approval).toHaveCount(1);
    await uiPost(`/api/v1/approvals/${approvalId}/resolve`, () => approval.getByRole("button", { name: "Approve", exact: true }).click());
    assert.equal((await scenario.observe()).snapshot.runs.length, 0, "Approval alone cannot launch a run");
    await expect(assign).toBeEnabled(); await detail().getByLabel("Assignment", { exact: true }).selectOption(fixture.instance_id);
    const worktree = detail().getByRole("checkbox", { name: "Use an isolated Git worktree", exact: true });
    await expect(worktree).not.toBeChecked(); await worktree.check();
    const assigned = await uiPost(`/api/v1/tasks/${taskId}/assign`, () => assign.click());

    stage = "verify successful retained work with the actual empty artifact UI";
    const completed = await scenario.waitForVerified();
    const run = assertMacCorrectionAssignment({ snapshot: completed.snapshot, previousRunIds: [], runId: assigned.run.id,
      taskId, instanceId: fixture.instance_id });
    assert.equal(run.status, "completed"); await state("review");
    evidence.run_id = run.id; evidence.observations.completed = completed;
    await emptyArtifacts(1, "Installed Mac: the separate successful task reaches Review with no report artifact or download action");
    await recovery(completed, run.id, 2, "completed", "Installed Mac: the zero-artifact success reports the original computer, root and branch, and both Copy actions return exact values");

    stage = "cold reload the renderer and reopen the original successful run";
    await page.reload();
    const coldRead = page.waitForRequest((request) => new URL(request.url()).pathname === `/api/v1/tasks/${taskId}` && request.method() === "GET", { timeout: 45_000 });
    void coldRead.catch(() => {});
    await page.getByRole("link", { name: "Workspace", exact: true }).click();
    await page.getByLabel("Project", { exact: true }).selectOption(fixture.project_id);
    const taskButton = page.getByRole("list", { name: "Tasks", exact: true }).getByRole("button")
      .filter({ has: page.getByText(fixture.task_title, { exact: true }) });
    await expect(taskButton).toHaveCount(1); await taskButton.click(); await state("review");
    const response = await (await coldRead).response(); assert.ok(response); assert.equal(response.status(), 200);
    const cold = await response.json(); assert.equal(cold.task.id, taskId); assert.equal(cold.runs.length, 1);
    assert.deepEqual(cold.runs[0].workspace_retention, run.workspace_retention); assert.deepEqual(cold.artifacts, []);
    const reopened = await scenario.waitForVerified();
    assert.deepEqual(reopened.snapshot.runs, completed.snapshot.runs);
    assert.deepEqual(reopened.receipts, completed.receipts); assert.deepEqual(reopened.launches, completed.launches);
    assert.deepEqual(reopened.workspace, completed.workspace);
    evidence.observations.reopened = reopened;
    evidence.cold_reload = { path: `/api/v1/tasks/${taskId}`, status: response.status(), run_id: run.id,
      retention_event_id: run.workspace_retention.event_id, unchanged_launch_count: reopened.launches.length };
    await emptyArtifacts(3, "Installed Mac: after a cold renderer reload the original successful task still has no artifacts");
    await recovery(reopened, run.id, 4, "cold_reload", "Installed Mac: after cold reload the same durable zero-artifact recovery report and exact root/branch Copy values remain available");
    assertMacZeroArtifactCommands({ commands: evidence.ui_commands, taskId, approvalId, instanceId: fixture.instance_id, fixture });
    evidence.verification = await scenario.verify();
    assert.deepEqual(evidence.verification.counts, { tasks: 1, runs: 1, launches: 1, approvals: 1, reviews: 0, artifacts: 0, retained_worktrees: 1, live_owned_processes: 0 });
    assertMacZeroArtifactScreenshots(evidence.screenshots); evidence.passed = true;
    check("A separate installed Mac task completes with zero artifacts, retains its complete worktree and restores exact recovery/Copy values after cold renderer reload");
    return evidence;
  } catch (error) {
    evidence.failed_stage = stage; evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
}
