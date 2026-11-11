import { ContentAddressedBlobIntegrityError, ContentAddressedBlobNotFoundError, contentAddressedChecksum, copyContentAddressedBytes,
  validateContentAddressedRead, verifyContentAddressedBytes, type ContentAddressedBlobStore } from "./content-addressed-blob-store.js";

export interface SupabaseContentAddressedBlobStoreOptions {
  url: string;
  serviceRoleKey: string;
  bucket: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const MAX_METADATA_BYTES = 64 * 1024;

function parseConfiguration(options: SupabaseContentAddressedBlobStoreOptions): { origin: string; timeoutMs: number } {
  let url: URL;
  try { url = new URL(options.url); } catch { throw new Error("Invalid Supabase Storage URL"); }
  if (typeof options.url !== "string" || /[\s\\]/.test(options.url) || url.protocol !== "https:"
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Supabase Storage requires an HTTPS origin without credentials, path, query or fragment");
  }
  if (typeof options.serviceRoleKey !== "string" || options.serviceRoleKey.length < 32 || options.serviceRoleKey.length > 8192
    || !/^[A-Za-z0-9._-]+$/.test(options.serviceRoleKey)) throw new Error("Invalid Supabase Storage service key");
  if (typeof options.bucket !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(options.bucket)) {
    throw new Error("Invalid Supabase Storage bucket name");
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("Invalid Supabase Storage timeout");
  if (options.fetch !== undefined && typeof options.fetch !== "function") throw new Error("Invalid Supabase Storage fetch implementation");
  return { origin: url.origin, timeoutMs };
}

/** Read at most limit + 1 bytes, including when a peer lies about Content-Length. */
async function boundedBody(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  const buffer = new Uint8Array(limit + 1);
  if (!response.body) return buffer.subarray(0, 0);
  const reader = response.body.getReader();
  // Aborting a mocked/custom fetch must also settle a pending body read.
  const cancel = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let offset = 0, finished = false;
  try {
    while (true) {
      signal.throwIfAborted();
      let part: ReadableStreamReadResult<Uint8Array>;
      try { part = await reader.read(); }
      catch {
        signal.throwIfAborted();
        throw new Error("Supabase Storage response could not be read");
      }
      const { done, value } = part;
      signal.throwIfAborted();
      if (done) { finished = true; break; }
      if (value.byteLength > limit - offset) throw new ContentAddressedBlobIntegrityError("Supabase Storage response exceeds the expected size");
      buffer.set(value, offset);
      offset += value.byteLength;
    }
    return buffer.subarray(0, offset);
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}

function parsedObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** Private Storage API access stays on one trusted origin; no public URLs escape. */
export class SupabaseContentAddressedBlobStore implements ContentAddressedBlobStore {
  readonly #origin: string;
  readonly #serviceRoleKey: string;
  readonly #bucket: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  private constructor(options: SupabaseContentAddressedBlobStoreOptions, origin: string, timeoutMs: number) {
    this.#origin = origin;
    this.#serviceRoleKey = options.serviceRoleKey;
    this.#bucket = options.bucket;
    this.#timeoutMs = timeoutMs;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  static async create(options: SupabaseContentAddressedBlobStoreOptions): Promise<SupabaseContentAddressedBlobStore> {
    const { origin, timeoutMs } = parseConfiguration(options);
    const store = new SupabaseContentAddressedBlobStore(options, origin, timeoutMs);
    await store.#request("bucket validation", `/storage/v1/bucket/${encodeURIComponent(options.bucket)}`, {}, async (response, signal) => {
      if (!response.ok) throw new Error(`Supabase Storage bucket validation failed (HTTP ${response.status})`);
      const bucket = parsedObject(await boundedBody(response, MAX_METADATA_BYTES, signal));
      if (bucket?.id !== options.bucket || bucket.public !== false) throw new Error("Supabase Storage bucket must exist and be private");
    });
    return store;
  }

  async write(input: Uint8Array): Promise<void> {
    const bytes = copyContentAddressedBytes(input);
    const key = contentAddressedChecksum(bytes).slice(7);
    await this.#request("write", `/storage/v1/object/${encodeURIComponent(this.#bucket)}/${key}`, {
      method: "POST", headers: { "content-type": "application/octet-stream", "x-upsert": "true" }, body: Buffer.from(bytes),
    }, async (response, signal) => {
      if (!response.ok) throw new Error(`Supabase Storage write failed (HTTP ${response.status})`);
      await boundedBody(response, MAX_METADATA_BYTES, signal);
    });
  }

  async read(checksum: string, expectedSize: number): Promise<Uint8Array> {
    const key = validateContentAddressedRead(checksum, expectedSize);
    return this.#request("read", `/storage/v1/object/authenticated/${encodeURIComponent(this.#bucket)}/${key}`, {}, async (response, signal) => {
      if (response.status === 404) throw new ContentAddressedBlobNotFoundError();
      if (!response.ok) {
        // Some Storage API versions wrap an object 404 inside an HTTP 400.
        // Do not turn authentication, permission or transport failures into 404.
        if (response.status === 400) {
          const error = parsedObject(await boundedBody(response, MAX_METADATA_BYTES, signal));
          if (String(error?.statusCode) === "404" && error?.error === "not_found" && error?.message === "Object not found") {
            throw new ContentAddressedBlobNotFoundError();
          }
        }
        throw new Error(`Supabase Storage read failed (HTTP ${response.status})`);
      }
      const bytes = await boundedBody(response, expectedSize, signal);
      verifyContentAddressedBytes(bytes, checksum, expectedSize);
      return bytes;
    });
  }

  async #request<T>(operation: string, path: string, init: RequestInit,
    consume: (response: Response, signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeoutError = new Error(`Supabase Storage ${operation} timed out`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(timeoutError); reject(timeoutError); }, this.#timeoutMs);
    });
    const request = (async () => {
      let response: Response;
      try {
        response = await this.#fetch(new URL(path, this.#origin), { ...init, redirect: "error", signal: controller.signal,
          headers: { ...init.headers, apikey: this.#serviceRoleKey, authorization: `Bearer ${this.#serviceRoleKey}` } });
      } catch {
        if (controller.signal.aborted) throw timeoutError;
        // Fetch/provider errors may contain credential-bearing inputs. Never echo them.
        throw new Error(`Supabase Storage ${operation} request failed`);
      }
      if (controller.signal.aborted) throw timeoutError;
      let sameOrigin = false;
      try { sameOrigin = !response.url || new URL(response.url).origin === this.#origin; } catch { /* Invalid response URLs are refused without echoing them. */ }
      if (response.redirected || !sameOrigin) {
        throw new Error(`Supabase Storage ${operation} refused a redirected response`);
      }
      return consume(response, controller.signal);
    })();
    try { return await Promise.race([request, deadline]); }
    finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }
}
