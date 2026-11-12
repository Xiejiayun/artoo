import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativeSkillInventoryV1Schema } from "@artoo/domain";
import { createNativeSkillSampler, discoverNativeSkills } from "./native-skills.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "artoo-skill-inventory-")); directories.push(home);
  const workspace = join(home, "workspace"); mkdirSync(workspace);
  return { home, workspace, options: { home, env: {}, workspaceRoots: [workspace] } };
}
function skill(directory: string, name: string, description = "Run real tests", body = "PRIVATE SKILL BODY"): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}`);
}

describe("native skill discovery", () => {
  it("discovers user, system and workspace metadata without uploading skill bodies or searching arbitrary folders", () => {
    const { home, workspace, options } = fixture();
    skill(join(home, ".codex/skills/testing"), "Test runner", "运行测试");
    skill(join(home, ".codex/skills/.system/creator"), "Skill creator");
    skill(join(home, ".agents/skills/shared"), "Shared skill");
    skill(join(workspace, ".agents/skills/frontend"), "Frontend");
    skill(join(workspace, "unrelated/hidden"), "Undiscovered");
    const result = discoverNativeSkills("codex", options)!;
    expect(NativeSkillInventoryV1Schema.safeParse(result).success).toBe(true);
    expect(result.skills.map((entry) => entry.name).sort()).toEqual(["Frontend", "Shared skill", "Skill creator", "Test runner"]);
    expect(result.skills.find((entry) => entry.name === "Frontend")).toMatchObject({ scope: "workspace", workspace_root: workspace });
    expect(result.skills.find((entry) => entry.name === "Skill creator")?.id).toBe(".system/creator");
    expect(JSON.stringify(result)).not.toContain("PRIVATE SKILL BODY");
    expect(result).toMatchObject({ truncated: false, unreadable_count: 0 });
  });

  it("respects runtime home overrides and separates Codex and Claude directories", () => {
    const { home, workspace } = fixture();
    const env = { CODEX_HOME: join(home, "codex-config"), CLAUDE_CONFIG_DIR: join(home, "claude-config") };
    skill(join(env.CODEX_HOME, "skills/codex"), "Codex skill");
    skill(join(env.CLAUDE_CONFIG_DIR, "skills/claude"), "Claude skill");
    skill(join(workspace, ".claude/skills/local"), "Claude local");
    const options = { home, env, workspaceRoots: [workspace] };
    expect(discoverNativeSkills("codex", options)?.skills.map((entry) => entry.name)).toEqual(["Codex skill"]);
    expect(discoverNativeSkills("claude-code", options)?.skills.map((entry) => entry.name)).toEqual(["Claude local", "Claude skill"]);
    expect(discoverNativeSkills("mock", options)).toBeUndefined();
  });

  it("reads folded YAML and CRLF, and reports malformed, duplicate, aliased or oversized headers", () => {
    const { home, options } = fixture();
    const root = join(home, ".codex/skills");
    const headers = ["name: Folded\r\ndescription: >-\r\n  Build and\r\n  test code", "name: Broken\nname: duplicate\ndescription: x", "name: [not, a, string]\ndescription: x", "name: Alias\nx: &x [1, 2]\ndescription: *x", `name: Large\ndescription: ${"x".repeat(40_000)}`];
    headers.forEach((header, i) => { const dir = join(root, String(i)); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "SKILL.md"), `---\r\n${header}\r\n---\r\nBody`); });
    const inventory = discoverNativeSkills("codex", options)!;
    expect(inventory.skills).toEqual([expect.objectContaining({ name: "Folded", description: "Build and test code" })]);
    expect(inventory.unreadable_count).toBe(4);
  });

  it("does not traverse linked skill directories and returns an explicit empty scan for missing folders", () => {
    const { home, options } = fixture();
    expect(discoverNativeSkills("codex", options)).toMatchObject({ skills: [], unreadable_count: 0 });
    const root = join(home, ".codex/skills"), target = join(home, "outside");
    mkdirSync(root, { recursive: true }); skill(target, "Outside skill");
    symlinkSync(target, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(discoverNativeSkills("codex", options)).toMatchObject({ skills: [], unreadable_count: 1 });
  });

  it("bounds inventories and refreshes the cached observation after one minute", () => {
    const { home, options } = fixture();
    const root = join(home, ".codex/skills");
    for (let i = 0; i < 129; i++) skill(join(root, `skill-${i}`), `Skill ${i}`);
    let now = Date.parse("2026-11-12T00:00:00Z");
    const sample = createNativeSkillSampler({ ...options, now: () => now });
    const first = sample("codex")!;
    expect(first.skills).toHaveLength(128); expect(first.truncated).toBe(true);
    rmSync(root, { recursive: true });
    now += 59_999; expect(sample("codex")).toBe(first);
    now++; expect(sample("codex")).toMatchObject({ skills: [], truncated: false, observed_at: new Date(now).toISOString() });
  });
});
