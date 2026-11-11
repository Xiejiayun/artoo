import { createHash } from "node:crypto";
import { FileSystemContentAddressedBlobStore, type ContentAddressedBlobStore } from "@artoo/storage";

/** Local directories remain supported by existing development and test callers. */
export type ContentAddressedBlobSource = string | ContentAddressedBlobStore;
export interface ArtifactStorageOptions {
  artifactStore?: ContentAddressedBlobStore;
  artifactDir?: string;
}

export function resolveArtifactStore(options: ArtifactStorageOptions): ContentAddressedBlobStore | undefined {
  return options.artifactStore ?? (options.artifactDir ? new FileSystemContentAddressedBlobStore(options.artifactDir) : undefined);
}

export function requireArtifactStore(options: ArtifactStorageOptions): ContentAddressedBlobStore {
  const store = resolveArtifactStore(options);
  if (!store) throw new Error("A configured artifact store is required");
  return store;
}

function storeFor(source: ContentAddressedBlobSource): ContentAddressedBlobStore {
  return typeof source === "string" ? new FileSystemContentAddressedBlobStore(source) : source;
}

export const blobChecksum = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export async function writeContentAddressedBlob(source: ContentAddressedBlobSource, bytes: Buffer): Promise<void> {
  await storeFor(source).write(bytes);
}

/** A missing, replaced, or truncated blob must not be sent under its expected digest. */
export async function readContentAddressedBlob(source: ContentAddressedBlobSource, checksum: string, size: number): Promise<Buffer> {
  return Buffer.from(await storeFor(source).read(checksum, size));
}
