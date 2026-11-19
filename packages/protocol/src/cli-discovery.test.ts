import { describe, expect, it } from "vitest";
import {
  cliDiscoveryRefreshCommandSchema,
  cliDiscoverySnapshotMessageSchema,
  cliVerifyConnectionCommandSchema,
  cliVerifyResultMessageSchema,
} from "./cli-discovery.js";
import { commandSchema, nodeHeartbeatSchema } from "./node-messages.js";

describe("cli discovery protocol contracts", () => {
  const discoveryInventory = {
    version: 1,
    observed_at: "2026-11-18T08:30:00Z",
    entries: [
      {
        id: "copilot",
        display_name: "GitHub Copilot CLI",
        install_status: "installed",
        execution_status: "installed_unverified",
        version: "1.0.109",
        reason_code: "verification_required",
        reason: "已安装，未验证",
        can_verify: true,
        can_dispatch: false,
      },
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
    ],
  } as const;

  it("keeps cli_discovery optional on node.heartbeat for older daemons", () => {
    const legacy = {
      kind: "node.heartbeat",
      node_id: "computer_legacy",
      sequence: 1,
      resources: { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 10 },
      runtimes: [{ runtime: "codex", status: "available" }],
      running_instances: [],
    };
    const parsedLegacy = nodeHeartbeatSchema.parse(legacy);
    expect(parsedLegacy.cli_discovery).toBeUndefined();

    const parsedModern = nodeHeartbeatSchema.parse({
      ...legacy,
      cli_discovery: discoveryInventory,
    });
    expect(parsedModern.cli_discovery).toEqual(discoveryInventory);
  });

  it("validates refresh and verify commands without accepting server-supplied argv", () => {
    const refresh = {
      kind: "command",
      id: "cmd_refresh_1",
      idempotency_key: "refresh_1",
      type: "cli.discovery.refresh.v1",
      payload: { version: 1, request_id: "req_1" },
    };
    expect(cliDiscoveryRefreshCommandSchema.parse(refresh)).toEqual(refresh);
    expect(commandSchema.parse(refresh)).toEqual(refresh);
    expect(
      commandSchema.safeParse({
        ...refresh,
        payload: { ...refresh.payload, argv: ["--version"] },
      }).success,
    ).toBe(false);

    const verify = {
      kind: "command",
      id: "cmd_verify_1",
      idempotency_key: "verify_1",
      type: "cli.verify.v1",
      payload: { version: 1, request_id: "req_2", runtime: "copilot" },
    };
    expect(cliVerifyConnectionCommandSchema.parse(verify)).toEqual(verify);
    expect(commandSchema.parse(verify)).toEqual(verify);
    expect(
      commandSchema.safeParse({
        ...verify,
        payload: { ...verify.payload, runtime: "gemini" },
      }).success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({
        ...verify,
        payload: { ...verify.payload, command: "copilot" },
      }).success,
    ).toBe(false);
  });

  it("validates discovery snapshot and verify result frames", () => {
    const snapshot = {
      kind: "cli.discovery.snapshot.v1",
      node_id: "computer_1",
      request_id: "req_1",
      cli_discovery: discoveryInventory,
    };
    expect(cliDiscoverySnapshotMessageSchema.parse(snapshot)).toEqual(snapshot);

    const result = {
      kind: "cli.verify.result.v1",
      node_id: "computer_1",
      request_id: "req_2",
      outcome: {
        version: 1,
        runtime: "copilot",
        status: "verified",
        verified_at: "2026-11-18T08:31:00Z",
        version_observed: "1.0.109",
        message: "已就绪（仅手动单轮无工具）",
      },
      cli_discovery: discoveryInventory,
    };
    expect(cliVerifyResultMessageSchema.parse(result)).toEqual(result);
    expect(
      cliVerifyResultMessageSchema.safeParse({
        ...result,
        outcome: { ...result.outcome, message: "C:\\Users\\alice\\token" },
      }).success,
    ).toBe(false);
  });
});
