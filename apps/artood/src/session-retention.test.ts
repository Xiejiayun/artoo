import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { productDevelopmentContext, type ContextPack } from "@artoo/domain";
import { createWorkspaceToolSession, type WorkspaceToolSession } from "./workspace-tools.js";
import { createResearchSession, prepareResearchOptions, type ResearchSession } from "./research.js";
import { VerificationCleanupError } from "./verification.js";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));
const roots: string[] = [], sessions: (WorkspaceToolSession | ResearchSession)[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.close().catch(() => {}); roots.push(dirname(session.configPath));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.resetAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject };
}
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-session-retention-"))); roots.push(root);
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  const context: ContextPack = { task: { id: "task", title: "Task", description: "", acceptance_criteria: [] },
    project: { id: "project", name: "Project", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] },
    artifacts: { expected: [] }, product_development: productDevelopmentContext("research") };
  const researchOptions = prepareResearchOptions({ receiptDirectory: join(root, "receipts") }, [workspace]);
  const binding = { projectId: "project", goalId: null, runId: "run", taskId: "task", workspaceRoot: workspace };
  return { root, workspace, context, researchOptions, binding };
}
function broker(session: WorkspaceToolSession | ResearchSession) {
  const config = JSON.parse(readFileSync(session.configPath, "utf8")) as { url: string; token: string };
  return (input: unknown) => fetch(config.url, { method: "POST", headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify(input) });
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

describe("invocation session retention and actual request drain", () => {
  it.each(["workspace", "research"])("retains %s files but revokes its real broker, with idempotent retention", async kind => {
    const f = fixture();
    const session = kind === "research" ? await createResearchSession(f.researchOptions, f.binding)
      : await createWorkspaceToolSession({ workspaceRoot: f.workspace, context: f.context, contextText: "context", verify: async () => { throw new Error("Unused verifier"); } });
    sessions.push(session); const send = broker(session);
    expect((await send({ tool: "invalid" })).status).toBe(400);
    await session.close({ retainFiles: true });
    expect(existsSync(session.configPath)).toBe(true); expect(existsSync(session.mcpPath)).toBe(true);
    await expect(send({ tool: "invalid" })).rejects.toThrow();
    await session.close(); expect(existsSync(session.configPath)).toBe(true);
  });
  it.each(["workspace", "research"])("preserves ordinary %s cleanup when no retention was requested", async kind => {
    const f = fixture();
    const session = kind === "research" ? await createResearchSession(f.researchOptions, f.binding)
      : await createWorkspaceToolSession({ workspaceRoot: f.workspace, context: f.context, contextText: "context", verify: async () => { throw new Error("Unused verifier"); } });
    sessions.push(session); await session.close(); expect(existsSync(dirname(session.configPath))).toBe(false);
  });
  it("joins an admitted asynchronous evidence reader after its HTTP socket has closed", async () => {
    const f = fixture(), entered = deferred<void>(), reading = deferred<never>();
    const session = await createWorkspaceToolSession({ workspaceRoot: f.workspace, context: f.context, contextText: "context",
      verify: async () => { throw new Error("Unused verifier"); }, readEvidence: async () => { entered.resolve(); return reading.promise; } });
    sessions.push(session); const request = broker(session)({ tool: "read_evidence", reference: "fixture" }).catch(() => undefined);
    try {
      await entered.promise; let closed = false;
      const closing = session.close().then(() => { closed = true; });
      void session.close({ retainFiles: true }); await nextTurn();
      expect(closed).toBe(false); expect(existsSync(session.configPath)).toBe(true);
      reading.reject(new Error("Controlled completed evidence read")); await closing; await request;
      expect(closed).toBe(true); expect(existsSync(session.configPath)).toBe(true);
    } finally { reading.reject(new Error("Fixture teardown")); await request; }
  });
  it("joins research DNS/download continuations, rather than treating socket closure as completion", async () => {
    const f = fixture(), entered = deferred<void>(), lookup = deferred<never>();
    dns.lookup.mockImplementation(async () => { entered.resolve(); return lookup.promise; });
    const session = await createResearchSession(f.researchOptions, f.binding); sessions.push(session);
    const request = broker(session)({ tool: "fetch", url: "https://example.com/controlled" }).catch(() => undefined);
    try {
      await entered.promise; let closed = false;
      const closing = session.close({ retainFiles: true }).then(() => { closed = true; }); await nextTurn();
      expect(closed).toBe(false); expect(existsSync(session.configPath)).toBe(true);
      lookup.reject(new Error("Controlled DNS completion; no external request was made")); await closing; await request;
      expect(closed).toBe(true); expect(session.receipts()).toEqual([]); expect(existsSync(session.configPath)).toBe(true);
    } finally { lookup.reject(new Error("Fixture teardown")); await request; }
  });
  it("keeps independent verifier cleanup uncertainty sticky after broker revocation", async () => {
    const f = fixture(), entered = deferred<void>(), verifier = deferred<never>(); let aborted = false;
    const session = await createWorkspaceToolSession({ workspaceRoot: f.workspace, context: f.context, contextText: "context",
      verify: async signal => { signal.addEventListener("abort", () => { aborted = true; }, { once: true }); entered.resolve(); return verifier.promise; } });
    sessions.push(session); const send = broker(session), request = send({ tool: "verify" }).catch(() => undefined);
    try {
      await entered.promise; const closing = session.close({ retainFiles: true });
      const expected = expect(closing).rejects.toBeInstanceOf(VerificationCleanupError);
      expect(aborted).toBe(true); verifier.reject(new VerificationCleanupError("Controlled unconfirmed verifier"));
      await expected; await request;
      expect(existsSync(session.configPath)).toBe(true); await expect(send({ tool: "context" })).rejects.toThrow();
      await expect(session.close()).rejects.toBeInstanceOf(VerificationCleanupError);
    } finally { verifier.reject(new VerificationCleanupError("Controlled fixture teardown")); await request; }
  });
});
