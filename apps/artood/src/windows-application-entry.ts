import type { VerificationCapabilities } from "@artoo/domain";
import type { ArtoodConfig } from "./main.js";
import type { ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";
import { readApplicationVerificationProfile } from "./application-verification-profile.js";
import { attachWindowsVerificationBackend, prepareVerificationProfiles, readPreparedApplicationVerificationProfile } from "./verification.js";
import { describeWindowsProcessInstallation } from "./windows-process-installation.js";
import { assertNativeWindows, physicalWindowsDirectory } from "./windows-local-acl.js";

type LocalConfiguration = Pick<ArtoodConfig, "allowedRoots" | "verificationProfiles" | "windowsProcessBackend"
  | "managedJournal" | "worktreeBaseRepo" | "ownedResultProfilesFile">;

export interface WindowsApplicationEntryVerifier {
  readonly verification_profile_id: string;
  readonly verification_profile_digest: string;
  readonly application_configuration: Readonly<ApplicationRuntimeFilePin>;
  readonly application_contract_digest: string;
  readonly application_toolchain_digest: string;
  readonly host_manifest: Readonly<ApplicationRuntimeFilePin>;
  readonly host_entry: Readonly<ApplicationRuntimeFilePin>;
  readonly backend: Readonly<{ directory: string; manifest_sha256: string }>;
  readonly origin: string;
  readonly verification_capabilities: Readonly<VerificationCapabilities>;
}

function fail(reason: string): never { throw Error(`Windows application entry verifier: ${reason}`); }
function rootsOf(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || !values.length || values.length > 128) fail("complete bounded write roots required");
  const roots = values.map(physicalWindowsDirectory).sort();
  if (new Set(roots.map(root => root.toLowerCase())).size !== roots.length) fail("write roots alias");
  return roots;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Local setup projection only. All opaque authorities remain inside this bundle.
 * Publication configuration, discovery and the real daemon each retain their
 * own admission; these JSON facts cannot authorize a candidate or start a service. */
export function describeWindowsApplicationEntryVerifier(config: LocalConfiguration,
  verificationProfileId: string): WindowsApplicationEntryVerifier {
  assertNativeWindows();
  if (process.arch !== "x64") fail("native x64 is required");
  if (!config || !config.windowsProcessBackend || config.managedJournal !== undefined
    || config.worktreeBaseRepo !== undefined || config.ownedResultProfilesFile !== undefined)
    fail("ordinary fixed workspaces and an original native backend required");
  const selected = config.verificationProfiles?.filter(profile => profile.application !== undefined);
  if (selected?.length !== 1 || selected[0]!.id !== verificationProfileId)
    fail("one matching configured application verifier required");
  const roots = rootsOf(config.allowedRoots), backend = config.windowsProcessBackend;
  const installation = describeWindowsProcessInstallation(backend);
  if (JSON.stringify(rootsOf(installation.writableWorkspaceRoots)) !== JSON.stringify(roots))
    fail("original native backend differs from the complete write roots");
  // Prepare the full configured collection, including any ordinary profiles, so
  // no sibling workspace or writable root disappears from asset boundary checks.
  const profiles = prepareVerificationProfiles(config.verificationProfiles, config.allowedRoots);
  const verifier = profiles.find(profile => profile.id === verificationProfileId);
  if (!verifier) fail("configured application verifier was not prepared");
  attachWindowsVerificationBackend(verifier, backend);
  const application = readPreparedApplicationVerificationProfile(verifier);
  if (!application) fail("original locally prepared application verifier required");
  const facts = readApplicationVerificationProfile(application);
  if (JSON.stringify(rootsOf(facts.roots)) !== JSON.stringify(roots))
    fail("original application verifier differs from the complete write roots");
  const capabilities = verifier.capabilities;
  if (!capabilities?.application || capabilities.profile_digest !== verifier.digest
    || capabilities.application.config_digest !== facts.configuration.sha256
    || capabilities.application.contract_digest !== facts.capabilities.contract_digest)
    fail("original verifier capability binding changed");
  return freeze(structuredClone({
    verification_profile_id: verifier.id, verification_profile_digest: verifier.digest,
    application_configuration: facts.configuration, application_contract_digest: facts.capabilities.contract_digest,
    application_toolchain_digest: facts.toolchainDigest, host_manifest: facts.config.hostManifest, host_entry: facts.hostEntry,
    backend: { directory: installation.directory, manifest_sha256: installation.manifestSha256 },
    origin: facts.config.origin, verification_capabilities: capabilities,
  }));
}
