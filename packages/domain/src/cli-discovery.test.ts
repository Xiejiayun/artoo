import { describe, expect, it } from "vitest";
import {
  CliConnectionVerificationOutcomeV1Schema,
  CliDiscoveryEntryV1Schema,
  CliDiscoveryInventoryV1Schema,
  DISCOVERABLE_CLI_IDS,
  SINGLE_TURN_TEXT_RUNTIME_FEATURE_V1,
  isSingleTurnTextRuntime,
} from "./cli-discovery.js";

describe("cli discovery domain contracts", () => {
  const readyCopilot = {
    id: "copilot",
    display_name: "GitHub Copilot CLI",
    install_status: "installed",
    execution_status: "ready_single_turn",
    version: "1.0.109",
    reason_code: "single_turn_no_tools_only",
    reason: "已就绪（仅手动单轮无工具）",
    can_verify: true,
    can_dispatch: true,
  } as const;

  const missingGemini = {
    id: "gemini",
    display_name: "Gemini CLI",
    install_status: "missing",
    execution_status: "unsupported",
    version: null,
    reason_code: "not_installed",
    reason: "未安装",
    can_verify: false,
    can_dispatch: false,
  } as const;

  const unverifiedShim = {
    id: "cursor",
    display_name: "Cursor CLI",
    install_status: "unverified_entrypoint",
    execution_status: "unavailable",
    version: null,
    reason_code: "unverified_windows_shim",
    reason: "入口未确认",
    can_verify: false,
    can_dispatch: false,
  } as const;

  it("exposes controlled catalog ids and single-turn runtime helper", () => {
    expect(DISCOVERABLE_CLI_IDS).toEqual(["codex", "claude-code", "copilot", "agy", "gemini", "opencode", "cursor"]);
    expect(SINGLE_TURN_TEXT_RUNTIME_FEATURE_V1).toBe("single-turn-text-runtime.v1");
    expect(isSingleTurnTextRuntime("copilot")).toBe(true);
    expect(isSingleTurnTextRuntime("agy")).toBe(true);
    expect(isSingleTurnTextRuntime("gemini")).toBe(false);
    expect(isSingleTurnTextRuntime("codex")).toBe(false);
  });

  it("accepts valid discovery entries and inventory snapshots", () => {
    const inventory = {
      version: 1,
      observed_at: "2026-11-18T08:30:00Z",
      entries: [
        {
          id: "codex",
          display_name: "Codex",
          install_status: "installed",
          execution_status: "existing_runtime",
          version: "0.139.0",
          reason_code: "existing_runtime",
          reason: "已注册既有运行时",
          can_verify: false,
          can_dispatch: true,
        },
        readyCopilot,
        {
          id: "agy",
          display_name: "Antigravity CLI",
          install_status: "installed",
          execution_status: "installed_unverified",
          version: "1.5.8",
          reason_code: "verification_required",
          reason: "已安装，未验证",
          can_verify: true,
          can_dispatch: false,
        },
        missingGemini,
        {
          id: "opencode",
          display_name: "OpenCode",
          install_status: "installed",
          execution_status: "unsupported",
          version: "0.2.1",
          reason_code: "execution_unsupported_in_mvp",
          reason: "已安装，暂不支持执行",
          can_verify: false,
          can_dispatch: false,
        },
        unverifiedShim,
      ],
    };

    expect(CliDiscoveryInventoryV1Schema.parse(inventory)).toEqual(inventory);
  });

  it("rejects inconsistent dispatch/verify flags, duplicates, unknown fields, and local paths", () => {
    // Missing or unverified entrypoints cannot dispatch or verify
    expect(CliDiscoveryEntryV1Schema.safeParse({ ...missingGemini, can_dispatch: true }).success).toBe(false);
    expect(CliDiscoveryEntryV1Schema.safeParse({ ...missingGemini, can_verify: true }).success).toBe(false);
    expect(CliDiscoveryEntryV1Schema.safeParse({ ...missingGemini, version: "1.0.0" }).success).toBe(false);
    expect(
      CliDiscoveryEntryV1Schema.safeParse({ ...unverifiedShim, execution_status: "installed_unverified" }).success,
    ).toBe(false);

    // Non-single-turn runtime cannot report ready_single_turn or can_verify
    expect(
      CliDiscoveryEntryV1Schema.safeParse({
        ...readyCopilot,
        id: "gemini",
      }).success,
    ).toBe(false);
    expect(
      CliDiscoveryEntryV1Schema.safeParse({
        ...readyCopilot,
        id: "codex",
        execution_status: "existing_runtime",
        can_verify: true,
      }).success,
    ).toBe(false);

    // Unsupported or unverified installed CLIs cannot be dispatchable
    expect(
      CliDiscoveryEntryV1Schema.safeParse({
        ...readyCopilot,
        execution_status: "installed_unverified",
        can_dispatch: true,
      }).success,
    ).toBe(false);
    expect(
      CliDiscoveryEntryV1Schema.safeParse({
        ...readyCopilot,
        execution_status: "unsupported",
        can_verify: true,
      }).success,
    ).toBe(false);

    // Local filesystem paths and control chars are rejected
    for (const leaky of [
      "C:\\Users\\alice\\copilot.exe",
      "C:/tools/copilot",
      "/Users/alice/.copilot",
      "/home/alice/bin/agy",
      "\\\\server\\share\\tool",
      "1.0.0\nsecret",
    ]) {
      expect(CliDiscoveryEntryV1Schema.safeParse({ ...readyCopilot, reason: leaky }).success).toBe(false);
      expect(CliDiscoveryEntryV1Schema.safeParse({ ...readyCopilot, version: leaky }).success).toBe(false);
    }

    // Strict object and duplicate entries rejected
    expect(CliDiscoveryEntryV1Schema.safeParse({ ...readyCopilot, extra: "no" }).success).toBe(false);
    expect(
      CliDiscoveryInventoryV1Schema.safeParse({
        version: 1,
        observed_at: "2026-11-18T08:30:00Z",
        entries: [readyCopilot, readyCopilot],
      }).success,
    ).toBe(false);
  });

  it("validates verification outcomes and rejects path leaks", () => {
    const ok = {
      version: 1,
      runtime: "copilot",
      status: "auth_failed",
      verified_at: "2026-11-18T08:31:00Z",
      version_observed: "1.0.109",
      message: "请在本机登录 Copilot CLI",
    };
    expect(CliConnectionVerificationOutcomeV1Schema.parse(ok)).toEqual(ok);
    expect(CliConnectionVerificationOutcomeV1Schema.safeParse({ ...ok, runtime: "gemini" }).success).toBe(false);
    expect(
      CliConnectionVerificationOutcomeV1Schema.safeParse({ ...ok, message: "C:\\Users\\alice\\.copilot failed" })
        .success,
    ).toBe(false);
  });
});
