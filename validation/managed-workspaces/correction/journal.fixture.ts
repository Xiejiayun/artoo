import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { provisionLocalJournal, type JournalOptions } from "../../../apps/artood/dist/managed/journal.js";
import { allocateWorkspaceRoot } from "@artoo/protocol";
import type { StartRequest } from "../../../apps/artood/dist/managed/journal-types.js";

export const observations: unknown[] = [];
interface Lifetime { pid?: number; spawnedAt?: string; exitedAt?: string; closedAt?: string; exit?: number | null; signal?: string | null; childAbsentAt?: string; groupAbsentAt?: string }
interface Response { id?: string; kind?: string; ok?: boolean; value?: unknown; error?: string }
export function absent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
}
async function drainOwnedAbsence(pid: number): Promise<{ childAbsentAt: string; groupAbsentAt: string }> {
  const deadline = performance.now() + 5000, observed = new Map<number, string>();
  let lastUnknown: string | undefined;
  while (performance.now() < deadline) {
    for (const target of [pid, -pid]) {
      if (observed.has(target)) continue; // ESRCH is latched; never probe a reused identity.
      try { if (absent(target)) observed.set(target, new Date().toISOString()); }
      catch (error) { lastUnknown = String(error); } // EPERM/other errors are never absence.
    }
    if (observed.size === 2 && performance.now() <= deadline) {
      return { childAbsentAt: observed.get(pid)!, groupAbsentAt: observed.get(-pid)! };
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
  }
  throw new Error(`Owned fixture PID/group absence remains unconfirmed after 5 seconds${lastUnknown ? `: ${lastUnknown}` : ""}`);
}
export async function finite<T>(promise: Promise<T>, milliseconds = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Owned fixture deadline exceeded")), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const identity = (path: string) => { const s = lstatSync(path, { bigint: true }); return `${s.dev}:${s.ino}`; };
export class FixtureClient {
  readonly lifetime: Lifetime = {};
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<Response>;
  readonly closed: Promise<void>;
  readonly replies: Response[] = [];
  readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  stderr = "";
  private expectedExit = 0;
  constructor(configurationPath: string) {
    this.child = spawn(process.execPath, [fileURLToPath(new URL("./dist/journal-child.mjs", import.meta.url)), configurationPath], {
      detached: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: "" },
    });
    this.child.once("spawn", () => { this.lifetime.pid = this.child.pid; this.lifetime.spawnedAt = new Date().toISOString(); });
    this.child.once("exit", (code, signal) => { Object.assign(this.lifetime, { exitedAt: new Date().toISOString(), exit: code, signal }); });
    this.closed = new Promise((resolve) => this.child.once("close", () => { this.lifetime.closedAt = new Date().toISOString(); for (const waiter of this.pending.values()) waiter.reject(new Error("Fixture exited before command reply")); this.pending.clear(); resolve(); }));
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr += chunk.toString(); });
    const lines = createInterface({ input: this.child.stdout });
    this.ready = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      lines.on("line", (line) => {
        let value: Response;
        try { value = JSON.parse(line) as Response; } catch { reject(new Error(`Unexpected owned child output: ${line}`)); return; }
        this.replies.push(value);
        if (value.kind === "ready") resolve(value);
        if (value.kind === "failed") reject(new Error(value.error));
        if (!value.id) return;
        const waiter = this.pending.get(value.id); if (!waiter) return;
        this.pending.delete(value.id);
        if (value.ok) waiter.resolve(value.value); else waiter.reject(new Error(value.error));
      });
    });
  }
  async send<T = unknown>(op: string, input: Record<string, unknown> = {}): Promise<T> {
    await finite(this.ready);
    const id = randomUUID();
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.child.stdin.write(JSON.stringify({ id, op, ...input }) + "\n", (error) => { if (error) reject(error); });
    });
    return finite(response, op === "physical" ? 60000 : 15000);
  }
  expectInitializationFailure(): void { this.expectedExit = 1; }
  async close(): Promise<void> {
    if (!this.lifetime.closedAt) {
      if (this.lifetime.exitedAt === undefined) {
        if (this.expectedExit === 1) this.child.stdin.end();
        else { try { await this.send("close"); } finally { this.child.stdin.end(); } }
      }
      await finite(this.closed, 12000);
    }
    if (this.lifetime.pid === undefined || !this.lifetime.exitedAt || !this.lifetime.closedAt) throw new Error("Fixture child/stdio cleanup is not confirmed");
    if (!this.lifetime.childAbsentAt || !this.lifetime.groupAbsentAt) {
      Object.assign(this.lifetime, await drainOwnedAbsence(this.lifetime.pid));
    }
    if (this.lifetime.exit !== this.expectedExit || this.lifetime.signal !== null) throw new Error("Fixture child did not reach its explicitly expected exit");
  }
}

