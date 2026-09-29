import assert from "node:assert/strict";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** Test-only infrastructure, never registered on the production Fastify app.
 * Node presence comes from authenticated WS hello/heartbeat/disconnect; all
 * resources, discussions, plans and acceptance go through production APIs. */
export async function createWorkflowFixture({ root, temporary, origin, projectId, peerToken, suffix, request, until }) {
  const { createAdapterRegistry, createArtoodNode, createProcessAdapter } = await import(pathToFileURL(join(root, "apps/artood/dist/index.js")).href);
  const fields = {
    project_id: projectId,
    computer_name: `Native fixture computer ${suffix}`,
    planner_name: `Native planner ${suffix}`, reviewer_name: `Native reviewer ${suffix}`,
    goal_title: `Native reviewed objective ${suffix}`,
    task_1_title: `Implement shared contract ${suffix}`, task_2_title: `Verify shared contract ${suffix}`,
    task_1_criterion: "Authenticated clients receive the documented response",
    task_2_criterion: "Contract and failure cases pass after implementation",
  };
  const platform = process.platform === "win32" ? "windows" : "macos";
  const code = await request("/api/v1/devices/pairings", { intended_platform: platform }, peerToken);
  const claimed = await request("/api/v1/devices/claim", { code: code.code, platform, app_version: "native-ui-node-fixture", display_name: fields.computer_name });
  const enrolled = await request(`/api/v1/devices/${claimed.device.id}/enroll`, { display_name: fields.computer_name, hostname: "isolated-ui-fixture", os: platform, arch: process.arch }, peerToken);
  fields.computer_id = enrolled.computer_id;
  const configurationPath = join(temporary, "discussion-process.json");
  const workspaces = Object.fromEntries(["planner", "reviewer"].map((role) => [role, join(temporary, role)]));
  for (const directory of Object.values(workspaces)) mkdirSync(directory);
  const registry = createAdapterRegistry(["planner", "reviewer"].map((role) => {
    const runtime = `ui-${role}`;
    const command = [process.execPath, join(root, "scripts/fixtures/ios-ui-discussion.mjs"), "{{context_pack_path}}", configurationPath, role];
    return { runtime, capabilities: ["code.read"], adapter: createProcessAdapter({ runtimeId: runtime,
      command, discussionCommand: command, allowedRoots: [workspaces[role]], outputFormat: "codex-json" }) };
  }));
  const socketURL = new URL("/api/v1/node", origin);
  socketURL.protocol = "ws:"; socketURL.searchParams.set("token", claimed.node_token);
  const node = createArtoodNode({ url: socketURL.href, registry, heartbeatIntervalMs: 500, acknowledgeRunEvents: true,
    hello: { kind: "node.hello", node_id: fields.computer_id, protocol_version: "0.1", artood_version: "native-ui-fixture",
      machine: { hostname: "isolated-ui-fixture", os: platform, arch: process.arch } } });
  const transitions = [];
  const readDaemon = async () => (await request("/api/v1/daemons", undefined, peerToken)).daemons.find((daemon) => daemon.computer_id === fields.computer_id);
  let control;
  let operation = Promise.resolve();
  let closing = false;
  const changeNode = async (start) => {
    if (start) await node.start(); else await node.stop();
    await until(async () => {
      const daemon = await readDaemon();
      return start ? daemon?.status === "online" && daemon.connected && daemon.runtimes.length === 2
        : daemon?.status === "offline" && !daemon.connected;
    }, `Authenticated fixture node did not become ${start ? "online" : "offline"}`, 60_000);
    const daemon = await readDaemon();
    transitions.push({ action: start ? "start" : "stop", status: daemon.status, connected: daemon.connected,
      last_heartbeat_at: daemon.last_heartbeat_at, checked_at: new Date().toISOString() });
    return { daemon };
  };
  const close = async () => {
    closing = true;
    await operation.catch(() => {});
    try {
      if (control?.listening) await new Promise((resolve, reject) => control.close((error) => error ? reject(error) : resolve()));
    } finally { await node.stop(); }
  };
  try {
    await changeNode(true);
    for (const role of ["planner", "reviewer"]) {
      const created = await request(`/api/v1/computers/${fields.computer_id}/instances`, {
        runtime: `ui-${role}`, workspace_root: workspaces[role], display_name: fields[`${role}_name`], capabilities: ["code.read"],
      }, peerToken);
      fields[`${role}_instance_id`] = created.agent_instance.id;
      fields[`${role}_agent_id`] = created.agent.id;
    }
    assert.notEqual(fields.planner_instance_id, fields.reviewer_instance_id);
    const { goal } = await request("/api/v1/goals", { project_id: projectId, title: fields.goal_title,
      objective: "Discuss an implementation and its dependent verification. A human must review the proposal before either task exists.",
      acceptance_criteria: [fields.task_1_criterion, fields.task_2_criterion] }, peerToken);
    fields.goal_id = goal.id;
    fields.goal_room_id = goal.room_id;
    assert.ok(fields.goal_room_id);
    // Same-room messages from another thread must never enter the planning
    // context. User messages are intentional: checking assistant bodies alone
    // would miss this kind of cross-thread leakage.
    const { message: unrelatedRoot } = await request(`/api/v1/rooms/${goal.room_id}/messages`, {
      kind: "text", body: `Unrelated thread sentinel ${suffix}`, client_request_id: randomUUID(),
    }, peerToken);
    const { message: unrelatedReply } = await request(`/api/v1/rooms/${goal.room_id}/messages`, {
      kind: "text", body: `Unrelated reply sentinel ${suffix}`, thread_root_id: unrelatedRoot.id, client_request_id: randomUUID(),
    }, peerToken);
    fields.unrelated_message_ids = [unrelatedRoot.id, unrelatedReply.id];
    fields.context_receipts_directory = join(temporary, "context-receipts");
    mkdirSync(fields.context_receipts_directory, { mode: 0o700 });
    writeFileSync(configurationPath, JSON.stringify(fields), { mode: 0o600 });

    control = createServer((req, res) => {
      const reply = (status, value) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
      const remote = req.socket.remoteAddress;
      const supplied = Buffer.from(req.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${peerToken}`);
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote) || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        req.resume(); reply(401, { error: "Fixture control requires its loopback bearer credential" }); return;
      }
      req.resume();
      if (closing) { reply(503, { error: "Fixture closing" }); return; }
      if (req.method === "GET" && req.url === "/node") {
        void readDaemon().then((daemon) => reply(200, { daemon }), () => reply(503, { error: "Shared server unavailable" })); return;
      }
      if (req.method !== "POST" || !["/node/start", "/node/stop"].includes(req.url)) { reply(404, { error: "Unknown fixture operation" }); return; }
      operation = operation.catch(() => {}).then(() => changeNode(req.url === "/node/start"));
      void operation.then((result) => reply(200, result), (error) => reply(500, { error: error.message }));
    });
    control.requestTimeout = 70_000;
    await new Promise((resolve, reject) => { control.once("error", reject); control.listen(0, "127.0.0.1", resolve); });
    const address = control.address();
    assert.ok(address && typeof address === "object");
    fields.fixture_control_url = `http://127.0.0.1:${address.port}`;
    fields.fixture_control_token = peerToken;
    return { fields, close, transitions, readDaemon };
  } catch (error) { await close(); throw error; }
}

/** Read-only assertions after the native/browser UI has accepted the proposal. */
export async function verifyWorkflowResults({ fixture, request, transitions }) {
  const { bundle } = await request(`/api/v1/goals/${fixture.goal_id}/audit-bundle`);
  assert.equal(bundle.tasks.length, 2, "Human plan acceptance must materialize exactly two goal tasks");
  const first = bundle.tasks.find(({ task }) => task.title === fixture.task_1_title)?.task;
  const second = bundle.tasks.find(({ task }) => task.title === fixture.task_2_title)?.task;
  assert.ok(first && second);
  assert.deepEqual(first.acceptance_criteria, [fixture.task_1_criterion]);
  assert.deepEqual(second.acceptance_criteria, [fixture.task_2_criterion]);
  const { dependencies } = await request(`/api/v1/tasks/${second.id}/dependencies`);
  assert.equal(dependencies.length, 1);
  assert.deepEqual([dependencies[0].from_task_id, dependencies[0].to_task_id, dependencies[0].type], [first.id, second.id, "blocks"]);
  const { discussions } = await request(`/api/v1/goals/${fixture.goal_id}/discussions`);
  assert.equal(discussions.length, 1);
  const discussion = discussions[0];
  assert.equal(discussion.status, "ready");
  assert.equal(discussion.current_step, 3);
  assert.equal(discussion.total_steps, 3);
  assert.equal(bundle.plans.length, 1);
  assert.equal(bundle.plans[0].id, discussion.plan_id);
  assert.equal(bundle.plans[0].status, "accepted");
  const { turns } = await request(`/api/v1/rooms/${discussion.room_id}/assistant-turns?thread_root_id=${encodeURIComponent(discussion.thread_root_id)}`);
  assert.equal(turns.length, 3);
  assert.equal(discussion.room_id, fixture.goal_room_id);
  const { message: root } = await request(`/api/v1/rooms/${discussion.room_id}/messages/${discussion.thread_root_id}`);
  const { messages } = await request(`/api/v1/rooms/${discussion.room_id}/messages?thread_root_id=${encodeURIComponent(discussion.thread_root_id)}`);
  const byId = new Map([root, ...messages].map((message) => [message.id, message]));
  const expectedHistory = [root.id];
  const receipts = [];
  for (const [index, turn] of turns.entries()) {
    assert.equal(turn.status, "completed", turn.error ?? "Every process-backed discussion turn must complete");
    const { run } = await request(`/api/v1/runs/${turn.run_id}`);
    assert.equal(run.computer_id, fixture.computer_id);
    const role = index === 1 ? "reviewer" : "planner";
    assert.equal(run.agent_instance_id, fixture[`${role}_instance_id`]);
    const { usage } = await request(`/api/v1/runs/${run.id}/usage`);
    assert.match(usage.provider_session_id, new RegExp(`^ios-ui-fixture:${role}:\\d+:${turn.id}$`));
    assert.equal(usage.cost_usd, null, "Fixture usage does not establish a real model price");
    // The actual subprocess records only the identities and hashes it read.
    // Bind them to production API messages, not fixture-generated expectations.
    const context = JSON.parse(readFileSync(join(fixture.context_receipts_directory, `${sha256(turn.id)}.json`), "utf8"));
    assert.equal(usage.provider_session_id, `ios-ui-fixture:${role}:${context.pid}:${turn.id}`);
    assert.equal(context.role, role);
    assert.equal(context.turn_id, turn.id);
    assert.equal(context.task_id, turn.task_id);
    assert.equal(context.project_id, fixture.project_id);
    assert.equal(context.room_id, discussion.room_id);
    assert.equal(context.thread_root_id, discussion.thread_root_id);
    assert.equal(context.history_truncated, false);
    const currentRequest = byId.get(turn.user_message_id);
    assert.ok(currentRequest, "The real turn's request must belong to its discussion thread");
    assert.equal(context.current_request_sha256, sha256(currentRequest.body));
    assert.deepEqual(context.messages, expectedHistory.map((id) => {
      const message = byId.get(id);
      assert.ok(message, "Every context message must be an actual earlier message in this thread");
      return { id, role: message.actor_type === "agent" ? "assistant" : "user", actor_id: message.actor_id, body_sha256: sha256(message.body) };
    }), "Context must contain exactly this thread's root and preceding agent answers, in order");
    assert.ok(context.messages.every((message) => !fixture.unrelated_message_ids.includes(message.id)));
    receipts.push({ turn_id: turn.id, run_id: run.id, agent_instance_id: run.agent_instance_id, response_message_id: turn.response_message_id,
      process_receipt: usage.provider_session_id, context_room_id: context.room_id, context_thread_root_id: context.thread_root_id,
      context_message_ids: context.messages.map((message) => message.id) });
    // Planning requests are system coordinator instructions, supplied through
    // current_request. They must not reappear as prior human conversation.
    assert.equal(currentRequest.actor_type, "system");
    expectedHistory.push(turn.response_message_id);
  }
  assert.equal(receipts.filter((receipt) => receipt.agent_instance_id === fixture.planner_instance_id).length, 2);
  assert.equal(receipts.filter((receipt) => receipt.agent_instance_id === fixture.reviewer_instance_id).length, 1);
  const answers = messages.filter((message) => message.actor_type === "agent");
  assert.equal(answers.length, 3);
  assert.equal(answers.filter((message) => message.actor_id === fixture.planner_instance_id).length, 2, "Planner instance owns its contribution and synthesis");
  assert.equal(answers.filter((message) => message.actor_id === fixture.reviewer_instance_id).length, 1, "Reviewer instance owns its contribution");
  for (const receipt of receipts) {
    const role = receipt.agent_instance_id === fixture.planner_instance_id ? "planner" : "reviewer";
    assert.equal(answers.find((message) => message.id === receipt.response_message_id)?.actor_id, fixture[`${role}_instance_id`]);
  }
  const stopped = transitions.findIndex((transition) => transition.action === "stop" && transition.status === "offline");
  assert.ok(stopped >= 0 && transitions.slice(stopped + 1).some((transition) => transition.action === "start" && transition.status === "online"), "Native/browser workflow must stop and resume the actual authenticated node");
  return { goal_id: fixture.goal_id, discussion_id: discussion.id, plan_id: discussion.plan_id,
    task_ids: [first.id, second.id], dependency: { from_task_id: first.id, to_task_id: second.id, type: "blocks" },
    process_turns: receipts, daemon_transitions: transitions };
}
