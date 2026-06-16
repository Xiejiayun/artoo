import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeCodeRuntime, createNodeClient } from "@artoo/artood";
import type { NodeToServerMessage, RunEventMessage } from "@artoo/protocol";
import { createInProcessChannel } from "@artoo/testkit";
import { afterEach, describe, expect, it } from "vitest";

import { attachNodeBinding } from "./node-binding.js";
import { buildTestServer, type TestServer } from "./test-support.js";

/**
 * Gated TRUE Claude runtime smoke (#15/#17/#10 v1 evidence). Opt-in ONLY: skipped
 * unless ARTOO_CLAUDE_SMOKE=1, and it spawns the REAL `claude` CLI (auth/quota/
 * network risk) — enabled explicitly by codex on Jeremy's authority.
 *   ARTOO_CLAUDE_SMOKE=1 npx vitest run apps/server/src/claude-runtime-smoke.test.ts
 *
 * It drives the full seam with a real claude-code runtime: REST create/ready/
 * assign -> server persists run + ContextPack -> run.start over the in-process
 * channel -> a real node-client spawns the real `claude` CLI (claudeCodeRuntime
 * preset) inside an isolated tmp workspace -> claude produces changes.patch ->
 * run completes -> the server drives the task to review and exposes an audit
 * bundle. The workspace is under the OS temp dir, never the project repo.
 */
const ENABLED = process.env.ARTOO_CLAUDE_SMOKE === "1";

function isRunEvent(m: NodeToServerMessage): m is RunEventMessage {
  return m.kind === "run.event";
}

describe.skipIf(!ENABLED)("gated true Claude runtime smoke (real claude CLI)", () => {
  let server: TestServer | undefined;
  const cleanups: Array<() => void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
    await server?.close();
    server = undefined;
  });

  it(
    "assign -> real claude runtime -> changes.patch artifact -> review",
    async () => {
      const wsParent = mkdtempSync(join(tmpdir(), "artoo-claude-ws-"));
      cleanups.push(() => rmSync(wsParent, { recursive: true, force: true }));
      const workspaceRoot = join(wsParent, "run");
      if (!workspaceRoot.startsWith(tmpdir())) {
        throw new Error("claude smoke refuses to operate outside the OS temp dir");
      }
      // Ordinary (non-branch) runs assume the workspace already exists — the node
      // does not materialize it. Create the isolated tmp workspace up front.
      mkdirSync(workspaceRoot, { recursive: true });

      server = await buildTestServer({ workspaceRoot });

      const channel = createInProcessChannel();
      const binding = attachNodeBinding(server.ctx, channel.serverTransport);
      server.ctx.onRunQueued = (runId) => binding.dispatchRunStart(runId);
      cleanups.push(() => binding.close());

      // REAL claude-code runtime adapter (spawns the real `claude` CLI).
      const registration = claudeCodeRuntime({ allowedRoots: [wsParent] });
      const node = createNodeClient({
        nodeId: "computer_local_mock",
        transport: channel.node,
        adapter: registration.adapter
      });
      node.start();
      cleanups.push(() => {
        void node.stop();
      });

      const received: NodeToServerMessage[] = [];
      const terminal = new Promise<void>((resolve) => {
        channel.serverTransport.subscribe((m) => {
          received.push(m);
          const terminalLifecycle =
            isRunEvent(m) &&
            m.event.type === "run.lifecycle" &&
            ["completed", "failed", "cancelled"].includes(m.event.payload.phase);
          // A rejected run.start arrives as a command.ack, not a run.event — resolve
          // on it too so a spawn/auth failure surfaces instead of hanging.
          const rejectedAck = m.kind === "command.ack" && m.status === "rejected";
          if (terminalLifecycle || rejectedAck) {
            resolve();
          }
        });
      });

      const created = await server.app.inject({
        method: "POST",
        url: "/api/v1/tasks",
        payload: {
          project_id: "proj_artoo",
          title: "claude smoke: create a marker file",
          description:
            "Create a new file named greeting.txt in the current working directory whose only content is exactly this single line: ARTOO-CLAUDE-SMOKE-OK. This is a real change, so the changes.patch run artifact should contain its diff. Do not access the network.",
          acceptance_criteria: ["greeting.txt exists containing ARTOO-CLAUDE-SMOKE-OK"],
          required_capabilities: ["code.modify"]
        }
      });
      const taskId = created.json().task.id as string;
      await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
      const assignRes = await server.app.inject({
        method: "POST",
        url: `/api/v1/tasks/${taskId}/assign`,
        payload: { mode: "auto" }
      });
      const run = assignRes.json().run as { id: string; runtime?: string };

      await terminal;
      await node.stop();
      await binding.drain();

      // ---- Evidence capture (no credentials/auth output) ----
      const runEvents = received.filter(isRunEvent);
      const phases = runEvents
        .filter((e) => e.event.type === "run.lifecycle")
        .map((e) => (e.event.type === "run.lifecycle" ? e.event.payload.phase : ""));
      const artifactEvents = runEvents.filter((e) => e.event.type === "artifact.created");
      const patchPath = join(workspaceRoot, "changes.patch");
      const patchExists = existsSync(patchPath);
      const patchBytes = patchExists ? readFileSync(patchPath) : Buffer.alloc(0);
      const patchSha = patchExists ? createHash("sha256").update(patchBytes).digest("hex") : null;
      const greetingPath = join(workspaceRoot, "greeting.txt");
      const greetingExists = existsSync(greetingPath);
      const greetingContent = greetingExists ? readFileSync(greetingPath, "utf8").trim() : "";
      const outputEvents = runEvents.filter((e) => e.event.type === "run.output");
      const outputBytes = outputEvents.reduce(
        (n, e) => n + (e.event.type === "run.output" ? e.event.payload.text.length : 0),
        0
      );
      const snap = await server.app.inject({ method: "GET", url: `/api/v1/tasks/${taskId}` });
      const taskStatus = snap.json().task.status as string;
      const auditExport = await server.app.inject({
        method: "GET",
        url: `/api/v1/tasks/${taskId}/audit-bundle/export`
      });

      // eslint-disable-next-line no-console
      console.log(
        "CLAUDE_SMOKE_EVIDENCE " +
          JSON.stringify(
            {
              taskId,
              runId: run.id,
              runtimeLabel: run.runtime ?? "(seed=mock; adapter=real claude-code preset)",
              lifecyclePhases: phases,
              runOutputEvents: outputEvents.length,
              runOutputBytes: outputBytes,
              artifactCount: artifactEvents.length,
              greetingFile: { exists: greetingExists, content: greetingContent.slice(0, 120) },
              changesPatch: { exists: patchExists, sha256: patchSha, bytes: patchBytes.length },
              taskStatus,
              auditExport: { httpStatus: auditExport.statusCode, bodyBytes: auditExport.body.length }
            },
            null,
            2
          )
      );

      // Proves the real claude runtime end-to-end: a real claude process read the
      // task (delivered inline via the #5310bea ContextPack fix), DID THE WORK
      // (created greeting.txt with the exact marker), produced the changes.patch
      // artifact, the run reached completed, the task advanced to review, and the
      // audit bundle exports.
      expect(greetingExists).toBe(true);
      expect(greetingContent).toContain("ARTOO-CLAUDE-SMOKE-OK");
      expect(phases).toContain("started");
      expect(phases).toContain("completed");
      expect(outputEvents.length).toBeGreaterThan(0);
      expect(artifactEvents.length).toBeGreaterThan(0);
      expect(taskStatus).toBe("review");
      expect(auditExport.statusCode).toBe(200);
    },
    300_000
  );
});
