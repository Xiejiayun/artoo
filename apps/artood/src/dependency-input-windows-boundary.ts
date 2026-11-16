import {
  collectWindowsAclFacts,
  TRUSTED_WINDOWS_SYSTEM_SIDS,
  WINDOWS_ANCESTOR_REPLACEMENT_MASK,
  windowsPathComponents,
  windowsPathKey,
} from "./windows-local-acl.js";

/** Data snapshots are private inputs. chmod's Windows read-only attribute is
 * only supplemental; every existing component must pass the real NTFS audit. */
export function assertPrivateWindowsDependencyInputs(root: string, files: readonly string[]): void {
  if (process.platform !== "win32") return;
  const ancestors = windowsPathComponents(root),
    privatePaths = new Set([root, ...files].map(windowsPathKey));
  const targets = [
    ...ancestors.map((path) => ({ path, directory: true, readAcl: true })),
    ...files.map((path) => ({ path, directory: false, readAcl: true })),
  ];
  const facts = collectWindowsAclFacts(targets, 10000);
  const trusted = new Set([facts.currentSid, ...TRUSTED_WINDOWS_SYSTEM_SIDS]);
  for (const fact of facts.nodes) {
    if (!fact.ownerSid || !trusted.has(fact.ownerSid))
      throw new Error("Dependency input path has an untrusted Windows owner");
    const privatePath = privatePaths.has(windowsPathKey(fact.path));
    for (const ace of fact.aces) {
      if (ace.qualifier !== "AccessAllowed" || (ace.flags & 8) !== 0 || trusted.has(ace.sid)) continue;
      if (privatePath ? ace.mask !== 0 : (ace.mask & WINDOWS_ANCESTOR_REPLACEMENT_MASK) !== 0)
        throw new Error("Dependency input NTFS ACL permits a foreign principal to read or replace the snapshot");
    }
  }
}
