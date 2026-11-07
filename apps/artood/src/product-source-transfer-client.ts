import { createHash } from "node:crypto";
import { ProductSourceTransferRequestV1Schema, PRODUCT_SOURCE_TRANSFER_MAX_BYTES_V1, productSourceTransferRequestDigestV1,
  parseDeviceToken, type ProductSourceTransferRequestV1 } from "@artoo/domain";
import { PRODUCT_SOURCE_TRANSFER_REQUEST_HEADER_V1, PRODUCT_SOURCE_TRANSFER_CHECKSUM_HEADER_V1,
  ProductSourceTransferUploadResponseV1Schema } from "@artoo/protocol";
import { importProductSourceTransfer, readProductSourceExportBytes, type PreparedProductSourceRuntime } from "./product-source-runtime.js";

const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function fail(message: string): never { throw new Error(`Product source transport: ${message}`); }
async function boundedBody(response: Response, maximum: number): Promise<Buffer> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > maximum)) fail("response length exceeds its bound");
  if (!response.body) fail("response body is missing");
  const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > maximum) fail("stream exceeds its bound"); chunks.push(Buffer.from(value));
    }
    if (length !== null && Number(length) !== size) fail("response length changed");
    return Buffer.concat(chunks, size);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

/** Local paired-node configuration only. No task-selected URL, redirect or provider credential. */
export function createProductSourceTransferClient(options: { serverOrigin: string; nodeToken: string; runtime: PreparedProductSourceRuntime }) {
  const origin = new URL(options.serverOrigin), parsed = parseDeviceToken(options.nodeToken);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
    || !parsed) fail("an exact server origin and paired node token are required");
  const { nodeToken, runtime } = options;
  const request = (input: unknown) => {
    const value = ProductSourceTransferRequestV1Schema.parse(input);
    return { value, digest: productSourceTransferRequestDigestV1(value, sha) };
  };
  async function send(value: ProductSourceTransferRequestV1, digest: string, method: "GET" | "PUT", body: Buffer | undefined,
    signal: AbortSignal): Promise<Response> {
    const url = new URL(`/api/v1/node/product-source-transfers/${encodeURIComponent(value.transfer_id)}/content`, origin);
    const response = await fetch(url, { method, redirect: "error", credentials: "omit", cache: "no-store", signal,
      headers: { authorization: `Bearer ${nodeToken}`, [PRODUCT_SOURCE_TRANSFER_REQUEST_HEADER_V1]: digest,
        ...(body ? { "content-type": "application/octet-stream", [PRODUCT_SOURCE_TRANSFER_CHECKSUM_HEADER_V1]: value.source.capsule_digest } : {}) },
      ...(body ? { body: new Uint8Array(body) } : {}) });
    if (response.status !== 200 || response.url !== url.href) { await response.body?.cancel(); fail(`fixed endpoint returned status ${response.status}`); }
    return response;
  }
  return Object.freeze({
    async upload(input: unknown, signal?: AbortSignal) {
      const { value, digest } = request(input), bytes = readProductSourceExportBytes(runtime, value, digest);
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await send(value, digest, "PUT", bytes, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
        const result = ProductSourceTransferUploadResponseV1Schema.parse(JSON.parse((await boundedBody(response, 4096)).toString("utf8")));
        if (result.transfer.transfer_id !== value.transfer_id || result.transfer.request_digest !== digest
          || result.transfer.capsule_digest !== value.source.capsule_digest || result.transfer.status !== "available") fail("upload receipt binding differs");
        return result.transfer;
      } finally { clearTimeout(timer); }
    },
    async downloadAndImport(input: unknown, signal?: AbortSignal) {
      const { value, digest } = request(input), controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let bytes: Buffer;
      try {
        const response = await send(value, digest, "GET", undefined, combined);
        if (response.headers.get(PRODUCT_SOURCE_TRANSFER_REQUEST_HEADER_V1) !== digest
          || response.headers.get(PRODUCT_SOURCE_TRANSFER_CHECKSUM_HEADER_V1) !== value.source.capsule_digest
          || response.headers.get("content-type")?.split(";")[0] !== "application/octet-stream") {
          await response.body?.cancel(); fail("download response binding differs");
        }
        bytes = await boundedBody(response, PRODUCT_SOURCE_TRANSFER_MAX_BYTES_V1);
        if (bytes.length !== value.source.capsule_bytes || sha(bytes) !== value.source.capsule_digest) fail("downloaded capsule differs");
      } finally { clearTimeout(timer); }
      return importProductSourceTransfer(runtime, value, digest, bytes, signal);
    },
  });
}
