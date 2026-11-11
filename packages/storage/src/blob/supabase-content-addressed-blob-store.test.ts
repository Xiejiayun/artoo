import { afterEach, describe, expect, it, vi } from "vitest";

import { ContentAddressedBlobIntegrityError, ContentAddressedBlobNotFoundError, contentAddressedChecksum, MAX_CONTENT_ADDRESSED_BLOB_BYTES } from "./content-addressed-blob-store.js";
import { SupabaseContentAddressedBlobStore, type SupabaseContentAddressedBlobStoreOptions } from "./supabase-content-addressed-blob-store.js";

const options = { url: "https://project.supabase.co", serviceRoleKey: "sb_secret_test_service_role_key_1234567890", bucket: "artoo-artifacts" };
const bucketResponse = () => Response.json({ id: options.bucket, public: false });
const content = new TextEncoder().encode("protected capsule");
const checksum = contentAddressedChecksum(content);

async function fixture(response: () => Response | Promise<Response> = () => new Response(content), overrides: Partial<SupabaseContentAddressedBlobStoreOptions> = {}) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(bucketResponse()).mockImplementation(async () => response());
  const store = await SupabaseContentAddressedBlobStore.create({ ...options, ...overrides, fetch: fetcher });
  return { store, fetcher };
}
afterEach(() => { vi.useRealTimers(); });

