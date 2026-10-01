#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { getE2EReportContext, writeE2EReport } from "./e2e-report.mjs";
import { closeOwnedBrowser } from "./owned-browser.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function directoryDigest(directory) {
  const hash = createHash("sha256");
  function visit(current, prefix = "") {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${prefix}${entry.name}`, path = join(current, entry.name);
      if (entry.isDirectory()) visit(path, `${name}/`);
      else if (entry.isFile()) hash.update(name).update("\0").update(sha256(readFileSync(path))).update("\0");
      else throw new Error(`Unexpected build entry: ${name}`);
    }
  }
  visit(directory);
  return hash.digest("hex");
}

async function main() {
  const report = { ...getE2EReportContext(), started_at: new Date().toISOString(), passed: false, checks: [],
    scope: "Local production-mode offline backup and restore using isolated persistent servers, real authenticated APIs and browser screenshots. This does not verify a deployed TLS/OIDC environment, an off-site backup, or hardware failure recovery.",
    authentication: "The disposable owner's initial session is provisioned by the test. Device pairing, account reads and all business mutations use production HTTP endpoints; no live Google login is claimed.",
    model: "A deterministic local subprocess produces the artifact through the real artood/upload path. No AI provider is contacted.",
  };
  const output = join(root, "artifacts", "recovery", report.started_at.replaceAll(/[:.]/g, "-"));
  mkdirSync(output, { recursive: true });
  const html = join(output, "report.html"), json = join(output, "report.json"), screenshots = [];
  const title = "Artoo · local production recovery drill";
  writeE2EReport({ outputPath: html, title, report });
  let temporary, server, node, browserServer, browser, context, page;
  let origin, ownerToken, controlToken, nodeToken, computerId, makeNode;
  const interrupted = new AbortController();
  const signal = () => AbortSignal.any([interrupted.signal, AbortSignal.timeout(20_000)]);
  const interrupt = (name) => interrupted.abort(new Error(`Recovery drill interrupted by ${name}`));
  const onInterrupt = () => interrupt("SIGINT"), onTerminate = () => interrupt("SIGTERM");
  process.once("SIGINT", onInterrupt); process.once("SIGTERM", onTerminate);
  const check = (name) => { report.checks.push({ name, passed: true }); console.log(`[recovery] PASS ${name}`); };
  async function until(predicate, message, timeout = 45_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      interrupted.signal.throwIfAborted();
      if (await predicate()) return;
      await new Promise((done) => setTimeout(done, 150));
    }
    throw new Error(message);
  }
  async function request(path, { body, token = controlToken ?? ownerToken, key, method = body === undefined ? "GET" : "POST", status } = {}) {
    const response = await fetch(`${origin}${path}`, { method, redirect: "error", signal: signal(),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(key ? { "Idempotency-Key": key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(status === undefined ? response.ok : response.status === status, true, `${method} ${path} returned ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  async function artifactBytes(uri) {
    const response = await fetch(`${origin}${uri}`, { headers: { Authorization: `Bearer ${controlToken}` }, redirect: "error", signal: signal() });
    assert.equal(response.status, 200, "Authenticated artifact download must succeed");
    return Buffer.from(await response.arrayBuffer());
  }
  async function storage(action, paths, data, expectedFailure) {
    interrupted.signal.throwIfAborted();
    // This cwd has no .env. Explicit paths override any workstation settings;
    // the maintenance command can access only this invocation's fixture data.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|COMSPEC|WINDIR|TMP|TEMP|TMPDIR)$/i.test(key)));
    Object.assign(env, { NODE_ENV: "production", ARTOO_DATA_DIR: data, ARTOO_DB_DIR: join(data, "db"), ARTOO_ARTIFACT_DIR: join(data, "artifacts") });
    try {
      await execute(process.execPath, [join(root, "scripts/storage.mjs"), action, ...paths], {
        cwd: temporary, env, timeout: 120_000, maxBuffer: 1024 * 1024, signal: interrupted.signal,
      });
    } catch (error) {
      if (expectedFailure) {
        assert.match(String(error.stderr ?? ""), expectedFailure, `Storage ${action} must reject for the expected reason`);
        return;
      }
      throw new Error(`Storage ${action} failed: ${String(error.stderr ?? error.message).slice(0, 1000)}`);
    }
    assert.equal(expectedFailure, undefined, `Storage ${action} unexpectedly accepted an unsafe operation`);
  }
  try {
    assert.equal(process.argv.length, 2, "Usage: node scripts/recovery-e2e.mjs");
    assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Use Node.js 24 or newer");
    for (const file of ["apps/server/dist/main.js", "apps/artood/dist/index.js", "apps/web/dist/index.html"]) {
      assert.ok(existsSync(join(root, file)), `Build the production packages before this drill: missing ${file}`);
    }
    report.built_artifacts = Object.fromEntries(["apps/server", "apps/artood", "apps/web", ...readdirSync(join(root, "packages")).map((name) => `packages/${name}`)]
      .map((path) => `${path}/dist`).filter((path) => existsSync(join(root, path))).map((path) => [path, directoryDigest(join(root, path))]));
    report.build_scope = "Uses existing compiled output; SHA-256 directory digests above identify the tested artifacts separately from working-tree provenance.";
    temporary = realpathSync(mkdtempSync(join(tmpdir(), "artoo-recovery-")));
    const data = join(temporary, "original"), restored = join(temporary, "restored"), backup = join(temporary, "backup");
    const workspace = join(temporary, "workspace"); mkdirSync(workspace);
    const fixtureScript = join(temporary, "produce-artifact.mjs");
    const expectedBytes = Buffer.from("Artoo recovery evidence\nTask, account, messages and artifact bytes survived offline restore.\n恢复验证通过。\n", "utf8");
    writeFileSync(fixtureScript, `import { writeFileSync } from "node:fs";\nwriteFileSync("recovery-proof.txt", Buffer.from(${JSON.stringify(expectedBytes.toString("base64"))}, "base64"));\nconsole.log("Recovery artifact produced by the deterministic subprocess");\n`, { mode: 0o600 });
    const [{ startServer }, { createSession }, { createAdapterRegistry, createArtoodNode, createProcessAdapter, createArtifactUploader }] = await Promise.all([
      import(pathToFileURL(join(root, "apps/server/dist/main.js")).href),
      import(pathToFileURL(join(root, "apps/server/dist/auth/auth-service.js")).href),
      import(pathToFileURL(join(root, "apps/artood/dist/index.js")).href),
    ]);
    const production = { NODE_ENV: "production", ARTOO_HOST: "127.0.0.1", ARTOO_PORT: "0",
      ARTOO_WORKSPACE_ROOT: workspace, ARTOO_WEB_DIST: join(root, "apps/web/dist"), ARTOO_PAIRING_PEPPER: randomBytes(32).toString("hex"),
      GOOGLE_CLIENT_ID: "local-recovery-fixture", GOOGLE_CLIENT_SECRET: "unused-local-recovery-fixture",
      GOOGLE_REDIRECT_URI: "http://localhost/auth/google/callback", AUTH_ALLOWED_EMAILS: "owner@recovery.test", AUTH_OWNER_EMAILS: "owner@recovery.test" };
    async function start(dataRoot) {
      interrupted.signal.throwIfAborted();
      server = await startServer({ ...production, ARTOO_DATA_DIR: dataRoot });
      const address = server.app.server.address();
      assert.ok(address && typeof address === "object"); origin = `http://127.0.0.1:${address.port}`;
      assert.equal(server.persistent, true); assert.equal(server.ctx.deviceAuth.devControlEscape, false); assert.equal(server.ctx.deviceAuth.devNodeToken, null);
      await request("/api/v1/bootstrap", { token: null, status: 401 });
      await request("/dev/tasks/none/run", { token: null, body: {}, status: 404 });
    }
    await start(data);
    ownerToken = (await createSession(server.ctx, { ttlMs: 3_600_000 }, { userId: "user_owner" })).raw;
    const code = await request("/api/v1/devices/pairings", { body: { intended_platform: "macos" }, status: 201 });
    const claimed = await request("/api/v1/devices/claim", { body: { code: code.code, platform: "macos", app_version: "recovery-fixture", display_name: "Recovery execution computer" }, status: 201, token: null });
    controlToken = claimed.control_token; nodeToken = claimed.node_token;
    const identity = await request("/auth/session");
    assert.equal(identity.user.email, "owner@recovery.test"); assert.equal(identity.user.role, "owner"); assert.equal(identity.device_id, claimed.device.id);
    computerId = (await request(`/api/v1/devices/${claimed.device.id}/enroll`, { body: { display_name: "Recovery execution computer", hostname: "isolated-recovery-fixture", os: process.platform, arch: process.arch } })).computer_id;
    makeNode = () => {
      const nodeURL = new URL("/api/v1/node", origin); nodeURL.protocol = "ws:"; nodeURL.searchParams.set("token", nodeToken);
      const registry = createAdapterRegistry([{ runtime: "recovery-fixture", capabilities: ["code.modify"],
        adapter: createProcessAdapter({ runtimeId: "recovery-fixture", command: [process.execPath, fixtureScript], allowedRoots: [workspace], artifacts: [{ type: "report", path: "recovery-proof.txt" }] }) }]);
      return createArtoodNode({ url: nodeURL.href, registry, uploadArtifact: createArtifactUploader(nodeURL.href, computerId), acknowledgeRunEvents: true, heartbeatIntervalMs: 500,
        hello: { kind: "node.hello", node_id: computerId, protocol_version: "0.1", artood_version: "recovery-fixture", machine: { hostname: "isolated-recovery-fixture", os: process.platform, arch: process.arch } } });
    };
    const nodeOnline = async () => (await request("/api/v1/daemons")).daemons.some((item) => item.computer_id === computerId && item.connected && item.status === "online" && item.runtimes.some((runtime) => runtime.runtime === "recovery-fixture" && runtime.status === "available"));
    node = makeNode(); await node.start(); await until(nodeOnline, "Paired node did not advertise its runtime");
    const instance = (await request(`/api/v1/computers/${computerId}/instances`, { body: { runtime: "recovery-fixture", workspace_root: workspace, display_name: "Recovery fixture agent", capabilities: ["code.modify"] }, status: 201 })).agent_instance;
    check("Real persistent server enforces production auth; public pairing/enrollment connects an authenticated execution node");

    const taskKey = randomUUID(), messageKey = randomUUID();
    const taskBody = { project_id: "proj_artoo", title: `Recovery proof ${randomUUID().slice(0, 8)}`, description: "A real completed task used only by this isolated local recovery drill.", acceptance_criteria: ["Restore the task, messages, account and artifact without duplicate writes"], required_capabilities: ["code.modify"] };
    const created = await request("/api/v1/tasks", { body: taskBody, key: taskKey, status: 201 });
    const taskId = created.task.id, roomId = created.room.id;
    const messageBody = { body: "This message must exist exactly once before and after recovery.", kind: "text", client_request_id: randomUUID() };
    const messagePath = `/api/v1/rooms/${roomId}/messages`;
    const message = (await request(messagePath, { body: messageBody, key: messageKey, status: 201 })).message;
    await request(`/api/v1/tasks/${taskId}/ready`, { body: {}, key: randomUUID() });
    await request(`/api/v1/tasks/${taskId}/assign`, { body: { mode: "manual", agent_instance_id: instance.id }, key: randomUUID() });
    await until(async () => {
      const snapshot = await request(`/api/v1/tasks/${taskId}`);
      assert.notEqual(snapshot.task.status, "blocked", "Deterministic artifact execution failed");
      return snapshot.task.status === "review";
    }, "Task did not reach artifact review");
    const snapshot = await request(`/api/v1/tasks/${taskId}`);
    assert.equal(snapshot.runs.length, 1); assert.equal(snapshot.artifacts.length, 1);
    const artifact = snapshot.artifacts[0]; assert.equal(artifact.checksum, `sha256:${sha256(expectedBytes)}`);
    assert.deepEqual(await artifactBytes(artifact.uri), expectedBytes);
    await request(`/api/v1/tasks/${taskId}/review`, { body: { outcome: "accepted", comment: "Artifact bytes verified before offline backup" }, key: randomUUID() });
    check("Public APIs persist a task/message and a real subprocess artifact; authenticated download matches its exact UTF-8 bytes");

    const channel = process.env.ARTOO_CHROMIUM_CHANNEL?.trim() || undefined;
    browserServer = await chromium.launchServer({ headless: true, ...(channel ? { channel } : {}) });
    browser = await chromium.connect(browserServer.wsEndpoint());
    report.environment.browser = `${channel ?? "playwright-bundled-chromium"} ${browser.version()}`;
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await context.addCookies([{ name: "artoo_session", value: ownerToken, url: origin, httpOnly: true, sameSite: "Lax" }]);
    page = await context.newPage(); page.setDefaultTimeout(20_000);
    const pageErrors = []; page.on("pageerror", (error) => pageErrors.push(error.message));
    async function capture(name, caption) {
      await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.getByRole("button", { name: new RegExp(taskBody.title) }).click();
      await expect(page.locator(".task-detail__meta .ui-badge--status")).toHaveText("done");
      await expect(page.getByText(messageBody.body, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Download artifact", exact: true })).toBeVisible();
      await expect(page.getByText("Live updates connected", { exact: true })).toBeVisible();
      assert.deepEqual(pageErrors, [], "The rendered recovery workspace must not have uncaught errors");
      const path = join(output, name); await page.screenshot({ path, fullPage: false, animations: "disabled", timeout: 30_000 });
      screenshots.push({ path, caption });
    }
    await capture("before-backup.png", "Before backup: authenticated production Web UI shows the completed task, original message and stored artifact");
    await storage("backup", [join(temporary, "busy-backup")], data, /locked/);
    assert.equal(existsSync(join(temporary, "busy-backup")), false);
    check("Maintenance refuses an online database backup instead of taking an inconsistent snapshot");
    await page.goto("about:blank");
    await node.stop(); node = undefined; await server.close(); server = undefined;
    const stoppedAt = Date.now();
    await storage("backup", [backup], data);
    const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8"));
    assert.equal(manifest.format, "artoo-backup-v1"); assert.equal(manifest.database.name, "database.tar.gz");
    assert.equal(manifest.artifacts.length, 1);
    for (const entry of [manifest.database, ...manifest.artifacts]) {
      const bytes = readFileSync(join(backup, entry === manifest.database ? "" : "artifacts", entry.name));
      assert.equal(bytes.length, entry.size); assert.equal(sha256(bytes), entry.sha256);
    }
    assert.equal(manifest.artifacts[0].sha256, sha256(expectedBytes));
    report.backup = { format: manifest.format, database_bytes: manifest.database.size, database_sha256: manifest.database.sha256, artifact_count: manifest.artifacts.length, artifact_sha256: manifest.artifacts[0].sha256 };
    check("Offline storage CLI backup and independent manifest verification preserve the database archive and every artifact byte");
    await storage("restore", [backup, restored], data);
    await storage("restore", [backup, restored], data, /refusing overwrite/);
    const corruptBackup = join(temporary, "corrupt-backup"), rejected = join(temporary, "rejected-restore");
    cpSync(backup, corruptBackup, { recursive: true });
    writeFileSync(join(corruptBackup, "artifacts", manifest.artifacts[0].name), "corrupt fixture bytes");
    await storage("restore", [corruptBackup, rejected], data, /checksum mismatch/);
    assert.equal(existsSync(rejected), false);
    assert.equal(readdirSync(temporary).some((name) => name.startsWith("rejected-restore.partial-")), false);
    check("Restore refuses overwriting an existing target and rejects a corrupt artifact without publishing a partial recovery");
    // Make the original database and execution output unavailable, so a passing
    // download cannot accidentally depend on the old deployment or workspace.
    rmSync(data, { recursive: true, force: true });
    rmSync(join(workspace, "recovery-proof.txt"), { force: true });
    assert.equal(existsSync(data), false);
    assert.equal(existsSync(join(workspace, "recovery-proof.txt")), false);
    await start(restored);
    assert.deepEqual((await request("/auth/session", { token: ownerToken })).user, identity.user);
    assert.deepEqual(await request("/auth/session"), identity);
    const recovered = await request(`/api/v1/tasks/${taskId}`);
    assert.equal(recovered.task.status, "done"); assert.equal(recovered.task.title, taskBody.title);
    assert.deepEqual(recovered.artifacts, snapshot.artifacts); assert.equal(recovered.runs.length, 1); assert.equal(recovered.runs[0].id, snapshot.runs[0].id);
    assert.deepEqual(await artifactBytes(artifact.uri), expectedBytes);
    node = makeNode(); await node.start(); await until(nodeOnline, "The restored server rejected the original node credential");
    check("With original data and workspace artifact removed, restored server preserves account/session, control/node credentials, completed run and artifact bytes");
    assert.equal((await request("/api/v1/tasks", { body: taskBody, key: taskKey, status: 201 })).task.id, taskId);
    assert.equal((await request(messagePath, { body: messageBody, key: messageKey, status: 201 })).message.id, message.id);
    await request("/api/v1/tasks", { body: { ...taskBody, title: "Conflicting replay must not be written" }, key: taskKey, status: 409 });
    const tasks = (await request("/api/v1/tasks?project_id=proj_artoo")).tasks;
    assert.equal(tasks.length, 1); assert.equal(tasks[0].id, taskId);
    assert.equal((await request(messagePath)).messages.filter((item) => item.body === messageBody.body).length, 1);
    const afterBody = { kind: "text", body: "A new authenticated message was committed after recovery.", client_request_id: randomUUID() };
    const afterKey = randomUUID();
    const afterMessage = (await request(messagePath, { body: afterBody, key: afterKey, status: 201 })).message;
    assert.equal((await request(messagePath, { body: afterBody, key: afterKey, status: 201 })).message.id, afterMessage.id);
    assert.equal((await request(messagePath)).messages.filter((item) => item.body === afterBody.body).length, 1);
    report.recovery = { task_id: taskId, room_id: roomId, artifact_id: artifact.id, device_id: claimed.device.id, computer_id: computerId, original_task_count: tasks.length, original_message_copies: 1, post_restore_message_copies: 1, local_drill_elapsed_ms: Date.now() - stoppedAt };
    check("Pre-backup task/message idempotency survives restore; conflicting replay is rejected; a new post-restore write is also applied once");
    await capture("after-restore.png", "After restore to a new data directory: the same account sees the completed task, original message and downloadable artifact");
    const downloadEvent = page.waitForEvent("download", { timeout: 20_000 });
    await page.getByRole("button", { name: "Download artifact", exact: true }).click();
    const download = await downloadEvent, downloaded = join(temporary, "downloaded-proof.txt");
    await download.saveAs(downloaded); assert.equal(await download.failure(), null); assert.deepEqual(readFileSync(downloaded), expectedBytes);
    check("Restored production Web UI renders the persisted task/message and downloads the exact original artifact through its normal control");
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
    console.error(`[recovery] ${report.error}`);
    // The only UI visited is the authenticated synthetic task; no pairing or
    // secret-entry form is captured, including in a failed run.
    if (page && !page.isClosed() && page.url().startsWith(`${origin}/`)) {
      const path = join(output, "failure.png");
      await page.screenshot({ path, fullPage: false, timeout: 5000 }).then(() => screenshots.push({ path, caption: "Synthetic recovery workspace at the failing step" })).catch(() => {});
    }
  } finally {
    const cleanup = {};
    if (browserServer) {
      try { cleanup.browser = await closeOwnedBrowser(browserServer); }
      catch { cleanup.browser = { closed: false, error: "Owned browser cleanup failed" }; }
    } else cleanup.browser = { closed: true, not_started: true };
    for (const [name, resource] of [["node", node], ["server", server]]) {
      try { if (resource) await (name === "node" ? resource.stop() : resource.close()); cleanup[`${name}_closed`] = true; }
      catch { cleanup[`${name}_closed`] = false; }
    }
    try {
      if (temporary) {
        assert.ok(temporary.startsWith(`${realpathSync(tmpdir())}${sep}artoo-recovery-`), "Refusing removal outside this drill's temporary directory");
        rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
      cleanup.temporary_directory_removed = !temporary || !existsSync(temporary);
    } catch { cleanup.temporary_directory_removed = false; }
    report.cleanup = cleanup;
    report.cleanup_complete = cleanup.browser.closed && cleanup.node_closed && cleanup.server_closed && cleanup.temporary_directory_removed;
    if (!report.cleanup_complete) { report.passed = false; report.error ??= "Recovery drill cleanup was incomplete"; process.exitCode = 1; }
    process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onTerminate);
    report.finished_at = new Date().toISOString();
    writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
    writeE2EReport({ outputPath: html, title, report, screenshots });
    console.log(`[recovery] HTML report: ${html}`);
    console.log(`[recovery] ${report.passed ? "PASS" : "FAIL"}; cleanup=${report.cleanup_complete}`);
    // Embedded database shutdown can reset process.exitCode. Decide the CLI
    // outcome only after every cleanup step and report write has completed.
    process.exitCode = report.passed ? 0 : 1;
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
