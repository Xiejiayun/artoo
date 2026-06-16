import { describe, expect, it } from "vitest";

import {
  summarizeSettings,
  toBootstrapEnv,
  validateSettings,
  type SupervisorSettings
} from "./config.js";

const SECRET = "nodecred-SECRET-do-not-leak-abc123";
const valid: SupervisorSettings = {
  serverNodeUrl: "ws://host:4000/api/v1/node",
  nodeId: "computer_1",
  nodeCredential: SECRET,
  runtimes: ["codex", "claude-code"],
  allowedRoots: ["C:/ws"],
  worktreeBaseRepo: "C:/repo"
};

describe("validateSettings", () => {
  it("accepts well-formed settings", () => {
    const result = validateSettings(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.settings.nodeId).toBe("computer_1");
  });

  it("defaults runtimes to [] and allows omitting worktreeBaseRepo", () => {
    const result = validateSettings({
      serverNodeUrl: "ws://h/api/v1/node",
      nodeId: "c1",
      nodeCredential: "x",
      allowedRoots: ["/ws"]
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings.runtimes).toEqual([]);
      expect(result.settings.worktreeBaseRepo).toBeUndefined();
    }
  });

  it("rejects a missing node credential as a start-blocking error naming the field", () => {
    const { nodeCredential: _omit, ...withoutCred } = valid;
    void _omit;
    const result = validateSettings(withoutCred);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toMatch(/nodeCredential/);
  });

  it("rejects missing required fields, naming them", () => {
    const result = validateSettings({ nodeCredential: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const joined = result.errors.join("\n");
      expect(joined).toMatch(/serverNodeUrl/);
      expect(joined).toMatch(/nodeId/);
      expect(joined).toMatch(/allowedRoots/);
    }
  });

  it("requires at least one allowed root", () => {
    expect(validateSettings({ ...valid, allowedRoots: [] }).ok).toBe(false);
  });

  it("NEVER echoes the credential value in validation errors", () => {
    // credential is present but another field is invalid → errors must not leak it.
    const result = validateSettings({ ...valid, serverNodeUrl: "  " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).not.toContain(SECRET);
  });
});

describe("toBootstrapEnv", () => {
  it("injects the credential as ARTOO_NODE_URL token and maps the rest", () => {
    const env = toBootstrapEnv(valid);
    expect(env.ARTOO_NODE_URL).toContain(`token=${SECRET}`);
    expect(env.ARTOO_NODE_ID).toBe("computer_1");
    expect(env.ARTOO_ALLOWED_ROOTS).toBe("C:/ws");
    expect(env.ARTOO_RUNTIMES).toBe("codex,claude-code");
    expect(env.ARTOO_WORKTREE_BASE_REPO).toBe("C:/repo");
  });

  it("omits optional env vars when not set", () => {
    const env = toBootstrapEnv({
      serverNodeUrl: "ws://h/api/v1/node",
      nodeId: "c1",
      nodeCredential: "x",
      runtimes: [],
      allowedRoots: ["/ws"]
    });
    expect(env.ARTOO_RUNTIMES).toBeUndefined();
    expect(env.ARTOO_WORKTREE_BASE_REPO).toBeUndefined();
  });
});

describe("summarizeSettings (credential redaction)", () => {
  it("reports only that a credential is configured, never its value", () => {
    const summary = summarizeSettings(valid);
    expect(summary.nodeCredentialConfigured).toBe(true);
    expect(summary.serverNodeUrl).toBe("ws://host:4000/api/v1/node"); // base url, no token
    expect(JSON.stringify(summary)).not.toContain(SECRET);
  });

  it("keeps the credential only in the env object, not in the printable summary", () => {
    expect(JSON.stringify(toBootstrapEnv(valid))).toContain(SECRET);
    expect(JSON.stringify(summarizeSettings(valid))).not.toContain(SECRET);
  });
});
