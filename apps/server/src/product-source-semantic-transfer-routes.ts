import { assertProductResearchProvenanceV1, assertProductResearchProvenanceV2, parseDeviceToken, PRODUCT_SOURCE_TRANSFER_MAX_BYTES_V1,
  type ProductSourceTransferRequestV2 } from "@artoo/domain";
import { PRODUCT_SOURCE_TRANSFER_CHECKSUM_HEADER_V1, PRODUCT_SOURCE_TRANSFER_REQUEST_HEADER_V1,
  ProductSourceTransferUploadResponseV1Schema } from "@artoo/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { blobChecksum, readContentAddressedBlob, writeContentAddressedBlob, type ContentAddressedBlobSource } from "./content-addressed-blob.js";
import { ContentAddressedBlobIntegrityError, ContentAddressedBlobNotFoundError } from "@artoo/storage";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import { resolveNodeToken } from "./services/device-service.js";
import { inspectProductSourceSemanticTransferForNode, type AuthenticatedTransferNode } from "./services/product-source-transfer-service.js";

const route = "/api/v1/node/product-source-transfers-v2/:id/content";
const sha = (value: string | Uint8Array): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** The auth hook only delegates this exact route; paired credentials are still mandatory here. */
async function nodeIdentity(ctx: ServerContext, req: FastifyRequest): Promise<AuthenticatedTransferNode> {
  const raw = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
  const identity = await resolveNodeToken(ctx, raw), parsed = parseDeviceToken(raw);
  if (!identity?.computerId || !parsed) throw AppError.permissionDenied("A paired execution-node credential is required for semantic source transfer");
  return { deviceId: identity.deviceId, computerId: identity.computerId, tokenLookup: parsed.lookup };
}
function requestBinding(req: FastifyRequest) {
  const digest = req.headers[PRODUCT_SOURCE_TRANSFER_REQUEST_HEADER_V1];
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw AppError.validation("Exact semantic transfer request digest is required");
  return { id: (req.params as { id: string }).id, digest };
}

/** Bounded report extraction authenticates the complete source metadata set before availability. */
export function assertSemanticCapsuleResearch(bytes: Buffer, request: ProductSourceTransferRequestV2): void {
  const base = request.byte_request, source = base.source, provenance = request.source_export.research_provenance;
  let capsule: { version?: unknown; kind?: unknown; source?: unknown; manifest?: { entries?: unknown[] }; manifest_digest?: unknown; files?: unknown[] };
  try { capsule = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw AppError.validation("Semantic product source capsule is not UTF-8 JSON"); }
  if (!capsule || capsule.version !== 1 || capsule.kind !== "artoo.product-source.v1" || !isDeepStrictEqual(capsule.source,
    { project_id: base.project_id, profile_id: source.profile_id, profile_digest: source.profile_digest, subject_digest: source.subject_digest })
    || capsule.manifest_digest !== source.manifest_digest || !capsule.manifest || !Array.isArray(capsule.manifest.entries)
    || blobChecksum(Buffer.from(JSON.stringify(capsule.manifest))) !== source.manifest_digest || !Array.isArray(capsule.files)) {
    throw AppError.validation("Semantic capsule header differs from the immutable request");
  }
  const pin = provenance.research;
  const entries = capsule.manifest.entries.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && (entry as Record<string, unknown>).path === pin.path);
  const files = capsule.files.filter((file): file is Record<string, unknown> => !!file && typeof file === "object" && (file as Record<string, unknown>).path === pin.path);
  if (entries.length !== 1 || files.length !== 1 || entries[0]!.kind !== "file" || entries[0]!.checksum !== pin.checksum || entries[0]!.size !== pin.size
    || typeof files[0]!.base64 !== "string" || files[0]!.base64.length !== Math.ceil(pin.size / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(files[0]!.base64)) {
    throw AppError.validation("Semantic capsule lacks its single bounded measured research file");
  }
  const research = Buffer.from(files[0]!.base64, "base64");
  if (research.toString("base64") !== files[0]!.base64) throw AppError.validation("Research file has noncanonical base64");
  try {
    if (!!request.measurement_v2 !== !!request.source_export.measurement_v2) throw new Error("Unpaired report version");
    const inspect = request.measurement_v2 ? assertProductResearchProvenanceV2 : assertProductResearchProvenanceV1;
    inspect(provenance, research, sha);
  }
  catch { throw AppError.validation("Research source metadata differs from its authenticated export provenance"); }
}

export function registerProductSourceSemanticTransferRoutes(app: FastifyInstance, ctx: ServerContext, artifactStore: ContentAddressedBlobSource): void {
  void app.register(async scoped => {
    scoped.removeContentTypeParser("application/octet-stream");
    scoped.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: PRODUCT_SOURCE_TRANSFER_MAX_BYTES_V1 },
      (_req, body, done) => done(null, body));
    scoped.put(route, { bodyLimit: PRODUCT_SOURCE_TRANSFER_MAX_BYTES_V1,
      errorHandler(error, _req, reply) {
        if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") return reply.status(413).send({ error: {
          code: "validation_error", message: "semantic product source capsule exceeds the 12 MiB limit", details: {} } });
        throw error;
      },
    }, async (req, reply) => {
      const identity = await nodeIdentity(ctx, req), binding = requestBinding(req);
      const { request } = await inspectProductSourceSemanticTransferForNode(ctx, binding.id, binding.digest, identity, "upload");
      const source = request.byte_request.source;
      if (!Buffer.isBuffer(req.body) || req.body.length !== source.capsule_bytes || blobChecksum(req.body) !== source.capsule_digest
        || req.headers[PRODUCT_SOURCE_TRANSFER_CHECKSUM_HEADER_V1] !== source.capsule_digest) {
        throw AppError.validation("Semantic product source capsule bytes differ from the immutable request");
      }
      assertSemanticCapsuleResearch(req.body, request);
      await writeContentAddressedBlob(artifactStore, req.body);
      const fresh = await nodeIdentity(ctx, req);
      const completed = await inspectProductSourceSemanticTransferForNode(ctx, binding.id, binding.digest, fresh, "upload", true);
      void reply.header("cache-control", "private, no-store");
      return ProductSourceTransferUploadResponseV1Schema.parse({ transfer: completed.receipt });
    });
    scoped.get(route, async (req, reply) => {
      const identity = await nodeIdentity(ctx, req), binding = requestBinding(req);
      const { request } = await inspectProductSourceSemanticTransferForNode(ctx, binding.id, binding.digest, identity, "download");
      const source = request.byte_request.source;
      let bytes: Buffer;
      try { bytes = await readContentAddressedBlob(artifactStore, source.capsule_digest, source.capsule_bytes); }
      catch (error) {
        if (error instanceof ContentAddressedBlobNotFoundError || error instanceof ContentAddressedBlobIntegrityError) {
          throw AppError.conflict("Semantic product source content is missing or differs from its stored digest");
        }
        throw error;
      }
      assertSemanticCapsuleResearch(bytes, request);
      const fresh = await nodeIdentity(ctx, req);
      await inspectProductSourceSemanticTransferForNode(ctx, binding.id, binding.digest, fresh, "download");
      void reply.header("content-type", "application/octet-stream").header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff").header(PRODUCT_SOURCE_TRANSFER_CHECKSUM_HEADER_V1, source.capsule_digest)
        .header(PRODUCT_SOURCE_TRANSFER_REQUEST_HEADER_V1, binding.digest).header("x-artoo-source-export-digest", request.source_export_digest);
      return bytes;
    });
  });
}
