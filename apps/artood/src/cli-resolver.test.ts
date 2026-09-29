import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCliCommand, runtimeAvailable } from "./cli-resolver.js";

describe("safe runtime executable resolution", () => {
  it("reports missing binaries and never searches a task-relative PATH entry", () => {
    expect(resolveCliCommand("artoo-not-installed", "")).toBeUndefined();
    expect(resolveCliCommand("artoo-not-installed", ".")).toBeUndefined();
    expect(resolveCliCommand(process.execPath)).toEqual([process.execPath]);
    expect(runtimeAvailable("artoo-not-installed", process.execPath)).toBe(true);
    expect(runtimeAvailable("codex", join(tmpdir(), "artoo-nonexistent-program.exe"))).toBe(false);
  });

  it.runIf(process.platform === "win32")("resolves an npm cmd shim to Node argv without executing its shell text", () => {
    const root = mkdtempSync(join(tmpdir(), "artoo-cli-"));
    try {
      mkdirSync(join(root, "node_modules", "fake"), { recursive: true });
      const entry = join(root, "node_modules", "fake", "cli.js");
      writeFileSync(entry, "process.exit(0)");
      writeFileSync(join(root, "test-cli.cmd"), '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\fake\\cli.js" %*\r\n');
      expect(resolveCliCommand("test-cli", root)).toEqual([process.execPath, entry]);
      writeFileSync(join(root, "unsafe.cmd"), "echo secret & arbitrary.exe %*");
      expect(resolveCliCommand("unsafe", root)).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.runIf(process.platform !== "win32")("requires executable permission on Unix", () => {
    const root = mkdtempSync(join(tmpdir(), "artoo-cli-"));
    try {
      const file = join(root, "test-cli");
      writeFileSync(file, "#!/bin/sh\nexit 0\n");
      expect(resolveCliCommand("test-cli", root)).toBeUndefined();
      chmodSync(file, 0o755);
      expect(resolveCliCommand("test-cli", root)).toEqual([file]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
