import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentInstances, computers, contextPacks, runs, tasks } from "@artoo/db";
import { ContextPackSchema, ID_PREFIXES } from "@artoo/domain";
import type {
  NodeToServerMessage,
  NodeTransport,
  RunResumeCommand,
  RunStartCommand,
  RunStopCommand,
  Unsubscribe,
} from "@artoo/protocol";
import { and, eq } from "drizzle-orm";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { validatePersistedAllocationStart } from "./persisted-allocation-start.js";
import {
  failRunDaemonDisconnect,
  failRunStart,
  ingestWireRunEvent,
} from "./services/run-service.js";

const FALLBACK_WORKSPACE_ROOT = join(tmpdir(), "artoo-workspace");

export interface NodeBinding {
  /** Exact feature support from this current accepted hello; false once disposed. */
  supportsExecutionFeature(feature: string): boolean;
  /** Build + send run.start for a queued run over the node transport. */
  dispatchRunStart(runId: string): Promise<void>;
  /** Build + send run.resume for an already-active run (#115 P2-S3 reconnect). */
  dispatchRunResume(runId: string): Promise<void>;
  /** Resolves only after the node has confirmed that the process is stopped. */
  dispatchRunStop(runId: string): Promise<void>;
  /** Deliver frames buffered by the WebSocket authentication handshake. */
  receive(message: NodeToServerMessage): void;
  /** Resolves once all received run-events have been ingested (test sync point). */
  drain(): Promise<void>;
  close(): void;
}

/**
 * Server side of the node protocol. Owns a {@link NodeTransport}: dispatches
 * run.start / run.resume commands, and ingests Node->Server messages — run.event
 * through the qualified full-frame {@link ingestWireRunEvent} receiver,
 * rejected run.start command.ack through {@link failRunStart} recovery, and
 * rejected run.resume command.ack through the daemon_disconnect failure path.
 *
 * Incoming run-events are serialized (the in-process transport delivers them
 * synchronously and the node streams in sequence order) so run/task transitions
 * apply in order. A real artood swaps the in-process transport for a WebSocket;
 * this binding is unchanged.
 */
