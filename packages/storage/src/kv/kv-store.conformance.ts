import { describe, expect, it } from "vitest";

import type { KvStore } from "../ports.js";

/**
 * Shared conformance suite that EVERY KvStore adapter must pass. This is what
 * guarantees dev (in-memory) and prod (Redis) behave identically — the parity
 * net for embedded-first. `advance` moves the adapter's injected clock so TTL
 * is asserted deterministically (Gate 0: no wall-clock in tests).
 */
export function describeKvStoreContract(
  name: string,
  setup: () => { store: KvStore; advance: (ms: number) => void },
): void {
  describe(`KvStore contract: ${name}`, () => {
    it("returns null for missing keys", async () => {
      const { store } = setup();
      expect(await store.get("missing")).toBeNull();
    });

    it("sets then gets a value", async () => {
      const { store } = setup();
      await store.set("k", "v");
      expect(await store.get("k")).toBe("v");
    });

    it("overwrites and deletes", async () => {
      const { store } = setup();
      await store.set("k", "v1");
      await store.set("k", "v2");
      expect(await store.get("k")).toBe("v2");
      await store.delete("k");
      expect(await store.get("k")).toBeNull();
    });

    it("expires values after the ttl elapses", async () => {
      const { store, advance } = setup();
      await store.set("k", "v", { ttlMs: 100 });
      expect(await store.get("k")).toBe("v");
      advance(99);
      expect(await store.get("k")).toBe("v");
      advance(1);
      expect(await store.get("k")).toBeNull();
    });

    it("compareAndSet writes only when the expected value matches", async () => {
      const { store } = setup();
      // absent -> set succeeds when expecting null
      expect(await store.compareAndSet("k", null, "first")).toBe(true);
      expect(await store.get("k")).toBe("first");
      // stale expectation is rejected, value unchanged
      expect(await store.compareAndSet("k", "wrong", "second")).toBe(false);
      expect(await store.get("k")).toBe("first");
      // correct expectation swaps the value
      expect(await store.compareAndSet("k", "first", "second")).toBe(true);
      expect(await store.get("k")).toBe("second");
    });
  });
}
