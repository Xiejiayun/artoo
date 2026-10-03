import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { agentInstances } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./test-support.js";

const execute = promisify(execFile);
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
};
async function until(predicate: () => boolean | Promise<boolean>, label: string, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(label);
}
function killOwned(pid: number, group = false) {
  try { process.kill(group ? -pid : pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

describe.skipIf(process.platform === "win32")("POSIX managed worker process ownership", () => {
  let buildRoot: string;
  let bundle: string;
  let server: TestServer | undefined;
  let workspace: string | undefined;
  let worker: ChildProcess | undefined;
  let workerClosed = true;
  let cliPid: number | undefined;
  let descendantPid: number | undefined;
  let guardianPid: number | undefined;
  beforeAll(async () => {
    buildRoot = realpathSync(mkdtempSync(join(tmpdir(), "artoo-posix-worker-build-")));
    bundle = join(buildRoot, "artood.mjs");
    // Compile only into this test's temporary directory. Do not replace the
    // application's dist or bundled daemon while another E2E run is active.
    await build({ entryPoints: [fileURLToPath(new URL("../../artood/src/main.ts", import.meta.url))], outfile: bundle,
      bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent",
      // Like the Vitest imports above, the child bundle must use this checkout's
      // source. Package exports point at dist, which is absent after npm ci and
      // can otherwise silently test stale shared code from an earlier build.
      alias: {
        "@artoo/domain": fileURLToPath(new URL("../../../packages/domain/src/index.ts", import.meta.url)),
        "@artoo/protocol": fileURLToPath(new URL("../../../packages/protocol/src/index.ts", import.meta.url)),
      },
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
      external: ["bufferutil", "utf-8-validate"] });
  });
  afterAll(() => { if (buildRoot) rmSync(buildRoot, { recursive: true, force: true }); });
  afterEach(async () => {
    // All IDs originate from our spawned worker or its fixture PID files.
    // Functional assertions run before this emergency cleanup.
    if (worker?.pid && alive(worker.pid)) killOwned(worker.pid);
    if (cliPid) killOwned(cliPid, true);
    if (guardianPid && alive(guardianPid)) killOwned(guardianPid);
    const owned = [worker?.pid, cliPid, descendantPid, guardianPid].filter((pid): pid is number => !!pid);
    try { await until(() => owned.every((pid) => !alive(pid)) && workerClosed, "Owned fixture processes did not exit during cleanup"); }
    finally {
      await server?.close();
      if (workspace) rmSync(workspace, { recursive: true, force: true });
      server = undefined; workspace = undefined; worker = undefined;
      cliPid = undefined; descendantPid = undefined; guardianPid = undefined;
    }
  });

  async function launch({ ipc = true, parentExit, inheritOutput = false }: { ipc?: boolean; parentExit?: number; inheritOutput?: boolean } = {}) {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "artoo-posix-worker-")));
    const fixture = join(workspace, "codex-fixture.mjs");
    writeFileSync(fixture, `#!${process.execPath}
import {spawn} from 'node:child_process';
import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
if(process.argv.includes('--fixture-child')) {
  writeFileSync('child.pid',String(process.pid)); setInterval(()=>appendFileSync('child.log','x'),20);
} else {
  writeFileSync('parent.pid',String(process.pid));
  spawn(process.execPath,[fileURLToPath(import.meta.url),'--fixture-child'],{stdio:${parentExit === undefined || inheritOutput ? "'inherit'" : "'ignore'"}});
  setInterval(()=>{appendFileSync('parent.log','x'); if(existsSync('exit-parent')) process.exit(${parentExit ?? 0});},20);
}
`);
    chmodSync(fixture, 0o755);
    server = await buildTestServer({ workspaceRoot: workspace, enableDevRoutes: false });
    await server.db.db.update(agentInstances).set({ runtime: "codex" }).where(eq(agentInstances.id, "instance_mock_coder"));
    const origin = await server.app.listen({ port: 0, host: "127.0.0.1" });
    worker = spawn(process.execPath, [bundle], { detached: true, stdio: ["ignore", "ignore", "pipe", ...(ipc ? ["ipc" as const] : [])], env: {
      ...process.env, NODE_ENV: "production", ELECTRON_RUN_AS_NODE: "1",
      ARTOO_NODE_URL: `${origin.replace("http:", "ws:")}/api/v1/node?token=dev`, ARTOO_NODE_ID: "computer_local_mock",
      ARTOO_ALLOWED_ROOTS: workspace, ARTOO_RUNTIMES: "codex", ARTOO_CODEX_BINARY: fixture, ARTOO_HEARTBEAT_INTERVAL_MS: "25",
      ARTOO_CODEX_PROVIDER_URL: "", ARTOO_CODEX_PROVIDER_KEY: "", ARTOO_CODEX_MODEL: "",
    } });
    workerClosed = false;
    worker.once("exit", () => { workerClosed = true; });
    let diagnostic = "";
    worker.stderr?.on("data", (data) => { diagnostic += String(data); });
    await until(() => {
      if (worker!.exitCode !== null) throw new Error(`Worker exited before registration: ${diagnostic}`);
      return server!.nodeRegistry.get("computer_local_mock") !== undefined;
    }, "Worker did not register");
    const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Owned POSIX writer", acceptance_criteria: ["No orphan writers"], required_capabilities: ["code.modify"],
    } });
    const taskId = created.json().task.id as string;
    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto" } });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const runId = assigned.json().run.id as string;
    const startupStartedAt = Date.now();
    let lastStartupPoll = startupStartedAt, startupPolls = 0;
    try {
      await until(() => {
        lastStartupPoll = Date.now(); startupPolls++;
        // Retain ownership even if only one process reaches startup, so a
        // failed startup still cleans up every PID the fixture published.
        if (existsSync(join(workspace!, "parent.pid"))) cliPid = Number(readFileSync(join(workspace!, "parent.pid"), "utf8"));
        if (existsSync(join(workspace!, "child.pid"))) descendantPid = Number(readFileSync(join(workspace!, "child.pid"), "utf8"));
        return existsSync(join(workspace!, "parent.log")) && existsSync(join(workspace!, "child.log"));
      }, "CLI fixture did not start writing");
    } catch (cause) {
      // Observe files before awaiting the database, preserving the actual
      // timeout boundary instead of a potentially later state.
      const observedAt = Date.now();
      const startup = { elapsed_ms: observedAt - startupStartedAt, last_poll_age_ms: observedAt - lastStartupPoll, polls: startupPolls,
        files: readdirSync(workspace).map((name) => { const file = statSync(join(workspace!, name)); return { name, bytes: file.size, modified_at: file.mtimeMs }; }),
        worker_exit: worker.exitCode, worker_signal: worker.signalCode, diagnostic: diagnostic.slice(-4000) };
      const run = (await server.app.inject({ method: "GET", url: `/api/v1/runs/${runId}` })).json().run;
      throw new Error(`CLI startup state: ${JSON.stringify({ startup, run_observed_at: Date.now(), run })}`, { cause });
    }
    await until(async () => {
      const { stdout } = await execute("/bin/ps", ["-axo", "pid=,ppid="]);
      const children = stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number))
        .filter(([pid, parent]) => parent === worker!.pid && pid !== cliPid);
      if (children.length !== 1) return false;
      guardianPid = children[0]![0]; return true;
    }, "Could not identify this worker's independent guardian");
    return runId;
  }

  async function assertWritersStopped() {
    await until(() => [cliPid!, descendantPid!, guardianPid!].every((pid) => !alive(pid)), "CLI, descendant or guardian survived ownership loss");
    const before = readFileSync(join(workspace!, "child.log"), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readFileSync(join(workspace!, "child.log"), "utf8")).toBe(before);
  }

  it("IPC parent disconnection stops the real node and every owned writer", async () => {
    const runId = await launch();
    worker!.disconnect();
    await until(() => workerClosed, "Worker survived desktop IPC disconnection");
    expect(worker!.exitCode).toBe(0);
    expect((await server!.app.inject({ method: "GET", url: `/api/v1/runs/${runId}` })).json().run.status).toBe("cancelled");
    await assertWritersStopped();
  });

  it("guardian stops the CLI when only the daemon PID is killed", async () => {
    await launch();
    worker!.kill("SIGKILL");
    await until(() => workerClosed, "Killed worker did not exit");
    await assertWritersStopped();
  });

  it("guardian survives loss of the daemon's owned process group", async () => {
    await launch();
    killOwned(worker!.pid!, true);
    await until(() => workerClosed, "Killed worker group did not exit");
    await assertWritersStopped();
  });

  it.each([{ code: 0, inheritOutput: false }, { code: 1, inheritOutput: false }, { code: 1, inheritOutput: true }])("CLI exit $code stops its descendant before a terminal run (inherited output: $inheritOutput)", async ({ code, inheritOutput }) => {
    const runId = await launch({ parentExit: code, inheritOutput });
    writeFileSync(join(workspace!, "exit-parent"), "exit");
    await until(async () => (await server!.app.inject({ method: "GET", url: `/api/v1/runs/${runId}` })).json().run.status === (code === 0 ? "completed" : "failed"), "Run did not reach its expected terminal state");
    expect(alive(descendantPid!), "Terminal run still has a workspace writer").toBe(false);
    await assertWritersStopped();
  });

  it("a standalone worker without IPC continues running and shuts down on SIGTERM", async () => {
    const runId = await launch({ ipc: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(workerClosed).toBe(false); expect(alive(cliPid!)).toBe(true);
    worker!.kill("SIGTERM");
    await until(() => workerClosed, "Standalone worker did not shut down");
    expect(worker!.exitCode).toBe(0);
    expect((await server!.app.inject({ method: "GET", url: `/api/v1/runs/${runId}` })).json().run.status).toBe("cancelled");
    await assertWritersStopped();
  });
});
