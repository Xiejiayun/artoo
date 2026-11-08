import { win32 } from "node:path";
import { describeApplicationInstallation, bindApplicationInstallationSession, auditApplicationInstallation,
  createApplicationInstallationReopenReference, reopenApplicationInstallation, retireApplicationInstallation,
  type PreparedApplicationInstallation, type ApplicationInstallationReopenOptions } from "./application-installation.js";
import { acquireApplicationSession, releaseApplicationSession } from "./application-session-ownership.js";
import { prepareInstalledApplicationServiceProfile } from "./application-service-profile.js";
import { initializeApplicationStore, checkExistingApplicationStore, startLocalApplicationService, type LocalApplicationService } from "./application-local-service.js";
import { ApplicationRuntimeFilePinSchema, type ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";
import { assertWindowsCodeInstallation } from "./windows-code-installation.js";
import { assertWindowsProcessBackend } from "./owned/windows-owned-process.js";

/** First creation only. The original installation is retired after real database
 * initialization/normal closure, descriptor publication and exclusive release.
 * A failure retains the store and ownership directory for diagnosis. */
export async function initializeRestartableApplication(installation: PreparedApplicationInstallation, signal?: AbortSignal): Promise<ApplicationRuntimeFilePin> {
  if (signal?.aborted) throw Error("Installed application initialization cancelled");
  const binding = describeApplicationInstallation(installation);
  const session = acquireApplicationSession({ controlDirectory: win32.join(win32.dirname(binding.directory), "control"),
    writableWorkspaceRoots: binding.allowedRoots });
  bindApplicationInstallationSession(installation, session);
  const profile = prepareInstalledApplicationServiceProfile(installation);
  await initializeApplicationStore(profile, signal);
  if (signal?.aborted) throw Error("Installed application initialization cancelled; ownership retained");
  const reference = createApplicationInstallationReopenReference(installation);
  auditApplicationInstallation(installation); retireApplicationInstallation(installation); releaseApplicationSession(session);
  return reference;
}

export type InstalledApplicationReopenOptions = Omit<ApplicationInstallationReopenOptions, "session">;

/** Open unchanged installed data in a newly admitted host. The caller must have
 * established hostCode before importing the canonical application graph. This
 * API accepts the original optional bootstrap admission from the separate fixed
 * application-service-bootstrap entry. It does not provide crash takeover or
 * publication; existing explicit callers retain their own admission boundary. */
export async function reopenInstalledApplicationService(input: InstalledApplicationReopenOptions, signal?: AbortSignal): Promise<LocalApplicationService> {
  if (signal?.aborted) throw Error("Installed application startup cancelled");
  if (!input || Object.keys(input).some(key => !["reference", "nodeId", "allowedRoots", "node", "backend", "hostCode", "hostDirectory", "bootstrap"].includes(key)))
    throw Error("Fixed installed application reopen inputs required");
  // Capture before the first await. Actual opaque objects remain original;
  // caller mutations cannot switch later preparation or lifecycle ownership.
  const selected: InstalledApplicationReopenOptions = Object.freeze({ ...input,
    reference: Object.freeze(ApplicationRuntimeFilePinSchema.parse(input.reference)),
    node: Object.freeze(ApplicationRuntimeFilePinSchema.parse(input.node)), allowedRoots: Object.freeze([...input.allowedRoots]) });
  if (win32.basename(selected.reference.path) !== "REOPEN.v1.json" || selected.reference.bytes > 4_194_304)
    throw Error("Fixed installed application descriptor required");
  assertWindowsCodeInstallation(selected.hostCode, selected.hostDirectory); assertWindowsProcessBackend(selected.backend);
  const session = acquireApplicationSession({ controlDirectory: win32.dirname(selected.reference.path), writableWorkspaceRoots: selected.allowedRoots });
  const installation = reopenApplicationInstallation({ ...selected, session });
  const profile = prepareInstalledApplicationServiceProfile(installation);
  // Check real SQLite format/schema/scope through the original open-only broker,
  // and await its full normal closure before advertising a listener.
  await checkExistingApplicationStore(profile, signal);
  if (signal?.aborted) throw Error("Installed application startup cancelled; ownership retained");
  let original: LocalApplicationService | undefined;
  const stop = () => { if (original) void original.close().catch(() => {}); };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    original = await startLocalApplicationService(profile);
    const owner = original;
    const closed = owner.closed.then(() => {
      auditApplicationInstallation(installation);
      retireApplicationInstallation(installation);
      releaseApplicationSession(session);
    }).finally(() => signal?.removeEventListener("abort", stop));
    void closed.catch(() => {});
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      const outcomes = await Promise.allSettled([Promise.resolve().then(() => owner.close()), closed]);
      const errors = outcomes.flatMap(value => value.status === "rejected" ? [value.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Installed application closure failed; ownership retained if unsettled");
    })();
    if (signal?.aborted) { await close(); throw Error("Installed application startup cancelled"); }
    return Object.freeze({ origin: owner.origin, closed, close });
  } catch (error) {
    signal?.removeEventListener("abort", stop);
    if (!original) throw error;
    const cleanup = await Promise.allSettled([Promise.resolve().then(() => original!.close()), original.closed]);
    throw Object.assign(Error("Installed application startup failed", { cause: error }), { cleanup });
  }
}
