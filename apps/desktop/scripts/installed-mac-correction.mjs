import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { inspectInstalledMacRetention } from "./installed-mac-retention-ui.mjs";
import { hasCompletePNGPixelStream } from "../../../scripts/png-evidence.mjs";

export const macCorrectionImageNames = [
  "macos-correction-worktree-settings.png", "macos-correction-initial-artifact.png",
  "macos-correction-review-history.png", "macos-correction-failed-retained.png",
  "macos-correction-retry-ready.png", "macos-correction-artifact-versions.png",
  "macos-correction-second-review.png", "macos-correction-stop-confirmation.png",
  "macos-correction-kept-running.png", "macos-correction-cancelled-retained.png",
  "macos-correction-final-history.png", "macos-correction-final-artifacts.png",
  "macos-correction-initial-retained-output.png", "macos-correction-initial-retention-report.png",
  "macos-correction-initial-retained-after-reload.png", "macos-correction-corrected-retained-output.png",
  "macos-correction-corrected-retention-report.png", "macos-correction-failed-retention-report.png",
  "macos-correction-cancelled-retention-report.png", "macos-correction-final-r1-retained.png",
  "macos-correction-final-r2-retained.png", "macos-correction-final-r3-retained.png",
  "macos-correction-final-r4-retained.png",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sortedIds = (rows) => rows.map(({ id }) => id).sort();
const byIdentity = (rows) => [...rows].sort((a, b) => (a.id ?? a.run_id ?? a.root).localeCompare(b.id ?? b.run_id ?? b.root));

/** Bind the UI assignment response to the new execution, without interpreting
 * the ordering or terminal failures of historical runs. */
export function assertMacCorrectionAssignment({ snapshot, previousRunIds, runId, taskId, instanceId }) {
  assert.equal(snapshot.task.id, taskId);
  assert.equal(new Set(snapshot.runs.map((run) => run.id)).size, snapshot.runs.length);
  assert.ok(!previousRunIds.includes(runId));
  assert.deepEqual(sortedIds(snapshot.runs), [...previousRunIds, runId].sort());
  const run = snapshot.runs.find((item) => item.id === runId);
  assert.ok(run); assert.equal(run.task_id, taskId); assert.equal(run.agent_instance_id, instanceId);
  return run;
}

export function parseMacCorrectionRetention(text, expected) {
  const prefix = "Worktree retained for recovery: ";
  const lines = text.split("\n").filter((line) => line.startsWith(prefix));
  assert.equal(lines.length, 1, "The exact run must expose one real recovery diagnostic");
  assert.deepEqual(JSON.parse(lines[0].slice(prefix.length)), expected);
  return lines[0];
}

/** The four-run fixture has one terminal report per run. UI expectations come
 * from its independently observed compact reads and typed audit identity. */
export function assertMacCorrectionRetention(observation, runId) {
  const matches = observation.snapshot.runs.filter((item) => item.id === runId);
  assert.equal(matches.length, 1); const run = matches[0];
  assert.equal(run.task_id, observation.snapshot.task.id);
  const outcomes = { completed: "Execution completed", failed: "Execution failed", cancelled: "Execution cancelled" };
  assert.ok(Object.hasOwn(outcomes, run.status));
  const reports = observation.bundle.events.filter((event) => event.type === "run.workspace.retained" && event.run_id === runId);
  assert.equal(reports.length, 1, "The exact run must have one typed node-owned retention report");
  const event = reports[0];
  assert.equal(event.task_id, run.task_id); assert.equal(event.organization_id, observation.snapshot.task.organization_id);
  assert.deepEqual(event.actor, { type: "system", id: run.computer_id });
  assert.ok(typeof event.id === "string" && event.id.length > 0);
  assert.ok(Number.isSafeInteger(event.position) && event.position > 0);
  assert.ok(Number.isSafeInteger(event.sequence) && event.sequence >= 0);
  assert.ok(Number.isFinite(Date.parse(event.occurred_at)));
  assert.deepEqual(event.payload, { version: 1, workspace_root: run.workspace_root, workspace_branch: run.workspace_branch,
    outcome: run.status, reporter_computer_id: run.computer_id });
  const report = { ...event.payload, event_id: event.id, position: event.position, sequence: event.sequence,
    reported_at: new Date(event.occurred_at).toISOString() };
  assert.deepEqual(run.workspace_retention, report);
  const reads = observation.run_reads.filter((item) => item.id === runId);
  assert.equal(reads.length, 1); assert.deepEqual(reads[0], run, "Task snapshot and exact Run GET must agree");
  return { run, report, outcome_label: outcomes[run.status] };
}

function stableState(observation) {
  assert.ok(observation.snapshot?.task);
  return {
    task: observation.snapshot.task, runs: byIdentity(observation.snapshot.runs),
    approvals: byIdentity(observation.snapshot.approvals), reviews: observation.snapshot.reviews,
    artifacts: byIdentity(observation.snapshot.artifacts), receipts: byIdentity(observation.receipts),
    launches: byIdentity(observation.launches), exits: byIdentity(observation.exits),
    workspaces: byIdentity(observation.workspaces), live_pids: [...observation.live_pids].sort((a, b) => a - b),
    artifact_bytes: [...observation.artifact_bytes].sort((a, b) => a.artifact_id.localeCompare(b.artifact_id)),
    cancellation: observation.cancellation, base: observation.base,
    run_reads: byIdentity(observation.run_reads), leases: byIdentity(observation.leases),
    durable_events: observation.bundle.events.filter((event) => ["run.workspace.retained", "run.started", "run.completed", "run.failed", "run.cancelled", "run.reconciled"].includes(event.type))
      .sort((a, b) => a.position - b.position),
  };
}

/** Repeated reads, not one delayed sample, establish that dismissal/cancellation
 * did not change dispatch, work bytes or the owned process identity. */
export async function observeStableMacCorrection(read, baseline, { minimumMs = 3100, now = () => performance.now(),
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  assert.ok(Number.isFinite(minimumMs) && minimumMs >= 3100 && minimumMs <= 60_000);
  const expected = stableState(baseline), started = now(); let samples = 0;
  do {
    assert.deepEqual(stableState(await read()), expected, "Correction state changed during the explicit stability boundary");
    samples++;
    if (now() - started >= minimumMs && samples >= 2) break;
    await pause(250);
  } while (true);
  return { minimum_ms: minimumMs, observed_ms: now() - started, samples };
}

export async function captureMacCorrectionScreenshot(snapshot, { filename, caption, evidence }) {
  assert.ok(macCorrectionImageNames.includes(filename), "Unapproved correction screenshot name");
  const image = await snapshot(filename, caption);
  assert.ok(image?.path && basename(image.path) === filename && image.caption === caption);
  assert.ok(existsSync(image.path) && hasCompletePNGPixelStream(readFileSync(image.path)), "Correction screenshot must contain actual complete PNG bytes");
  evidence.screenshots.push(image);
  return image;
}

export function assertMacCorrectionScreenshotInventory(screenshots) {
  assert.deepEqual(screenshots.map((image) => basename(image.path)).sort(), [...macCorrectionImageNames].sort(),
    "Every named correction screenshot must come from this run");
}

/** Root owns setup, instance provisioning, observer cleanup, installed-app
 * restart and HTML publication. Every task/approval/review/assignment/retry/stop
 * mutation below originates in the actual installed renderer. */
export async function runInstalledMacCorrection({ page: initialPage, electronApp: initialApp, api, snapshot, check,
  scenario, fixture = scenario.fields, restartWithSystemPath, onEvidence = () => {} }) {
  assert.equal(process.platform, "darwin");
  const { expect } = await import("@playwright/test");
  let page = initialPage, electronApp = initialApp, taskId;
  const evidence = { passed: false, result: "fail", scope: "Installed Mac UI and actual Git worktrees; deterministic correction CLI, no live-provider claim",
    path_scope: "The earlier baseline uses empty PATH. This owned-app phase explicitly restores system PATH for real Git operations.",
    screenshots: [], checks: [], ui_commands: [], checkpoints: [], downloads: [], download_paths: [], observations: {}, retention_ui: [] };
  onEvidence(evidence);
  const pass = (message) => { evidence.checks.push(message); check(message); };
  const detail = () => page.getByRole("complementary", { name: "Task detail", exact: true });
  const artifactRow = (id) => detail().getByRole("listitem", { name: `Artifact ${id}`, exact: true });
  const runRow = (id) => detail().getByRole("listitem", { name: `Run ${id}`, exact: true });
  const history = () => detail().getByRole("region", { name: "Review history", exact: true });
  const eventRow = (id) => { assert.match(id, /^[A-Za-z0-9_-]+$/); return history().locator(`[data-review-id="${id}"]`); };
  const state = async (status) => {
    await expect(detail().getByRole("heading", { name: fixture.task_title, exact: true })).toBeVisible();
    await expect(detail().locator(".task-detail__meta .ui-badge--status")).toHaveText(status);
  };
  const checkpoint = async (name) => {
    const saved = await scenario.waitForCheckpoint(name);
    evidence.checkpoints.push(saved); return saved.observation;
  };
  const uiPost = async (path, action, inspect = () => {}) => {
    assert.ok(path.startsWith("/api/v1/"));
    const pending = page.waitForResponse((response) => new URL(response.url()).pathname === path && response.request().method() === "POST", { timeout: 45_000 });
    void pending.catch(() => {});
    await action(); const response = await pending;
    assert.ok(response.ok(), `Correction UI command ${path} failed with HTTP ${response.status()}`);
    const body = response.request().postDataJSON(); inspect(body);
    evidence.ui_commands.push({ method: "POST", path, status: response.status(), body });
    return response.json();
  };
  const capture = async (target, index, caption) => {
    for (const label of ["Pairing code", "Model API key"]) {
      const input = page.getByLabel(label, { exact: true });
      if (await input.count() && await input.isVisible()) assert.equal(await input.inputValue(), "", "Approved evidence must exclude credential values");
    }
    if (target) {
      // Center the complete evidence region inside its real scroll container.
      // Chromium's if-needed alignment can leave a fractional edge clipped.
      await target.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
      await expect(target).toBeVisible();
      await expect(target).toBeInViewport({ ratio: 1 });
    }
    return captureMacCorrectionScreenshot(snapshot, { filename: macCorrectionImageNames[index], caption, evidence });
  };
  const reopenTask = async () => {
    await page.getByRole("link", { name: "Workspace", exact: true }).click();
    const project = page.getByLabel("Project", { exact: true });
    if (await project.inputValue() !== fixture.project_id) await project.selectOption(fixture.project_id);
    const button = page.getByRole("list", { name: "Tasks", exact: true }).getByRole("button")
      .filter({ has: page.getByText(fixture.task_title, { exact: true }) });
    await expect(button).toHaveCount(1); await button.click();
    await expect(detail().getByRole("heading", { name: fixture.task_title, exact: true })).toBeVisible();
  };
  const assertArtifacts = async (observation) => {
    await expect(detail().locator("[data-artifact-id]")).toHaveCount(observation.snapshot.artifacts.length);
    for (const artifact of observation.snapshot.artifacts) {
      const row = artifactRow(artifact.id);
      await expect(row).toContainText(artifact.metadata.filename);
      await expect(row.getByText(artifact.run_id, { exact: true })).toBeVisible();
      await expect(row.getByText(artifact.id, { exact: true })).toBeVisible();
      await expect(row.locator("time")).toHaveAttribute("datetime", artifact.created_at);
      await expect(row.getByRole("button", { name: "Download artifact", exact: true })).toBeEnabled();
    }
  };
  const assertHistory = async (observation) => {
    const reviews = [...observation.snapshot.reviews].sort((a, b) => a.position - b.position);
    await expect(history().locator("[data-review-id]")).toHaveCount(reviews.length);
    assert.deepEqual(await history().locator("[data-review-id]").evaluateAll((rows) => rows.map((row) => row.dataset.reviewId)), reviews.map((review) => review.event_id));
    for (const review of reviews) {
      const row = eventRow(review.event_id);
      await expect(row).toHaveAttribute("data-outcome", "changes_requested");
      assert.equal(await row.locator(".review-comment").textContent(), review.comment);
      await expect(row.locator("[data-actor-id]")).toHaveAttribute("data-actor-id", review.actor.id);
      await expect(row).toContainText(review.actor_name);
      await expect(row.locator("time")).toHaveAttribute("datetime", review.occurred_at);
      assert.deepEqual((await row.locator("[data-review-artifact-id]").evaluateAll((items) => items.map((item) => item.dataset.reviewArtifactId))).sort(), [...review.artifact_ids].sort());
      for (const id of review.artifact_ids) {
        const artifact = observation.snapshot.artifacts.find((item) => item.id === id); assert.ok(artifact);
        await expect(row).toContainText(artifact.metadata.filename); await expect(row).toContainText(artifact.run_id);
      }
    }
  };
  const download = async (artifact, observation, tag) => {
    assert.match(tag, /^[a-z0-9-]+$/);
    const path = join(fixture.workspace_parent, `mac-ui-download-${tag}.patch`);
    assert.equal(existsSync(path), false, "Each actual download must preserve its own owned evidence file");
    await electronApp.evaluate(({ session }, destination) => {
      globalThis.__artooCorrectionDownload = { state: "waiting" };
      session.defaultSession.once("will-download", (_event, item) => {
        globalThis.__artooCorrectionDownload = { state: "started", filename: item.getFilename() };
        item.setSavePath(destination);
        item.once("done", (_event, state) => { globalThis.__artooCorrectionDownload.state = state; });
      });
    }, path);
    await artifactRow(artifact.id).getByRole("button", { name: "Download artifact", exact: true }).click();
    await expect.poll(async () => {
      const result = await electronApp.evaluate(() => globalThis.__artooCorrectionDownload);
      assert.ok(!["cancelled", "interrupted"].includes(result.state), `Native correction download ${result.state}`);
      return result.state;
    }, { timeout: 30_000 }).toBe("completed");
    const result = await electronApp.evaluate(() => globalThis.__artooCorrectionDownload);
    assert.equal(result.filename, artifact.metadata.filename);
    const bytes = readFileSync(path), expected = observation.artifact_bytes.find((item) => item.artifact_id === artifact.id);
    assert.ok(expected); assert.equal(hash(bytes), expected.sha256); assert.equal(bytes.length, expected.size);
    assert.equal(bytes.toString("utf8"), expected.text);
    evidence.download_paths.push(path);
    evidence.downloads.push({ tag, path, artifact_id: artifact.id, run_id: artifact.run_id, filename: result.filename, sha256: hash(bytes), bytes: bytes.length });
  };
  const retainedOutput = async (observation, runId, index, caption) => {
    const run = observation.snapshot.runs.find((item) => item.id === runId); assert.ok(run);
    const row = runRow(runId); await expect(row).toHaveAttribute("data-status", run.status);
    const output = row.locator("details.run-output");
    await expect(output).toHaveCount(1);
    if (await output.getAttribute("open") === null) await output.locator("summary").click();
    const pre = output.locator("pre"); await expect(pre).toContainText("Worktree retained for recovery: ");
    const line = parseMacCorrectionRetention(await pre.textContent(), { run_id: run.id, task_id: taskId,
      workspace_root: run.workspace_root, workspace_branch: run.workspace_branch, outcome: run.status });
    // Scroll the real pane to the actual recovery line. A long live-output block
    // may exceed one viewport; never rewrite its DOM or manufacture a crop.
    const visible = await pre.evaluate((element, text) => {
      const node = element.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE || node.textContent.indexOf(text) < 0) return false;
      const range = document.createRange(), start = node.textContent.indexOf(text);
      range.setStart(node, start); range.setEnd(node, start + text.length);
      let pane = element.parentElement;
      while (pane && !(pane.scrollHeight > pane.clientHeight && /auto|scroll/.test(getComputedStyle(pane).overflowY))) pane = pane.parentElement;
      if (!pane) return false;
      const before = range.getBoundingClientRect(), bounds = pane.getBoundingClientRect();
      pane.scrollTop += before.top - bounds.top - 16;
      const rect = range.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left >= Math.max(0, bounds.left) && rect.right <= Math.min(innerWidth, bounds.right) + 1
        && rect.top >= Math.max(0, bounds.top) && rect.bottom <= Math.min(innerHeight, bounds.bottom) - 4;
    }, line);
    assert.equal(visible, true, "The complete actual recovery diagnostic must fit the captured native viewport");
    await capture(null, index, caption);
  };
  const retainedWorkspace = async (observation, runId, index, caption, boundary) => {
    const result = await inspectInstalledMacRetention({ page, electronApp, api, taskId, runId,
      identity: assertMacCorrectionRetention(observation, runId) });
    await capture(result.card, index, caption);
    evidence.retention_ui.push({ ...result.evidence, boundary, screenshot: macCorrectionImageNames[index] });
  };
  let stage = "restart the same installed app with system PATH for actual Git operations";
  try {
    assert.equal(fixture.instances.length, 4); assert.equal(new Set(fixture.instances.map((item) => item.id)).size, 4);
    const connection = await page.evaluate(async () => { const value = await window.artooDesktop.getConnection(); return { paired: value.paired, device_id: value.deviceId, computer_id: value.computerId }; });
    assert.equal(connection.paired, true); assert.equal(connection.device_id, fixture.recipient_device_id); assert.equal(connection.computer_id, fixture.computer_id);
    const previousConfig = (await page.evaluate(() => window.artooDesktop.daemonStatus())).config;
    ({ page, electronApp } = await restartWithSystemPath());
    assert.ok(page && electronApp);
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible({ timeout: 45_000 });
    const restored = await page.evaluate(async () => { const value = await window.artooDesktop.getConnection(); return { paired: value.paired, device_id: value.deviceId, computer_id: value.computerId }; });
    assert.deepEqual(restored, connection);
    assert.equal(await electronApp.evaluate(() => Boolean(process.env.PATH)), true, "This Git phase must not keep the baseline empty PATH");
    stage = "configure the Git repository and allowed workspace through Settings UI";
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
    const savedConfig = (await page.evaluate(() => window.artooDesktop.daemonStatus())).config;
    assert.deepEqual(savedConfig.allowedRoots, roots); assert.equal(savedConfig.worktreeBaseRepo, fixture.base_repository);
    assert.deepEqual(savedConfig.codex, previousConfig.codex, "Git setup must leave the existing CLI/model configuration intact");
    await page.getByRole("button", { name: "Start worker", exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.artooDesktop.daemonStatus())).state, { timeout: 45_000 }).toBe("running");
    await expect.poll(async () => {
      const daemon = (await api("/api/v1/daemons")).daemons.find((item) => item.computer_id === fixture.computer_id);
      return daemon?.status === "online" && daemon.connected && daemon.runtimes.some((item) => item.runtime === fixture.runtime_id && item.status === "available");
    }, { timeout: 65_000 }).toBe(true);
    evidence.worker = { device_id: restored.device_id, computer_id: restored.computer_id, allowed_roots: roots, base_repository: fixture.base_repository, cli_configuration_preserved: true };
    await capture(page.getByLabel("Git repository for isolated worktrees (optional)", { exact: true }), 0, "Installed Mac: the actual Git repository field is shown after saving Settings for isolated execution");
    pass("The same installed device explicitly restores system PATH, configures Git through Settings and starts its paired worker without changing CLI settings");

    stage = "create the correction task and mark it Ready through installed UI";
    assert.equal((await scenario.observe()).snapshot, null);
    await page.getByRole("link", { name: "Workspace", exact: true }).click();
    await page.getByLabel("Project", { exact: true }).selectOption(fixture.project_id);
    await page.getByRole("button", { name: "New task", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create task", exact: true });
    await dialog.getByLabel("Title", { exact: true }).fill(fixture.task_title);
    await dialog.getByLabel("Description", { exact: true }).fill("Review an actual report, correct it with persisted feedback, and retain recoverable work after completion, failure or an explicit Stop.");
    await dialog.getByLabel("Acceptance criteria (one per line)", { exact: true }).fill(`${fixture.criterion_1}\n${fixture.criterion_2}`);
    await dialog.locator("summary").filter({ hasText: "Required capabilities" }).click();
    await dialog.getByRole("checkbox", { name: "Write code", exact: true }).check();
    const created = await uiPost("/api/v1/tasks", () => dialog.getByRole("button", { name: "Create task", exact: true }).click(), (body) => {
      assert.equal(body.title, fixture.task_title); assert.equal(body.project_id, fixture.project_id);
      assert.deepEqual(body.acceptance_criteria, [fixture.criterion_1, fixture.criterion_2]); assert.deepEqual(body.required_capabilities, ["code.modify"]);
    });
    taskId = created.task.id; evidence.task_id = taskId;
    await state("backlog");
    await uiPost(`/api/v1/tasks/${taskId}/ready`, () => detail().getByRole("button", { name: "Mark ready", exact: true }).click());
    await state("ready");

    const assign = async (slot, checkpointName) => {
      stage = `request approval and manually assign correction execution ${slot}`;
      const before = await scenario.observe(), priorIds = sortedIds(before.snapshot.runs), instance = fixture.instances[slot - 1];
      assert.equal(before.snapshot.task.id, taskId);
      const assignButton = detail().getByRole("button", { name: "Assign", exact: true });
      if (slot > 1) await expect(assignButton).toBeDisabled();
      const form = detail().getByRole("form", { name: "Request execution approval", exact: true });
      if (!await form.isVisible()) await detail().getByText("Require approval before execution", { exact: true }).click();
      await form.getByLabel("Execution approval summary", { exact: true }).fill(fixture.approval_summaries[slot - 1]);
      const request = await uiPost(`/api/v1/tasks/${taskId}/execution-approval`, () => form.getByRole("button", { name: "Request execution approval", exact: true }).click(),
        (body) => assert.equal(body.summary, fixture.approval_summaries[slot - 1]));
      await expect(assignButton).toBeDisabled();
      const approval = detail().getByRole("region", { name: "Approvals", exact: true }).getByRole("listitem")
        .filter({ has: page.getByText(fixture.approval_summaries[slot - 1], { exact: true }) });
      await expect(approval).toHaveCount(1);
      await uiPost(`/api/v1/approvals/${request.approval.id}/resolve`, () => approval.getByRole("button", { name: "Approve", exact: true }).click(), (body) => assert.equal(body.decision, "approved"));
      assert.deepEqual(sortedIds((await scenario.observe()).snapshot.runs), priorIds, "Approval alone must not launch a run");
      await expect(assignButton).toBeEnabled();
      await detail().getByLabel("Assignment", { exact: true }).selectOption(instance.id);
      const worktree = detail().getByRole("checkbox", { name: "Use an isolated Git worktree", exact: true });
      if (slot === 1) await expect(worktree).not.toBeChecked();
      await worktree.check();
      const assigned = await uiPost(`/api/v1/tasks/${taskId}/assign`, () => assignButton.click(), (body) =>
        assert.deepEqual(body, { mode: "manual", agent_instance_id: instance.id, branch_backed: true }));
      const observation = await checkpoint(checkpointName);
      const run = assertMacCorrectionAssignment({ snapshot: observation.snapshot, previousRunIds: priorIds, runId: assigned.run.id, taskId, instanceId: instance.id });
      assert.equal(observation.snapshot.approvals.find((item) => item.id === request.approval.id)?.run_id, run.id);
      await state(observation.snapshot.task.status); await expect(runRow(run.id)).toHaveAttribute("data-status", run.status);
      return { observation, run };
    };
    const requestChanges = async (comment) => {
      await state("review"); const input = detail().getByLabel("Review comment", { exact: true });
      await expect(input).toHaveValue(""); await input.fill(comment);
      await uiPost(`/api/v1/tasks/${taskId}/review`, () => detail().getByRole("button", { name: "Request changes", exact: true }).click(), (body) => {
        assert.equal(body.outcome, "changes_requested"); assert.equal(body.comment, comment); assert.ok(Number.isSafeInteger(body.base_version));
      });
      await state("ready");
    };

    const first = await assign(1, "initial"), originalArtifact = first.observation.snapshot.artifacts.find((item) => item.run_id === first.run.id);
    assert.ok(originalArtifact); await assertArtifacts(first.observation); await download(originalArtifact, first.observation, "initial");
    await capture(artifactRow(originalArtifact.id), 1, "Installed Mac: the first real report identifies its original execution and is downloaded through the authenticated UI");
    await retainedOutput(first.observation, first.run.id, 12, "Installed Mac: the completed first run keeps its original recovery diagnostic visible in actual process output");
    await retainedWorkspace(first.observation, first.run.id, 13, "Installed Mac: the first completed run reports its computer, time, root and branch; both Copy actions return exact values", "initial");
    stage = "submit the first exact multiline review and restore its durable history after renderer reload";
    await requestChanges(fixture.review_comment_1);
    await page.reload();
    const coldRead = page.waitForRequest((request) => new URL(request.url()).pathname === `/api/v1/tasks/${taskId}` && request.method() === "GET", { timeout: 45_000 });
    void coldRead.catch(() => {});
    await reopenTask(); await state("ready");
    const coldResponse = await (await coldRead).response(); assert.ok(coldResponse); assert.equal(coldResponse.status(), 200);
    const coldSnapshot = await coldResponse.json();
    assert.equal(coldSnapshot.task.id, taskId); assert.equal(coldSnapshot.runs.length, 1);
    assert.deepEqual(coldSnapshot.runs.find((run) => run.id === first.run.id)?.workspace_retention, first.run.workspace_retention);
    evidence.cold_reload = { path: `/api/v1/tasks/${taskId}`, status: coldResponse.status(), run_id: first.run.id,
      retention_event_id: first.run.workspace_retention.event_id, run_count_before_any_new_assignment: coldSnapshot.runs.length };
    const changes = await checkpoint("changes_requested"); await assertHistory(changes);
    await capture(eventRow(changes.snapshot.reviews[0].event_id), 2, "Installed Mac: after reload, the first submitted review retains its exact multiline feedback, reviewer and original artifact inventory");
    await retainedWorkspace(changes, first.run.id, 14, "Installed Mac: after a cold renderer reload and before any new execution, the original completed report and exact copied root/branch remain available", "cold_reload");
    pass("The first successful worktree, typed recovery report, downloaded artifact and exact UI-submitted review survive a real renderer reload before any new execution");

    const failed = await assign(2, "failed");
    await retainedOutput(failed.observation, failed.run.id, 3, "Installed Mac: the failed correction exposes the exact recovery worktree for its modified and new files");
    await retainedWorkspace(failed.observation, failed.run.id, 17, "Installed Mac: the failed run reports its original computer, timestamp, root and branch with exact Copy values", "failed");
    stage = "explicitly Retry the failed task without creating another run or deleting its work";
    const retried = await uiPost(`/api/v1/tasks/${taskId}/retry`, () => detail().getByRole("button", { name: "Retry", exact: true }).click());
    assert.ok(!retried.run, "Retry must only return this task to Ready");
    const ready = await checkpoint("retried"); await state("ready"); await assertHistory(ready);
    await expect(detail().getByRole("button", { name: "Assign", exact: true })).toBeDisabled();
    await capture(detail().locator(".work-task-actions"), 4, "Installed Mac: explicit Retry returns the same task to Ready while a fresh execution approval is still required");
    pass("The second actual process consumes persisted feedback, fails with its files retained, and Retry creates no run or artifact");

    const corrected = await assign(3, "corrected"), correctedArtifact = corrected.observation.snapshot.artifacts.find((item) => item.run_id === corrected.run.id);
    assert.ok(correctedArtifact); await assertArtifacts(corrected.observation); await assertHistory(corrected.observation);
    await download(originalArtifact, corrected.observation, "original-again"); await download(correctedArtifact, corrected.observation, "corrected");
    assert.notEqual(originalArtifact.checksum, correctedArtifact.checksum);
    await capture(detail().locator(".artifact-list"), 5, "Installed Mac: both same-named reports remain downloadable and have distinct originating run identities and creation times");
    await retainedOutput(corrected.observation, corrected.run.id, 15, "Installed Mac: the corrected completed run keeps its own recovery diagnostic and original worktree identity");
    await retainedWorkspace(corrected.observation, corrected.run.id, 16, "Installed Mac: the corrected completed run reports its retained workspace independently of the first report, with exact root and branch Copy values", "corrected");
    stage = "submit the second review with both immutable report versions recorded";
    await requestChanges(fixture.review_comment_2);
    const secondChanges = await checkpoint("changes_requested_again"); await assertHistory(secondChanges);
    await capture(eventRow(secondChanges.snapshot.reviews[1].event_id), 6, "Installed Mac: the second durable review records both actual artifact versions without rewriting the first review");
    pass("A third separately approved execution produces a different report from real review context; both original and corrected UI downloads match their immutable bytes");

    const held = await assign(4, "holding");
    stage = "dismiss Stop for the exact fourth run and observe unchanged live execution";
    const beforeKeep = await checkpoint("keep_running_before");
    await detail().getByRole("button", { name: "Stop run", exact: true }).click();
    const confirmation = detail().getByRole("group", { name: "Confirm cancellation", exact: true });
    await expect(confirmation).toContainText(held.run.id); await expect(confirmation).toContainText("cancel its task");
    await capture(confirmation, 7, "Installed Mac: Stop explicitly identifies the held run and explains that confirming also cancels its task");
    await confirmation.getByRole("button", { name: "Keep running", exact: true }).click(); await expect(confirmation).toHaveCount(0);
    evidence.observations.keep_running = await observeStableMacCorrection(() => scenario.observe(), beforeKeep);
    await checkpoint("keep_running_after"); await state("running");
    await capture(runRow(held.run.id), 8, "Installed Mac: Keep running leaves the same fourth execution running with no cancellation request or new launch");
    stage = "confirm Stop only for the captured fourth execution";
    await detail().getByRole("button", { name: "Stop run", exact: true }).click(); await expect(confirmation).toContainText(held.run.id);
    await uiPost(`/api/v1/runs/${held.run.id}/cancel`, () => confirmation.getByRole("button", { name: "Confirm stop", exact: true }).click());
    const stopped = await checkpoint("stopped"); await state("cancelled");
    await retainedOutput(stopped, held.run.id, 9, "Installed Mac: the cancelled fourth run exposes its retained worktree after its actual process has exited");
    await retainedWorkspace(stopped, held.run.id, 18, "Installed Mac: the cancelled run reports its original root and branch after the owned process exits; both Copy values remain exact", "stopped");
    evidence.observations.stopped = await observeStableMacCorrection(() => scenario.observe(), stopped);
    const final = await checkpoint("stopped_stable"); await assertHistory(final); await assertArtifacts(final);
    for (const [index, run] of [first.run, failed.run, corrected.run, held.run].entries()) {
      await retainedWorkspace(final, run.id, 19 + index, `Installed Mac: at the final stable checkpoint, execution ${index + 1} retains its exact historical report, visible identity and both Copy values`, "stopped_stable");
    }
    await capture(eventRow(final.snapshot.reviews[1].event_id), 10, "Installed Mac: submitted review history remains readable after the task is cancelled");
    await download(originalArtifact, final, "final-original"); await download(correctedArtifact, final, "final-corrected");
    await capture(detail().locator(".artifact-list"), 11, "Installed Mac: both immutable reports still download through the actual UI after cancellation");
    pass("Keep running issues no cancel; one exact paired-device Stop ends only the fourth process while all four worktrees, typed recovery reports and both artifacts remain unchanged");
    stage = "verify all four actual executions, feedback contexts, immutable reports and retained file bytes";
    evidence.verification = await scenario.verify(); assert.equal(evidence.verification.passed, true);
    assert.deepEqual(evidence.verification.counts, { runs: 4, launches: 4, approvals: 4, reviews: 2, artifacts: 2, retained_worktrees: 4, live_owned_processes: 0 });
    assertMacCorrectionScreenshotInventory(evidence.screenshots);
    evidence.passed = true; evidence.result = "pass";
    return evidence;
  } catch (error) {
    evidence.failed_stage = stage; evidence.error = error instanceof Error ? error.message : String(error);
    const failure = error instanceof Error ? error : new Error(evidence.error);
    failure.correctionEvidence = evidence; throw failure;
  }
}
