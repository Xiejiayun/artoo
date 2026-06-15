#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = resolve(repoRoot, "apps/server/dist/main.js");
const help = process.argv.includes("--help") || process.argv.includes("-h");

if (help) {
  console.log(`Artoo v1 demo

Usage:
  npm run build
  npm run demo:v1

Environment:
  ARTOO_DEMO_BASE_URL        Use an already-running server instead of starting one.
                             Accepts either http://host:port or http://host:port/api/v1.
  ARTOO_DEMO_PORT            Port for the temporary server. Default: pick a free port.
  ARTOO_DEMO_WORKSPACE_ROOT  Workspace root for the temporary server.
                             Default: a new temp directory.
  ARTOO_DEMO_VERBOSE=1       Print temporary server stdout/stderr.
`);
  process.exit(0);
}

const verbose = process.env.ARTOO_DEMO_VERBOSE === "1";
const demoId = `v1-demo-${Date.now()}-${randomUUID().slice(0, 8)}`;
const externalBaseUrl = process.env.ARTOO_DEMO_BASE_URL;
let serverProcess;
let serverLog = "";

try {
  const baseUrl =
    externalBaseUrl !== undefined && externalBaseUrl.trim() !== ""
      ? normalizeBaseUrl(externalBaseUrl)
      : await startTemporaryServer();

  const bootstrap = await waitForBootstrap(baseUrl);
  const project = bootstrap.projects?.[0];
  assert(project?.id, "bootstrap returned at least one project");

  const created = await api(baseUrl, "POST", "/tasks", {
    idempotencyKey: `${demoId}:create`,
    body: {
      project_id: project.id,
      title: `Artoo v1 demo ${demoId}`,
      description: "Deterministic release demo driven by scripts/v1-demo.mjs.",
      priority: "p2",
      acceptance_criteria: ["server run completes", "audit export proof validates"],
    },
  });
  const taskId = created.task?.id;
  const roomId = created.room?.id;
  assert(taskId, "task was created");
  assert(roomId, "task room was created");

  await api(baseUrl, "POST", `/rooms/${roomId}/messages`, {
    body: {
      kind: "text",
      body: "Demo transcript: ready, assign, mock execute, accept, export audit proof.",
    },
  });

  await api(baseUrl, "POST", `/tasks/${taskId}/ready`, {
    idempotencyKey: `${demoId}:ready`,
  });

  const assigned = await api(baseUrl, "POST", `/tasks/${taskId}/assign`, {
    idempotencyKey: `${demoId}:assign`,
    body: { write_paths: ["demo/changes.patch"] },
  });
  const runId = assigned.run?.id;
  assert(runId, "task assignment created a run");

  await api(baseUrl, "POST", `/dev/runs/${runId}/mock-execute`, {
    idempotencyKey: `${demoId}:mock-execute`,
  });

  const reviewed = await api(baseUrl, "POST", `/tasks/${taskId}/review`, {
    idempotencyKey: `${demoId}:review`,
    body: {
      outcome: "accepted",
      comment: "v1 demo accepted after mock runtime completion.",
    },
  });
  assert(reviewed.task?.status === "done", `task reached done, got ${reviewed.task?.status}`);

  const bundleResponse = await api(baseUrl, "GET", `/tasks/${taskId}/audit-bundle`);
  const exportResponse = await api(baseUrl, "GET", `/tasks/${taskId}/audit-bundle/export`);
  const exported = exportResponse.export;

  assert(exported?.schema_version === "v1alpha1", "audit export schema_version is v1alpha1");
  assert(exported.signature === null, "audit export is explicitly unsigned");
  assert(exported.signing?.status === "deferred", "audit export records signing deferral");
  assert(stableJson(exported.bundle) === stableJson(bundleResponse.bundle), "export bundle matches audit bundle");
  assert(exported.bundle.task?.status === "done", "exported task evidence is done");
  assert(
    exported.bundle.runs?.some((run) => run.id === runId && run.status === "completed"),
    "export includes completed run",
  );
  assert(exported.bundle.artifacts?.length > 0, "export includes at least one artifact");
  assert(exported.bundle.scheduler_decisions?.length > 0, "export includes scheduler decision evidence");
  assert(exported.bundle.events?.length > 0, "export includes event-log evidence");

  const expectedHash = `sha256:${sha256(stableJson(exported.bundle))}`;
  assert(exported.bundle_sha256 === expectedHash, "bundle_sha256 matches canonical redacted bundle JSON");

  console.log("Artoo v1 demo passed.");
  console.log(`- API base: ${baseUrl}`);
  console.log(`- project: ${project.id}`);
  console.log(`- task: ${taskId} (${exported.bundle.task.status})`);
  console.log(`- run: ${runId} (completed)`);
  console.log(`- artifacts: ${exported.bundle.artifacts.map((artifact) => artifact.uri).join(", ")}`);
  console.log(`- audit bundle: ${exported.bundle_sha256}`);
  console.log(`- signing: ${exported.signing.status}`);
} finally {
  await stopTemporaryServer();
}

