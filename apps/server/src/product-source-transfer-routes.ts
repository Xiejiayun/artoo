import { parseDeviceToken, PRODUCT_SOURCE_TRANSFER_MAX_BYTES_V1 } from "@artoo/domain";
import { ContentAddressedBlobIntegrityError, ContentAddressedBlobNotFoundError } from "@artoo/storage";
import { PRODUCT_SOURCE_TRANSFER_CHECKSUM_HEADER_V1, PRODUCT_SOURCE_TRANSFER_CONTENT_ROUTE_V1,
  PRODUCT_SOURCE_TRANSFER_REQUEST_HEADER_V1, ProductSourceTransferUploadResponseV1Schema } from "@artoo/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isDeepStrictEqual } from "node:util";
import { blobChecksum, readContentAddressedBlob, writeContentAddressedBlob, type ContentAddressedBlobSource } from "./content-addressed-blob.js";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { resolveNodeToken } from "./services/device-service.js";
import { inspectProductSourceTransferForNode, type AuthenticatedTransferNode } from "./services/product-source-transfer-service.js";

/** Paired node tokens only: there is intentionally no dev-node or control-session escape. */
async function nodeIdentity(ctx: ServerContext, req: FastifyRequest): Promise<AuthenticatedTransferNode> {
  const raw = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
  const identity = await resolveNodeToken(ctx, raw), parsed = parseDeviceToken(raw);
  if (!identity?.computerId || !parsed) throw AppError.permissionDenied("A paired execution-node credential is required for product source transfer");
  return { deviceId: identity.deviceId, computerId: identity.computerId, tokenLookup: parsed.lookup };
}
function requestBinding(req: FastifyRequest) {
  const digest = req.headers[PRODUCT_SOURCE_TRANSFER_REQUEST_HEADER_V1];
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw AppError.validation("Exact transfer request digest is required");
  return { id: (req.params as { id: string }).id, digest };
}

export function registerProductSourceTransferRoutes(app: FastifyInstance, ctx: ServerContext, artifactStore: ContentAddressedBlobSource): void {
  // Encapsulation keeps the existing ordinary artifact parser and its 10 MiB limit unchanged.
  void app.register(async scoped => {
    scoped.removeContentTypeParser("application/octet-stream");
    scoped.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: PRODUCT_SOURCE_TRANSFER_MAX_BYTES_V1 },
      (_req, body, done) => done(null, body));
    scoped.put(PRODUCT_SOURCE_TRANSFER_CONTENT_ROUTE_V1, {
      bodyLimit: PRODUCT_SOURCE_TRANSFER_MAX_BYTES_V1,
      errorHandler(error, _req, reply) {
        if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
          return reply.status(413).send({ error: { code: "validation_error", message: "product source capsule exceeds the 12 MiB limit", details: {} } });
        }
        throw error;
      },
    }, async (req, reply) => {
      const identity = await nodeIdentity(ctx, req), binding = requestBinding(req);
      const { request } = await inspectProductSourceTransferForNode(ctx, binding.id, binding.digest, identity, "upload");
      if (!Buffer.isBuffer(req.body)) throw AppError.validation("Product source capsule must be application/octet-stream");
      const bytes = req.body;
      if (bytes.length !== request.source.capsule_bytes || blobChecksum(bytes) !== request.source.capsule_digest
        || req.headers[PRODUCT_SOURCE_TRANSFER_CHECKSUM_HEADER_V1] !== request.source.capsule_digest) {
        throw AppError.validation("Product source capsule bytes differ from the immutable request");
      }
      // This binds the capsule's public header; the destination still must decode the complete
      // bounded format and validate every path and byte. Neither step grants execution authority.
      let capsule: { version?: unknown; kind?: unknown; source?: unknown; manifest?: unknown; manifest_digest?: unknown };
      try { capsule = JSON.parse(bytes.toString("utf8")); } catch { throw AppError.validation("Product source capsule is not JSON"); }
      const source = request.source;
      if (!capsule || capsule.version !== 1 || capsule.kind !== "artoo.product-source.v1" || !isDeepStrictEqual(capsule.source,
        { project_id: request.project_id, profile_id: source.profile_id, profile_digest: source.profile_digest, subject_digest: source.subject_digest })
        || capsule.manifest_digest !== source.manifest_digest || !capsule.manifest
        || blobChecksum(Buffer.from(JSON.stringify(capsule.manifest))) !== source.manifest_digest) {
        throw AppError.validation("Product source capsule header differs from the immutable request");
      }
      await writeContentAddressedBlob(artifactStore, bytes);
      // A failure here can retain an unreferenced blob, never an available transfer.
      const fresh = await nodeIdentity(ctx, req);
      const completed = await inspectProductSourceTransferForNode(ctx, binding.id, binding.digest, fresh, "upload", true);
      void reply.status(200).header("cache-control", "private, no-store");
      return ProductSourceTransferUploadResponseV1Schema.parse({ transfer: completed.receipt });
    });
    scoped.get(PRODUCT_SOURCE_TRANSFER_CONTENT_ROUTE_V1, async (req, reply) => {
      const identity = await nodeIdentity(ctx, req), binding = requestBinding(req);
      const { request } = await inspectProductSourceTransferForNode(ctx, binding.id, binding.digest, identity, "download");
      let bytes: Buffer;
      try { bytes = await readContentAddressedBlob(artifactStore, request.source.capsule_digest, request.source.capsule_bytes); }
      catch (error) {
        if (error instanceof ContentAddressedBlobNotFoundError || error instanceof ContentAddressedBlobIntegrityError) {
          throw AppError.conflict("Product source content is missing or differs from its stored digest");
        }
        throw error;
      }
      const fresh = await nodeIdentity(ctx, req);
      await inspectProductSourceTransferForNode(ctx, binding.id, binding.digest, fresh, "download");
      void reply.header("content-type", "application/octet-stream").header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff").header(PRODUCT_SOURCE_TRANSFER_CHECKSUM_HEADER_V1, request.source.capsule_digest)
        .header(PRODUCT_SOURCE_TRANSFER_REQUEST_HEADER_V1, binding.digest);
      return bytes;
    });
  });
}
