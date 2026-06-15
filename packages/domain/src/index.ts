/**
 * @artoo/domain — pure domain contracts for artoo v0.1.
 *
 * No IO, no DB, no env. State machines and helpers are pure; the only entropy
 * seams are createSystemClock() / createUlidIdGen(), which are injected.
 */
export const ARTOO_DOMAIN_PACKAGE = "@artoo/domain";

export * from "./ids.js";
export * from "./clock.js";
export * from "./capabilities.js";
export * from "./state.js";
export * from "./events.js";
export * from "./context-pack.js";
export * from "./node-payloads.js";
export * from "./schemas.js";
export * from "./api.js";
export * from "./dag.js";
