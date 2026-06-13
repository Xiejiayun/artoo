import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { BlobRef, BlobStore } from "../ports.js";

/**
 * Dev/test BlobStore backed by the local filesystem. Keys are POSIX-style
 * (`logs/1.txt`); they are confined to the store root so a malicious or buggy
 * key cannot read or write outside it. S3/MinIO swap in for production behind
 * the same {@link BlobStore} port.
 */
export class FileSystemBlobStore implements BlobStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async put(key: string, data: Uint8Array): Promise<BlobRef> {
    const target = this.#resolveKey(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    return {
      uri: pathToFileURL(target).href,
      checksum: createHash("sha256").update(data).digest("hex"),
      size: data.byteLength,
    };
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const buf = await readFile(this.#resolveKey(key));
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (err) {
      if (isNotFound(err)) {
        return null;
      }
      throw err;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    await this.#walk(this.#root, keys);
    return keys.filter((key) => key.startsWith(prefix));
  }

  async delete(key: string): Promise<void> {
    await rm(this.#resolveKey(key), { force: true });
  }

  /** Resolve a key under the root, rejecting anything that escapes it. */
  #resolveKey(key: string): string {
    const target = resolve(this.#root, key);
    if (target !== this.#root && !target.startsWith(this.#root + sep)) {
      throw new Error(`blob key escapes store root: ${key}`);
    }
    return target;
  }

  async #walk(dir: string, out: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (isNotFound(err)) {
        return;
      }
      throw err;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.#walk(full, out);
      } else {
        out.push(relative(this.#root, full).split(sep).join("/"));
      }
    }
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
