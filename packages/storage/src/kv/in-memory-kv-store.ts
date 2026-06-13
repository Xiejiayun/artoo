import type { KvSetOptions, KvStore } from "../ports.js";

interface Entry {
  value: string;
  /** Absolute expiry in clock ms, or null for no expiry. */
  expiresAt: number | null;
}

export interface InMemoryKvStoreOptions {
  /** Injectable clock for deterministic TTL. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Dev/test KvStore. Holds disposable state only (presence, queues, leases,
 * idempotency hints) per design 3.6, so a process-local map is sufficient;
 * Redis swaps in for production behind the same {@link KvStore} port.
 */
export class InMemoryKvStore implements KvStore {
  readonly #map = new Map<string, Entry>();
  readonly #now: () => number;

  constructor(options: InMemoryKvStoreOptions = {}) {
    this.#now = options.now ?? ((): number => Date.now());
  }

  async get(key: string): Promise<string | null> {
    return this.#read(key);
  }

  async set(key: string, value: string, options?: KvSetOptions): Promise<void> {
    this.#map.set(key, { value, expiresAt: this.#expiry(options) });
  }

  async delete(key: string): Promise<void> {
    this.#map.delete(key);
  }

  async compareAndSet(
    key: string,
    expected: string | null,
    next: string,
    options?: KvSetOptions,
  ): Promise<boolean> {
    if (this.#read(key) !== expected) {
      return false;
    }
    this.#map.set(key, { value: next, expiresAt: this.#expiry(options) });
    return true;
  }

  /** Read with lazy expiry so reads never return stale values. */
  #read(key: string): string | null {
    const entry = this.#map.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt !== null && entry.expiresAt <= this.#now()) {
      this.#map.delete(key);
      return null;
    }
    return entry.value;
  }

  #expiry(options?: KvSetOptions): number | null {
    if (options?.ttlMs === undefined) {
      return null;
    }
    return this.#now() + options.ttlMs;
  }
}