describe("SupabaseContentAddressedBlobStore", () => {
  it("validates private storage and preserves immutable keys across duplicate uploads", async () => {
    const objects = new Map<string, Uint8Array>();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === `/storage/v1/bucket/${options.bucket}`) return bucketResponse();
      const key = path.split("/").at(-1)!;
      if (init?.method === "POST") {
        expect(new Headers(init.headers).get("x-upsert")).toBe("true");
        objects.set(key, Uint8Array.from(init.body as Uint8Array));
        return Response.json({ Key: `${options.bucket}/${key}` });
      }
      return new Response(Uint8Array.from(objects.get(key)!));
    });
    const store = await SupabaseContentAddressedBlobStore.create({ ...options, fetch: fetcher });
    await store.write(content); await store.write(content);
    expect(await store.read(checksum, content.length)).toEqual(content);
    expect([...objects.keys()]).toEqual([checksum.slice(7)]);
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      `/storage/v1/bucket/${options.bucket}`,
      `/storage/v1/object/${options.bucket}/${checksum.slice(7)}`,
      `/storage/v1/object/${options.bucket}/${checksum.slice(7)}`,
      `/storage/v1/object/authenticated/${options.bucket}/${checksum.slice(7)}`,
    ]);
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(String(url)).origin).toBe(options.url);
      expect(String(url)).not.toContain(options.serviceRoleKey);
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("apikey")).toBe(options.serviceRoleKey);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${options.serviceRoleKey}`);
    }
  });

  it.each([{ id: options.bucket, public: true }, { id: options.bucket }, { id: "another-bucket", public: false }])
    ("fails closed on an invalid bucket descriptor %j", async descriptor => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(descriptor));
      await expect(SupabaseContentAddressedBlobStore.create({ ...options, fetch: fetcher })).rejects.toThrow("must exist and be private");
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it("does not leak bucket failure bodies or fetch exception messages", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(options.serviceRoleKey, { status: 403 }));
    await expect(SupabaseContentAddressedBlobStore.create({ ...options, fetch: fetcher })).rejects.toThrow("bucket validation failed (HTTP 403)");
    fetcher.mockRejectedValueOnce(new Error(options.serviceRoleKey));
    await expect(SupabaseContentAddressedBlobStore.create({ ...options, fetch: fetcher })).rejects.toThrow("bucket validation request failed");
  });

  it.each([
    { url: "http://project.supabase.co" }, { url: "https://user:password@project.supabase.co" },
    { url: "https://project.supabase.co/storage" }, { url: "https://project.supabase.co?token=x" },
    { url: "https://project.supabase.co#fragment" }, { url: "https://project.supabase.co\n" },
    { serviceRoleKey: "short" }, { serviceRoleKey: `${options.serviceRoleKey}\r\ninjected: yes` },
    { bucket: "../other" }, { bucket: "a/b" }, { bucket: "" }, { timeoutMs: 0 }, { timeoutMs: Infinity },
  ])("rejects unsafe configuration before sending credentials %j", async override => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(SupabaseContentAddressedBlobStore.create({ ...options, ...override, fetch: fetcher })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps only object absence to the dedicated not-found error", async () => {
    for (const response of [new Response(null, { status: 404 }), Response.json({ statusCode: "404", error: "not_found", message: "Object not found" }, { status: 400 })]) {
      const { store } = await fixture(() => response);
      await expect(store.read(checksum, content.length)).rejects.toBeInstanceOf(ContentAddressedBlobNotFoundError);
    }
    for (const status of [400, 401, 403, 429, 500]) {
      const { store } = await fixture(() => new Response(options.serviceRoleKey, { status }));
      const read = store.read(checksum, content.length);
      await expect(read).rejects.toThrow(`read failed (HTTP ${status})`);
      await expect(read).rejects.not.toBeInstanceOf(ContentAddressedBlobIntegrityError);
    }
  });

  it("rejects permission failures even if the body impersonates a missing object", async () => {
    const { store } = await fixture(() => Response.json({ statusCode: "404", error: "not_found", message: "Object not found" }, { status: 403 }));
    await expect(store.read(checksum, content.length)).rejects.not.toBeInstanceOf(ContentAddressedBlobNotFoundError);
  });

  it("verifies sizes and digests, including empty objects", async () => {
    const { store } = await fixture(() => new Response(content));
    await expect(store.read(checksum, content.length + 1)).rejects.toBeInstanceOf(ContentAddressedBlobIntegrityError);
    const wrong = contentAddressedChecksum(new Uint8Array(content.length));
    await expect(store.read(wrong, content.length)).rejects.toBeInstanceOf(ContentAddressedBlobIntegrityError);
    const empty = await fixture(() => new Response(null));
    expect(await empty.store.read(contentAddressedChecksum(new Uint8Array()), 0)).toEqual(new Uint8Array());
  });

  it("cancels oversized streams instead of buffering the complete object", async () => {
    const cancelled = vi.fn();
    const { store } = await fixture(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(content.length + 1)); }, cancel: cancelled,
    })));
    await expect(store.read(checksum, content.length)).rejects.toBeInstanceOf(ContentAddressedBlobIntegrityError);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("sanitizes errors raised while streaming a response", async () => {
    const { store } = await fixture(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error(options.serviceRoleKey)); },
    })));
    const read = store.read(checksum, content.length);
    await expect(read).rejects.toThrow("response could not be read");
    await expect(read).rejects.not.toBeInstanceOf(ContentAddressedBlobIntegrityError);
  });

  it("enforces the read deadline after response headers and cancels the stalled body", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const { store } = await fixture(() => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled })), { timeoutMs: 10 });
    const assertion = expect(store.read(checksum, content.length)).rejects.toThrow("read timed out");
    await vi.advanceTimersByTimeAsync(11);
    await assertion;
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("enforces a deadline even when a custom fetch ignores AbortSignal", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    const assertion = expect(SupabaseContentAddressedBlobStore.create({ ...options, fetch: fetcher, timeoutMs: 10 })).rejects.toThrow("bucket validation timed out");
    await vi.advanceTimersByTimeAsync(11);
    await assertion;
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("rejects responses redirected to another origin without echoing the URL", async () => {
    const response = new Response(content);
    Object.defineProperty(response, "url", { value: `https://another.example/${options.serviceRoleKey}` });
    const { store } = await fixture(() => response);
    await expect(store.read(checksum, content.length)).rejects.toThrow("refused a redirected response");
  });

  it("checks write and read limits before making storage requests", async () => {
    const { store, fetcher } = await fixture();
    await expect(store.write(new Uint8Array(MAX_CONTENT_ADDRESSED_BLOB_BYTES + 1))).rejects.toThrow("12 MiB");
    await expect(store.read(checksum, MAX_CONTENT_ADDRESSED_BLOB_BYTES + 1)).rejects.toBeInstanceOf(ContentAddressedBlobIntegrityError);
    await expect(store.read("../../key", 0)).rejects.toBeInstanceOf(ContentAddressedBlobIntegrityError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
