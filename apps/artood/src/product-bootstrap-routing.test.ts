import { existsSync, mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeEmptyProductRepository } from "./product-bootstrap.js";
import { runProtectedCommand } from "./protected-command.js";
import { VerificationCleanupError } from "./verification-cleanup-error.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";

vi.mock("./protected-command.js", () => ({ runProtectedCommand: vi.fn() }));
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  // These mocks start no native process; retained fixture staging can be removed by the test owner.
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-bootstrap-routing-"))); roots.push(root); return root;
}
const success = { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), elapsedMs: 1 };

describe("ordinary bootstrap protected routing (controlled mocks, not native qualification)", () => {
  it("routes initialization and existing-repository inspection through the same local backend", async () => {
    const root = fixture(), backend = Object.freeze({}) as PreparedWindowsProcessBackend, signal = new AbortController().signal;
    vi.mocked(runProtectedCommand).mockImplementation(async (request, options, suppliedBackend) => {
      expect(suppliedBackend).toBe(backend); expect(request.signal).toBe(signal);
      expect(options).toMatchObject({ gitExecutable: "protected-git", readTimeoutMs: 10000, materializeTimeoutMs: 10000, maxOutputBytes: 64 * 1024 });
      if (request.kind === "materialize") {
        expect(request.args).toEqual(["-c", "init.templateDir=", "init", "--initial-branch=main", "."]);
        mkdirSync(join(request.cwd, ".git")); return success;
      }
      expect(request.cwd).toBe(root); expect(request.args).toEqual(["rev-parse", "--show-toplevel", "--absolute-git-dir"]);
      return { ...success, stdout: Buffer.from(`${root}\n${join(root, ".git")}\n`) };
    });
    expect(await initializeEmptyProductRepository(root, "protected-git", signal, backend)).toBe("created");
    writeFileSync(join(root, "product", "index.html"), "source");
    expect(await initializeEmptyProductRepository(root, "protected-git", signal, backend)).toBe("existing");
    expect(readdirSync(root).some(name => name.startsWith(".artoo-initialize-"))).toBe(false);
    expect(existsSync(join(root, "product", "index.html"))).toBe(true);
  });
  it("keeps the existing optional call shape and removes only known-safe staging after a command failure", async () => {
    const root = fixture(); vi.mocked(runProtectedCommand).mockResolvedValue({ ...success, status: 3 });
    await expect(initializeEmptyProductRepository(root, "protected-git")).rejects.toThrow(/exited 3/);
    expect(runProtectedCommand).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined);
    expect(readdirSync(root)).toEqual([]);
  });
  it("retains the staging directory and prevents a second bootstrap after uncertain closure", async () => {
    const root = fixture(), error = new VerificationCleanupError("controlled unknown helper closure");
    vi.mocked(runProtectedCommand).mockRejectedValue(error);
    await expect(initializeEmptyProductRepository(root, "protected-git")).rejects.toBe(error);
    const entries = readdirSync(root); expect(entries).toHaveLength(1); expect(entries[0]).toMatch(/^\.artoo-initialize-/);
    await expect(initializeEmptyProductRepository(root, "protected-git")).rejects.toThrow(/nonempty/);
    expect(runProtectedCommand).toHaveBeenCalledTimes(1); expect(readdirSync(root)).toEqual(entries);
  });
  it("propagates inspection cleanup uncertainty while preserving the existing repository", async () => {
    const root = fixture(); mkdirSync(join(root, ".git")); writeFileSync(join(root, "source.txt"), "source");
    const error = new VerificationCleanupError("controlled unknown inspection closure"); vi.mocked(runProtectedCommand).mockRejectedValue(error);
    await expect(initializeEmptyProductRepository(root, "protected-git")).rejects.toBe(error);
    expect(readdirSync(root).sort()).toEqual([".git", "source.txt"]);
  });
});
