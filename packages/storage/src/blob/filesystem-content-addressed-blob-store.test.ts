import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ContentAddressedBlobIntegrityError, ContentAddressedBlobNotFoundError, contentAddressedChecksum, MAX_CONTENT_ADDRESSED_BLOB_BYTES } from "./content-addressed-blob-store.js";
import { FileSystemContentAddressedBlobStore } from "./filesystem-content-addressed-blob-store.js";

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "artoo-cas-"));
  directories.push(directory);
  return { directory, store: new FileSystemContentAddressedBlobStore(directory) };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("FileSystemContentAddressedBlobStore", () => {
  it("retains content-addressed bytes across store instances and duplicate writes", async () => {
    const { directory, store } = await fixture(), bytes = Buffer.from("retained source capsule");
    await store.write(bytes);
    await store.write(bytes);
    const checksum = contentAddressedChecksum(bytes);
    expect(await new FileSystemContentAddressedBlobStore(directory).read(checksum, bytes.length)).toEqual(bytes);
    expect(await readdir(directory)).toEqual([checksum.slice(7)]);
  });

  it("retains an empty blob", async () => {
    const { store } = await fixture(), bytes = new Uint8Array();
    await store.write(bytes);
    expect((await store.read(contentAddressedChecksum(bytes), 0)).byteLength).toBe(0);
  });

  it("distinguishes a missing object from other filesystem errors", async () => {
    const { directory, store } = await fixture(), bytes = Buffer.from("missing");
    await expect(store.read(contentAddressedChecksum(bytes), bytes.length)).rejects.toBeInstanceOf(ContentAddressedBlobNotFoundError);
    const nonDirectory = join(directory, "file");
    await writeFile(nonDirectory, "x");
    await expect(new FileSystemContentAddressedBlobStore(nonDirectory).read(contentAddressedChecksum(bytes), bytes.length))
      .rejects.not.toBeInstanceOf(ContentAddressedBlobNotFoundError);
  });

  it("rejects truncated or replaced content under the original name", async () => {
    const { directory, store } = await fixture(), bytes = Buffer.from("original");
    await store.write(bytes);
    const checksum = contentAddressedChecksum(bytes), path = join(directory, checksum.slice(7));
    await writeFile(path, "short");
    await expect(store.read(checksum, bytes.length)).rejects.toBeInstanceOf(ContentAddressedBlobIntegrityError);
    await writeFile(path, "replaced");
    await expect(store.read(checksum, bytes.length)).rejects.toBeInstanceOf(ContentAddressedBlobIntegrityError);
  });

  it("rejects path-shaped checksums and out-of-bounds sizes before IO", async () => {
    const { directory, store } = await fixture(), checksum = contentAddressedChecksum(new Uint8Array());
    await expect(store.read("sha256:../../secret", 0)).rejects.toBeInstanceOf(ContentAddressedBlobIntegrityError);
    for (const size of [-1, 0.1, NaN, MAX_CONTENT_ADDRESSED_BLOB_BYTES + 1]) {
      await expect(store.read(checksum, size)).rejects.toBeInstanceOf(ContentAddressedBlobIntegrityError);
    }
    await expect(store.write(new Uint8Array(MAX_CONTENT_ADDRESSED_BLOB_BYTES + 1))).rejects.toThrow("12 MiB");
    expect(await readdir(directory)).toEqual([]);
  });
});