export async function fixture() {
  if (!tmpdir().startsWith("/private/tmp/artoo-journal-correction-validation-") || !existsSync(join(tmpdir(), ".validation-owner"))) {
    throw new Error("Persistent journal fixtures require the task-owned validation parent");
  }
  const root = mkdtempSync(join(tmpdir(), "artoo-journal-fixture-"));
  const marker = randomUUID(), originalIdentity = identity(root);
  writeFileSync(join(root, ".fixture-owner"), marker, { flag: "wx", mode: 0o600 });
  const location = { directory: join(root, "journal"), controllerScope: "fixture-controller", nodeId: "fixture-node" };
  const provisioned = await provisionLocalJournal(location);
  const options: JournalOptions = { ...location, expectedNamespace: provisioned.namespace };
  const clients: FixtureClient[] = [];
  return { root, options, provisioned, clients,
    payload(suffix: string): StartRequest {
      const runId = `run_${suffix}`, taskId = `task_${suffix}`, base = join(root, "workspaces"), instance = "ai_journal";
      const workspaceRoot = allocateWorkspaceRoot({ workspaceRoot: base, branchBacked: true, targetComputerOs: process.platform,
        agentInstanceId: instance, runId, worktreeBase: { version: 1, strategy: "per-run", basePath: base } })!;
      return { expectedNamespace: options.expectedNamespace, runId, idempotencyKey: `${runId}:start`, payload: {
        run_id: runId, task_id: taskId, agent_instance_id: instance, runtime: "process",
        workspace: { root: workspaceRoot, branch: `user/jiaxie/journal-${suffix}` },
        workspace_allocation: { version: 1, strategy: "per-run", base_path: base }, workspace_retention_reporting: "typed-v1",
        context_pack: { id: `ctx_${suffix}`, payload: { task: { id: taskId, title: "Journal fixture", description: "Preserve exact launch", acceptance_criteria: ["one durable admission"] },
          project: { id: "project_journal", name: "Journal fixture", default_workspace: null },
          workspace: { root: workspaceRoot, file_scope: ["tracked.txt"] }, policy: { filesystem_write_scope: ["tracked.txt"], requires_approval: [] },
          memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] } } },
        policy_snapshot: { filesystem_write_scope: [workspaceRoot], requires_approval: [] }, artifact_rules: { paths: [] },
      } };
    },
    async client(extra: Partial<JournalOptions> = {}, role: "client" | "locker" | "storage-fixture" = "client", storage?: { fixtureAction: string; fixtureRunId?: string; fixtureValue?: number }) {
      const path = join(root, `client-${clients.length}.json`);
      writeFileSync(path, JSON.stringify({ role, options: { ...options, ...extra }, databasePath: join(location.directory, "journal.sqlite"), ...storage }), { flag: "wx", mode: 0o600 });
      const client = new FixtureClient(path); clients.push(client); await finite(client.ready); return client;
    },
    async close(remove: boolean) {
      let failed: unknown;
      for (const client of [...clients].reverse()) { try { await client.close(); } catch (error) { failed ??= error; } }
      const confirmed = failed === undefined;
      observations.push({ case: "fixture-cleanup", root, removed: remove && confirmed, confirmed,
        clients: clients.map((c) => ({ lifetime: c.lifetime, replies: c.replies, stderr: c.stderr })), ...(failed ? { error: String(failed) } : {}) });
      if (!confirmed) throw failed;
      if (identity(root) !== originalIdentity || readFileSync(join(root, ".fixture-owner"), "utf8") !== marker) throw new Error("Fixture ownership changed");
      if (remove) { rmSync(root, { recursive: true }); if (existsSync(root)) throw new Error("Fixture removal failed"); }
    },
  };
}
