import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { agentInstances } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./test-support.js";

const bundle = fileURLToPath(new URL("../../desktop/daemon/artood.mjs", import.meta.url));
const COMPUTER = "computer_local_mock";
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 12_000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("desktop worker verification timeout");
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Build with npm run bundle-daemon --workspace @artoo/desktop before this gate.
// Uses a temporary npm Codex shim; no real AI binary/model/network is invoked.
describe.skipIf(process.platform !== "win32" || !existsSync(bundle))("bundled Windows execution worker", () => {
  let server: TestServer | undefined;
  let worker: ChildProcess | undefined;
  let workspace: string | undefined;
  let pids: number[] = [];
  afterEach(async () => {
    if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    if (pids.length > 0) await until(() => pids.every((pid) => !alive(pid)));
    await server?.close();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
    server = undefined; worker = undefined; workspace = undefined; pids = [];
  });

  async function launch(): Promise<{ runId: string; exit: Promise<number | null> }> {
    workspace = mkdtempSync(join(tmpdir(), "artoo-desktop-worker-"));
    const shimDir = join(workspace, "bin");
    mkdirSync(shimDir);
    writeFileSync(join(shimDir, "codex.cmd"), '@ECHO off\r\n"%_prog%" "%dp0%\\fake-cli.mjs" %*\r\n');
    writeFileSync(join(shimDir, "fake-cli.mjs"), `import {spawn} from 'node:child_process';
import {appendFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
if(process.argv[2]==='child') {writeFileSync('child.pid',String(process.pid));setInterval(()=>appendFileSync('child.log','x'),20);}
else {writeFileSync('parent.pid',String(process.pid));spawn(process.execPath,[fileURLToPath(import.meta.url),'child'],{stdio:'inherit'});setInterval(()=>appendFileSync('parent.log','x'),20);}
`);
    server = await buildTestServer({ workspaceRoot: workspace, enableDevRoutes: false });
    await server.db.db.update(agentInstances).set({ runtime: "codex" }).where(eq(agentInstances.id, "instance_mock_coder"));
    const address = await server.app.listen({ port: 0, host: "127.0.0.1" });
    worker = spawn(process.execPath, [bundle], { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: {
      ...process.env, PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`, NODE_ENV: "production", ELECTRON_RUN_AS_NODE: "1",
      ARTOO_NODE_URL: `${address.replace("http:", "ws:")}/api/v1/node?token=dev`, ARTOO_NODE_ID: COMPUTER,
      ARTOO_ALLOWED_ROOTS: workspace, ARTOO_RUNTIMES: "codex", ARTOO_HEARTBEAT_INTERVAL_MS: "25",
    } });
    let diagnostic = "";
    worker.stderr?.on("data", (data: Buffer) => { diagnostic += data.toString(); });
    const exit = new Promise<number | null>((resolve) => worker!.once("exit", resolve));
    await until(() => {
      if (worker!.exitCode !== null) throw new Error(`worker exited: ${diagnostic}`);
      return server!.nodeRegistry.get(COMPUTER) !== undefined;
    });
    const taskId = (await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Managed worker stop", acceptance_criteria: ["stopped"], required_capabilities: ["code.modify"],
    } })).json().task.id as string;
    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto" } });
    expect(assigned.statusCode, assigned.body).toBe(200);
    await until(() => existsSync(join(workspace!, "parent.log")) && existsSync(join(workspace!, "child.log")));
    pids = ["parent.pid", "child.pid"].map((name) => Number(readFileSync(join(workspace!, name), "utf8")));
    return { runId: assigned.json().run.id as string, exit };
  }

  it("IPC shutdown confirms CLI and descendant exit before worker success", async () => {
    const { runId, exit } = await launch();
    worker!.send({ type: "shutdown" });
    expect(await exit).toBe(0);
    expect(pids.every((pid) => !alive(pid))).toBe(true);
    await until(async () => (await server!.app.inject({ method: "GET", url: `/api/v1/runs/${runId}` })).json().run.status === "cancelled");
  });

  it("a crashed daemon's independent guardian terminates its CLI process tree", async () => {
    const { exit } = await launch();
    worker!.kill("SIGKILL");
    await exit;
    await until(() => pids.every((pid) => !alive(pid)));
    expect(pids.every((pid) => !alive(pid))).toBe(true);
  });
});
