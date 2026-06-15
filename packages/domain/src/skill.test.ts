import { describe, expect, it } from "vitest";

import {
  PERMISSION_CATEGORIES,
  SKILL_API_VERSION,
  SkillManifestSchema,
  McpBindingSchema,
  contributedCapabilities,
  skillContributesCapabilities,
  summarizeSkillPermissions,
  validateSkillManifest,
  type SkillManifest,
} from "./skill.js";

// ---------------------------------------------------------------------------
// Fixture manifests (parsed-object form; YAML->object parsing is out of domain
// scope). No live MCP — bindings are static descriptors only.
// ---------------------------------------------------------------------------

const validMinimal = {
  api_version: "v1alpha1",
  id: "code-search",
  name: "Code Search",
  version: "1.0.0",
  capabilities: ["code.read"],
  compatible_runtimes: ["codex", "claude-code"],
} as const;

const validWithMcp = {
  api_version: "v1alpha1",
  id: "fs-tools",
  name: "Filesystem Tools",
  version: "2.3.1",
  description: "Read/write workspace files and call a local MCP server.",
  capabilities: ["code.read", "code.modify"],
  compatible_runtimes: ["claude-code"],
  permissions: {
    filesystem: { read: ["/repo"], write: ["/repo/out"] },
    network: { outbound: ["api.example.com"] },
    secrets: ["GITHUB_TOKEN"],
    external_services: ["github"],
    high_risk_actions: [{ action: "git.push", risk: "high" }],
  },
  approval_risks: [{ action: "github.post_comment", risk: "medium", reason: "external write" }],
  input_schema: "./schemas/input.json",
  output_schema: { type: "object", required: ["summary"] },
  mcp: {
    server: "filesystem",
    transport: "stdio",
    command: "mcp-server-fs",
    args: ["--root", "/repo"],
  },
} as const;

const invalidMissing = {
  api_version: "v1alpha1",
  name: "No Id",
  // missing id, version, capabilities, compatible_runtimes
} as const;

const invalidPermissionShape = {
  ...validMinimal,
  permissions: { filesystem: "all-of-it" },
} as const;

const invalidSemver = {
  ...validMinimal,
  version: "1.0",
} as const;

describe("skill manifest v1alpha1 schema", () => {
  it("parses a valid minimal manifest and defaults description", () => {
    const result = SkillManifestSchema.safeParse(validMinimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("code-search");
      expect(result.data.description).toBe("");
      expect(result.data.compatible_runtimes).toEqual(["codex", "claude-code"]);
    }
  });

  it("covers codex and claude-code runtime strings", () => {
    expect(SkillManifestSchema.safeParse(validMinimal).success).toBe(true);
    const codexOnly = { ...validMinimal, compatible_runtimes: ["codex"] };
    const claudeOnly = { ...validMinimal, compatible_runtimes: ["claude-code"] };
    expect(SkillManifestSchema.safeParse(codexOnly).success).toBe(true);
    expect(SkillManifestSchema.safeParse(claudeOnly).success).toBe(true);
  });

  it("parses a valid manifest with MCP binding and structured permissions", () => {
    const result = SkillManifestSchema.safeParse(validWithMcp);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcp?.transport).toBe("stdio");
      expect(result.data.permissions?.high_risk_actions?.[0]?.risk).toBe("high");
      expect(result.data.approval_risks).toEqual([
        { action: "github.post_comment", risk: "medium", reason: "external write" },
      ]);
      expect(result.data.input_schema).toBe("./schemas/input.json");
      expect(result.data.output_schema).toEqual({ type: "object", required: ["summary"] });
    }
  });

  it("a valid non-MCP skill does not require mcp", () => {
    const result = SkillManifestSchema.safeParse(validMinimal);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.mcp).toBeUndefined();
  });

  it("preserves forward-compatible unknown top-level fields (passthrough)", () => {
    const withExtra = { ...validMinimal, future_field: { nested: true } };
    const result = SkillManifestSchema.safeParse(withExtra);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).future_field).toEqual({ nested: true });
    }
  });

  it("rejects unknown permission categories (closed vocabulary)", () => {
    const badCategory = { ...validMinimal, permissions: { telepathy: ["minds"] } };
    expect(SkillManifestSchema.safeParse(badCategory).success).toBe(false);
  });

  it("rejects empty compatible_runtimes", () => {
    expect(SkillManifestSchema.safeParse({ ...validMinimal, compatible_runtimes: [] }).success).toBe(
      false,
    );
  });
});

describe("validateSkillManifest", () => {
  it("returns ok with the parsed manifest for valid input", () => {
    const result = validateSkillManifest(validWithMcp);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.manifest?.id).toBe("fs-tools");
  });

  it("flags every missing required field with a path", () => {
    const result = validateSkillManifest(invalidMissing);
    expect(result.ok).toBe(false);
    expect(result.manifest).toBeUndefined();
    const paths = result.errors.map((e) => e.path);
    expect(paths).toContain("id");
    expect(paths).toContain("version");
    expect(paths).toContain("capabilities");
    expect(paths).toContain("compatible_runtimes");
  });

  it("rejects an invalid permission shape with a permissions path", () => {
    const result = validateSkillManifest(invalidPermissionShape);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path.startsWith("permissions.filesystem"))).toBe(true);
  });

  it("rejects a non-semver version", () => {
    const result = validateSkillManifest(invalidSemver);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path === "version")).toBe(true);
  });

  it("is deterministic: errors are sorted and stable across calls", () => {
    const a = validateSkillManifest(invalidMissing);
    const b = validateSkillManifest(invalidMissing);
    expect(a.errors).toEqual(b.errors);
    const paths = a.errors.map((e) => e.path);
    expect([...paths]).toEqual([...paths].sort());
  });
});

