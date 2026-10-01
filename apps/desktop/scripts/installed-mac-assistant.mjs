import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assistantHash, assistantStartupReceiptPath, assistantFailureReceiptPath } from "../../../scripts/fixtures/assistant-conversation.mjs";

export const macAssistantImageNames = ["macos-assistant-waiting.png", "macos-assistant-failed.png", "macos-assistant-first-answer.png", "macos-assistant-followup.png", "macos-assistant-cancelled.png"];

function processIsLive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error?.code === "ESRCH") return false; throw error; }
}

/** Read only this fixture's private startup files and probe their positive PIDs
 * with signal 0. This never stops a process or changes a server record. */
export function readMacAssistantObservations(fixture, { probe = processIsLive } = {}) {
  const receipts = [], failedOnceReceipts = [];
  for (const filename of readdirSync(fixture.receipts_directory).sort()) {
    if (/^\.assistant-receipt-[a-f0-9]{32}\.tmp$/.test(filename)) continue;
    assert.match(filename, /^(run-[a-f0-9]{64}|turn-[a-f0-9]{64}-failed-once)\.json$/, "Unexpected file in assistant receipts");
    const path = join(fixture.receipts_directory, filename), record = JSON.parse(readFileSync(path, "utf8"));
    if (filename.startsWith("run-")) {
      assert.equal(path, assistantStartupReceiptPath(fixture.receipts_directory, record.run_id));
      assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0, "Only a recorded positive child PID may be observed");
      receipts.push(record);
    } else {
      assert.equal(path, assistantFailureReceiptPath(fixture.receipts_directory, record.turn_id));
      failedOnceReceipts.push(record);
    }
  }
  return { receipts, failedOnceReceipts, livePids: [...new Set(receipts.map((receipt) => receipt.pid))].filter(probe) };
}

/** After the app/worker close attempt, independently observe only startup PIDs
 * recorded in this attempt's private receipts. Never terminate, discover or scan
 * other processes; an absent receipt cannot establish coverage of a process. */
export async function observeMacAssistantCleanup(fixture, { probe = processIsLive, timeoutMs = 10_000,
  now = () => performance.now(), pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 10_000);
  const started = now();
  const result = { scope: "Recorded assistant startup PIDs only; no process-tree scan or termination", closed: false,
    receipt_count: 0, observed_pids: [], live_pids: null, observed_ms: 0, samples: 0 };
  try {
    // Snapshot known ownership before probing. Keep these IDs even if files
    // disappear later; the enclosing harness removes the directory only after
    // this observer returns. No process has been probed by this initial read.
    const { receipts } = readMacAssistantObservations(fixture, { probe: () => false });
    result.receipt_count = receipts.length;
    result.observed_pids = [...new Set(receipts.map(({ pid }) => pid))];
    do {
      result.samples += 1;
      try {
        result.live_pids = result.observed_pids.filter(probe);
        delete result.error;
        if (result.live_pids.length === 0) { result.closed = true; break; }
      } catch (error) {
        // EPERM can briefly occur while macOS reaps a child. Uncertainty is
        // retried within the same bound, never treated as proof of exit.
        result.live_pids = null;
        result.error = { code: /^[A-Z0-9_]+$/.test(error?.code ?? "") ? error.code : "UNCONFIRMED", message: "Could not confirm a recorded assistant PID exited" };
      }
      if (now() - started >= timeoutMs) break;
      await pause(Math.min(100, timeoutMs - (now() - started)));
    } while (true);
  } catch {
    result.error = { code: "INVALID_RECEIPTS", message: "Could not validate this attempt's assistant startup receipts" };
  }
  result.observed_ms = now() - started;
  return result;
}

