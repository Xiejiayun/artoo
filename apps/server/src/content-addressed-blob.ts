import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export const blobChecksum = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Flush a private temporary file before publishing its content-addressed name. */
export async function writeContentAddressedBlob(directory: string, bytes: Buffer): Promise<void> {
  await mkdir(directory, { recursive: true });
  const staging = join(directory, `${randomUUID()}.upload`);
  try {
    const handle = await open(staging, "wx");
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(staging, join(directory, blobChecksum(bytes).slice(7)));
  } finally { await unlink(staging).catch(() => {}); }
}

/** A missing, replaced, or truncated blob must not be sent under its expected digest. */
export async function readContentAddressedBlob(directory: string, checksum: string, size: number): Promise<Buffer> {
  if (!/^sha256:[a-f0-9]{64}$/.test(checksum)) throw new Error("Invalid blob checksum");
  const path = join(directory, checksum.slice(7)), handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== size) throw new Error("Stored blob size changed");
    // Keep allocation bounded even if storage changes after stat; reject an extra byte.
    const buffer = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const bytes = buffer.subarray(0, offset);
    if (offset !== size || blobChecksum(bytes) !== checksum) throw new Error("Stored blob checksum changed");
    return bytes;
  } finally { await handle.close(); }
}
