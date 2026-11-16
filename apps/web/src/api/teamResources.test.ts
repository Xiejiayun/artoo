import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client.js";

describe("Team resource API", () => {
  it("encodes resource identity and sends explicit revision and version fields", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method: init?.method ?? "GET", body });
      const result = url.endsWith("/squad")
        ? { squad: { version: 1, project_id: "project /", revision: 3, source: "configured", agent_ids: ["agent"] } }
        : url.endsWith("/admission")
          ? { admission: { version: 1, computer_id: "machine /", revision: 2, state: "draining" } }
          : {
              policy: null,
              active: false,
              capacity_admission: { version: 1, shared_quotas_enabled: false, project_quota_enabled: false },
            };
      return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    });
    const api = new ApiClient({ baseUrl: "http://test.local/api/v1", fetch: fetcher });
    await api.putProjectSquad("project /", 2, ["agent"]);
    await api.putComputerAdmission("machine /", 1, "draining");
    await api.putSchedulingPolicy("project", "project /", 4, {
      version: 1,
      repo_url: null,
      default_branch: "main",
      max_concurrent_runs: 2,
    });
    expect(calls).toEqual([
      {
        url: "http://test.local/api/v1/projects/project%20%2F/squad",
        method: "PUT",
        body: { version: 1, expected_revision: 2, agent_ids: ["agent"] },
      },
      {
        url: "http://test.local/api/v1/computers/machine%20%2F/admission",
        method: "PUT",
        body: { version: 1, expected_revision: 1, state: "draining" },
      },
      {
        url: "http://test.local/api/v1/projects/project%20%2F/scheduling-policy",
        method: "PUT",
        body: {
          version: 1,
          expected_revision: 4,
          policy: { version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 2 },
        },
      },
    ]);
  });
  it("rejects unsupported Squad response versions", async () => {
    const api = new ApiClient({
      fetch: async () =>
        new Response(JSON.stringify({ squad: { version: 2 } }), { headers: { "content-type": "application/json" } }),
    });
    await expect(api.getProjectSquad("project")).rejects.toThrow();
  });
});
