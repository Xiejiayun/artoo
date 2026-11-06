import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { assertWindowsProcessBackendImage, invokeWindowsGuardianNative, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { describeWindowsProcessInstallation } from "./windows-process-installation.js";

const identity = z.object({ pid: z.number().int().positive(), creationTime: z.string().regex(/^\d+$/),
  image: z.string().min(1).max(32768), sid: z.string().regex(/^S-1-/) }).strict();
export const windowsSupervisorLifetimeSchema = z.object({ version: z.literal(1),
  capability: z.literal("artoo.windows-daemon-supervisor-lifetime.v1"),
  cleanupTimeoutMs: z.number().int().min(100).max(60_000), gracefulStopMs: z.number().int().min(100).max(60_000),
  sharedJob: z.literal(true), atomicDaemonMembership: z.literal(true),
  runtimeManifest: z.object({ path: z.string(), bytes: z.number().int().positive().max(4 * 1024 * 1024),
    sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict().optional() }).strict();
const qualification = z.object({ version: z.literal(1), capability: z.literal("artoo.windows-daemon-supervisor.v1"),
  daemon: identity, supervisor: identity, launchIdentityDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  lifetimeOwnership: windowsSupervisorLifetimeSchema.optional() }).strict();
declare const supervisorBrand: unique symbol;
export interface PreparedWindowsDaemonSupervisorAuthority { readonly [supervisorBrand]: true }
const authorities = new WeakMap<PreparedWindowsDaemonSupervisorAuthority, { backend: PreparedWindowsProcessBackend;
  facts: z.infer<typeof qualification>; nativeImage: string }>();

/** A fixed native relay asks the original supervisor's live HANDLE roster. There is
 * no PID, mode, topology, environment variable or serialized permit supplied here. */
export async function prepareWindowsDaemonSupervisorAuthority(backend: PreparedWindowsProcessBackend,
  options: { requireLifetime?: boolean } = {}): Promise<PreparedWindowsDaemonSupervisorAuthority> {
  if (process.platform !== "win32") throw Error("Native Windows daemon supervisor is required");
  const installation = describeWindowsProcessInstallation(backend);
  const manifest = JSON.parse(readFileSync(join(installation.directory, "manifest.json"), "utf8")) as { executable: string };
  const nativeImage = realpathSync.native(join(installation.directory, manifest.executable));
  const facts = qualification.parse(await invokeWindowsGuardianNative(backend, "supervisor", { version: 1, kind: "qualify" }));
  if (options.requireLifetime && !facts.lifetimeOwnership) throw Error("Supervised CLI requires native shared lifetime Job ownership");
  if (options.requireLifetime) {
    const entry = process.argv[1] && realpathSync.native(process.argv[1]);
    const pin = facts.lifetimeOwnership!.runtimeManifest;
    if (!entry || basename(entry) !== "artood.mjs" || !pin || pin.path !== join(dirname(entry), "bundle-manifest.json")
      || pin.sha256 !== process.env.ARTOO_SUPERVISED_BUNDLE_MANIFEST_SHA256) throw Error("Supervised CLI requires its original pinned complete runtime bundle");
  }
  if (facts.daemon.pid !== process.pid || realpathSync.native(facts.daemon.image) !== realpathSync.native(process.execPath)
    || realpathSync.native(facts.supervisor.image) !== nativeImage || facts.daemon.sid !== facts.supervisor.sid
    || BigInt(facts.supervisor.creationTime) >= BigInt(facts.daemon.creationTime)) throw Error("Native supervisor qualification changed its actual daemon lineage");
  Object.freeze(facts.daemon); Object.freeze(facts.supervisor);
  if (facts.lifetimeOwnership) {
    if (facts.lifetimeOwnership.runtimeManifest) Object.freeze(facts.lifetimeOwnership.runtimeManifest);
    Object.freeze(facts.lifetimeOwnership);
  }
  Object.freeze(facts);
  const token = Object.freeze({}) as PreparedWindowsDaemonSupervisorAuthority; authorities.set(token, { backend, facts, nativeImage }); return token;
}
/** This getter preserves the original native observation; guardian bootstrap then
 * independently checks that same live supervisor/daemon and launch state again. */
export function readWindowsDaemonSupervisorAuthority(token: PreparedWindowsDaemonSupervisorAuthority, backend: PreparedWindowsProcessBackend) {
  const saved = authorities.get(token);
  if (!saved || saved.backend !== backend || saved.facts.daemon.pid !== process.pid
    || realpathSync.native(process.execPath) !== realpathSync.native(saved.facts.daemon.image)) throw Error("Original same-process daemon supervisor authority required");
  assertWindowsProcessBackendImage(backend); return saved.facts;
}
