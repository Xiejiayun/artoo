import assert from "node:assert/strict";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assistantFailureReceiptPath, assistantStartupReceiptPath } from "./fixtures/assistant-conversation.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
function privateBytes(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1_000_000, "Fixture evidence must be a bounded regular file");
  return readFileSync(path);
}
function privateJSON(path) {
  try { return JSON.parse(privateBytes(path).toString("utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) {
      const incomplete = new Error("Assistant fixture receipt is incomplete");
      incomplete.code = "ASSISTANT_RECEIPT_INCOMPLETE"; throw incomplete;
    }
    throw new Error("Assistant fixture receipt is unreadable");
  }
}

/** Independent observation at the real adapter's start boundary; no pack edits. */
export function captureAssistantContext(path, runId) {
  const bytes = privateBytes(path);
  const runs = [...bytes.toString("utf8").split("\n\n", 1)[0].matchAll(/^run: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(runs, [runId], "The observed context must belong to this actual run");
  return { run_id: runId, sha256: hash(bytes) };
}

/** Only PIDs recorded by this private fixture are probed, never caller input. */
export function readAssistantObservations({ configuration, contextHashes = [], probe = alive, allowIncomplete = false }) {
  const receipts = [], failed_once_receipts = [], incomplete_receipts = [];
  for (const name of readdirSync(configuration.receipts_directory).sort()) {
    if (/^\.assistant-receipt-[a-f0-9]{32}\.tmp$/.test(name)) continue;
    assert.match(name, /^(?:run-[a-f0-9]{64}|turn-[a-f0-9]{64}-failed-once)\.json$/, "Unexpected fixture receipt name");
    let receipt;
    try { receipt = privateJSON(join(configuration.receipts_directory, name)); }
    catch (error) {
      // A live CLI can be between exclusive creation and the end of writeFileSync.
      // UI observation explicitly waits; final verification and cleanup remain strict.
      if (allowIncomplete && error.code === "ASSISTANT_RECEIPT_INCOMPLETE") { incomplete_receipts.push(name); continue; }
      throw error;
    }
    assert.equal(receipt.project_id, configuration.project_id);
    assert.equal(receipt.room_id, configuration.room_id);
    assert.equal(receipt.thread_root_id, null);
    assert.ok(typeof receipt.turn_id === "string" && receipt.turn_id.length > 0);
    if (name.startsWith("run-")) {
      assert.ok(typeof receipt.run_id === "string" && receipt.run_id.length > 0);
      assert.equal(name, basename(assistantStartupReceiptPath(configuration.receipts_directory, receipt.run_id)));
      assert.equal(receipt.workspace_root, realpathSync(configuration.workspace_root));
      assert.ok(Number.isSafeInteger(receipt.pid) && receipt.pid > 1, "A receipt must identify a real child PID");
      receipts.push(receipt);
    } else {
      assert.equal(name, basename(assistantFailureReceiptPath(configuration.receipts_directory, receipt.turn_id)));
      failed_once_receipts.push(receipt);
    }
  }
  const live_pids = [...new Set(receipts.filter((receipt) => probe(receipt.pid)).map((receipt) => receipt.pid))];
  return { receipts, failed_once_receipts, live_pids, incomplete_receipts, context_hashes: contextHashes.map((entry) => ({ ...entry })) };
}

/** Disposable infrastructure using the production pairing, node and adapter paths.
 * The control server never creates or changes a tested message, turn or run. */
export async function createAssistantFixture({ root, temporary, origin, projectId, channelId, userId, peerToken, suffix, request, until }) {
  const { createAdapterRegistry, createArtoodNode, createProcessAdapter } = await import(pathToFileURL(join(root, "apps/artood/dist/index.js")).href);
  const workspacePath = join(temporary, "assistant-workspace"), receiptsPath = join(temporary, "assistant-receipts");
  mkdirSync(workspacePath); mkdirSync(receiptsPath, { mode: 0o700 });
  const workspace = realpathSync(workspacePath), receiptsDirectory = realpathSync(receiptsPath);
  const fields = { computer_name: `Native assistant computer ${suffix}`, assistant_name: `Native conversation agent ${suffix}`,
    assistant_runtime: "ui-assistant", assistant_device_name: `Native assistant iPhone ${suffix}`,
    assistant_first_request: `Read this isolated workspace and answer the first request ${suffix}`,
    assistant_second_request: `Use your actual earlier answer for this follow-up ${suffix}`,
    assistant_hold_request: `Keep this request running until I cancel it ${suffix}`,
    assistant_draft: `Unsent native assistant draft ${suffix}`, assistant_receipts_directory: receiptsDirectory };
  const configuration = { project_id: projectId, room_id: channelId, user_id: userId, thread_root_id: null,
    workspace_root: realpathSync(workspace), receipts_directory: realpathSync(receiptsDirectory), runtime_id: fields.assistant_runtime,
    requests: { first: fields.assistant_first_request, second: fields.assistant_second_request, hold: fields.assistant_hold_request },
    hold_timeout_ms: 300_000 };
  const code = await request("/api/v1/devices/pairings", { intended_platform: "macos" }, peerToken);
  const claimed = await request("/api/v1/devices/claim", { code: code.code, platform: "macos", app_version: "assistant-ui-fixture", display_name: fields.computer_name });
  const enrolled = await request(`/api/v1/devices/${claimed.device.id}/enroll`, { display_name: fields.computer_name, hostname: "isolated-assistant-fixture", os: "macos", arch: process.arch }, peerToken);
  fields.computer_id = enrolled.computer_id; configuration.computer_id = enrolled.computer_id;
  const configurationPath = join(temporary, "assistant-process.json"), contextHashes = [];
  const adapter = createProcessAdapter({ runtimeId: fields.assistant_runtime,
    command: [process.execPath, join(root, "scripts/fixtures/assistant-conversation.mjs"), "{{context_pack_path}}", configurationPath],
    allowedRoots: [workspace], outputFormat: "codex-json" });
  const observedAdapter = { ...adapter, async start(config) {
    const handle = await adapter.start(config);
    try {
      const observed = captureAssistantContext(join(workspace, "context_pack.md"), config.runId);
      assert.ok(!contextHashes.some((entry) => entry.run_id === observed.run_id), "A run must start exactly once");
      contextHashes.push(observed);
      return handle;
    } catch (error) { await adapter.stop(handle, "user_cancelled"); throw error; }
  } };
  const socketURL = new URL("/api/v1/node", origin);
  socketURL.protocol = "ws:"; socketURL.searchParams.set("token", claimed.node_token);
  const node = createArtoodNode({ url: socketURL.href,
    registry: createAdapterRegistry([{ runtime: fields.assistant_runtime, capabilities: ["code.read"], adapter: observedAdapter }]),
    heartbeatIntervalMs: 500, acknowledgeRunEvents: true,
    hello: { kind: "node.hello", node_id: fields.computer_id, protocol_version: "0.1", artood_version: "assistant-ui-fixture",
      machine: { hostname: "isolated-assistant-fixture", os: "macos", arch: process.arch } } });
  const transitions = [], readObservations = () => readAssistantObservations({ configuration, contextHashes });
  const readDaemon = async () => (await request("/api/v1/daemons", undefined, peerToken)).daemons.find((daemon) => daemon.computer_id === fields.computer_id);
  let control, closing = false, operation = Promise.resolve();
  const changeNode = async (start) => {
    if (start) await node.start(); else await node.stop();
    await until(async () => {
      const daemon = await readDaemon();
      return start ? daemon?.status === "online" && daemon.connected && daemon.runtimes.some((runtime) => runtime.runtime === fields.assistant_runtime)
        : daemon?.status === "offline" && !daemon.connected;
    }, `Assistant node did not become ${start ? "online" : "offline"}`, 60_000);
    const daemon = await readDaemon();
    transitions.push({ action: start ? "start" : "stop", status: daemon.status, checked_at: new Date().toISOString() });
    return { daemon };
  };
  const close = async () => {
    closing = true;
    await operation.catch(() => {});
    try {
      if (control?.listening) {
        control.closeAllConnections();
        await new Promise((done, reject) => control.close((error) => error ? reject(error) : done()));
      }
    } finally {
      await node.stop();
      await until(() => readObservations().live_pids.length === 0, "Assistant fixture cleanup left a live owned subprocess", 10_000);
    }
  };
  try {
    await changeNode(true);
    const created = await request(`/api/v1/computers/${fields.computer_id}/instances`, { runtime: fields.assistant_runtime,
      workspace_root: workspace, display_name: fields.assistant_name, capabilities: ["code.read"] }, peerToken);
    fields.assistant_instance_id = created.agent_instance.id; configuration.agent_instance_id = fields.assistant_instance_id;
    const collision = await request(`/api/v1/computers/${fields.computer_id}/instances`, { runtime: fields.assistant_runtime,
      workspace_root: workspace, display_name: fields.assistant_name, capabilities: ["code.read"] }, peerToken);
    fields.assistant_collision_instance_id = collision.agent_instance.id;
    assert.notEqual(fields.assistant_collision_instance_id, fields.assistant_instance_id);
    assert.deepEqual([collision.agent.display_name, collision.agent_instance.computer_id, collision.agent_instance.runtime, collision.agent_instance.workspace_root],
      [created.agent.display_name, created.agent_instance.computer_id, created.agent_instance.runtime, created.agent_instance.workspace_root]);
    writeFileSync(configurationPath, JSON.stringify(configuration), { mode: 0o600 });
    const controlToken = randomBytes(32).toString("hex");
    control = createServer((req, res) => {
      const reply = (status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
      const supplied = Buffer.from(req.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${controlToken}`);
      req.resume();
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { reply(401, { error: "Authenticated loopback fixture control required" }); return; }
      if (closing) { reply(503, { error: "Fixture closing" }); return; }
      if (req.method === "GET" && req.url === "/observations") {
        try { reply(200, readAssistantObservations({ configuration, contextHashes, allowIncomplete: true })); }
        catch { reply(500, { error: "Assistant observation failed" }); } return;
      }
      if (req.method === "GET" && req.url === "/node") { void readDaemon().then((daemon) => reply(200, { daemon }), () => reply(503, { error: "Shared server unavailable" })); return; }
      if (req.method !== "POST" || !["/node/start", "/node/stop"].includes(req.url)) { reply(404, { error: "Unknown fixture operation" }); return; }
      operation = operation.catch(() => {}).then(() => changeNode(req.url === "/node/start"));
      void operation.then((value) => reply(200, value), () => reply(500, { error: "Assistant node transition failed" }));
    });
    control.requestTimeout = 70_000;
    await new Promise((done, reject) => { control.once("error", reject); control.listen(0, "127.0.0.1", done); });
    fields.fixture_control_url = `http://127.0.0.1:${control.address().port}`; fields.fixture_control_token = controlToken;
    return { fields, configuration, transitions, readDaemon, readObservations, close };
  } catch (error) { await close(); throw error; }
}
