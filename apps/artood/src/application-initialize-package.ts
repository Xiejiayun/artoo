import { assertApplicationInitializationAdmission, assertApplicationPublicationInitializationAdmission, type ApplicationInitializationTarget,
  type PreparedApplicationInitializationAdmission } from "./application-bootstrap-admission.js";
import { createApplicationInstallationOwner, invalidateApplicationInstallation, type PreparedApplicationInstallation } from "./application-installation.js";
import { initializeRestartableApplication, readInitializedApplicationInstallation } from "./application-installed-session.js";
import { materializeApplicationInstallationPlan, materializeApplicationInstallationPlanWithProvenance,
  type ApplicationInstallationRelocationProvenanceV1 } from "./application-install-package.js";
import { ApplicationRuntimeFilePinSchema, type ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";

export interface ApplicationPackageInitializationOptions extends ApplicationInitializationTarget {
  readonly bootstrap: PreparedApplicationInitializationAdmission;
}

/** Fixed trusted package installation only. No listener or product invocation is
 * started here. The returned descriptor comes from the actual original broker's
 * normal closure and installation writer, never from a current-disk scan. */
export async function initializeApplicationPackage(input: ApplicationPackageInitializationOptions, signal?: AbortSignal): Promise<ApplicationRuntimeFilePin> {
  return (await initialize(input, signal, false)).reference;
}
/** The fixed publication host exports relocation observations from this same
 * writer and actual initialized descriptor; it cannot promote a verifier store. */
export async function initializeApplicationPublicationPackage(input: ApplicationPackageInitializationOptions, signal?: AbortSignal) {
  const result = await initialize(input, signal, true);
  return Object.freeze({ reference: result.reference, provenance: result.provenance!,
    installation: readInitializedApplicationInstallation(result.reference) });
}
async function initialize(input: ApplicationPackageInitializationOptions, signal: AbortSignal | undefined, publication: boolean): Promise<{
  reference: ApplicationRuntimeFilePin; provenance?: ApplicationInstallationRelocationProvenanceV1;
}> {
  if (signal?.aborted) throw Error("Application package initialization cancelled");
  if (!input || Object.keys(input).some(key => !["parent", "sourceManifest", "nodeId", "allowedRoots", "node", "backend", "hostCode", "hostDirectory", "bootstrap"].includes(key)))
    throw Error("Fixed application initialization inputs required");
  const selected: ApplicationPackageInitializationOptions = Object.freeze({ ...input,
    sourceManifest: Object.freeze(ApplicationRuntimeFilePinSchema.parse(input.sourceManifest)),
    node: Object.freeze(ApplicationRuntimeFilePinSchema.parse(input.node)), allowedRoots: Object.freeze([...input.allowedRoots]) });
  assertApplicationInitializationAdmission(selected.bootstrap, selected);
  if (publication) assertApplicationPublicationInitializationAdmission(selected.bootstrap, selected);
  const owner = createApplicationInstallationOwner({ parent: selected.parent, nodeId: selected.nodeId, allowedRoots: selected.allowedRoots,
    node: selected.node, backend: selected.backend, signal, initialization: { bootstrap: selected.bootstrap, sourceManifest: selected.sourceManifest,
      hostCode: selected.hostCode, hostDirectory: selected.hostDirectory } });
  let installation: PreparedApplicationInstallation | undefined;
  try {
    const materialized = publication ? materializeApplicationInstallationPlanWithProvenance(selected.bootstrap, selected, owner) : undefined;
    const plan = materialized?.plan ?? materializeApplicationInstallationPlan(selected.bootstrap, selected, owner);
    assertApplicationInitializationAdmission(selected.bootstrap, selected);
    if (signal?.aborted) throw Error("Application package initialization cancelled");
    installation = owner.install(plan);
    const reference = publication ? await initializeRestartableApplication(installation, signal, true)
      : await initializeRestartableApplication(installation, signal);
    return { reference, ...(materialized ? { provenance: materialized.provenance } : {}) };
  } catch (error) {
    if (installation) invalidateApplicationInstallation(installation); else owner.abandon();
    throw error;
  }
}
