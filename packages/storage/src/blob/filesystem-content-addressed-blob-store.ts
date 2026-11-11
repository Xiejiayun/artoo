import { randomUUID } from "node:crypto";
import { mkdir, open, rename, stat as fileStat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ContentAddressedBlobIntegrityError, ContentAddressedBlobNotFoundError, contentAddressedChecksum, copyContentAddressedBytes,
  validateContentAddressedRead, verifyContentAddressedBytes, type ContentAddressedBlobStore } from "./content-addressed-blob-store.js";

export class FileSystemContentAddressedBlobStore implements ContentAddressedBlobStore {
  readonly #directory: string;

  constructor(directory: string) {
    if (typeof directory !== "string" || !directory.trim() || directory.includes("\0")) throw new Error("Invalid blob directory");
    this.#directory = resolve(directory);
  }

  async write(input: Uint8Array): Promise<void> {
    const bytes = copyContentAddressedBytes(input);
    await mkdir(this.#directory, { recursive: true });
    const staging = join(this.#directory, `${randomUUID()}.upload`);
    try {
      const handle = await open(staging, "wx");
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(staging, join(this.#directory, contentAddressedChecksum(bytes).slice(7)));
    } finally {
      // The rename consumes the staging file on success. Preserve write errors.
      await unlink(staging).catch(() => undefined);
    }
  }

  async read(checksum: string, expectedSize: number): Promise<Uint8Array> {
    const key = validateContentAddressedRead(checksum, expectedSize);
    let handle;
    try { handle = await open(join(this.#directory, key), "r"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Windows also reports ENOENT when a parent component is a regular file.
        // A misconfigured store root must not look like an absent artifact.
        try {
          if (!(await fileStat(this.#directory)).isDirectory()) throw new Error("Blob directory is not a directory");
        } catch (rootError) {
          if ((rootError as NodeJS.ErrnoException).code !== "ENOENT") throw rootError;
        }
        throw new ContentAddressedBlobNotFoundError();
      }
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== expectedSize) throw new ContentAddressedBlobIntegrityError("Stored blob size changed");
      const buffer = Buffer.alloc(expectedSize + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const bytes = buffer.subarray(0, offset);
      verifyContentAddressedBytes(bytes, checksum, expectedSize);
      return bytes;
    } finally { await handle.close(); }
  }
}
