import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { planningHash, planningReceiptPath, verifyMacPlanningTurns } from "./mac-planning-fixture.mjs";
import { capturePlanningEvidence } from "./installed-mac-planning-evidence.mjs";

export const macPlanningImageNames = ["macos-planning-instructions.png", "macos-planning-original.png", "macos-planning-suggestion.png", "macos-planning-accepted.png", "macos-planning-requests.png", "macos-planning-dependent-task.png"];

// All writes under test use the installed renderer. The authenticated API is
// read-only here; the enclosing smoke owns the server, worker and cleanup.
export async function runInstalledMacPlanning({ page, workspace, configurationPath, baseUrl, ownerCookie, artifactDir, onEvidence, onScreenshot }) {
  assert.equal(process.platform, "darwin", "Installed planning is a Mac-specific gate");
  const { expect } = await import("@playwright/test");
  const evidence = { result: "fail", scope: "Installed Mac UI and bundled worker; three deterministic Codex subprocess contributions, no model provider",
    usage_measurements: "Synthetic fixture counters verify usage ingestion; no provider usage or billing was measured",
    checks: [], turns: [], screenshots: [] };
  onEvidence(evidence);
  const check = (name) => { evidence.checks.push(name); console.log(`[mac-planning] PASS ${name}`); };
  const capture = async (locator, filename, caption) => {
    const proof = { filename, caption }; (evidence.viewport_captures ??= []).push(proof);
    await capturePlanningEvidence({ locator, description: caption, evidence: proof,
      captureFrame: async (part, sequential) => {
        const name = part === 1 ? filename : filename.replace(/\.png$/, `-viewport-${String(part).padStart(2, "0")}.png`);
        const path = join(artifactDir, name);
        const png = await page.screenshot({ path, fullPage: false, animations: "disabled", timeout: 30_000 });
        assert.ok(existsSync(path));
        const image = { path, caption: sequential ? `${caption} — viewport ${part}; complete content spans the recorded sequence` : caption };
        evidence.screenshots.push(image); onScreenshot(image);
        return { ...image, bytes: png.length, sha256: createHash("sha256").update(png).digest("hex") };
      } });
  };
  const api = async (route) => {
    const response = await fetch(`${baseUrl}/api/v1${route}`, { headers: { Cookie: ownerCookie }, signal: AbortSignal.timeout(15_000) });
    assert.ok(response.ok, `Planning read failed with HTTP ${response.status}`); return response.json();
  };
  const responseTo = (route) => page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1${route}` && response.request().method() === "POST");
  const consume = async (pending) => { const response = await pending; assert.ok(response.ok(), `Planning UI command failed with HTTP ${response.status()}`); return response.json(); };
  const suffix = randomUUID().slice(0, 8), planningWorkspace = join(workspace, "planning");
  const fixture = { workspace: planningWorkspace, context_receipts_directory: join(dirname(configurationPath), "mac-planning-receipts"),
    task_1_title: `Implement Mac planning contract ${suffix}`, task_2_title: `Verify Mac planning contract ${suffix}`,
    task_1_criterion: "The client presents the documented planning contract", task_2_criterion: "Verification follows implementation and checks both outcomes" };
  let stage = "start the installed planning worker through Settings";
  try {
    for (const name of macPlanningImageNames) {
      rmSync(join(artifactDir, name), { force: true });
      const prefix = name.replace(/\.png$/, "-viewport-");
      for (const existing of readdirSync(artifactDir)) {
        if (existing.startsWith(prefix) && /^\d{2}\.png$/.test(existing.slice(prefix.length))) rmSync(join(artifactDir, existing), { force: true });
      }
    }
    mkdirSync(planningWorkspace); mkdirSync(fixture.context_receipts_directory, { mode: 0o700 });
    const connection = await page.evaluate(() => window.artooDesktop.getConnection());
    fixture.computer_id = connection.computerId;
    assert.ok(fixture.computer_id, "Planning requires the paired execution computer");
    // App restart restores configuration; starting execution remains an
    // explicit user action. Establish it through the actual Settings control.
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Start worker", exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.artooDesktop.daemonStatus())).state,
      { timeout: 45_000 }).toBe("running");
    await expect.poll(async () => {
      const daemon = (await api("/daemons")).daemons.find((item) => item.computer_id === fixture.computer_id);
      return daemon?.status === "online" && daemon.connected === true
        && daemon.runtimes.some((runtime) => runtime.runtime === "codex" && runtime.status === "available");
    }, { timeout: 45_000 }).toBe(true);
    evidence.worker_ready = { computer_id: fixture.computer_id, bridge_state: "running", daemon_status: "online", codex_status: "available", action: "Settings UI Start worker" };
    check("Settings UI started the restored worker; the same paired computer is connected, online and advertises Codex");
    stage = "register installed planning participants";
    const names = [`Mac planning author ${suffix}`, `Mac planning reviewer ${suffix}`];
    for (const [index, name] of names.entries()) {
      await page.getByRole("link", { name: "Computers", exact: true }).click();
      if (!await page.getByLabel("Agent runtime", { exact: true }).isVisible()) await page.getByText("Register an agent workspace", { exact: true }).click();
      await page.getByLabel("Agent runtime", { exact: true }).selectOption("codex");
      await page.getByLabel("Agent display name", { exact: true }).fill(name);
      await page.getByLabel("Agent workspace path", { exact: true }).fill(planningWorkspace);
      const created = responseTo(`/computers/${fixture.computer_id}/instances`);
      await page.getByRole("button", { name: "Register agent", exact: true }).click();
      fixture[`${index === 0 ? "planner" : "reviewer"}_instance_id`] = (await consume(created)).agent_instance.id;
    }
    assert.notEqual(fixture.planner_instance_id, fixture.reviewer_instance_id);

    stage = "create goal and start discussion through installed UI";
    await page.getByRole("link", { name: "Goals", exact: true }).click();
    await page.getByRole("button", { name: "New goal", exact: true }).click();
    await page.getByLabel("Goal title", { exact: true }).fill(`Installed Mac planning verification ${suffix}`);
    await page.getByLabel("Objective", { exact: true }).fill("Discuss an implementation and its dependent verification; a human reviews the proposal before work is created.");
    await page.getByLabel("Goal acceptance criteria", { exact: true }).fill(`${fixture.task_1_criterion}\n${fixture.task_2_criterion}`);
    const createdGoal = responseTo("/goals");
    await page.getByRole("button", { name: "Create goal", exact: true }).click();
    const { goal } = await consume(createdGoal);
    fixture.goal_id = goal.id; fixture.goal_room_id = goal.room_id; fixture.project_id = goal.project_id;
    assert.ok(fixture.goal_room_id);
    writeFileSync(configurationPath, JSON.stringify(fixture), { mode: 0o600 });
    const planning = page.getByRole("region", { name: "Agent planning", exact: true });
    for (const name of names) await planning.getByRole("checkbox", { name: new RegExp(name) }).check();
    await planning.getByLabel(`${names[0]} discussion role`, { exact: true }).fill("Design and synthesis");
    await planning.getByLabel(`${names[1]} discussion role`, { exact: true }).fill("Review and verification");
    await planning.getByLabel("Discussion rounds", { exact: true }).fill("1");
    await planning.getByLabel("Discussion time limit (minutes)", { exact: true }).fill("5");
    const started = responseTo(`/goals/${goal.id}/discussions`);
    await planning.getByRole("button", { name: "Start planning discussion", exact: true }).click();
    let { discussion } = await consume(started);
    evidence.goal_id = goal.id; evidence.discussion_id = discussion.id;
    stage = "complete three real installed-worker contributions";
    await expect.poll(async () => {
      ({ discussion } = await api(`/discussions/${discussion.id}`));
      assert.ok(!["failed", "cancelled", "stopping"].includes(discussion.status), discussion.error ?? "Planning stopped");
      return discussion.status;
    }, { timeout: 90_000 }).toBe("ready");
    const threadQuery = `thread_root_id=${encodeURIComponent(discussion.thread_root_id)}`;
    const { turns } = await api(`/rooms/${discussion.room_id}/assistant-turns?${threadQuery}`);
    const { messages } = await api(`/rooms/${discussion.room_id}/messages?${threadQuery}`);
    const { message: root } = await api(`/rooms/${discussion.room_id}/messages/${discussion.thread_root_id}`);
    const runs = [], usages = [], receipts = [];
    for (const turn of turns) {
      runs.push((await api(`/runs/${turn.run_id}`)).run);
      usages.push((await api(`/runs/${turn.run_id}/usage`)).usage);
      receipts.push(JSON.parse(readFileSync(planningReceiptPath(fixture, turn.id), "utf8")));
    }
    assert.equal(readdirSync(fixture.context_receipts_directory).length, 3);
    evidence.turns = verifyMacPlanningTurns({ fixture, discussion, turns, root, messages, runs, usages, receipts });
    check("UI-selected instances on the installed computer produced three answers with exact prior-answer context through the bundled worker");
    await expect(planning.getByRole("progressbar", { name: "Planning progress", exact: true })).toHaveAttribute("value", "3", { timeout: 15_000 });
    await expect(planning.getByRole("button", { name: "Create plan proposal", exact: true })).toBeEnabled({ timeout: 15_000 });
    check("The installed planning view shows all three contributions complete and a reviewable proposal before evidence capture");

    stage = "review collapsed coordinator summaries and exact original instructions";
    const thread = planning.getByRole("region", { name: "Thread replies", exact: true });
    const instructions = thread.getByRole("region", { name: "Planning instruction", exact: true });
    const requests = thread.getByRole("region", { name: "Agent requests", exact: true });
    await expect(instructions).toHaveCount(3);
    await expect(requests.getByRole("article")).toHaveCount(3);
    for (const [index, turn] of turns.entries()) {
      const title = `Planning instruction · Step ${index + 1}`;
      const request = requests.getByRole("article", { name: `Agent request ${title}`, exact: true });
      await expect(request.locator("strong")).toHaveText(title);
      const instruction = instructions.filter({ has: page.getByRole("heading", { name: title, exact: true }) });
      await expect(instruction).toBeVisible();
      await expect(instruction).toContainText("You review a proposal before accepting it.");
      assert.equal(await instruction.locator("details").getAttribute("open"), null);
      await expect(instruction.locator("pre")).not.toBeVisible();
      if (index === 0) await capture(instruction, macPlanningImageNames[0], "Installed Mac: coordinator instructions appear as a readable summary by default");
      await instruction.getByText("Show agent instructions", { exact: true }).click();
      await expect(instruction.locator("pre")).toBeVisible();
      const originalInstruction = messages.find((message) => message.id === turn.user_message_id).body;
      assert.equal(await instruction.locator("pre").textContent(), originalInstruction);
      if (index === 0) await capture(instruction, macPlanningImageNames[1], "Installed Mac: expanded coordinator instructions match the exact server message");
      assert.equal(await instruction.locator("pre").textContent(), originalInstruction);
      await instruction.getByText("Show agent instructions", { exact: true }).click();
      await expect(instruction.locator("pre")).not.toBeVisible();
    }
    await capture(requests, macPlanningImageNames[4], "Installed Mac: all three request titles and accessible names use the short planning step instead of repeating internal instructions");
    evidence.instruction_disclosures_verified = 3;
    evidence.request_summaries_verified = 3;
    const synthesis = messages.find((message) => message.id === turns[2].response_message_id);
    assert.equal(synthesis.payload.discussion_plan.discussion_id, discussion.id);
    assert.equal(synthesis.payload.discussion_plan.goal_id, goal.id);
    const card = thread.getByRole("region", { name: "Suggested plan", exact: true });
    await expect(card).toBeVisible();
    for (const text of [fixture.task_1_title, fixture.task_2_title, fixture.task_1_criterion, fixture.task_2_criterion, `Depends on: ${fixture.task_1_title}`]) await expect(card).toContainText(text);
    await expect(card.locator("pre")).not.toBeVisible();
    await card.getByText("Show original reply", { exact: true }).click();
    await expect(card.locator("pre")).toBeVisible(); assert.equal(await card.locator("pre").textContent(), synthesis.body);
    await card.getByText("Show original reply", { exact: true }).click(); await expect(card.locator("pre")).not.toBeVisible();
    const proposedTasks = card.getByRole("list", { name: "Suggested tasks", exact: true }).locator(":scope > li");
    await expect(proposedTasks).toHaveCount(2);
    await expect(proposedTasks.nth(0).getByRole("heading", { name: `1. ${fixture.task_1_title}`, exact: true })).toBeVisible();
    await capture(proposedTasks.nth(0), macPlanningImageNames[2], "Installed Mac: the complete first proposed task, criteria and artifact expectation before acceptance");
    await expect(proposedTasks.nth(1).getByRole("heading", { name: `2. ${fixture.task_2_title}`, exact: true })).toBeVisible();
    await capture(proposedTasks.nth(1), macPlanningImageNames[5], "Installed Mac: the complete second proposed task and its dependency on the first task before acceptance");
    const audit = async () => (await api(`/goals/${goal.id}/audit-bundle`)).bundle;
    const before = await audit(); assert.equal(before.tasks.length, 0); assert.equal(before.plans.length, 0);
    check("Coordinator summaries and every exact original instruction expand and collapse; viewing suggestions creates no plan or tasks");

    stage = "propose and accept the plan through installed UI";
    const proposed = responseTo(`/discussions/${discussion.id}/propose-plan`);
    await planning.getByRole("button", { name: "Create plan proposal", exact: true }).click();
    const { plan } = await consume(proposed);
    const awaiting = await audit(); assert.equal(awaiting.tasks.length, 0); assert.equal(awaiting.plans.length, 1); assert.equal(awaiting.plans[0].status, "proposed");
    const accepted = responseTo(`/plans/${plan.id}/accept`);
    await page.getByRole("button", { name: "Accept plan and create tasks", exact: true }).click(); await consume(accepted);
    const after = await audit(); assert.equal(after.tasks.length, 2); assert.equal(after.plans.length, 1); assert.equal(after.plans[0].status, "accepted");
    const tasks = [fixture.task_1_title, fixture.task_2_title].map((title) => after.tasks.find(({ task }) => task.title === title)?.task);
    assert.ok(tasks.every(Boolean));
    assert.deepEqual(tasks.map((task) => task.acceptance_criteria), [[fixture.task_1_criterion], [fixture.task_2_criterion]]);
    const { dependencies } = await api(`/tasks/${tasks[1].id}/dependencies`);
    assert.deepEqual(dependencies.map((edge) => [edge.from_task_id, edge.to_task_id, edge.type]), [[tasks[0].id, tasks[1].id, "blocks"]]);
    assert.deepEqual(readdirSync(planningWorkspace), ["context_pack.md"], "Planning must not write work files or inherit the earlier patch");
    const plans = page.getByRole("region", { name: "Plans", exact: true });
    await expect(plans).toContainText("accepted"); await expect(plans).toContainText(fixture.task_2_title);
    await capture(plans, macPlanningImageNames[3], "Installed Mac: human acceptance creates two tasks with the reviewed criteria and dependency");
    check("Only UI acceptance materialized two tasks with the original criteria and blocks dependency; planning wrote no work files");
    Object.assign(evidence, { result: "pass", tasks_before_proposal: 0, tasks_before_acceptance: 0, tasks_after_acceptance: 2,
      plan_id: plan.id, task_ids: tasks.map((task) => task.id), instruction_sha256: turns.map((turn) => planningHash(messages.find((message) => message.id === turn.user_message_id).body)) });
    return evidence;
  } catch (error) {
    evidence.failed_stage = stage;
    evidence.error = `Installed deterministic planning failed during: ${stage}`;
    throw new Error(evidence.error, { cause: error });
  }
}
