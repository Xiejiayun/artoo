import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client.js";

describe("agent workspace base API", () => {
  it("uses the exact dedicated PATCH/DELETE routes and preserves the base path", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => new Response(JSON.stringify({ agent_instance: { id: "agent/with space" } }), { status: 200 }));
    const client = new ApiClient({ baseUrl: "https://team.example/api/v1", fetch, tokenProvider: () => "device-fixture-token" });
    const setting = { version: 1, strategy: "per-run", basePath: "/Approved//Task runs /" } as const;
    await client.setAgentWorktreeBase("agent/with space", setting);
    await client.clearAgentWorktreeBase("agent/with space");
    const route = "https://team.example/api/v1/agent-instances/agent%2Fwith%20space/worktree-workspace-base";
    expect(fetch.mock.calls[0]?.[0]).toBe(route);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "PATCH", redirect: "error", credentials: "include",
      headers: { Authorization: "Bearer device-fixture-token", "Content-Type": "application/json" }, body: JSON.stringify(setting) });
    expect(fetch.mock.calls[1]?.[0]).toBe(route);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE", redirect: "error", body: undefined });
    expect(fetch.mock.calls[1]?.[1]?.headers).not.toHaveProperty("Content-Type");
  });

  it("preserves a committed-route conflict message and its status", async () => {
    const message = "Confirm the disconnected process has stopped before changing this agent instance";
    const client = new ApiClient({ fetch: async () => new Response(JSON.stringify({ error: { code: "invalid_state", message } }), { status: 409 }) });
    await expect(client.setAgentWorktreeBase("agent", { version: 1, strategy: "per-run", basePath: "/Runs" })).rejects.toMatchObject({ code: "invalid_state", status: 409, message });
    await expect(client.clearAgentWorktreeBase("agent")).rejects.toMatchObject({ status: 409, message });
  });

  it("reports an offline clear without inventing a successful response", async () => {
    const client = new ApiClient({ fetch: async () => { throw new Error("offline"); } });
    await expect(client.clearAgentWorktreeBase("agent")).rejects.toMatchObject({ code: "network_error", status: 0, message: "Network request failed: Error: offline" });
  });
});
