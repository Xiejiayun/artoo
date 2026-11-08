import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { WorktreeResultsProfileSchema, openOwnedWorktreeResults } from "./owned/worktree-results.js";
import { canonicalOwnedVerification } from "./owned/worktree-verification-contract.js";
import { OwnedWorktreeVerificationTemplateSchema, prepareOwnedWorktreeVerificationTemplate, prepareOwnedResultProfiles,
  type PreparedOwnedResultProfiles } from "./owned-worktree-verification.js";
import { prepareVerificationProfiles } from "./verification.js";

/** Local administrator file only; derived identities never come from the server. */
export const OwnedResultProfilesFileV1Schema = z.object({ version: z.literal(1), profiles: z.array(z.object({
  store: WorktreeResultsProfileSchema,
  verifier: OwnedWorktreeVerificationTemplateSchema.omit({ version: true, node_id: true, project_id: true,
    results_profile_id: true, results_profile_digest: true, repository_root: true }),
}).strict()).min(1).max(64) }).strict();
const inside = (path: string, root: string) => { const rest = relative(root, path); return rest === "" || rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest); };
const sha = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function prepareFile(path: string, nodeId: string, allowedRoots: readonly string[], mode: "open" | "create"): Promise<PreparedOwnedResultProfiles> {
  if (process.platform !== "darwin") throw new Error("Managed owned-result configuration requires the qualified macOS journal platform");
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync.native(path) !== path || !allowedRoots.length) throw new Error("An absolute protected profiles file and local coding roots are required");
  const roots = allowedRoots.map(root => {
    if (!isAbsolute(root) || resolve(root) !== root || realpathSync.native(root) !== root || !lstatSync(root).isDirectory()) throw new Error("Coding roots must be physical canonical directories");
    return root;
  });
  const checkFile = () => {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!())
      || (stat.mode & 0o022n) !== 0n || stat.size > 1024n * 1024n || roots.some(root => inside(path, root))) {
      throw new Error("Profiles file must be owned, protected, bounded and outside coding roots");
    }
    return stat;
  };
  const before = checkFile(), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw new Error("Profiles file changed while opening");
    bytes = readFileSync(fd);
  } finally { closeSync(fd); }
  const parsed = OwnedResultProfilesFileV1Schema.parse(JSON.parse(bytes.toString("utf8")));
  // Validate every protected program and boundary before creating any store.
  const configured = parsed.profiles.map(entry => {
    if (entry.store.node_id !== nodeId || roots.some(root => inside(entry.store.state_root, root))) throw new Error("Result store node differs or signing state is inside a coding root");
    const templateConfig = { ...entry.verifier, version: 1 as const, node_id: nodeId, project_id: entry.store.project_id,
      results_profile_id: entry.store.id, results_profile_digest: sha(canonicalOwnedVerification(entry.store)), repository_root: entry.store.repository_root };
    const program = prepareVerificationProfiles([{ id: entry.verifier.id, project_id: entry.store.project_id, workspace_root: entry.store.repository_root,
      commands: entry.verifier.commands, subject_paths: entry.verifier.subject_paths, required_files: entry.verifier.required_files }])[0]!;
    if (program.trustedFiles.some(file => roots.some(root => inside(file.path, root)))) throw new Error("Protected verifier programs must be outside every coding root");
    return { profile: entry.store, template: prepareOwnedWorktreeVerificationTemplate(templateConfig) };
  });
  const entries = [];
  for (const entry of configured) entries.push({ store: await openOwnedWorktreeResults(entry.profile, { mode }), template: entry.template });
  const token = await prepareOwnedResultProfiles(nodeId, entries), after = checkFile();
  if (before.dev !== after.dev || before.ino !== after.ino || sha(bytes) !== sha(readFileSync(path))) throw new Error("Profiles file changed during local preparation");
  return token;
}

/** Startup never creates/reset state. Every declared store must already exist. */
export function loadOwnedResultProfilesFile(path: string, nodeId: string, allowedRoots: readonly string[]): Promise<PreparedOwnedResultProfiles> {
  return prepareFile(path, nodeId, allowedRoots, "open");
}
/** Explicit offline initialization. A partial failure retains all created files. */
export function initializeOwnedResultProfilesFile(path: string, nodeId: string, allowedRoots: readonly string[]): Promise<PreparedOwnedResultProfiles> {
  return prepareFile(path, nodeId, allowedRoots, "create");
}