async function startTemporaryServer() {
  if (!existsSync(serverEntry)) {
    throw new Error(`missing built server at ${serverEntry}; run npm run build first`);
  }

  const host = "127.0.0.1";
  const port =
    process.env.ARTOO_DEMO_PORT !== undefined && process.env.ARTOO_DEMO_PORT.trim() !== ""
      ? Number(process.env.ARTOO_DEMO_PORT)
      : await findFreePort(host);
  assert(Number.isInteger(port) && port > 0, `invalid ARTOO_DEMO_PORT: ${process.env.ARTOO_DEMO_PORT}`);

  const workspaceRoot =
    process.env.ARTOO_DEMO_WORKSPACE_ROOT !== undefined &&
    process.env.ARTOO_DEMO_WORKSPACE_ROOT.trim() !== ""
      ? process.env.ARTOO_DEMO_WORKSPACE_ROOT
      : mkdtempSync(join(tmpdir(), "artoo-v1-demo-"));

  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ARTOO_HOST: host,
      ARTOO_PORT: String(port),
      ARTOO_WORKSPACE_ROOT: workspaceRoot,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout?.on("data", (chunk) => collectServerLog("stdout", chunk));
  serverProcess.stderr?.on("data", (chunk) => collectServerLog("stderr", chunk));

  return normalizeBaseUrl(`http://${host}:${port}`);
}

async function stopTemporaryServer() {
  if (serverProcess === undefined || serverProcess.exitCode !== null) {
    return;
  }
  const exited = once(serverProcess, "exit");
  serverProcess.kill("SIGTERM");
  await Promise.race([exited, delay(3_000)]);
  if (serverProcess.exitCode === null && serverProcess.signalCode === null) {
    serverProcess.kill("SIGKILL");
    await Promise.race([once(serverProcess, "exit"), delay(1_000)]);
  }
}

function collectServerLog(label, chunk) {
  const text = chunk.toString();
  serverLog = `${serverLog}[${label}] ${text}`.slice(-8_000);
  if (verbose) {
    process.stderr.write(`[server:${label}] ${text}`);
  }
}

async function waitForBootstrap(baseUrl) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    if (serverProcess !== undefined && serverProcess.exitCode !== null) {
      throw new Error(`server exited before readiness\n${serverLog}`);
    }
    try {
      return await api(baseUrl, "GET", "/bootstrap");
    } catch (err) {
      lastError = err;
      await delay(250);
    }
  }
  throw new Error(`server did not become ready: ${lastError?.message ?? "unknown"}\n${serverLog}`);
}

async function api(baseUrl, method, path, options = {}) {
  const headers = { accept: "application/json" };
  if (options.idempotencyKey !== undefined) {
    headers["Idempotency-Key"] = options.idempotencyKey;
  }
  let body;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const response = await fetch(`${baseUrl}${path}`, { method, headers, body });
  const text = await response.text();
  const data = text === "" ? null : JSON.parse(text);
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with ${response.status}: ${text}`);
  }
  return data;
}

function normalizeBaseUrl(value) {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;
}

async function findFreePort(host) {
  const server = createServer();
  server.unref();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : undefined;
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  if (port === undefined) {
    throw new Error("could not allocate a demo port");
  }
  return port;
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortJson(value[key]);
    }
    return sorted;
  }
  return value;
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
