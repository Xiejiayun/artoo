import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nodeHeartbeatSchema } from "@artoo/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAdapterRegistry } from "./adapter-registry.js";
import {
  CONTROLLED_CLI_CATALOG,
  createCliDiscoverySampler,
  inspectCliEntrypoint,
  probeCliVersionAndIdentity,
} from "./cli-discovery.js";
import { createRegistryHeartbeat } from "./heartbeat.js";
import { claudeCodeRuntime, codexRuntime } from "./runtimes.js";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeFakeNodeScriptCli(dir: string, commandName: string, versionOutput: string, exitCode = 0): string {
  const scriptName = `${commandName}-cli.cjs`;
  const scriptPath = join(dir, scriptName);
  writeFileSync(
    scriptPath,
    `if (${exitCode} !== 0) { process.exit(${exitCode}); }\nprocess.stdout.write(${JSON.stringify(versionOutput)} + "\\n");\n`,
    "utf8",
  );
  if (process.platform === "win32") {
    const cmdPath = join(dir, `${commandName}.cmd`);
    writeFileSync(cmdPath, `@ECHO OFF\r\n"%~dp0\\node.exe" "%dp0%\\${scriptName}" %*\r\n`, "utf8");
    return cmdPath;
  }
  const shPath = join(dir, commandName);
  writeFileSync(shPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, { mode: 0o755 });
  return shPath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("cli-discovery", () => {
  it("matches scripts/npm-daemon/local-config.mjs CONTROLLED_CLI_CATALOG 1-to-1", async () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const modulePath = resolve(repoRoot, "scripts", "npm-daemon", "local-config.mjs");
    const localConfigModule = (await import(pathToFileURL(modulePath).href)) as {
      CONTROLLED_CLI_CATALOG: ReadonlyArray<{
        id: string;
        displayName: string;
        command: string;
        kind: string;
      }>;
    };
    const standaloneCatalog = localConfigModule.CONTROLLED_CLI_CATALOG.map((item) => ({
      id: item.id,
      displayName: item.displayName,
      command: item.command,
      kind: item.kind,
    }));
    expect(CONTROLLED_CLI_CATALOG).toEqual(standaloneCatalog);
    expect(CONTROLLED_CLI_CATALOG.map((item) => item.id)).toEqual([
      "codex",
      "claude-code",
      "copilot",
      "agy",
      "gemini",
      "opencode",
      "cursor",
    ]);
  });

  it("identifies verified npm shims, rejects unverified Windows shims, and rejects mismatched product versions", () => {
    const binDir = createTempDir("artoo-cli-discovery-");
    const copilotEntry = makeFakeNodeScriptCli(binDir, "copilot", "GitHub Copilot CLI 1.0.109.");
    const codexOverride = join(binDir, "codex-custom.cmd");
    if (process.platform === "win32") {
      writeFileSync(join(binDir, "codex-custom.cjs"), 'process.stdout.write("codex-cli 0.55.0\\n");\n', "utf8");
      writeFileSync(codexOverride, '@ECHO OFF\r\n"%dp0%\\codex-custom.cjs" %*\r\n', "utf8");
      // Unknown batch script that does not match the npm JS shim template must fail closed without shell execution.
      writeFileSync(join(binDir, "gemini.cmd"), "@echo off\r\necho Gemini CLI 9.9.9\r\n", "utf8");
    }
    const fakeCopilotOverride = makeFakeNodeScriptCli(binDir, "fake-copilot", "Some Other Binary 1.2.3");

    if (process.platform === "win32") {
      const geminiInspected = inspectCliEntrypoint("gemini", { PATH: binDir, PATHEXT: ".CMD" }, { platform: "win32" });
      expect(geminiInspected).toEqual({ status: "unverified_shim" });
    }

    const sampler = createCliDiscoverySampler({
      env: { PATH: binDir, PATHEXT: process.platform === "win32" ? ".EXE;.CMD;.BAT" : "" },
      platform: "win32",
      arch: "x64",
      binaryOverrides: {
        codex:
          process.platform === "win32" ? codexOverride : makeFakeNodeScriptCli(binDir, "codex", "codex-cli 0.55.0"),
        copilot: copilotEntry,
        cursor: fakeCopilotOverride,
      },
      registeredRuntimes: new Set(["codex"]),
      supportedSingleTurnRuntimes: new Set(),
      enabledSingleTurnRuntimes: new Set(),
    });

    const snapshot = sampler.snapshot();
    const byId = Object.fromEntries(snapshot.entries.map((entry) => [entry.id, entry]));

    expect(byId.codex).toMatchObject({
      install_status: "installed",
      execution_status: "existing_runtime",
      version: "0.55.0",
      reason_code: "existing_runtime",
      can_dispatch: true,
    });
    expect(byId.copilot).toMatchObject({
      install_status: "installed",
      execution_status: "unsupported",
      version: "1.0.109",
      reason_code: "execution_unsupported_in_mvp",
      can_verify: false,
      can_dispatch: false,
    });
    expect(byId.cursor).toMatchObject({
      install_status: "unverified_entrypoint",
      execution_status: "unavailable",
      version: null,
      reason_code: "identity_unconfirmed",
      can_verify: false,
      can_dispatch: false,
    });
    expect(byId.opencode).toMatchObject({
      install_status: "missing",
      execution_status: "unsupported",
      version: null,
      reason_code: "not_installed",
    });
    if (process.platform === "win32") {
      expect(byId.gemini).toMatchObject({
        install_status: "unverified_entrypoint",
        execution_status: "unavailable",
        reason_code: "unverified_windows_shim",
      });
    }

    // Never expose raw local paths inside reported entries.
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(binDir);
  });

  it("separates non-Windows platforms, disabled single-turn runtimes, verification status, and version fingerprint replacement", () => {
    const binDir = createTempDir("artoo-cli-state-");
    const copilotPath = join(binDir, "copilot");
    writeFileSync(copilotPath, "copilot-v1", "utf8");

    let currentVersion = "1.0.109";
    const probeMock = vi.fn(() => ({ confirmed: true, version: currentVersion }));

    // Non-Windows x64 stays platform_unsupported even if supportedSingleTurnRuntimes lists copilot.
    const macSampler = createCliDiscoverySampler({
      env: { PATH: "" },
      platform: "darwin",
      arch: "arm64",
      binaryOverrides: { copilot: copilotPath },
      supportedSingleTurnRuntimes: new Set(["copilot"]),
      enabledSingleTurnRuntimes: new Set(["copilot"]),
      probeVersion: probeMock,
    });
    expect(macSampler.snapshot().entries.find((e) => e.id === "copilot")).toMatchObject({
      install_status: "installed",
      execution_status: "unavailable",
      reason_code: "platform_unsupported",
      can_verify: false,
      can_dispatch: false,
    });

    // On win32 x64 with verified fingerprint: replacing the binary invalidates verification.
    let verifiedFingerprint: string | null = null;
    const winSampler = createCliDiscoverySampler({
      env: { PATH: "" },
      platform: "win32",
      arch: "x64",
      binaryOverrides: { copilot: copilotPath },
      supportedSingleTurnRuntimes: new Set(["copilot", "agy"]),
      enabledSingleTurnRuntimes: new Set(["copilot"]),
      probeVersion: probeMock,
      getVerificationOutcome: (runtime, fingerprint) =>
        runtime === "copilot" && verifiedFingerprint === fingerprint
          ? {
              version: 1,
              runtime: "copilot",
              status: "verified",
              verified_at: "2026-11-18T00:00:00.000Z",
              version_observed: currentVersion,
              message: "连接验证通过",
            }
          : undefined,
    });

    const first = winSampler.snapshot().entries.find((e) => e.id === "copilot");
    expect(first?.execution_status).toBe("installed_unverified");
    expect(first?.can_verify).toBe(true);
    expect(first?.can_dispatch).toBe(false);

    verifiedFingerprint = winSampler.candidate("copilot")!.fingerprint!;
    expect(winSampler.snapshot().entries.find((e) => e.id === "copilot")).toMatchObject({
      execution_status: "ready_single_turn",
      reason_code: "single_turn_no_tools_only",
      can_dispatch: true,
    });

    // Replace binary file contents -> fingerprint changes -> refresh() drops ready state cleanly.
    currentVersion = "1.0.110";
    writeFileSync(copilotPath, "copilot-v2-upgraded", "utf8");
    winSampler.refresh();
    expect(winSampler.snapshot().entries.find((e) => e.id === "copilot")).toMatchObject({
      execution_status: "installed_unverified",
      version: "1.0.110",
      reason_code: "verification_required",
      can_dispatch: false,
    });
  });

  it("caches probe results across heartbeats without re-spawning CLIs", () => {
    const binDir = createTempDir("artoo-cli-cache-");
    const copilotPath = join(binDir, "copilot");
    writeFileSync(copilotPath, "binary", "utf8");

    const probeSpy = vi.fn(() => ({ confirmed: true, version: "1.0.109" }));
    const sampler = createCliDiscoverySampler({
      env: { PATH: "" },
      platform: "win32",
      arch: "x64",
      binaryOverrides: { copilot: copilotPath },
      probeVersion: probeSpy,
    });

    const registry = createAdapterRegistry([
      codexRuntime({ allowedRoots: ["/ws"] }),
      claudeCodeRuntime({ allowedRoots: ["/ws"] }),
    ]);
    const beat = createRegistryHeartbeat({
      nodeId: "node-1",
      registry,
      cliDiscovery: () => sampler.snapshot(),
    });

    expect(probeSpy).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 8; i++) {
      const hb = beat();
      expect(nodeHeartbeatSchema.parse(hb).cli_discovery?.entries).toHaveLength(7);
    }
    expect(probeSpy).toHaveBeenCalledTimes(1);

    sampler.refresh();
    expect(probeSpy).toHaveBeenCalledTimes(2);
  });

  it("distinguishes agy bare version output from non-antigravity executables via acp --help check", () => {
    const binDir = createTempDir("artoo-cli-agy-check-");
    const fakeScript = join(binDir, "fake-agy.cjs");
    writeFileSync(
      fakeScript,
      'if (process.argv.includes("--version")) console.log("1.5.8"); else console.log("unrelated tool help");\n',
      "utf8",
    );
    const resolvedFake = {
      status: "resolved" as const,
      executable: process.execPath,
      prefixArgs: [fakeScript],
      entrypointPath: fakeScript,
      fingerprint: "sha256:fake",
    };
    expect(probeCliVersionAndIdentity("agy", resolvedFake)).toEqual({ confirmed: false, version: null });

    const realScript = join(binDir, "real-agy.cjs");
    writeFileSync(
      realScript,
      'if (process.argv.includes("--version")) console.log("1.5.8"); else if (process.argv[2] === "acp" && process.argv[3] === "--help") console.log("antigravity-cli acp");\n',
      "utf8",
    );
    const resolvedReal = {
      status: "resolved" as const,
      executable: process.execPath,
      prefixArgs: [realScript],
      entrypointPath: realScript,
      fingerprint: "sha256:real",
    };
    expect(probeCliVersionAndIdentity("agy", resolvedReal)).toEqual({ confirmed: true, version: "1.5.8" });

    // Confirm nested subdirs don't accidentally match relative entries when PATH contains missing folders.
    mkdirSync(join(binDir, "empty"));
    expect(inspectCliEntrypoint("copilot", { PATH: join(binDir, "empty") }, { platform: "win32" })).toEqual({
      status: "missing",
    });
  });
});
