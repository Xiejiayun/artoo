import { closeSync, fstatSync, lstatSync, openSync, opendirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { MAX_NATIVE_SKILLS, NativeSkillSchema, type NativeSkill, type NativeSkillInventoryV1 } from "@artoo/domain";

interface SkillRoot { path: string; scope: NativeSkill["scope"]; workspace_root?: string }
export interface NativeSkillDiscoveryOptions {
  workspaceRoots: readonly string[];
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}
const MAX_HEADER_BYTES = 32 * 1024;
const MAX_DIRECTORIES = 1024;

/** Read metadata only; never upload the skill body, scripts or supporting files. */
function readMetadata(path: string): { name: unknown; description: unknown } {
  if (!lstatSync(path).isFile()) throw new Error("Skill manifest must be a regular file");
  const fd = openSync(path, "r");
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Skill manifest must be a regular file");
    const bytes = Buffer.alloc(MAX_HEADER_BYTES);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    const text = bytes.subarray(0, length).toString("utf8").replace(/^\uFEFF/, "");
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
    if (!header) throw new Error("Missing or oversized skill frontmatter");
    // YAML aliases are unnecessary for these two scalar fields and stay disabled.
    const doc = parseDocument(header, { uniqueKeys: true });
    if (doc.errors.length) throw new Error("Invalid skill frontmatter");
    const value = doc.toJS({ maxAliasCount: 0 }) as Record<string, unknown> | null;
    return { name: value?.name, description: value?.description };
  } finally { closeSync(fd); }
}

/** Bounded, read-only discovery in standard user and explicitly allowed workspace roots. */
export function discoverNativeSkills(runtime: string, options: NativeSkillDiscoveryOptions): NativeSkillInventoryV1 | undefined {
  if (runtime !== "codex" && runtime !== "claude-code") return undefined;
  const home = options.home ?? homedir(), env = options.env ?? process.env;
  const roots: SkillRoot[] = runtime === "codex"
    ? [{ path: join(env.CODEX_HOME || join(home, ".codex"), "skills"), scope: "user" },
      { path: join(home, ".agents", "skills"), scope: "user" }]
    : [{ path: join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "skills"), scope: "user" }];
  for (const root of options.workspaceRoots.slice(0, 32)) {
    if (!isAbsolute(root)) continue;
    for (const directory of runtime === "codex" ? [".agents", ".codex"] : [".claude"]) {
      roots.push({ path: join(root, directory, "skills"), scope: "workspace", workspace_root: resolve(root) });
    }
  }
  const inventory: NativeSkillInventoryV1 = { version: 1, observed_at: new Date(options.now?.() ?? Date.now()).toISOString(),
    skills: [], truncated: options.workspaceRoots.length > 32, unreadable_count: 0 };
  let visited = 0;
  const seen = new Set<string>();
  const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
  function scan(root: SkillRoot, directory: string, prefix = ""): void {
    let handle;
    try {
      // Do not traverse symlinks/junctions or recursively search a user's workspace.
      if (!lstatSync(directory).isDirectory()) { inventory.unreadable_count++; return; }
      handle = opendirSync(directory);
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (++visited > MAX_DIRECTORIES) { inventory.truncated = true; break; }
        if (entry.isSymbolicLink()) { inventory.unreadable_count++; continue; }
        if (!entry.isDirectory()) continue;
        if (entry.name === ".system" && !prefix) { scan(root, join(directory, entry.name), ".system/"); continue; }
        if (entry.name.startsWith(".")) continue;
        const path = resolve(directory, entry.name, "SKILL.md");
        if (seen.has(path)) continue;
        try {
          const parsed = NativeSkillSchema.safeParse({ id: prefix + entry.name, ...readMetadata(path), path,
            scope: root.scope, ...(root.workspace_root ? { workspace_root: root.workspace_root } : {}) });
          if (!parsed.success) { inventory.unreadable_count++; continue; }
          if (inventory.skills.length === MAX_NATIVE_SKILLS) { inventory.truncated = true; break; }
          inventory.skills.push(parsed.data);
          seen.add(path);
        } catch (error) { if (!missing(error)) inventory.unreadable_count++; }
      }
    } catch (error) { if (!missing(error)) inventory.unreadable_count++; }
    finally { try { handle?.closeSync(); } catch { inventory.unreadable_count++; } }
  }
  for (const root of roots) {
    if (visited > MAX_DIRECTORIES) { inventory.truncated = true; break; }
    scan(root, root.path);
  }
  inventory.skills.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  return inventory;
}

/** Avoid filesystem scans on every transport tick; each snapshot carries its own observation time. */
export function createNativeSkillSampler(options: NativeSkillDiscoveryOptions): (runtime: string) => NativeSkillInventoryV1 | undefined {
  const cache = new Map<string, { at: number; inventory: NativeSkillInventoryV1 | undefined }>();
  return (runtime) => {
    const now = options.now?.() ?? Date.now(), previous = cache.get(runtime);
    if (previous && now >= previous.at && now - previous.at < 60_000) return previous.inventory;
    const inventory = discoverNativeSkills(runtime, options);
    cache.set(runtime, { at: now, inventory });
    return inventory;
  };
}
