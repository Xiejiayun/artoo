import { createHash } from "node:crypto";
import { ContentAddressedBlobIntegrityError, ContentAddressedBlobNotFoundError, type ContentAddressedBlobStore } from "@artoo/storage";

/** Controlled object-store fixture: deliberately has no filesystem directory. */
export class MemoryArtifactStore implements ContentAddressedBlobStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly reads: string[] = [];
  readonly writes: string[] = [];

  async write(bytes: Uint8Array): Promise<void> {
    const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    this.objects.set(checksum, Uint8Array.from(bytes));
    this.writes.push(checksum);
  }

  async read(checksum: string, expectedSize: number): Promise<Uint8Array> {
    this.reads.push(checksum);
    const bytes = this.objects.get(checksum);
    if (!bytes) throw new ContentAddressedBlobNotFoundError();
    if (bytes.byteLength !== expectedSize || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== checksum) {
      throw new ContentAddressedBlobIntegrityError("Controlled object-store integrity failure");
    }
    return Uint8Array.from(bytes);
  }
}
