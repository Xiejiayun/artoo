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

export { openLocalJournal, provisionLocalJournal } from "./managed/journal.js";
export { createManagedWebSocketTransport } from "./managed/managed-ws-transport.js";
export { createManagedNodeRunner } from "./managed/managed-node-runner.js";
export type { ManagedEventChannel, ManagedJournalOptions, ManagedSession, ManagedExposureContext } from "./managed/managed-delivery.js";
