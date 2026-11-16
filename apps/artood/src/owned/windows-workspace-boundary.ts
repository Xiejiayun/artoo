import { collectWindowsAclFacts, TRUSTED_WINDOWS_SYSTEM_SIDS, WINDOWS_ANCESTOR_REPLACEMENT_MASK, WINDOWS_MUTATION_MASK,
  windowsPathComponents, windowsPathKey } from "../windows-local-acl.js";

/** Local cooperating workspace boundary; no task can choose an executable,
 * trusted SID or bypass the physical NTFS/reparse observations. */
export function assertWindowsOwnedWorkspacePaths(paths: readonly { path: string; directory: boolean }[]): void {
  if (process.platform !== "win32") return;
  const leaves = new Set(paths.map(item => windowsPathKey(item.path)));
  const targets = new Map<string, { path: string; directory: boolean; readAcl: boolean }>();
  for (const item of paths) {
    for (const path of windowsPathComponents(item.path).slice(0, -1)) targets.set(windowsPathKey(path), { path, directory: true, readAcl: true });
    targets.set(windowsPathKey(item.path), { ...item, readAcl: true });
  }
  const facts = collectWindowsAclFacts([...targets.values()], 10000), trusted = new Set([facts.currentSid, ...TRUSTED_WINDOWS_SYSTEM_SIDS]);
  for (const item of facts.nodes) {
    if (!item.ownerSid || !trusted.has(item.ownerSid)) throw new Error("Windows owned workspace has an untrusted owner");
    const mask = leaves.has(windowsPathKey(item.path)) ? WINDOWS_MUTATION_MASK : WINDOWS_ANCESTOR_REPLACEMENT_MASK;
    if (item.aces.some(ace => ace.qualifier === "AccessAllowed" && (ace.flags & 8) === 0 && !trusted.has(ace.sid) && (ace.mask & mask) !== 0))
      throw new Error("Windows owned workspace permits foreign mutation or ancestor replacement");
  }
}