export function attachNodeBinding(
  ctx: ServerContext,
  transport: NodeTransport,
  computerId: string,
  executionFeatures: readonly string[] = [],
  isCurrentBinding: () => boolean = () => true,
): NodeBinding {
  // Copy the accepted hello snapshot so later caller mutation cannot change it.
  const executionFeatureSet = new Set(executionFeatures);
  const pendingCommandRun = new Map<string, string>(); // command_id -> run_id (run.start)
  const pendingResumeRun = new Map<string, { runId: string; timer: ReturnType<typeof setTimeout> }>();
  const pendingStops = new Map<string, { runId: string; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const stoppingRuns = new Map<string, Promise<void>>();
  // Coalesces only this binding's concurrent calls, never durable node ownership.
  const startingRuns = new Map<string, Promise<void>>();
  let closed = false;
  async function ownsRun(runId: string): Promise<boolean> {
    const run = (await ctx.db.db.select({ computerId: runs.computerId }).from(runs)
      .where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId))))[0];
    return run?.computerId === computerId;
  }
  let tail: Promise<void> = Promise.resolve();
  const enqueue = (work: () => Promise<unknown>): void => {
    tail = tail.then(work, work).then(
      () => undefined,
      () => undefined,
    );
  };

  const receive = (message: NodeToServerMessage): void => {
    // The credential-bound identity is authoritative for every inbound frame.
    if (closed || message.node_id !== computerId) return;
    if (message.kind === "run.event") {
      // Snapshot serialized-wire semantics before queued work can observe caller mutation.
      let frame: typeof message;
      try { frame = JSON.parse(JSON.stringify(message)) as typeof message; } catch { return; }
      enqueue(async () => {
        if (!(await ownsRun(frame.run_id))) return;
        let status: "accepted" | "rejected" = "accepted";
        try {
          const result = await ingestWireRunEvent(ctx, frame);
          if (result === null) return;
          if (!result.receiptBodyIdentity) throw new Error("run event did not obtain a qualified receipt");
        } catch { status = "rejected"; }
        await transport.send({
          kind: "command", id: `receipt:${frame.run_id}:${frame.sequence}`,
          idempotency_key: `receipt:${frame.run_id}:${frame.sequence}`, type: "run.event.ack",
          payload: { run_id: frame.run_id, sequence: frame.sequence, status,
            ...(status === "rejected" ? { message: "run event could not be accepted" } : {}),
          },
        });
      });
    } else if (message.kind === "command.ack" && pendingStops.has(message.command_id)) {
      const pending = pendingStops.get(message.command_id)!;
      pendingStops.delete(message.command_id);
      clearTimeout(pending.timer);
      enqueue(async () => {
        if (!(await ownsRun(pending.runId))) pending.reject(AppError.permissionDenied("run is not owned by this node"));
        else if (message.status === "rejected") pending.reject(AppError.conflict(`node could not stop run: ${message.message}`));
        else pending.resolve();
      });
    } else if (message.kind === "command.ack" && message.status === "rejected") {
      const startRunId = pendingCommandRun.get(message.command_id);
      if (startRunId !== undefined) {
        pendingCommandRun.delete(message.command_id);
        enqueue(async () => {
          if (await ownsRun(startRunId)) await failRunStart(ctx, startRunId, message.error_code, message.message);
        });
        return;
      }
      // #115 P2-S3b: a rejected run.resume (node no longer has the process) maps to
      // the same auditable daemon_disconnect failure path — idempotent, and only
      // for a starting/running run on this connected computer.
      const resume = pendingResumeRun.get(message.command_id);
      if (resume !== undefined) {
        pendingResumeRun.delete(message.command_id);
        clearTimeout(resume.timer);
        // Only explicit process_exited proves absence. Permission/policy errors
        // and malformed/unsupported requests cannot release write leases.
        enqueue(() => failRunDaemonDisconnect(ctx, resume.runId, computerId, message.error_code === "process_exited"));
      }
    } else if (message.kind === "command.ack") {
      // Accepted: no server-side transition (resume just continues the live run).
      pendingCommandRun.delete(message.command_id);
      const resume = pendingResumeRun.get(message.command_id);
      if (resume !== undefined) {
        clearTimeout(resume.timer);
        // A process may have survived beyond grace expiry. Its run has already
        // failed, so stop that exact process and wait for confirmation before
        // allowing another execution. Do not resurrect the failed run.
        void reconcileSurvivingProcess(resume.runId).catch(() => {});
      }
      pendingResumeRun.delete(message.command_id);
    }
  };
  const unsubscribe: Unsubscribe = transport.subscribe(receive);

  async function reconcileSurvivingProcess(runId: string): Promise<void> {
    const run = (await ctx.db.db.select({ status: runs.status, failureReason: runs.failureReason }).from(runs)
      .where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId), eq(runs.computerId, computerId))))[0];
    if (closed || run?.status !== "failed" || run.failureReason !== "daemon_disconnect") return;
    await binding.dispatchRunStop(runId);
    await failRunDaemonDisconnect(ctx, runId, computerId, true);
  }

  function assertCurrentStartBinding(runId: string): void {
    if (closed || !isCurrentBinding()) {
      throw AppError.conflict("Run start blocked because the node binding is no longer current",
        { run_id: runId, dispatch: "blocked", reason: closed ? "binding_closed" : "binding_replaced" });
    }
  }

  function assertAllocationFeature(runId: string): void {
    if (!binding.supportsExecutionFeature("workspace-allocation.per-run-v1")) {
      throw AppError.conflict("Run start blocked because the current node lacks allocation support",
        { run_id: runId, dispatch: "blocked", reason: "unsupported_execution_feature" });
    }
  }

  async function sendRunStart(runId: string): Promise<void> {
    assertCurrentStartBinding(runId);
    const [run] = await ctx.db.db.select().from(runs).where(and(
      eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId),
    ));
    assertCurrentStartBinding(runId);
    if (!run || run.computerId !== computerId) throw AppError.permissionDenied("run is not owned by this node");
    if (run.status !== "queued") return;

    // Only an explicit null record selects legacy behavior.
    const allocated = run.workspaceAllocation !== null;
    if (allocated) assertAllocationFeature(runId);
    const persistedContextPack = run.contextPackId === null ? undefined
      : (await ctx.db.db.select().from(contextPacks).where(and(
        eq(contextPacks.id, run.contextPackId), eq(contextPacks.organizationId, ctx.organizationId),
      )))[0];
    assertCurrentStartBinding(runId);
    let workspaceRoot: string;
    let workspaceBranch = run.workspaceBranch;
    let allocation: RunStartCommand["payload"]["workspace_allocation"];
    let context: RunStartCommand["payload"]["context_pack"];

    if (allocated) {
      const [[computer], [task]] = await Promise.all([
        ctx.db.db.select({ os: computers.os }).from(computers).where(and(
          eq(computers.id, computerId), eq(computers.organizationId, ctx.organizationId),
        )),
        ctx.db.db.select({ projectId: tasks.projectId }).from(tasks).where(and(
          eq(tasks.id, run.taskId), eq(tasks.organizationId, ctx.organizationId),
        )),
      ]);
      assertCurrentStartBinding(runId);
      const validated = validatePersistedAllocationStart(run, persistedContextPack,
        { computerOs: computer?.os, projectId: task?.projectId });
      workspaceRoot = validated.root;
      workspaceBranch = validated.branch;
      allocation = validated.allocation;
      context = validated.context;
    } else {
      const instance = run.workspaceRoot === null
        ? (await ctx.db.db.select({ workspaceRoot: agentInstances.workspaceRoot }).from(agentInstances)
          .where(eq(agentInstances.id, run.agentInstanceId)))[0]
        : undefined;
      assertCurrentStartBinding(runId);
      workspaceRoot = run.workspaceRoot ?? instance?.workspaceRoot ?? FALLBACK_WORKSPACE_ROOT;
      const contextPackId = run.contextPackId ?? ctx.idGen.generate(ID_PREFIXES.contextPack);
      const parsed = persistedContextPack === undefined ? undefined : ContextPackSchema.safeParse(persistedContextPack.payload);
      context = parsed?.success === true
        ? { id: contextPackId, payload: parsed.data }
        : { id: contextPackId, uri: "artoo://contextpack/" + contextPackId };
    }

    // A changed terminal/ownership state observed during the reads must not send.
    const [latest] = await ctx.db.db.select({ status: runs.status, computerId: runs.computerId }).from(runs).where(and(
      eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId),
    ));
    assertCurrentStartBinding(runId);
    if (!latest || latest.computerId !== computerId) throw AppError.permissionDenied("run is not owned by this node");
    if (latest.status !== "queued") return;
    if (allocated) assertAllocationFeature(runId);

    const commandId = ctx.idGen.generate("cmd");
    const command: RunStartCommand = {
      kind: "command", id: commandId, idempotency_key: runId + ":start", type: "run.start",
      payload: {
        run_id: runId, task_id: run.taskId, agent_instance_id: run.agentInstanceId, runtime: run.runtimeId,
        workspace: { root: workspaceRoot, ...(workspaceBranch !== null ? { branch: workspaceBranch } : {}) },
        ...(allocation !== undefined ? { workspace_allocation: allocation } : {}),
        ...(run.workspaceRoot !== null && workspaceBranch !== null ? { workspace_retention_reporting: "typed-v1" } : {}),
        context_pack: context,
        // The base is metadata, never a wider write grant.
        policy_snapshot: { filesystem_write_scope: [workspaceRoot], requires_approval: ["git.push", "external.post"] },
        artifact_rules: { paths: ["artifacts/**", "*.patch"] },
      },
    };
    assertCurrentStartBinding(runId);
    if (allocated) assertAllocationFeature(runId);
    pendingCommandRun.set(commandId, runId);
    // After send is invoked, disconnect/error may still mean delivery occurred.
    // Do not fail the run or release leases from this dispatch path.
    await transport.send(command);
  }

  const binding: NodeBinding = {
    receive,
    supportsExecutionFeature(feature): boolean {
      return !closed && isCurrentBinding() && executionFeatureSet.has(feature);
    },
    async dispatchRunStart(runId: string): Promise<void> {
      assertCurrentStartBinding(runId);
      const existing = startingRuns.get(runId);
      if (existing) return existing;
      const operation = sendRunStart(runId).finally(() => { startingRuns.delete(runId); });
      startingRuns.set(runId, operation);
      return operation;
    },

    // #115 P2-S3: ask a reconnected node to continue an already-active run after a
    // brief disconnect grace window. Only the run id is sent; accepted means no
    // server transition, rejected means the node lost the process and the server
    // fails the run through the daemon_disconnect path.
    async dispatchRunResume(runId: string): Promise<void> {
      if (closed) return;
      if (!(await ownsRun(runId))) throw AppError.permissionDenied("run is not owned by this node");
      const commandId = ctx.idGen.generate("cmd");
      const timer = setTimeout(() => {
        if (closed || !pendingResumeRun.delete(commandId)) return;
        enqueue(async () => {
          await failRunDaemonDisconnect(ctx, runId, computerId);
          // Run the stop outside the ingestion queue: its ACK is itself queued.
          void reconcileSurvivingProcess(runId).catch(() => {});
        });
      }, 15_000);
      pendingResumeRun.set(commandId, { runId, timer });
      const command: RunResumeCommand = {
        kind: "command",
        id: commandId,
        idempotency_key: `${runId}:resume`,
        type: "run.resume",
        payload: { run_id: runId },
      };
      try { await transport.send(command); }
      catch (error) {
        clearTimeout(timer);
        pendingResumeRun.delete(commandId);
        await failRunDaemonDisconnect(ctx, runId, computerId);
        throw error;
      }
    },

    async dispatchRunStop(runId: string): Promise<void> {
      if (closed) throw AppError.conflict("node disconnected before process stop was confirmed");
      if (!(await ownsRun(runId))) throw AppError.permissionDenied("run is not owned by this node");
      const existing = stoppingRuns.get(runId);
      if (existing) return existing;
      const commandId = ctx.idGen.generate("cmd");
      const pending = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingStops.delete(commandId);
          reject(AppError.conflict("node did not confirm process stop; the run and write leases remain active"));
        }, 15_000);
        pendingStops.set(commandId, { runId, resolve, reject, timer });
      });
      void pending.catch(() => {}); // disconnect may reject during transport.send
      stoppingRuns.set(runId, pending);
      const command: RunStopCommand = {
        kind: "command", id: commandId, idempotency_key: `${runId}:stop`,
        type: "run.stop", payload: { run_id: runId, reason: "user_cancelled" },
      };
      try {
        try { await transport.send(command); }
        catch (error) { pendingStops.get(commandId)?.reject(error instanceof Error ? error : new Error(String(error))); }
        await pending;
      } finally {
        const entry = pendingStops.get(commandId);
        if (entry) clearTimeout(entry.timer);
        pendingStops.delete(commandId);
        stoppingRuns.delete(runId);
      }
    },

    async drain(): Promise<void> {
      // Settle the current chain, then re-check in case ingestion enqueued more.
      let previous: Promise<void>;
      do {
        previous = tail;
        await previous;
      } while (previous !== tail);
    },

    close(): void {
      closed = true;
      unsubscribe();
      for (const pending of pendingResumeRun.values()) clearTimeout(pending.timer);
      pendingResumeRun.clear();
      for (const pending of pendingStops.values()) {
        clearTimeout(pending.timer);
        pending.reject(AppError.conflict("node disconnected before process stop was confirmed"));
      }
      pendingStops.clear();
    },
  };
  return binding;
}
