import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { installedLiveProviderPlan } from "./installed-live-provider-gate.mjs";

// Explicit extension of the installed-package smoke. This consumes five real
// model turns (three for discussion scope) only when ARTOO_DESKTOP_LIVE_CODEX=1.
// The enclosing harness owns
// pairing, installation, server, isolated app data, logout and cleanup.
export async function runInstalledLiveProvider({ page, workspace, userData, baseUrl, ownerCookie, artifactDir, restartApp, server, onScreenshot, platform = process.platform, env = process.env }) {
  const livePlan = installedLiveProviderPlan(platform, artifactDir, env);
  assert.ok(livePlan, "Installed live provider verification requires ARTOO_DESKTOP_LIVE_CODEX=1");
  assert.equal(platform, process.platform, "Live verification must run on the reported platform");
  const { scope, reportPath, platformName } = livePlan;
  const screenshots = [];
  const recordScreenshot = (screenshot) => { screenshots.push(screenshot); onScreenshot?.(screenshot); };
  mkdirSync(artifactDir, { recursive: true });
  for (const path of [livePlan.planScreenshotPath, livePlan.chatScreenshotPath]) rmSync(path, { force: true });
  const report = { result: "fail", checkedAt: new Date().toISOString(), cleanup_complete: false, platform,
    modelExecution: `Real Codex subprocesses through the installed ${platformName} worker and authenticated node WebSocket`,
    ownerAuthentication: "Test-provisioned owner cookie; native device pairing and authorization use production endpoints",
    scope, checks: [], measurements: [], screenshots };
  const save = () => writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  save();
  let stage = "validate local live configuration";
  let failureSnapshot = async () => undefined;
  // Retain discussion states and fixed error categories only. Never include
  // provider text, model output, keys or fill arguments. Tracing is disabled.
  try {
    const binary = env.ARTOO_DESKTOP_LIVE_BINARY;
    const model = env.ARTOO_DESKTOP_LIVE_MODEL;
    const provider = new URL(env.ARTOO_DESKTOP_LIVE_URL);
    const keyFile = env.ARTOO_DESKTOP_LIVE_KEY_FILE;
    assert.ok(binary && isAbsolute(binary) && existsSync(binary));
    assert.ok(model && keyFile && isAbsolute(keyFile));
    assert.ok((provider.protocol === "https:" || (provider.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(provider.hostname)))
      && !provider.username && !provider.password && !provider.search && !provider.hash);
    const apiKey = readFileSync(keyFile, "utf8").trim();
    assert.ok(apiKey.length > 0);
    assert.ok(!model.includes(apiKey), "Model name must not contain the provider credential");
    const [{ contextPacks, eventLog, runs }, { DiscussionPlanPreviewSchema }, { and, desc, eq }, { expect }] = await Promise.all([
      import("@artoo/db"), import("@artoo/domain"), import("drizzle-orm"), import("@playwright/test"),
    ]);
    const diagnostic = (value) => {
      if (value == null) return null;
      const text = String(value);
      // Never copy provider-controlled strings to a failure report. Encoded or
      // transformed credentials need not resemble the original key.
      const category = /unauthori[sz]ed|forbidden|invalid.?api.?key|\b(?:401|403)\b/i.test(text) ? "authentication"
        : /rate.?limit|quota|\b429\b/i.test(text) ? "rate_limit"
        : /timeout|timed out|deadline/i.test(text) ? "timeout"
        : /unavailable|connection|ECONN|ENOTFOUND|\b50[234]\b/i.test(text) ? "unavailable"
        : "other";
      return { present: true, category };
    };
    const providerUrl = provider.toString().replace(/\/$/, "");
    report.requested_model = model;
    report.provider = "Operator-configured Responses API";
    const liveWorkspace = join(workspace, "live-provider");
    mkdirSync(liveWorkspace);
    const check = (value) => { report.checks.push(value); console.log(`[live-installed] PASS ${value}`); save(); };
    const api = async (route) => {
      const response = await fetch(`${baseUrl}/api/v1${route}`, { headers: { Cookie: ownerCookie }, signal: AbortSignal.timeout(15_000) });
      assert.ok(response.ok, `Read failed with HTTP ${response.status}`);
      return response.json();
    };
    const until = async (predicate, timeout = 45_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error("Stage exceeded its deadline");
    };
    const status = () => page.evaluate(() => window.artooDesktop.daemonStatus());
    const responseTo = (path) => page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1${path}` && response.request().method() === "POST");
    const consume = async (pending) => { const response = await pending; assert.ok(response.ok()); return response.json(); };

    const { loadAiDataSharingPolicy } = await import("../../server/dist/config/ai-data-sharing.js");
    const sharingPolicy = loadAiDataSharingPolicy(env);
    assert.ok(sharingPolicy?.mode === "external" && env.ARTOO_LIVE_AI_SHARING_CONSENT === "1",
      "Installed live verification requires actual external AI recipients and explicit ARTOO_LIVE_AI_SHARING_CONSENT=1");
    server.ctx.aiDataSharingPolicy = sharingPolicy;
    stage = "review actual AI recipients through installed UI";
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Review AI data sharing", exact: true }).click();
    for (const provider of sharingPolicy.providers) await expect(page.getByText(provider.name, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Allow AI data sharing", exact: true }).click();
    await expect(page.getByText("You have allowed this team's current disclosure.", { exact: true })).toBeVisible();
    check("Actual configured AI recipients explicitly accepted through the installed client");

    stage = "save real provider settings through installed UI";
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    if ((await status()).state !== "stopped") {
      await page.getByRole("button", { name: "Stop worker", exact: true }).click();
    }
    await until(async () => (await status()).state === "stopped");
    await page.getByLabel("Codex program (optional)", { exact: true }).fill(binary);
    await page.getByLabel("Model connection", { exact: true }).selectOption("responses");
    await page.getByLabel("Model name", { exact: true }).fill(model);
    await page.getByLabel("Model API address", { exact: true }).fill(providerUrl);
    await page.getByLabel("API authentication", { exact: true }).selectOption("api-key");
    await page.getByLabel("Model API key", { exact: true }).fill(apiKey);
    await page.getByRole("button", { name: "Save worker configuration", exact: true }).click();
    await until(async () => { const config = (await status()).config.codex; return config.model === model && config.baseUrl === providerUrl && config.hasKey; });
    await expect(page.getByLabel("Model API key", { exact: true })).toHaveValue("");
    const saved = (await status()).config.codex;
    assert.equal(JSON.stringify(saved).includes(apiKey), false);
    assert.equal(readFileSync(join(userData, "connection.json"), "utf8").includes(apiKey), false);
    page = await restartApp();
    assert.deepEqual((await status()).config.codex, saved);
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Start worker", exact: true }).click();
    await until(async () => (await status()).state === "running");
    const connection = await page.evaluate(() => window.artooDesktop.getConnection());
    await until(async () => (await api(`/computers/${connection.computerId}/runtimes`)).runtimes.some((runtime) => runtime.runtime === "codex" && runtime.status === "available"));
    check("UI-saved provider settings and encrypted key survive app restart; selected Codex becomes available");

    stage = "register two real worker instances";
    const names = ["Installed live planner", "Installed live reviewer"];
    const instances = [];
    for (const name of names) {
      await page.getByRole("link", { name: "Computers", exact: true }).click();
      const summary = page.getByText("Register an agent workspace", { exact: true });
      if (!await page.getByLabel("Agent runtime", { exact: true }).isVisible()) await summary.click();
      await page.getByLabel("Agent runtime", { exact: true }).selectOption("codex");
      await page.getByLabel("Agent display name", { exact: true }).fill(name);
      await page.getByLabel("Agent workspace path", { exact: true }).fill(liveWorkspace);
      const created = responseTo(`/computers/${connection.computerId}/instances`);
      await page.getByRole("button", { name: "Register agent", exact: true }).click();
      instances.push((await consume(created)).agent_instance.id);
    }
    assert.equal(new Set(instances).size, 2);

    const turns = [], answers = [];
    if (scope === "all") {
      stage = "create an installed-client conversation";
      await page.getByRole("link", { name: "Workspace", exact: true }).click();
      await page.getByRole("button", { name: "New task", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Create task" });
      await dialog.getByLabel("Title", { exact: true }).fill(`Installed ${platformName} provider conversation verification`);
      await dialog.getByLabel("Description", { exact: true }).fill("Read only the supplied context and answer the request. Do not modify files or access the network.");
      await dialog.getByLabel("Acceptance criteria (one per line)").fill("The follow-up uses the actual prior answer.");
      const taskCreated = responseTo("/tasks");
      await dialog.getByRole("button", { name: "Create task", exact: true }).click();
      const task = await consume(taskCreated);
      const roomId = task.room.id;
      const conversation = page.getByRole("region", { name: "Task conversation", exact: true });
      await conversation.getByLabel("Message destination", { exact: true }).selectOption("assistant");
      await conversation.getByLabel("Execution agent", { exact: true }).selectOption(instances[0]);
      const marker = `INSTALLED_${randomUUID().replaceAll("-", "")}`;
      for (const body of [
        `Reply with exactly this verification marker: ${marker}. Do not change files or access the network.`,
        "Repeat the verification marker from your previous answer, followed by FOLLOWUP. Use the supplied conversation history. Do not change files or access the network.",
      ]) {
        stage = `real installed conversation turn ${turns.length + 1}`;
        await conversation.getByLabel("Message", { exact: true }).fill(body);
        const submitted = responseTo(`/rooms/${roomId}/assistant-turns`);
        await conversation.getByRole("button", { name: "Send to agent", exact: true }).click();
        const turnId = (await consume(submitted)).turn.id;
        let turn;
        await until(async () => {
          turn = (await api(`/rooms/${roomId}/assistant-turns`)).turns.find((item) => item.id === turnId);
          assert.ok(turn && !["failed", "cancelled"].includes(turn.status));
          assert.ok(!(turn.status === "waiting" && turn.error));
          return turn.status === "completed";
        }, 120_000);
        assert.ok(turn.response_message_id);
        turns.push(turn);
        console.log(`[live-installed] Conversation turn ${turns.length}/2 completed`);
      }
      const history = (await api(`/rooms/${roomId}/messages`)).messages;
      answers.push(...turns.map((turn) => history.find((item) => item.id === turn.response_message_id)));
      assert.equal(history.filter((item) => item.actor_type === "agent" && item.kind === "text").length, 2);
      assert.ok(answers[0].body.includes(marker) && answers[1].body.includes(marker) && answers[1].body.includes("FOLLOWUP"));
      await expect(conversation.locator(".msg__text").filter({ hasText: "FOLLOWUP" }).last()).toBeVisible();
      await conversation.screenshot({ path: livePlan.chatScreenshotPath, timeout: 30_000 });
      recordScreenshot({ path: livePlan.chatScreenshotPath, caption: `${platformName} installed worker: two real provider answers with prior-answer context` });
    }

    const sessions = new Set();
    const inspect = async (turn, previous, discussion = false) => {
      const [run] = await server.ctx.db.db.select().from(runs).where(eq(runs.id, turn.run_id));
      assert.equal(run.computerId, connection.computerId);
      assert.equal(run.runtimeId, "codex");
      assert.equal(run.status, "completed");
      const [row] = await server.ctx.db.db.select().from(contextPacks).where(eq(contextPacks.id, run.contextPackId));
      for (const answer of previous) assert.ok(row.payload.conversation.messages.some((message) => message.id === answer.id && message.body === answer.body));
      if (discussion) {
        assert.equal(row.payload.policy.execution_mode, "discussion");
        assert.deepEqual(row.payload.policy.filesystem_write_scope, []);
      }
      const { usage } = await api(`/runs/${turn.run_id}/usage`);
      assert.ok(usage.input_tokens > 0 && usage.output_tokens > 0 && usage.provider_session_id);
      sessions.add(usage.provider_session_id);
      report.measurements.push({ run_id: turn.run_id, agent_instance_id: run.agentInstanceId,
        input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
        cached_input_tokens: usage.cached_input_tokens, cost_usd: usage.cost_usd, currency: usage.currency });
    };
    if (scope === "all") {
      await inspect(turns[0], []); await inspect(turns[1], [answers[0]]);
      check("Two real installed-worker answers persist exactly once; follow-up receives and repeats the prior answer");
    }

    stage = "start bounded planning discussion through installed UI";
    await page.getByRole("link", { name: "Goals", exact: true }).click();
    await page.getByRole("button", { name: "New goal", exact: true }).click();
    const titles = ["Specify chat response contract", "Verify chat response contract"];
    const criteria = ["Success and error response schemas are documented.", "Tests cover success and error responses against the documented schema."];
    await page.getByLabel("Goal title", { exact: true }).fill(`Installed ${platformName} provider planning verification`);
    await page.getByLabel("Objective", { exact: true }).fill("Discuss a plan only; do not implement it. Produce exactly two tasks in this order. " +
      `Task 0 title must be exactly '${titles[0]}', with exactly one acceptance criterion '${criteria[0]}'. ` +
      `Task 1 title must be exactly '${titles[1]}', with exactly one acceptance criterion '${criteria[1]}'. ` +
      "Task 1 must depend on task 0 using ref '0' and type 'blocks'. Task 0 has no dependencies. " +
      "Keep required_capabilities, approval_gates, write_scopes and expected_artifacts empty. " +
      "The reviewer must quote the code invented in the planner's first answer, and the final JSON rationale must retain that same code.");
    await page.getByLabel("Goal acceptance criteria", { exact: true }).fill("The plan preserves criteria and dependency until human acceptance.");
    const goalCreated = responseTo("/goals");
    await page.getByRole("button", { name: "Create goal", exact: true }).click();
    const { goal } = await consume(goalCreated);
    const planning = page.getByRole("region", { name: "Agent planning", exact: true });
    for (const name of names) await planning.getByRole("checkbox", { name: new RegExp(name) }).check();
    await planning.getByLabel(`${names[0]} discussion role`, { exact: true }).fill("Design and synthesis. Initially invent one code matching REVIEW_ plus 6 uppercase letters/digits. In synthesis reuse that original code.");
    await planning.getByLabel(`${names[1]} discussion role`, { exact: true }).fill("Review. Quote the exact REVIEW_ code in the first agent's answer and assess task order, dependency and acceptance criteria.");
    await planning.getByLabel("Discussion rounds", { exact: true }).fill("1");
    await planning.getByLabel("Discussion time limit (minutes)", { exact: true }).fill("5");
    const started = responseTo(`/goals/${goal.id}/discussions`);
    await planning.getByRole("button", { name: "Start planning discussion", exact: true }).click();
    let { discussion } = await consume(started);
    stage = "complete bounded planning discussion through installed worker";
    failureSnapshot = async () => {
      const latest = (await api(`/discussions/${discussion.id}`)).discussion;
      const pending = (await api(`/rooms/${discussion.room_id}/assistant-turns?thread_root_id=${encodeURIComponent(discussion.thread_root_id)}`)).turns;
      const states = [];
      for (const turn of pending) {
        const run = turn.run_id ? (await server.ctx.db.db.select().from(runs).where(eq(runs.id, turn.run_id)))[0] : undefined;
        const errors = turn.run_id ? await server.ctx.db.db.select().from(eventLog).where(and(eq(eventLog.runId, turn.run_id), eq(eventLog.type, "run.output"))).orderBy(desc(eventLog.position)).limit(40) : [];
        states.push({ status: turn.status, error: diagnostic(turn.error), run_status: run?.status,
          failure_reason: diagnostic(run?.failureReason),
          stderr: errors.filter((event) => event.payload.stream === "stderr").slice(0, 5).map((event) => diagnostic(event.payload.text)) });
      }
      return { status: latest.status, current_step: latest.current_step, error: diagnostic(latest.error), turns: states };
    };
    let lastStep = -1;
    await until(async () => {
      ({ discussion } = await api(`/discussions/${discussion.id}`));
      assert.ok(!["failed", "cancelled", "stopping"].includes(discussion.status));
      if (lastStep !== discussion.current_step) {
        lastStep = discussion.current_step;
        console.log(`[live-installed] Discussion ${lastStep}/3 contributions completed`);
      }
      return discussion.status === "ready";
    }, 240_000);
    assert.equal(discussion.current_step, 3);
    const thread = `thread_root_id=${encodeURIComponent(discussion.thread_root_id)}`;
    const discussionTurns = (await api(`/rooms/${discussion.room_id}/assistant-turns?${thread}`)).turns;
    const discussionMessages = (await api(`/rooms/${discussion.room_id}/messages?${thread}`)).messages;
    assert.equal(discussionTurns.length, 3);
    assert.equal(discussionMessages.filter((message) => message.actor_type === "agent" && message.kind === "text").length, 3);
    const replies = discussionTurns.map((turn) => discussionMessages.find((message) => message.id === turn.response_message_id));
    for (const [index, turn] of discussionTurns.entries()) {
      assert.equal(replies[index].actor_id, instances[index === 1 ? 1 : 0]);
      await inspect(turn, replies.slice(0, index), true);
    }
    const code = replies[0].body.match(/\bREVIEW_[A-Z0-9]{6}\b/)?.[0];
    assert.ok(code && replies[1].body.includes(code));
    const preview = DiscussionPlanPreviewSchema.parse(replies[2].payload.discussion_plan);
    assert.ok(preview.rationale.includes(code));
    assert.deepEqual(preview.task_specs.map((spec) => spec.title), titles);
    assert.deepEqual(preview.task_specs.map((spec) => spec.acceptance_criteria), criteria.map((value) => [value]));
    assert.deepEqual(preview.task_specs[0].dependencies, []);
    assert.deepEqual(preview.task_specs[1].dependencies, [{ ref: "0", type: "blocks" }]);
    const card = planning.getByRole("region", { name: "Suggested plan", exact: true });
    await expect(card).toBeVisible();
    await expect(card).toContainText(`Depends on: ${titles[0]}`);
    await expect(card.locator("pre")).not.toBeVisible();
    await card.getByText("Show original reply", { exact: true }).click();
    assert.equal(await card.locator("pre").textContent(), replies[2].body);
    await card.getByText("Show original reply", { exact: true }).click();
    report.screenshot = livePlan.planScreenshotPath;
    await card.screenshot({ path: report.screenshot, timeout: 30_000 });
    recordScreenshot({ path: report.screenshot, caption: `${platformName} installed worker: real provider discussion and validated plan before human acceptance` });
    const audit = async () => (await api(`/goals/${goal.id}/audit-bundle`)).bundle;
    const before = await audit();
    assert.equal(before.tasks.length, 0); assert.equal(before.plans.length, 0);
    check("Two real instances discuss and synthesize with prior answers; installed UI renders the validated plan without creating tasks");

    stage = "review and accept the real plan through installed UI";
    const proposed = responseTo(`/discussions/${discussion.id}/propose-plan`);
    await planning.getByRole("button", { name: "Create plan proposal", exact: true }).click();
    const { plan } = await consume(proposed);
    assert.equal((await audit()).tasks.length, 0);
    const accepted = responseTo(`/plans/${plan.id}/accept`);
    await page.getByRole("button", { name: "Accept plan and create tasks", exact: true }).click();
    await consume(accepted);
    const after = await audit();
    assert.equal(after.tasks.length, 2); assert.equal(after.plans[0].status, "accepted");
    const materialized = titles.map((title) => after.tasks.find(({ task }) => task.title === title).task);
    assert.deepEqual(materialized.map((task) => task.acceptance_criteria), criteria.map((value) => [value]));
    const edges = (await api(`/tasks/${materialized[1].id}/dependencies`)).dependencies;
    assert.deepEqual(edges.map((edge) => ({ from: edge.from_task_id, to: edge.to_task_id, type: edge.type })),
      [{ from: materialized[0].id, to: materialized[1].id, type: "blocks" }]);
    assert.deepEqual(readdirSync(liveWorkspace).filter((name) => name !== "context_pack.md"), []);
    const expectedTurns = livePlan.expectedTurns;
    assert.equal(sessions.size, expectedTurns);
    assert.equal(report.measurements.length, expectedTurns);
    assert.equal(JSON.stringify(report).includes(apiKey), false);
    check(`Human acceptance creates two tasks with the original criteria and dependency; ${expectedTurns} sessions report usage and write no work files`);
    report.result = "pass";
    report.provider_turns = expectedTurns; report.provider_session_count = sessions.size;
    report.tasks_before_proposal = 0; report.tasks_before_acceptance = 0; report.tasks_after_acceptance = 2;
    report.answer_sha256 = [...answers, ...replies].map((answer) => createHash("sha256").update(answer.body).digest("hex"));
    save();
    return { page, reportPath, screenshots };
  } catch (error) {
    report.error_class = ["Error", "AssertionError", "TypeError", "TimeoutError"].includes(error?.name) ? error.name : "Error";
    report.failure_location = [...String(error?.stack ?? "").matchAll(/installed-live-provider\.mjs:(\d+):(\d+)/g)]
      .map(([, line, column]) => ({ line: Number(line), column: Number(column) }));
    try { report.failure_state = await failureSnapshot(); } catch { report.failure_state = "Failure state could not be retrieved"; }
    report.error = `Installed real-provider verification failed during: ${stage}. Provider text and input values are omitted; discussion states and fixed error categories are retained when available.`;
    save();
    throw new Error(report.error);
  }
}
