import { createHash } from "node:crypto";
import { parseDeviceToken, ProductSourceTransferReceiptV1Schema, ProductSourceTransferRequestV2Schema,
  productSourceTransferRequestDigestV2, type ProductSourceTransferRequestV2 } from "@artoo/domain";
import type { PreparedProductSourceRuntime } from "./product-source-runtime.js";

const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const requestHeader = "x-artoo-transfer-request-digest", exportHeader = "x-artoo-source-export-digest", checksumHeader = "x-artoo-checksum";
declare const authenticatedBrand: unique symbol;
export interface AuthenticatedProductSourceTransferV2 { readonly [authenticatedBrand]: true }
interface AuthenticatedState { nodeId: string; request: ProductSourceTransferRequestV2; requestDigest: string; bytes: Buffer }
const authenticated = new WeakMap<AuthenticatedProductSourceTransferV2, AuthenticatedState>();

/** A schema or disk record cannot reconstruct the original successful paired-server response. */
export function readAuthenticatedProductSourceTransferV2(token: AuthenticatedProductSourceTransferV2): AuthenticatedState {
  const saved = authenticated.get(token); if (!saved) throw new Error("An original authenticated semantic-transfer response is required");
  return { ...saved, request: structuredClone(saved.request), bytes: Buffer.from(saved.bytes) };
}
async function boundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > maxBytes)) throw new Error("Semantic transfer response exceeds its bound");
  if (!response.body) throw new Error("Missing semantic transfer response");
  const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
  try {
    for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength;
      if (size > maxBytes) throw new Error("Semantic transfer stream exceeds its bound"); chunks.push(Buffer.from(item.value)); }
    if (length !== null && Number(length) !== size) throw new Error("Semantic transfer response length changed");
    return Buffer.concat(chunks, size);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

/** Trusted local server/node configuration, never a URL or token from a task/context. */
export function createProductSourceSemanticClient(options: { serverOrigin: string; nodeId: string; nodeToken: string }) {
  const origin = new URL(options.serverOrigin), { nodeId, nodeToken } = options;
  if (!nodeId || !parseDeviceToken(nodeToken) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) {
    throw new Error("Semantic transfer requires an exact local server origin and paired node configuration");
  }
  const parse = (input: unknown) => { const request = ProductSourceTransferRequestV2Schema.parse(input);
    return { request, requestDigest: productSourceTransferRequestDigestV2(request, sha) }; };
  async function send(request: ProductSourceTransferRequestV2, digest: string, method: "PUT" | "GET", bytes: Buffer | undefined,
    signal?: AbortSignal): Promise<Buffer> {
    const base = request.byte_request;
    if (nodeId !== (method === "PUT" ? base.source.node_id : base.destination.node_id)) throw new Error("Semantic request is assigned to another node");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    try {
      const url = new URL(`/api/v1/node/product-source-transfers-v2/${encodeURIComponent(base.transfer_id)}/content`, origin);
      const response = await fetch(url, { method, redirect: "error", credentials: "omit", cache: "no-store",
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        headers: { authorization: `Bearer ${nodeToken}`, [requestHeader]: digest,
          ...(bytes ? { "content-type": "application/octet-stream", [checksumHeader]: base.source.capsule_digest } : {}) },
        ...(bytes ? { body: new Uint8Array(bytes) } : {}) });
      if (response.status !== 200 || response.url !== url.href) { await response.body?.cancel(); throw new Error(`Semantic transfer endpoint returned ${response.status}`); }
      if (method === "GET" && (response.headers.get(requestHeader) !== digest || response.headers.get(exportHeader) !== request.source_export_digest
        || response.headers.get(checksumHeader) !== base.source.capsule_digest || response.headers.get("content-type")?.split(";")[0] !== "application/octet-stream")) {
        await response.body?.cancel(); throw new Error("Semantic download does not bind the complete source provenance and request");
      }
      return await boundedBody(response, method === "PUT" ? 4096 : 12 * 1024 * 1024);
    } finally { clearTimeout(timer); }
  }
  return Object.freeze({
    async upload(runtime: PreparedProductSourceRuntime, input: unknown, signal?: AbortSignal) {
      const { request, requestDigest } = parse(input);
      const { readProductSourceExportBytesV2 } = await import("./product-source-runtime.js");
      const bytes = readProductSourceExportBytesV2(runtime, request, requestDigest);
      const json = JSON.parse((await send(request, requestDigest, "PUT", bytes, signal)).toString("utf8"));
      const receipt = ProductSourceTransferReceiptV1Schema.parse(json.transfer);
      if (receipt.transfer_id !== request.byte_request.transfer_id || receipt.request_digest !== requestDigest
        || receipt.capsule_digest !== request.byte_request.source.capsule_digest || receipt.status !== "available") throw new Error("Semantic upload receipt differs");
      return receipt;
    },
    async download(input: unknown, signal?: AbortSignal): Promise<AuthenticatedProductSourceTransferV2> {
      const { request, requestDigest } = parse(input), bytes = await send(request, requestDigest, "GET", undefined, signal);
      if (bytes.length !== request.byte_request.source.capsule_bytes || sha(bytes) !== request.byte_request.source.capsule_digest) {
        throw new Error("Semantic capsule bytes differ from the authenticated source export");
      }
      const token = Object.freeze({}) as AuthenticatedProductSourceTransferV2;
      authenticated.set(token, { nodeId, request: structuredClone(request), requestDigest, bytes }); return token;
    },
  });
}
