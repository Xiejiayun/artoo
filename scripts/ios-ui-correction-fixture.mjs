import assert from "node:assert/strict";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createCorrectionObserver, createCorrectionWorkspaces, correctionProcessAlive } from "./fixtures/execution-correction-scenario.mjs";
import { correctionCheckpoints } from "./fixtures/execution-correction-results.mjs";

/** Artifact reads use the actual credential and cannot follow an external URI or redirect. */
export async function readCorrectionArtifact({ origin, peerToken, artifact }) {
  assert.ok(typeof artifact.id === "string" && /^[A-Za-z0-9_-]+$/.test(artifact.id));
  const path = `/api/v1/artifacts/${artifact.id}/content`;
  assert.equal(artifact.uri, path, "Correction artifact must use its exact production content route");
  const destination = new URL(artifact.uri, origin), base = new URL(origin);
  assert.equal(destination.origin, base.origin);
  assert.equal(destination.pathname, path);
  assert.equal(destination.search, ""); assert.equal(destination.hash, "");
  const response = await fetch(destination, { headers: { Authorization: `Bearer ${peerToken}` },
    redirect: "error", signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, "Authenticated correction artifact download must succeed");
  return Buffer.from(await response.arrayBuffer());
}

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

/** Authenticated loopback observation only. It never performs a product action. */
export async function createCorrectionControl({ scenario, errors = [] }) {
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
    if (req.method === "GET" && req.url === "/observations") {
      req.resume();
      void scenario.observe().then((observation) => reply(200, observation), (error) => {
        errors.push(error); reply(500, { error: "Correction observation failed" });
      });
      return;
    }
    const match = req.method === "POST" ? /^\/checkpoints\/([a-z_]+)$/.exec(req.url ?? "") : null;
    if (!match || !correctionCheckpoints.includes(match[1])) {
      req.resume(); reply(404, { error: "Unknown fixture operation" }); return;
    }
    const name = match[1];
    void (async () => {
      try { await readEmptyObject(req); }
      catch { reply(400, { error: "Checkpoint requires an empty JSON object" }); return; }
      if (closing) { reply(503, { error: "Fixture closing" }); return; }
      if (reserved.has(name)) { reply(409, { error: "Checkpoint already submitted" }); return; }
      if (correctionCheckpoints[reserved.size] !== name) { reply(409, { error: "Checkpoint is out of order" }); return; }
      reserved.add(name);
      operation = operation.catch(() => {}).then(async () => {
        assert.ok(!closing, "Correction control closed before queued checkpoint");
        return scenario.waitForCheckpoint(name);
      });
      void operation.then((checkpoint) => reply(200, checkpoint), (error) => {
        errors.push(error); reply(500, { error: "Correction checkpoint failed" });
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
    finally { await operation.catch(() => {}); await stopped; }
  })();
  return { url: `http://127.0.0.1:${control.address().port}`, token, close };
}

function liveOwnedLaunches(setup) {
  return readdirSync(setup.receiptsDirectory).filter((name) => name.startsWith("launch-")).flatMap((name) => {
    const match = /^launch-([0-9]+)-[a-f0-9]{16}\.json$/.exec(name);
    assert.ok(match, "Unexpected correction launch evidence name");
    const path = join(setup.receiptsDirectory, name), stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16_384, "Correction launch evidence must be a bounded regular file");
    const launch = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(launch.pid, Number(match[1]));
    assert.ok(Number.isSafeInteger(launch.pid) && launch.pid > 1 && setup.workspaceRoots.includes(launch.workspace_root));
    return correctionProcessAlive(launch.pid) ? [launch.pid] : [];
  });
}

/** Disposable setup uses production enrollment, node transport, process adapter
 * and artifact upload. Task/review/approval/assign/Stop writes belong to UI only. */
export async function createCorrectionFixture({ root, temporary, origin, server, projectId, userId, peerToken, suffix, request, until }) {
  const { createAdapterRegistry, createArtoodNode, createArtifactUploader, createProcessAdapter } = await import(pathToFileURL(join(root, "apps/artood/dist/index.js")).href);
  const setup = createCorrectionWorkspaces({ temporary, projectId, platform: "ios", suffix });
  const runtime = "ui-correction", computerName = `Native correction computer ${suffix}`, errors = [];
  const nodePlatform = process.platform === "win32" ? "windows" : "macos";
  let node, scenario, control, closePromise;
  const close = () => closePromise ??= (async () => {
    try {
      if (control) await control.close();
      else await scenario?.close();
    } finally {
      await node?.stop();
      await until(() => liveOwnedLaunches(setup).length === 0, "Correction fixture cleanup left a live owned process", 10_000);
    }
  })();
  try {
    const pairing = await request("/api/v1/devices/pairings", { intended_platform: nodePlatform }, peerToken);
    const claimed = await request("/api/v1/devices/claim", { code: pairing.code, platform: nodePlatform,
      app_version: "correction-ui-fixture", display_name: computerName });
    const enrolled = await request(`/api/v1/devices/${claimed.device.id}/enroll`, { display_name: computerName,
      hostname: "isolated-correction-fixture", os: nodePlatform, arch: process.arch }, peerToken);
    const computerId = enrolled.computer_id;
    const adapter = createProcessAdapter({ runtimeId: runtime,
      command: [process.execPath, join(root, "scripts/fixtures/execution-correction.mjs"), "{{context_pack_path}}", setup.configurationPath],
      allowedRoots: [setup.directory], artifacts: [{ type: "patch", path: "changes.patch" }], outputFormat: "codex-json" });
    const socketURL = new URL("/api/v1/node", origin);
    socketURL.protocol = socketURL.protocol === "https:" ? "wss:" : "ws:";
    socketURL.searchParams.set("token", claimed.node_token);
    node = createArtoodNode({ url: socketURL.href,
      registry: createAdapterRegistry([{ runtime, capabilities: ["code.modify"], adapter }]),
      workspace: { worktreeBaseRepo: setup.baseRepo, allowedRoots: [setup.directory] },
      uploadArtifact: createArtifactUploader(socketURL.href, computerId), heartbeatIntervalMs: 500, acknowledgeRunEvents: true,
      hello: { kind: "node.hello", node_id: computerId, protocol_version: "0.1", artood_version: "correction-ui-fixture",
        machine: { hostname: "isolated-correction-fixture", os: nodePlatform, arch: process.arch } } });
    const authenticatedRequest = (path, body) => request(path, body, peerToken);
    scenario = await createCorrectionObserver({ root, setup, server, origin, request: authenticatedRequest, userId,
      computerId, runtimeId: runtime, readArtifact: (artifact) => readCorrectionArtifact({ origin, peerToken, artifact }) });
    await node.start();
    await until(async () => {
      const daemon = (await authenticatedRequest("/api/v1/daemons")).daemons.find((value) => value.computer_id === computerId);
      return daemon?.status === "online" && daemon.connected && daemon.runtimes.some((value) => value.runtime === runtime);
    }, "Correction node did not publish its authenticated runtime", 60_000);
    await scenario.registerInstances();
    control = await createCorrectionControl({ scenario, errors });
    const fields = scenario.fields;
    Object.assign(fields, { computer_name: computerName, fixture_control_url: control.url, fixture_control_token: control.token });
    return { fields, node, scenario, setup, close, errors };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Correction fixture initialization and cleanup failed"); }
    throw error;
  }
}