export async function observeStableMacAssistantState(read, { minimumMs = 3100, now = () => performance.now(), pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  assert.ok(Number.isFinite(minimumMs) && minimumMs >= 3100 && minimumMs <= 60_000);
  const started = now(); let samples = 0;
  do {
    await read(); samples += 1;
    if (now() - started >= minimumMs && samples >= 2) break;
    await pause(250);
  } while (true);
  return { minimum_ms: minimumMs, observed_ms: now() - started, samples };
}

export async function captureMacAssistantScreenshot(locator, { artifactDir, filename, caption, evidence, onScreenshot }) {
  assert.ok(macAssistantImageNames.includes(filename));
  const path = join(artifactDir, filename);
  await locator.screenshot({ path, timeout: 30_000 });
  assert.ok(existsSync(path));
  const image = { path, caption };
  evidence.screenshots.push(image); onScreenshot(image);
}

// The installed renderer owns every tested mutation. APIs below are GET-only;
// the enclosing smoke owns app/server lifecycle and final failure cleanup.
export async function runInstalledMacAssistant({ page, workspace, configurationPath, baseUrl, ownerCookie, artifactDir, onEvidence, onScreenshot, onCleanupObserver = () => {} }) {
  assert.equal(process.platform, "darwin", "Installed direct-assistant verification is Mac-specific");
  const { expect } = await import("@playwright/test");
  const { verifyAssistantConversationResults } = await import("../../../scripts/fixtures/assistant-conversation-results.mjs");
  const evidence = { result: "fail", scope: "Installed Mac UI and bundled worker; deterministic direct assistant, no model provider",
    usage_measurements: "Synthetic fixture counters verify ingestion; no provider usage or billing was measured", checks: [], screenshots: [], observations: {} };
  onEvidence(evidence);
  const check = (name) => { evidence.checks.push(name); console.log(`[mac-assistant] PASS ${name}`); };
  const capture = (locator, index, caption) => captureMacAssistantScreenshot(locator, { artifactDir, filename: macAssistantImageNames[index], caption, evidence, onScreenshot });
  const api = async (route) => {
    const response = await fetch(`${baseUrl}/api/v1${route}`, { headers: { Cookie: ownerCookie }, signal: AbortSignal.timeout(15_000) });
    assert.ok(response.ok, `Assistant read failed with HTTP ${response.status}`); return response.json();
  };
  const responseTo = (route) => page.waitForResponse((response) => new URL(response.url()).pathname === `/api/v1${route}` && response.request().method() === "POST");
  const consume = async (pending) => { const response = await pending; assert.ok(response.ok(), `Assistant UI command failed with HTTP ${response.status()}`); return response.json(); };
  const suffix = randomUUID().slice(0, 8), channelName = `mac-assistant-${suffix}`, agentName = `Mac direct assistant ${suffix}`;
  const fixture = { runtime_id: "codex", thread_root_id: null,
    workspace_root: join(workspace, "assistant-conversation"), receipts_directory: join(dirname(configurationPath), "mac-assistant-receipts"),
    requests: { first: `Create the first direct answer ${suffix}`, second: `Use the actual previous answer ${suffix}`, hold: `Keep this request running until I cancel ${suffix}` } };
  const contextHashes = [];
  const contextSnapshot = (runId) => {
    assert.ok(!contextHashes.some((entry) => entry.run_id === runId));
    const bytes = readFileSync(join(fixture.workspace_root, "context_pack.md"));
    const runIds = [...bytes.toString("utf8").split("\n\n", 1)[0].matchAll(/^run: (.+)$/gm)].map((match) => match[1]);
    assert.deepEqual(runIds, [runId], "Archive the actual run context before the next subprocess can replace it");
    contextHashes.push({ run_id: runId, sha256: assistantHash(bytes) });
  };
  let stage = "prepare an installed worker and dedicated conversation workspace";
  try {
    for (const filename of macAssistantImageNames) rmSync(join(artifactDir, filename), { force: true });
    mkdirSync(fixture.workspace_root); mkdirSync(fixture.receipts_directory, { mode: 0o700 });
    fixture.workspace_root = realpathSync(fixture.workspace_root); fixture.receipts_directory = realpathSync(fixture.receipts_directory);
    onCleanupObserver(() => observeMacAssistantCleanup(fixture));
    const connection = await page.evaluate(() => window.artooDesktop.getConnection());
    fixture.computer_id = connection.computerId; assert.ok(fixture.computer_id);
    const worker = async (start) => {
      await page.getByRole("link", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: start ? "Start worker" : "Stop worker", exact: true }).click();
      await expect.poll(async () => (await page.evaluate(() => window.artooDesktop.daemonStatus())).state,
        { timeout: 45_000 }).toBe(start ? "running" : "stopped");
      await expect.poll(async () => {
        const daemon = (await api("/daemons")).daemons.find((item) => item.computer_id === fixture.computer_id);
        return start ? daemon?.status === "online" && daemon.connected === true
          && daemon.runtimes.some((runtime) => runtime.runtime === "codex" && runtime.status === "available")
          : daemon?.status === "offline" && daemon.connected === false;
      }, { timeout: 65_000 }).toBe(true);
    };
    await worker(true);
    await page.getByRole("link", { name: "Computers", exact: true }).click();
    if (!await page.getByLabel("Agent runtime", { exact: true }).isVisible()) await page.getByText("Register an agent workspace", { exact: true }).click();
    await page.getByLabel("Agent runtime", { exact: true }).selectOption("codex");
    await page.getByLabel("Agent display name", { exact: true }).fill(agentName);
    await page.getByLabel("Agent workspace path", { exact: true }).fill(fixture.workspace_root);
    const registered = responseTo(`/computers/${fixture.computer_id}/instances`);
    await page.getByRole("button", { name: "Register agent", exact: true }).click();
    const { agent_instance: instance } = await consume(registered);
    assert.equal(instance.computer_id, fixture.computer_id); assert.equal(instance.runtime, "codex"); assert.equal(instance.workspace_root, fixture.workspace_root);
    fixture.agent_instance_id = instance.id;

    await page.getByRole("link", { name: "Channels", exact: true }).click();
    await page.getByRole("button", { name: "New channel", exact: true }).click();
    await page.getByLabel("Channel name", { exact: true }).fill(channelName);
    await page.getByLabel("Channel description", { exact: true }).fill("Installed-client direct assistant verification using a deterministic subprocess fixture");
    const created = responseTo("/channels");
    await page.getByRole("button", { name: "Create channel", exact: true }).click();
    const { channel } = await consume(created);
    fixture.room_id = channel.id; fixture.project_id = channel.project_id; fixture.user_id = (await api("/bootstrap")).user.id;
    assert.ok(fixture.room_id && fixture.project_id && fixture.user_id);
    assert.deepEqual((await api(`/rooms/${fixture.room_id}/messages`)).messages, [], "The UI-created channel must have no seeded conversation");
    writeFileSync(configurationPath, JSON.stringify(fixture), { mode: 0o600 });
    Object.assign(evidence, { room_id: fixture.room_id, computer_id: fixture.computer_id, agent_instance_id: fixture.agent_instance_id });
    const openChannel = async () => {
      await page.getByRole("link", { name: "Channels", exact: true }).click();
      await page.getByRole("navigation", { name: "Channel list", exact: true }).getByRole("button", { name: `# ${channelName}`, exact: true }).click();
      await expect(page.getByRole("heading", { name: `# ${channelName}`, exact: true })).toBeVisible();
    };
    const conversation = page.getByRole("region", { name: "Channel conversation", exact: true });
    const requestCard = (body) => conversation.getByRole("region", { name: "Agent requests", exact: true })
      .getByRole("article", { name: `Agent request ${body}`, exact: true });
    const captureAnswer = async (answer, index, caption) => {
      const row = conversation.getByRole("list", { name: "Messages", exact: true })
        .getByRole("article", { name: "text message", exact: true }).filter({ has: page.getByText(answer.body, { exact: true }) });
      await expect(row).toHaveCount(1);
      await row.scrollIntoViewIfNeeded();
      await expect(row).toBeVisible();
      await expect(row).toBeInViewport({ ratio: 1 });
      await capture(row, index, caption);
    };
    const send = async (body) => {
      await conversation.getByLabel("Message destination", { exact: true }).selectOption("assistant");
      await conversation.getByLabel("Execution agent", { exact: true }).selectOption(fixture.agent_instance_id);
      await expect(conversation.getByLabel("Execution agent", { exact: true })).toHaveValue(fixture.agent_instance_id);
      await conversation.getByLabel("Message", { exact: true }).fill(body);
      const submitted = responseTo(`/rooms/${fixture.room_id}/assistant-turns`);
      await conversation.getByRole("button", { name: "Send to agent", exact: true }).click();
      const result = await consume(submitted);
      assert.equal(result.message.body, body); assert.equal(result.message.actor_id, fixture.user_id); assert.equal(result.message.actor_type, "user");
      assert.equal(result.turn.user_message_id, result.message.id);
      return result.turn;
    };
    const turnsNow = async () => (await api(`/rooms/${fixture.room_id}/assistant-turns`)).turns;
    const waitTurn = async (id, status) => {
      let turn;
      await expect.poll(async () => { turn = (await turnsNow()).find((item) => item.id === id); return turn?.status; }, { timeout: 60_000 }).toBe(status);
      return turn;
    };
    const taskNow = (id) => api(`/tasks/${id}`);
    const requireStableTurn = (turn, expected) => {
      assert.ok(turn); assert.equal(turn.id, expected.id); assert.equal(turn.status, expected.status); assert.equal(turn.run_id, expected.run_id);
      assert.equal(turn.user_message_id, expected.user_message_id); assert.equal(turn.task_id, expected.task_id);
    };

    stage = "send while the actual worker is offline and observe automatic recovery";
    await worker(false); await openChannel();
    const first = await send(fixture.requests.first), waiting = await waitTurn(first.id, "waiting");
    assert.equal(waiting.run_id, null); assert.equal(waiting.user_message_id, first.user_message_id);
    assert.equal((await taskNow(waiting.task_id)).runs.length, 0); assert.equal(readMacAssistantObservations(fixture).receipts.length, 0);
    await expect(requestCard(fixture.requests.first).getByText("waiting", { exact: true })).toBeVisible();
    evidence.observations.waiting = { turn_id: first.id, user_message_id: first.user_message_id, run_id: null, run_count: 0, receipt_count: 0 };
    await capture(requestCard(fixture.requests.first), 0, "Installed Mac: the selected agent request waits without a run while its actual worker is offline");
    await worker(true); await openChannel();
    const firstCompleted = await waitTurn(first.id, "completed");
    assert.equal(firstCompleted.user_message_id, first.user_message_id); contextSnapshot(firstCompleted.run_id);
    const firstMessages = (await api(`/rooms/${fixture.room_id}/messages`)).messages;
    const firstAnswer = firstMessages.find((message) => message.id === firstCompleted.response_message_id); assert.ok(firstAnswer);
    await expect(conversation.getByRole("list", { name: "Messages", exact: true }).getByText(firstAnswer.body, { exact: true })).toBeVisible();
    assert.equal((await taskNow(first.task_id)).runs.length, 1); assert.equal(readMacAssistantObservations(fixture).receipts.length, 1);
    evidence.observations.automatic_recovery = { turn_id: first.id, run_id: firstCompleted.run_id, retry_clicked: false };
    await captureAnswer(firstAnswer, 2, "Installed Mac: the first persisted agent answer is fully visible after automatic worker recovery");
    check("A UI-authored request waited with no run, then completed once after Settings restarted its exact worker without Retry");

    stage = "retain the genuine failed subprocess before retrying that same turn";
    const second = await send(fixture.requests.second), failed = await waitTurn(second.id, "failed");
    assert.equal(second.task_id, first.task_id); assert.equal(failed.user_message_id, second.user_message_id); contextSnapshot(failed.run_id);
    await expect(requestCard(fixture.requests.second).getByText("failed", { exact: true })).toBeVisible();
    const failureWindow = await observeStableMacAssistantState(async () => {
      requireStableTurn((await turnsNow()).find((turn) => turn.id === failed.id), failed);
      assert.equal((await taskNow(failed.task_id)).runs.length, 2); assert.equal(readMacAssistantObservations(fixture).receipts.length, 2);
    });
    evidence.observations.failed_before_retry = { ...failureWindow, turn_id: failed.id, run_id: failed.run_id, user_message_id: failed.user_message_id, run_count: 2 };
    await capture(requestCard(fixture.requests.second), 1, "Installed Mac: the real first follow-up process failed and remains failed until explicit Retry");
    const retried = responseTo(`/assistant-turns/${second.id}/retry`);
    await requestCard(fixture.requests.second).getByRole("button", { name: "Retry agent request", exact: true }).click();
    const retryResponse = (await consume(retried)).turn;
    assert.equal(retryResponse.id, second.id); assert.equal(retryResponse.user_message_id, second.user_message_id);
    const secondCompleted = await waitTurn(second.id, "completed");
    assert.equal(secondCompleted.user_message_id, second.user_message_id); assert.notEqual(secondCompleted.run_id, failed.run_id); contextSnapshot(secondCompleted.run_id);
    const answers = (await api(`/rooms/${fixture.room_id}/messages`)).messages.filter((message) => message.actor_type === "agent" && message.kind === "text");
    assert.equal(answers.length, 2);
    const secondAnswer = answers.find((message) => message.id === secondCompleted.response_message_id); assert.ok(secondAnswer);
    assert.equal(secondAnswer.body, `Follow-up used the actual earlier answer: ${firstAnswer.body}`);
    for (const answer of answers) await expect(conversation.getByRole("list", { name: "Messages", exact: true }).getByText(answer.body, { exact: true })).toBeVisible();
    await captureAnswer(secondAnswer, 3, "Installed Mac: the complete retried follow-up answer visibly repeats the actual first answer");
    check("The failed turn stayed unchanged across dispatcher periods; UI Retry kept its request identity and a new process used the actual prior answer");

    stage = "cancel the held running subprocess through its own UI control";
    const third = await send(fixture.requests.hold), running = await waitTurn(third.id, "running");
    assert.equal(third.task_id, first.task_id);
    let held;
    await expect.poll(() => {
      let observation;
      try { observation = readMacAssistantObservations(fixture); } catch (error) { if (error instanceof SyntaxError) return false; throw error; }
      held = observation.receipts.find((receipt) => receipt.run_id === running.run_id);
      return !!held && observation.livePids.includes(held.pid);
    }, { timeout: 30_000 }).toBe(true);
    contextSnapshot(running.run_id);
    assert.equal(held.behavior, "hold_until_cancel");
    await expect(requestCard(fixture.requests.hold).getByText("running", { exact: true })).toBeVisible();
    evidence.observations.hold_started = { turn_id: third.id, run_id: running.run_id, pid: held.pid, observed_live: true };
    const cancelledResponse = responseTo(`/assistant-turns/${third.id}/cancel`);
    await requestCard(fixture.requests.hold).getByRole("button", { name: "Cancel agent request", exact: true }).click();
    assert.equal((await consume(cancelledResponse)).turn.id, third.id);
    const cancelled = await waitTurn(third.id, "cancelled");
    assert.equal(cancelled.run_id, running.run_id); assert.equal(cancelled.user_message_id, third.user_message_id);
    await expect.poll(() => readMacAssistantObservations(fixture).livePids, { timeout: 30_000 }).toEqual([]);
    const cancelWindow = await observeStableMacAssistantState(async () => {
      requireStableTurn((await turnsNow()).find((turn) => turn.id === third.id), cancelled);
      assert.equal((await taskNow(third.task_id)).runs.length, 4);
      const observation = readMacAssistantObservations(fixture); assert.equal(observation.receipts.length, 4); assert.deepEqual(observation.livePids, []);
      assert.equal((await api(`/rooms/${fixture.room_id}/messages`)).messages.filter((message) => message.actor_type === "agent" && message.kind === "text").length, 2);
    });
    evidence.observations.cancelled_without_redispatch = { ...cancelWindow, turn_id: third.id, run_id: running.run_id, pid: held.pid, live_pids: [], run_count: 4, answer_count: 2 };
    await expect(requestCard(fixture.requests.hold).getByText("cancelled", { exact: true })).toBeVisible();
    await capture(requestCard(fixture.requests.hold), 4, "Installed Mac: cancelling this running request stopped its real process without a third answer or another run");

    stage = "verify actual server records and independently archived context hashes";
    const turns = await turnsNow(), messages = (await api(`/rooms/${fixture.room_id}/messages`)).messages, { runs } = await taskNow(first.task_id);
    const usages = [];
    for (const run of runs) usages.push({ run_id: run.id, usage: (await api(`/runs/${run.id}/usage`)).usage });
    const observation = readMacAssistantObservations(fixture);
    evidence.verification = verifyAssistantConversationResults({ fixture, turns, messages, runs, usages, contextHashes, ...observation });
    assert.deepEqual(readdirSync(fixture.workspace_root), ["context_pack.md"], "Direct conversation must not inherit or create the artifact/planning workspace's work files");
    check("Read-only records bind three turns, four terminated subprocesses and two answers to the exact selected instance, computer and observed context");
    evidence.result = "pass";
    return evidence;
  } catch (error) {
    evidence.failed_stage = stage; evidence.error = `Installed direct-assistant verification failed during: ${stage}`;
    throw new Error(evidence.error, { cause: error });
  }
}
