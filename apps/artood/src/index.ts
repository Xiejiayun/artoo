export function createArtoodPlaceholder(): string {
  return "artoo-artood";
}

export * from "./adapter-registry.js";
export * from "./heartbeat.js";
export * from "./node-client.js";
export * from "./process-adapter.js";
export * from "./runtimes.js";
export * from "./ws-transport.js";
export * from "./node-runner.js";
export * from "./workspace-binding.js";
export * from "./artifact-upload.js";
export * from "./verification.js";
export { prepareWindowsProcessInstallation } from "./windows-process-installation.js";
export type { WindowsProcessInstallation } from "./windows-process-installation.js";
export * from "./product-release.js";
export type { ReleaseCapabilityReader } from "./release-capability-authority.js";

export { openLocalJournal, provisionLocalJournal, upgradeLocalJournalForOwnedResults } from "./managed/journal.js";
export { loadOwnedResultProfilesFile, initializeOwnedResultProfilesFile } from "./owned-result-profiles.js";
export { prepareOwnedResultProfiles, prepareOwnedWorktreeVerificationTemplate, readOwnedResultProfileDescriptors } from "./owned-worktree-verification.js";
export type { PreparedOwnedResultProfiles, PreparedOwnedWorktreeVerificationTemplate } from "./owned-worktree-verification.js";
export { openOwnedWorktreeResults } from "./owned/worktree-results.js";
export { createManagedWebSocketTransport } from "./managed/managed-ws-transport.js";
export { createManagedNodeRunner } from "./managed/managed-node-runner.js";
export type { ManagedEventChannel, ManagedJournalOptions, ManagedSession, ManagedExposureContext } from "./managed/managed-delivery.js";
