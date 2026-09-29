import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { artifacts, runs } from "@artoo/db";
import { ArtifactTypeSchema, ID_PREFIXES } from "@artoo/domain";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { resolveNodeToken } from "./services/device-service.js";

export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

/** Bounded, content-addressed storage. Client paths are labels, never disk paths. */
export function registerArtifactRoutes(app: FastifyInstance, ctx: ServerContext, artifactDir: string): void {
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: MAX_ARTIFACT_BYTES },
    (_req, body, done) => done(null, body));

  app.put("/api/v1/node/runs/:id/artifacts", {
    bodyLimit: MAX_ARTIFACT_BYTES,
    errorHandler(error, _req, reply) {
      if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        return reply.status(413).send({ error: { code: "validation_error", message: "artifact exceeds the 10 MiB upload limit", details: {} } });
      }
      throw error;
    },
  }, async (req, reply) => {
    const { id: runId } = req.params as { id: string };
    const authorization = req.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const identity = await resolveNodeToken(ctx, token);
    // Development nodes must still bind to the run's owning computer.
    const devNodeId = ctx.deviceAuth.devNodeToken !== null && token === ctx.deviceAuth.devNodeToken
      ? req.headers["x-artoo-node-id"] : undefined;
    const computerId = identity?.computerId ?? (typeof devNodeId === "string" ? devNodeId : undefined);
    if (!computerId) throw AppError.permissionDenied("a paired execution-node credential is required");
    const run = (await ctx.db.db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId))))[0];
    if (!run || run.computerId !== computerId) throw AppError.permissionDenied("run is not owned by this node");
    if (!["queued", "starting", "running"].includes(run.status)) throw AppError.conflict("cannot upload artifacts to a terminal run");
    const query = req.query as { path?: string; type?: string };
    const parsedType = ArtifactTypeSchema.safeParse(query.type);
    if (!parsedType.success) throw AppError.validation("invalid artifact type");
    const filename = (query.path ?? "artifact.bin").split(/[\\/]/).at(-1) ?? "artifact.bin";
    if (!filename || filename.length > 255 || /[\x00-\x1f]/.test(filename)) throw AppError.validation("invalid artifact filename");
    if (!Buffer.isBuffer(req.body)) throw AppError.validation("artifact body must be application/octet-stream");
    const bytes = req.body;
    const digest = createHash("sha256").update(bytes).digest("hex");
    const checksum = `sha256:${digest}`;
    if (req.headers["x-artoo-checksum"] !== checksum) throw AppError.validation("artifact checksum does not match uploaded bytes");
    await mkdir(artifactDir, { recursive: true });
    // Flush a private temp file then atomically publish it, so interruption can
    // never leave a partially written blob under its permanent content hash.
    const staging = join(artifactDir, `${randomUUID()}.upload`);
    try {
      const handle = await open(staging, "wx");
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(staging, join(artifactDir, digest));
    } finally { await unlink(staging).catch(() => {}); }
    const artifact = await ctx.db.transaction(async (tx) => {
      const current = (await tx.select().from(runs).where(and(eq(runs.id, runId), eq(runs.organizationId, ctx.organizationId))))[0];
      if (!current || current.computerId !== computerId || !["queued", "starting", "running"].includes(current.status)) {
        throw AppError.conflict("run ended before artifact upload completed");
      }
      const previous = (await tx.select().from(artifacts).where(and(
        eq(artifacts.organizationId, ctx.organizationId), eq(artifacts.runId, runId), eq(artifacts.checksum, checksum),
      ))).find((row) => (row.metadata as Record<string, unknown>).filename === filename && row.type === parsedType.data);
      if (previous) return previous;
      const artifactId = ctx.idGen.generate(ID_PREFIXES.artifact);
      return (await tx.insert(artifacts).values({
        id: artifactId, organizationId: ctx.organizationId, taskId: run.taskId, runId,
        type: parsedType.data, uri: `/api/v1/artifacts/${artifactId}/content`, checksum,
        metadata: { filename, size: bytes.length, storage_key: digest, computer_id: computerId },
        createdAt: ctx.clock.nowIso(),
      }).returning())[0]!;
    });
    void reply.status(201);
    return { artifact: { id: artifact.id, uri: artifact.uri, checksum, metadata: artifact.metadata } };
  });

  // The regular API auth guard protects this route (session or control token).
  app.get("/api/v1/artifacts/:id/content", async (req, reply) => {
    const { id } = req.params as { id: string };
    const artifact = (await ctx.db.db.select().from(artifacts).where(and(eq(artifacts.id, id), eq(artifacts.organizationId, ctx.organizationId))))[0];
    const metadata = artifact?.metadata as Record<string, unknown> | undefined;
    const key = metadata?.storage_key;
    if (!artifact || typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) throw AppError.notFound("stored artifact not found");
    let bytes: Buffer;
    try { bytes = await readFile(join(artifactDir, key)); }
    catch { throw AppError.notFound("stored artifact content not found"); }
    const filename = typeof metadata?.filename === "string" ? metadata.filename : "artifact.bin";
    void reply.header("content-type", "application/octet-stream")
      .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, no-store")
      .header("etag", `"${key}"`);
    return bytes;
  });
}
