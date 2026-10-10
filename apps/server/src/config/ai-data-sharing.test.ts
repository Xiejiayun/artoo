import { describe, expect, it } from "vitest";
import { buildAiDataSharingPolicy, loadAiDataSharingPolicy } from "./ai-data-sharing.js";

const provider = { id: "test-provider", name: "Test AI provider", privacy_url: "https://provider.example.com/privacy" };
const external = () => ({ mode: "external", providers: [{ ...provider }] });

describe("AI data sharing disclosure", () => {
  it("distinguishes missing configuration from an explicit local-only declaration", () => {
    expect(loadAiDataSharingPolicy({})).toBeNull();
    const local = loadAiDataSharingPolicy({ ARTOO_AI_DATA_SHARING_POLICY: JSON.stringify({ mode: "local", providers: [] }) });
    expect(local?.mode).toBe("local");
    expect(local?.providers).toEqual([]);
    expect(() => buildAiDataSharingPolicy({ mode: "external", providers: [] })).toThrow();
    expect(() => buildAiDataSharingPolicy({ mode: "local", providers: [provider] })).toThrow();
  });

  it("versions all disclosed recipients and data use without depending on provider order", () => {
    const input = external();
    input.providers.push({ id: "second", name: "Second provider", privacy_url: "https://second.example.com/privacy" });
    const policy = buildAiDataSharingPolicy(input);
    expect(policy.version).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(policy.data_categories).toContain("workspace_files");
    expect(buildAiDataSharingPolicy({ ...input, providers: [...input.providers].reverse() }).version).toBe(policy.version);
    expect(buildAiDataSharingPolicy({ ...input, providers: [{ ...provider, name: "Changed recipient" }] }).version).not.toBe(policy.version);
    expect(buildAiDataSharingPolicy({ ...input, providers: [{ ...provider, privacy_url: "https://provider.example.com/new-policy" }] }).version).not.toBe(policy.version);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.providers[0])).toBe(true);
  });

  it("refuses private, insecure or credential-bearing policy URLs without logging their contents", () => {
    for (const privacy_url of ["http://provider.example.com/privacy", "https://user:private-secret@provider.example.com/privacy", "https://localhost/privacy", "https://internal.local/privacy", "https://127.0.0.1/privacy", "https://[::1]/privacy", "https://provider.example.com/privacy?token=private-secret"]) {
      let message = "";
      try { buildAiDataSharingPolicy({ ...external(), providers: [{ ...provider, privacy_url }] }); }
      catch (error) { message = (error as Error).message; }
      expect(message).not.toBe("");
      expect(message).not.toContain("private-secret");
    }
  });

  it("rejects secrets, duplicate identities and incomplete provider descriptions", () => {
    for (const input of [
      { ...external(), api_key: "private-secret" },
      { ...external(), providers: [{ ...provider, api_key: "private-secret" }] },
      { ...external(), providers: [provider, provider] },
      { ...external(), providers: [{ ...provider, name: " " }] },
      { ...external(), providers: [{ ...provider, id: "Bad ID" }] },
      { mode: "automatic", providers: [] },
      { providers: [provider] },
    ]) expect(() => buildAiDataSharingPolicy(input)).toThrow();
    try { loadAiDataSharingPolicy({ ARTOO_AI_DATA_SHARING_POLICY: '{"secret":"private-secret"' }); }
    catch (error) { expect((error as Error).message).not.toContain("private-secret"); }
  });
});
