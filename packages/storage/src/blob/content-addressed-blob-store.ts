import { createHash } from "node:crypto";

/** Server artifacts and source capsules share immutable SHA-256 object names. */
export interface ContentAddressedBlobStore {
  write(bytes: Uint8Array): Promise<void>;
  read(checksum: string, expectedSize: number): Promise<Uint8Array>;
}

export const MAX_CONTENT_ADDRESSED_BLOB_BYTES = 12 * 1024 * 1024;

/** Only an absent object is a not-found result; permissions and outages are not. */
export class ContentAddressedBlobNotFoundError extends Error {
  constructor() {
    super("Stored blob not found");
    this.name = "ContentAddressedBlobNotFoundError";
  }
}

/** Fixed diagnostic messages distinguish corrupt content from storage outages. */
export class ContentAddressedBlobIntegrityError extends Error {
  constructor(message = "Stored blob integrity check failed") {
    super(message);
    this.name = "ContentAddressedBlobIntegrityError";
  }
}

export function contentAddressedChecksum(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function validateContentAddressedRead(checksum: string, expectedSize: number): string {
  if (typeof checksum !== "string" || !/^sha256:[a-f0-9]{64}$/.test(checksum)) throw new ContentAddressedBlobIntegrityError("Invalid blob checksum");
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_CONTENT_ADDRESSED_BLOB_BYTES) {
    throw new ContentAddressedBlobIntegrityError("Stored blob size must be between 0 and 12 MiB");
  }
  return checksum.slice(7);
}

export function copyContentAddressedBytes(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_CONTENT_ADDRESSED_BLOB_BYTES) {
    throw new Error("Stored blob exceeds the 12 MiB limit");
  }
  // Callers cannot change a buffer after its content-addressed name is chosen.
  return Uint8Array.from(bytes);
}

export function verifyContentAddressedBytes(bytes: Uint8Array, checksum: string, expectedSize: number): void {
  if (bytes.byteLength !== expectedSize) throw new ContentAddressedBlobIntegrityError("Stored blob size changed");
  if (contentAddressedChecksum(bytes) !== checksum) throw new ContentAddressedBlobIntegrityError("Stored blob checksum changed");
}
