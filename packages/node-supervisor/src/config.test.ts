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

describe("serverNodeUrl hardening", () => {
  it("rejects a token-bearing url without echoing the token", () => {
    const result = validateSettings({ ...valid, serverNodeUrl: "ws://host/api/v1/node?token=leaked" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).not.toContain("leaked");
  });

  it("rejects a url with userinfo without echoing the password", () => {
    const result = validateSettings({ ...valid, serverNodeUrl: "ws://user:hunter2@host/api/v1/node" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).not.toContain("hunter2");
  });

  it("rejects non-ws protocols (http/file)", () => {
    expect(validateSettings({ ...valid, serverNodeUrl: "http://host/api/v1/node" }).ok).toBe(false);
    expect(validateSettings({ ...valid, serverNodeUrl: "file:///etc/passwd" }).ok).toBe(false);
  });

  it("accepts wss", () => {
    expect(validateSettings({ ...valid, serverNodeUrl: "wss://host/api/v1/node" }).ok).toBe(true);
  });

  it("summary sanitizes a token/userinfo-bearing url (defense in depth)", () => {
    // Bypass validation to prove the summary itself never echoes secrets.
    const dirty: SupervisorSettings = {
      ...valid,
      serverNodeUrl: "ws://user:hunter2@host/api/v1/node?token=leaked"
    };
    const summary = summarizeSettings(dirty);
    expect(summary.serverNodeUrl).toBe("ws://host/api/v1/node");
    expect(JSON.stringify(summary)).not.toContain("leaked");
    expect(JSON.stringify(summary)).not.toContain("hunter2");
  });
});

describe("whitespace-only rejection", () => {
  it("rejects whitespace-only nodeId and nodeCredential, naming the fields", () => {
    const result = validateSettings({ ...valid, nodeId: "   ", nodeCredential: "  \t " });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const joined = result.errors.join("\n");
      expect(joined).toMatch(/nodeId/);
      expect(joined).toMatch(/nodeCredential/);
    }
  });

  it("rejects whitespace-only allowed roots", () => {
    expect(validateSettings({ ...valid, allowedRoots: ["  "] }).ok).toBe(false);
  });

  it("trims normalizable fields (nodeId, allowedRoots)", () => {
    const result = validateSettings({ ...valid, nodeId: " computer_1 ", allowedRoots: [" C:/ws "] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.settings.nodeId).toBe("computer_1");
      expect(result.settings.allowedRoots).toEqual(["C:/ws"]);
    }
  });
});
