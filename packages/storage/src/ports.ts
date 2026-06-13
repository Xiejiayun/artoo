/**
 * Storage ports (embedded-first).
 *
 * Every port has an embedded/in-memory/filesystem adapter for dev+test and a
 * production adapter (Redis / S3 / Postgres) that is added later WITHOUT changing
 * the port. The DB swap (PGlite <-> Postgres) lives behind {@link DbClient} via
 * drizzle drivers; KvStore and BlobStore are abstracted here because drizzle does
 * not cover them.
 */

export interface KvSetOptions {
  /** Time-to-live in milliseconds. Omitted means the key never expires. */
  ttlMs?: number;
}

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: KvSetOptions): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Atomically set `key` to `next` only if its current value equals `expected`
   * (`null` meaning absent/expired). Returns true when the write happened.
   * This is the lease/lock primitive; in dev it needs no Redis round-trip.
   */
  compareAndSet(
    key: string,
    expected: string | null,
    next: string,
    options?: KvSetOptions,
  ): Promise<boolean>;
}

export interface BlobRef {
  /** Locator understood by the same BlobStore (e.g. file:// path, s3:// key). */
  uri: string;
  /** Lowercase hex sha-256 of the stored bytes. */
  checksum: string;
  /** Stored byte length. */
  size: number;
}

export interface BlobStore {
  put(key: string, data: Uint8Array): Promise<BlobRef>;
  get(key: string): Promise<Uint8Array | null>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}
