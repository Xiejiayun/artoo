import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgliteDbClient } from "@artoo/storage";
import { expect, it } from "vitest";

import { backupStorage, restoreStorage } from "./storage-operations.js";

it("restores multiple large artifacts intact and never publishes a late corrupt restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "artoo-artifact-restore-"));
  try {
    const dbDir = join(root, "db");
    const artifactDir = join(root, "artifacts");
    const db = await PgliteDbClient.create({ dataDir: dbDir });
    await db.close();
    await mkdir(artifactDir);
    const names: string[] = [];
    // Each file spans many stream chunks. Total size is deliberately much
    // larger than the stream high-water mark, with distinct checksums/sizes.
    for (let index = 0; index < 4; index++) {
      const bytes = Buffer.alloc(8 * 1024 * 1024 + index, index + 1);
      const name = createHash("sha256").update(bytes).digest("hex");
      names.push(name);
      await writeFile(join(artifactDir, name), bytes);
    }
    const backup = join(root, "backup");
    await backupStorage(dbDir, artifactDir, backup);
    const target = join(root, "restored");
    await restoreStorage(backup, target);
    for (const [index, name] of names.entries()) {
      const bytes = await readFile(join(target, "artifacts", name));
      expect(bytes.length).toBe(8 * 1024 * 1024 + index);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(name);
    }
    await expect(restoreStorage(backup, target)).rejects.toThrow("refusing overwrite");

    const manifest = JSON.parse(await readFile(join(backup, "manifest.json"), "utf8")) as { artifacts: Array<{ name: string }> };
    const last = manifest.artifacts.at(-1)!.name;
    const corrupt = await open(join(backup, "artifacts", last), "r+");
    try { await corrupt.write(Buffer.from([255]), 0, 1, 0); } finally { await corrupt.close(); }
    const unpublished = join(root, "corrupt-restore");
    await expect(restoreStorage(backup, unpublished)).rejects.toThrow("checksum mismatch");
    await expect(access(unpublished)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).some((name) => name.startsWith("corrupt-restore.partial-"))).toBe(false);
    // A failed later restore also cannot affect the already published one.
    expect(createHash("sha256").update(await readFile(join(target, "artifacts", last))).digest("hex")).toBe(last);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
