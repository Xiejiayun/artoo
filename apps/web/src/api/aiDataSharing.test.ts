import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client.js";

const denied = () => Response.json({ error: { code: "ai_consent_required", message: "Review sharing" } }, { status: 428 });
function setup() {
  let identity = "owner";
  let token = "token-a";
  const attempts: RequestInit[] = [];
  const api = new ApiClient({ baseUrl: "https://team.example.com/api/v1", tokenProvider: () => token,
    fetch: async (url, init) => {
      if (String(url).endsWith("/auth/session")) return Response.json({ user: { id: identity } });
      attempts.push(structuredClone(init!));
      return attempts.length === 1 ? denied() : Response.json({ accepted: true });
    },
  });
  return { api, attempts, setIdentity: (value: string) => { identity = value; }, setToken: (value: string) => { token = value; } };
}

describe("consent request replay", () => {
  it("preserves body, token and idempotency key after explicit permission", async () => {
    const { api, attempts } = setup();
    const allow = vi.fn(async () => true);
    api.setAIConsentHandler(allow, () => {}, "owner");
    await api.assignTask("task", { mode: "auto" }, "original-key");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(allow).toHaveBeenCalledTimes(1);
  });
  it("does not retry a declined action", async () => {
    const { api, attempts } = setup();
    api.setAIConsentHandler(async () => false, () => {}, "owner");
    await expect(api.assignTask("task", { mode: "auto" }, "draft-key")).rejects.toMatchObject({ status: 428 });
    expect(attempts).toHaveLength(1);
  });
  it.each(["account", "token", "logout", "unmounted"])("never replays into a changed %s", async (change) => {
    const { api, attempts, setIdentity, setToken } = setup();
    const clear = api.setAIConsentHandler(async () => {
      if (change === "account") setIdentity("someone-else");
      if (change === "token") setToken("token-b");
      if (change === "logout") api.invalidateAIConsent();
      if (change === "unmounted") clear();
      return true;
    }, () => {}, "owner");
    await expect(api.assignTask("task", { mode: "auto" }, "old-account-key")).rejects.toMatchObject({ status: 409 });
    expect(attempts).toHaveLength(1);
  });
  it("does not repeatedly prompt if the policy changes during approval", async () => {
    const fetch = vi.fn(async () => denied());
    const api = new ApiClient({ fetch, baseUrl: "https://team.example.com/api/v1" });
    api.getSession = async () => ({ user: { id: "owner", email: "owner@example.com" } });
    const allow = vi.fn(async () => true);
    api.setAIConsentHandler(allow, () => {}, "owner");
    await expect(api.assignTask("task", { mode: "auto" }, "key")).rejects.toMatchObject({ status: 428 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(allow).toHaveBeenCalledTimes(1);
  });
});
