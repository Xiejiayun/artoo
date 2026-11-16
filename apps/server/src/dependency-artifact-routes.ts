import { artifacts, contextPacks, runs, schedulerExecutionLeases, schedulerExecutionRequests, taskDependencies, tasks } from "@artoo/db";
import { ContextPackSchema, parseDeviceToken } from "@artoo/domain";
import { ContentAddressedBlobNotFoundError } from "@artoo/storage";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ServerContext } from "./context.js";
import { blobChecksum, readContentAddressedBlob, type ContentAddressedBlobSource } from "./content-addressed-blob.js";
import { AppError } from "./errors.js";
import { requireRunAiSharingAuthorization } from "./services/ai-data-sharing-service.js";
import { resolveNodeToken } from "./services/device-service.js";

const MAX_BYTES = 10 * 1024 * 1024;
const active = ["queued", "starting", "running", "paused", "awaiting_input"];

/** A node reads only a pinned dependency of its current assigned Run. Raw paths,
 * arbitrary artifact ids, control tokens and another session confer no access. */
export function registerDependencyArtifactRoutes(app: FastifyInstance, ctx: ServerContext, store: ContentAddressedBlobSource): void {
  async function authorize(request: FastifyRequest, runId: string, artifactId: string) {
    const raw = /^Bearer[\t ]+([^\s]+)$/i.exec(request.headers.authorization ?? "")?.[1] ?? "";
    const identity = await resolveNodeToken(ctx, raw), token = parseDeviceToken(raw);
    const session = identity?.computerId ? ctx.getPairedNodeSession?.(identity.computerId) : undefined;
    if (!identity?.computerId || !token || !session || session.deviceId !== identity.deviceId
      || session.computerId !== identity.computerId
      || session.tokenLookup !== token.lookup || session.sessionId !== request.headers["x-artoo-session-id"])
      throw AppError.permissionDenied("The current paired execution-node session is required");
    const authorized = await ctx.db.db.transaction(async (tx) => {
      const [run] = await tx.select().from(runs).where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId)));
      if (!run || run.computerId !== identity.computerId) throw AppError.permissionDenied("Run is not owned by this node");
      if (!active.includes(run.status)) throw AppError.conflict("Dependency access requires an active assigned Run");
      const [scheduled] = await tx.select().from(schedulerExecutionRequests)
        .where(and(eq(schedulerExecutionRequests.organizationId, ctx.organizationId), eq(schedulerExecutionRequests.consumedRunId, run.id)));
      if (scheduled) {
        if (scheduled.state !== "consumed" || scheduled.consumedDeviceId !== identity.deviceId || scheduled.consumedSessionId !== session.sessionId)
          throw AppError.conflict("Dependency access requires the original scheduler assignment session");
        const lease = schedulerExecutionLeases, now = ctx.clock.nowIso();
        const [issued] = await tx.select({ id: lease.id }).from(lease).where(eq(lease.requestId, scheduled.id));
        const [current] = await tx.select({ binding: lease.binding }).from(lease).where(and(
          eq(lease.organizationId, ctx.organizationId), eq(lease.requestId, scheduled.id), eq(lease.state, "active"),
          sql`${lease.observedAt} <= ${now}::timestamptz AND ${lease.expiresAt} > ${now}::timestamptz`,
          sql`NOT EXISTS (SELECT 1 FROM scheduler_execution_leases newer WHERE newer.task_id = ${lease.taskId} AND newer.epoch > ${lease.epoch})`,
        ));
        // Input transfer precedes ready/grant so network IO does not consume
        // the original five-second physical launch window. This read grants no
        // launch authority; once a lease exists it may never bypass its fence.
        if (issued ? (!current || current.binding.run_id !== run.id || current.binding.computer_id !== identity.computerId
          || current.binding.device_id !== identity.deviceId || current.binding.session_id !== session.sessionId) : run.status !== "queued")
          throw AppError.conflict("Dependency access requires the original current scheduler lease");
      }
      const [task] = await tx.select().from(tasks).where(and(eq(tasks.id, run.taskId), eq(tasks.organizationId, ctx.organizationId)));
      const [pack] = run.contextPackId ? await tx.select().from(contextPacks).where(and(
        eq(contextPacks.id, run.contextPackId), eq(contextPacks.runId, run.id), eq(contextPacks.taskId, run.taskId),
        eq(contextPacks.organizationId, ctx.organizationId),
      )) : [];
      const parsed = ContextPackSchema.safeParse(pack?.payload);
      if (!task || !parsed.success || parsed.data.task.id !== run.taskId || parsed.data.project.id !== task.projectId)
        throw AppError.conflict("Run execution context is unavailable or changed");
      const reference = parsed.data.dependency_context?.entries.flatMap((entry) => entry.artifacts.map((artifact) => ({ entry, artifact })))
        .find((item) => item.artifact.id === artifactId);
      if (!reference || !reference.entry.run_id || reference.entry.run_id !== reference.artifact.run_id)
        throw AppError.notFound("Artifact is not a frozen dependency of this Run");
      const [upstream] = await tx.select().from(tasks).where(and(eq(tasks.id, reference.entry.task_id),
        eq(tasks.organizationId, ctx.organizationId), eq(tasks.projectId, task.projectId)));
      const [edge] = await tx.select({ id: taskDependencies.id }).from(taskDependencies).where(and(
        eq(taskDependencies.organizationId, ctx.organizationId), eq(taskDependencies.fromTaskId, reference.entry.task_id),
        eq(taskDependencies.toTaskId, run.taskId), eq(taskDependencies.type, reference.entry.dependency_type),
      ));
      const [latest] = await tx.select().from(runs).where(and(eq(runs.organizationId, ctx.organizationId), eq(runs.taskId, reference.entry.task_id)))
        .orderBy(desc(runs.createdAt), desc(runs.id)).limit(1);
      if (!edge || upstream?.status !== "done" || latest?.id !== reference.artifact.run_id || latest.status !== "completed")
        throw AppError.conflict("Upstream dependency changed after this Run's context was frozen");
      const [artifact] = await tx.select().from(artifacts).where(and(eq(artifacts.organizationId, ctx.organizationId),
        eq(artifacts.id, artifactId), eq(artifacts.taskId, upstream.id), eq(artifacts.runId, latest.id)));
      const metadata = artifact?.metadata as Record<string, unknown> | undefined;
      const key = metadata?.storage_key, size = metadata?.size;
      if (!artifact || typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) throw AppError.notFound("Stored dependency content not found");
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES
        || artifact.checksum !== `sha256:${key}` || artifact.checksum !== reference.artifact.checksum || artifact.type !== reference.artifact.type)
        throw AppError.conflict("Stored dependency content differs from its frozen reference");
      return { run, checksum: `sha256:${key}`, size, sourceRunId: latest.id, artifactId: artifact.id,
        filename: typeof metadata?.filename === "string" ? metadata.filename : "dependency.bin" };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    await requireRunAiSharingAuthorization(ctx, authorized.run);
    return authorized;
  }

  app.get("/api/v1/node/runs/:id/dependency-artifacts/:artifactId/content", async (request, reply) => {
    const { id, artifactId } = request.params as { id: string; artifactId: string };
    const input = await authorize(request, id, artifactId);
    let bytes: Buffer;
    try { bytes = await readContentAddressedBlob(store, input.checksum, input.size); }
    catch (error) {
      if (error instanceof ContentAddressedBlobNotFoundError) throw AppError.notFound("Stored dependency content not found");
      throw error;
    }
    if (bytes.byteLength !== input.size || bytes.byteLength > MAX_BYTES || blobChecksum(bytes) !== input.checksum)
      throw AppError.conflict("Dependency object failed integrity validation");
    // Blob IO can outlive a session, consent, or dependency version. Recheck
    // before returning bytes; the client also checks the immutable checksum.
    const current = await authorize(request, id, artifactId);
    if (current.checksum !== input.checksum || current.size !== input.size || current.sourceRunId !== input.sourceRunId)
      throw AppError.conflict("Dependency content changed during download");
    return reply.header("content-type", "application/octet-stream")
      .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(input.filename)}`)
      .header("cache-control", "private, no-store").header("x-content-type-options", "nosniff")
      .header("x-artoo-checksum", input.checksum).header("x-artoo-artifact-id", input.artifactId)
      .header("x-artoo-source-run-id", input.sourceRunId).send(bytes);
  });
}
