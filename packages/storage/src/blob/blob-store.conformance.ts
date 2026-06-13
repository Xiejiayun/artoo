import { describe, expect, it } from "vitest";

import type { BlobStore } from "../ports.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Shared conformance suite every BlobStore adapter (filesystem, S3, ...) must pass. */
export function describeBlobStoreContract(
  name: string,
  setup: () => Promise<{ store: BlobStore }>,
): void {
  describe(`BlobStore contract: ${name}`, () => {
    it("returns null for a missing key", async () => {
      const { store } = await setup();
      expect(await store.get("missing/x.txt")).toBeNull();
    });

    it("puts then gets bytes and reports size + checksum shape", async () => {
      const { store } = await setup();
      const ref = await store.put("a/b.txt", encoder.encode("hello"));
      expect(ref.size).toBe(5);
      expect(ref.checksum).toMatch(/^[0-9a-f]{64}$/);
      const got = await store.get("a/b.txt");
      expect(got).not.toBeNull();
      expect(decoder.decode(got as Uint8Array)).toBe("hello");
    });

    it("checksum is the sha-256 of the stored bytes", async () => {
      const { store } = await setup();
      const ref = await store.put("c.txt", encoder.encode("hello"));
      expect(ref.checksum).toBe(
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      );
    });

    it("lists keys by prefix and deletes", async () => {
      const { store } = await setup();
      await store.put("logs/1.txt", encoder.encode("1"));
      await store.put("logs/2.txt", encoder.encode("2"));
      await store.put("other/3.txt", encoder.encode("3"));
      expect((await store.list("logs/")).sort()).toEqual(["logs/1.txt", "logs/2.txt"]);
      await store.delete("logs/1.txt");
      expect((await store.list("logs/")).sort()).toEqual(["logs/2.txt"]);
      expect(await store.get("logs/1.txt")).toBeNull();
    });

    it("rejects keys that escape the store root (POSIX and Windows styles)", async () => {
      const { store } = await setup();
      for (const bad of [
        "\0bad.txt",
        "/etc/passwd",
        "C:\\Windows\\system32\\drivers\\etc\\hosts",
        "\\\\server\\share\\escape.txt",
        "../escape.txt",
        "..\\escape.txt",
        "nested/../../escape.txt",
        "a\\..\\..\\b.txt",
      ]) {
        await expect(store.put(bad, encoder.encode("x"))).rejects.toThrow();
      }
    });
  });
}
