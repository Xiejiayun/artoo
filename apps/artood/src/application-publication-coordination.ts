import { AsyncLocalStorage } from "node:async_hooks";
import { win32 } from "node:path";

/** These captured paths select conflicts only. They never authorize a process,
 * replace an integrity audit, or certify current bytes or permissions. */
export interface ApplicationPublicationResourceMetadata {
  readonly id: string;
  readonly workspace: string;
  readonly verifier: object;
  readonly directories: readonly string[];
}
declare const reservationBrand: unique symbol;
export interface ApplicationPublicationReservation { readonly [reservationBrand]: true }
interface Reservation {
  readonly profile: object;
  readonly metadata: ApplicationPublicationResourceMetadata;
  readonly owners: Map<object, "active" | "quiescent">;
  released: boolean;
}
const metadata = new WeakMap<object, ApplicationPublicationResourceMetadata>();
const verifierDirectories = new WeakMap<object, readonly string[]>();
const reservations = new Map<ApplicationPublicationReservation, Reservation>();
const auditScope = new AsyncLocalStorage<ApplicationPublicationReservation>();
const key = (path: string) => win32.normalize(path).replace(/[\\/]+$/u, "").toLowerCase();
export function applicationPublicationPathsOverlap(left: string, right: string): boolean {
  const a = key(left), b = key(right);
  return a === b || a.startsWith(`${b}\\`) || b.startsWith(`${a}\\`);
}
function conflicts(left: readonly string[], right: readonly string[]): boolean {
  return left.some(a => right.some(b => applicationPublicationPathsOverlap(a, b)));
}
function paths(value: ApplicationPublicationResourceMetadata): readonly string[] { return [value.workspace, ...value.directories]; }
export function registerApplicationPublicationVerifierResources(verifier: object, directories: readonly string[]): void {
  const copy = Object.freeze([...directories]);
  const previous = verifierDirectories.get(verifier);
  if (previous && JSON.stringify(previous) !== JSON.stringify(copy)) throw Error("Original publication verifier resource routing changed");
  verifierDirectories.set(verifier, copy);
}
export function registerApplicationPublicationResources(profile: object, value: ApplicationPublicationResourceMetadata): void {
  if (metadata.has(profile)) throw Error("Publication resource routing is immutable");
  metadata.set(profile, Object.freeze({ ...value, directories: Object.freeze([...value.directories]) }));
}
export function readApplicationPublicationResourceMetadata(profile: object): ApplicationPublicationResourceMetadata {
  const value = metadata.get(profile);
  if (!value) throw Error("Original publication resource routing required");
  return value;
}
export function applicationPublicationRunResources(workspace: string, verifier?: object): readonly string[] {
  return [workspace, ...(verifier ? verifierDirectories.get(verifier) ?? [] : [])];
}
export function assertApplicationPublicationRunAdmission(resources: readonly string[]): void {
  for (const saved of reservations.values()) {
    if (conflicts(resources, paths(saved.metadata))) throw Error("Application publication resources are busy; original owners must close before a conflicting run");
  }
}
export function assertApplicationPublicationResourcesIdle(profile: object, activeRuns: readonly (readonly string[])[]): void {
  const resources = paths(readApplicationPublicationResourceMetadata(profile));
  if (activeRuns.some(run => conflicts(resources, run))) throw Error("Application publication resources have an active run owner");
}
export function claimApplicationPublicationResources(profile: object): ApplicationPublicationReservation {
  const value = readApplicationPublicationResourceMetadata(profile);
  assertApplicationPublicationRunAdmission(paths(value));
  const token = Object.freeze({}) as ApplicationPublicationReservation;
  reservations.set(token, { profile, metadata: value, owners: new Map(), released: false });
  return token;
}
function original(token: ApplicationPublicationReservation): Reservation {
  const saved = reservations.get(token);
  if (!saved || saved.released) throw Error("Original active publication reservation required");
  return saved;
}
export function withApplicationPublicationAuditScope<T>(token: ApplicationPublicationReservation, work: () => T): T {
  original(token); return auditScope.run(token, work);
}
/** Reject before the profile's terminal integrity catch. An active writer is a
 * coordination conflict, not evidence that the protected installation changed. */
export function assertApplicationPublicationAuditAvailable(profile: object): void {
  const value = readApplicationPublicationResourceMetadata(profile);
  for (const [token, saved] of reservations) {
    if (!conflicts(paths(value), paths(saved.metadata))) continue;
    if (auditScope.getStore() !== token || saved.profile !== profile || [...saved.owners.values()].some(state => state !== "quiescent"))
      throw Error("Application publication audit requires its original quiescent owner scope");
  }
}
export function beginApplicationPublicationOwner(token: ApplicationPublicationReservation, owner: object): void {
  const saved = original(token);
  if (saved.owners.has(owner) || auditScope.getStore() !== token) throw Error("Original unused publication owner scope required");
  saved.owners.set(owner, "active");
}
/** Only the process controller calls this after its original host/native proof.
 * Merely entering an audit scope cannot mark an owner quiescent. */
export function setApplicationPublicationOwnerQuiescent(token: ApplicationPublicationReservation, owner: object, quiescent: boolean): void {
  const saved = original(token);
  if (!saved.owners.has(owner)) throw Error("Original publication owner is unavailable");
  saved.owners.set(owner, quiescent ? "quiescent" : "active");
}
export function closeApplicationPublicationOwner(token: ApplicationPublicationReservation, owner: object): void {
  const saved = original(token);
  if (!saved.owners.delete(owner)) throw Error("Original publication owner closure was already consumed");
}
export function releaseApplicationPublicationResources(token: ApplicationPublicationReservation): void {
  const saved = original(token);
  if (saved.owners.size) throw Error("Application publication original owner closure remains unconfirmed");
  saved.released = true; reservations.delete(token);
}
