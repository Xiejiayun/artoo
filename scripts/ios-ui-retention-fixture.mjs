import assert from "node:assert/strict";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createSimulatorClipboard } from "./ios-simulator-clipboard.mjs";
import { createZeroArtifactWorkspaceScenario, verifyZeroArtifactWorkspace } from "./fixtures/zero-artifact-workspace-scenario.mjs";

export const retentionCheckpoints = Object.freeze(["completed", "relaunched"]);

async function readEmptyObject(request) {
  let text = "", size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= 1024) text += chunk.toString("utf8");
  }
  if (size > 1024) throw new Error("Checkpoint body is too large");
  const parsed = JSON.parse(text);
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0,
    "Checkpoint accepts only an empty object");
}

/** Authenticated loopback fixture controls. Product actions remain native UI. */
export async function createRetentionControl({ scenario, errors = [], clipboard }) {
  const token = randomBytes(32).toString("hex"), reserved = new Set();
  let operation = Promise.resolve(), closing = false, closePromise;
  const control = createServer((req, res) => {
    const reply = (status, body) => {
      if (res.destroyed) return;
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const supplied = Buffer.from(req.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${token}`);
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)
      || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      req.resume(); reply(401, { error: "Authenticated loopback fixture control required" }); return;
    }
    if (closing) { req.resume(); reply(503, { error: "Fixture closing" }); return; }
    if (clipboard?.handle(req, reply)) return;
    if (req.method === "GET" && req.url === "/observations") {
      req.resume();
      void scenario.observe().then((observation) => reply(200, observation), (error) => {
        errors.push(error); reply(500, { error: "Retention observation failed" });
      });
      return;
    }
    const match = req.method === "POST" ? /^\/checkpoints\/([a-z_]+)$/.exec(req.url ?? "") : null;
    if (!match || !retentionCheckpoints.includes(match[1])) {
      req.resume(); reply(404, { error: "Unknown fixture operation" }); return;
    }
    const name = match[1];
    void (async () => {
      try { await readEmptyObject(req); }
      catch { reply(400, { error: "Checkpoint requires an empty JSON object" }); return; }
      if (closing) { reply(503, { error: "Fixture closing" }); return; }
      if (reserved.has(name)) { reply(409, { error: "Checkpoint already submitted" }); return; }
      if (retentionCheckpoints[reserved.size] !== name) { reply(409, { error: "Checkpoint is out of order" }); return; }
      reserved.add(name);
      operation = operation.catch(() => {}).then(async () => {
        assert.ok(!closing, "Retention control closed before queued checkpoint");
        return scenario.waitForCheckpoint(name);
      });
      void operation.then((checkpoint) => reply(200, checkpoint), (error) => {
        errors.push(error); reply(500, { error: "Retention checkpoint failed" });
      });
    })();
  });
  control.requestTimeout = 70_000;
  await new Promise((resolve, reject) => { control.once("error", reject); control.listen(0, "127.0.0.1", resolve); });
  const close = () => closePromise ??= (async () => {
    closing = true;
    control.closeAllConnections();
    const stopped = new Promise((resolve, reject) => control.close((error) => error ? reject(error) : resolve()));
    // Abort the observer's wait before awaiting the queue; failure evidence must
    // not be delayed by an abandoned 60-second checkpoint wait.
    try { await scenario.close(); }
    finally {
      const results = await Promise.allSettled([clipboard?.close(), operation.catch(() => {}), stopped]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    }
  })();
  return { url: `http://127.0.0.1:${control.address().port}`, token, close, clipboardEvidence: () => clipboard?.evidence() ?? [] };
}


/** Compare business/file identity across a real cold relaunch, without treating
 * observation timestamps or unrelated cursors as immutable client state. */
export function verifyRetentionHistory(before, after) {
  for (const key of ["task", "runs", "approvals", "reviews", "artifacts"])
    assert.deepEqual(after.snapshot?.[key], before.snapshot?.[key], `Cold recovery changed ${key}`);
  for (const key of ["run_reads", "receipts", "launches", "contexts", "workspace", "base"])
    assert.deepEqual(after[key], before[key], `Cold recovery changed ${key}`);
  assert.deepEqual(before.live_pids, []); assert.deepEqual(after.live_pids, []);
  return true;
}

/** Provision only a disposable authenticated worker/instance and observation
 * control. Task creation, Ready, approval and assignment remain native UI. */
export async function createRetentionFixture({ root, temporary, origin, projectId, peerToken, suffix, request, until, simulatorUDID }) {
  const scenario = await createZeroArtifactWorkspaceScenario({ root, temporary, origin, projectId, suffix,
    request: (path, body) => request(path, body, peerToken), until });
  const checkpoints = [], errors = [];
  let control;
  const bridge = {
    observe: () => scenario.observe(),
    async waitForCheckpoint(name) {
      const observation = await scenario.waitForVerified();
      const verification = verifyZeroArtifactWorkspace({ ...scenario, observation });
      if (name === "relaunched") {
        assert.equal(checkpoints.length, 1); verifyRetentionHistory(checkpoints[0].observation, observation);
      }
      const record = { name, observation, verification }; checkpoints.push(record);
      return structuredClone(record);
    },
    close: () => scenario.close(),
  };
  try {
    control = await createRetentionControl({ scenario: bridge, errors, clipboard: createSimulatorClipboard({ simulatorUDID }) });
    const fields = { ...scenario.fields, criterion_1: scenario.fields.acceptance_criteria[0], criterion_2: scenario.fields.acceptance_criteria[1],
      native_device_name: `Native retained-work iPhone ${suffix}`, simulator_udid: simulatorUDID, fixture_control_url: control.url, fixture_control_token: control.token };
    return { scenario, fields, errors, evidence: () => structuredClone(checkpoints), clipboardEvidence: control.clipboardEvidence, close: () => control.close(),
      async verify() {
        assert.deepEqual(checkpoints.map((item) => item.name), retentionCheckpoints, "Both completed and cold-relaunch UI checkpoints are required");
        const final = await scenario.observe();
        const verified = verifyZeroArtifactWorkspace({ ...scenario, observation: final });
        verifyRetentionHistory(checkpoints[0].observation, checkpoints[1].observation);
        verifyRetentionHistory(checkpoints[1].observation, final);
        return { ...verified, workspace_retention: final.snapshot.runs[0].workspace_retention, historical_recovery: { passed: true, checkpoints: retentionCheckpoints,
          task_id: verified.task_id, run_id: verified.run_id, retention_event_id: verified.retention_event_id } };
      } };
  } catch (error) {
    await scenario.close().catch(() => {}); throw error;
  }
}
