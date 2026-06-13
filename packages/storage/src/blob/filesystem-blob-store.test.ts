import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeBlobStoreContract } from "./blob-store.conformance.js";
import { FileSystemBlobStore } from "./filesystem-blob-store.js";

describeBlobStoreContract("FileSystemBlobStore", async () => {
  const root = await mkdtemp(join(tmpdir(), "artoo-blob-"));
  return { store: new FileSystemBlobStore(root) };
});