describe("summarizeSkillPermissions", () => {
  it("is empty + low risk when no permissions are declared", () => {
    const manifest = SkillManifestSchema.parse(validMinimal);
    const summary = summarizeSkillPermissions(manifest);
    expect(summary.categories).toEqual([]);
    expect(summary.risk).toBe("low");
    expect(summary.secrets).toEqual([]);
  });

  it("produces a stable, sorted summary", () => {
    const manifest = SkillManifestSchema.parse({
      ...validMinimal,
      permissions: {
        filesystem: { read: ["/b", "/a"], write: [] },
        network: { outbound: ["z.com", "a.com"] },
      },
    });
    const summary = summarizeSkillPermissions(manifest);
    expect(summary.filesystem.read).toEqual(["/a", "/b"]);
    expect(summary.network.outbound).toEqual(["a.com", "z.com"]);
    expect(summary.categories).toEqual(["filesystem", "network"]);
  });

  it("rates filesystem write or network as at least medium", () => {
    const fsWrite = summarizeSkillPermissions(
      SkillManifestSchema.parse({ ...validMinimal, permissions: { filesystem: { read: [], write: ["/out"] } } }),
    );
    expect(fsWrite.risk).toBe("medium");
  });

  it("rates secrets / external services / high-risk actions as high", () => {
    const summary = summarizeSkillPermissions(SkillManifestSchema.parse(validWithMcp));
    expect(summary.risk).toBe("high");
    expect(summary.secrets).toEqual(["GITHUB_TOKEN"]);
    expect(summary.external_services).toEqual(["github"]);
    expect(summary.high_risk_actions).toEqual([{ action: "git.push", risk: "high" }]);
    expect(summary.approval_risks).toEqual([
      { action: "github.post_comment", risk: "medium", reason: "external write" },
    ]);
  });

  it("includes approval risks in deterministic risk calculation", () => {
    const summary = summarizeSkillPermissions(
      SkillManifestSchema.parse({
        ...validMinimal,
        approval_risks: [
          { action: "git.push", risk: "high" },
          { action: "github.comment", risk: "medium" },
        ],
      }),
    );
    expect(summary.risk).toBe("high");
    expect(summary.approval_risks).toEqual([
      { action: "git.push", risk: "high" },
      { action: "github.comment", risk: "medium" },
    ]);
  });
});

describe("capability contribution", () => {
  const enabledFs: SkillManifest = SkillManifestSchema.parse(validWithMcp);
  const enabledSearch: SkillManifest = SkillManifestSchema.parse(validMinimal);

  it("an enabled skill contributes its capabilities in canonical order", () => {
    expect(skillContributesCapabilities(enabledFs, true)).toEqual(["code.read", "code.modify"]);
  });

  it("a disabled skill contributes nothing", () => {
    expect(skillContributesCapabilities(enabledFs, false)).toEqual([]);
  });

  it("aggregates enabled installs, deduped", () => {
    const caps = contributedCapabilities([
      { manifest: enabledFs, enabled: true },
      { manifest: enabledSearch, enabled: true },
      { manifest: enabledSearch, enabled: false },
    ]);
    expect(caps).toEqual(["code.read", "code.modify"]);
  });

  it("filters by runtime compatibility when a runtime is given", () => {
    // enabledSearch is compatible with codex; enabledFs is claude-code only.
    expect(skillContributesCapabilities(enabledFs, true, "codex")).toEqual([]);
    expect(skillContributesCapabilities(enabledSearch, true, "codex")).toEqual(["code.read"]);
    const caps = contributedCapabilities(
      [
        { manifest: enabledFs, enabled: true },
        { manifest: enabledSearch, enabled: true },
      ],
      "codex",
    );
    expect(caps).toEqual(["code.read"]);
  });
});

describe("mcp binding descriptor (shape only, no live MCP)", () => {
  it("parses a fake local stdio descriptor", () => {
    const result = McpBindingSchema.safeParse({
      server: "filesystem",
      transport: "stdio",
      command: "mcp-server-fs",
      args: ["--root", "/repo"],
    });
    expect(result.success).toBe(true);
  });

  it("requires command for stdio and url for http/sse", () => {
    expect(McpBindingSchema.safeParse({ server: "x", transport: "stdio" }).success).toBe(false);
    expect(McpBindingSchema.safeParse({ server: "x", transport: "http" }).success).toBe(false);
    expect(
      McpBindingSchema.safeParse({ server: "x", transport: "http", url: "https://x" }).success,
    ).toBe(true);
  });
});

describe("vocabulary exports", () => {
  it("exposes the api version and permission categories", () => {
    expect(SKILL_API_VERSION).toBe("v1alpha1");
    expect(PERMISSION_CATEGORIES).toEqual([
      "filesystem",
      "network",
      "secrets",
      "external_service",
      "high_risk_action",
    ]);
  });
});
