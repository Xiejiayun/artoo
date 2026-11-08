import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { canonicalProductSourceTransferValueV1 as canonical, SourceStableConfigurationV1Schema, SourceCleanStopIntentV1Schema,
  type SourceStableConfigurationV1, type SourceCleanStopIntentV1 } from "@artoo/domain";
import { SourceCleanRestartGrantV1Schema, SourceSupervisorLaunchV1Schema, sourceCleanDigestV1,
  type SourceCleanRestartGrantV1 } from "@artoo/domain";
import type { ArtoodConfig } from "./main.js";
import { prepareProductSourceConfiguration } from "./product-source-config.js";
import { describeWindowsProcessInstallation } from "./windows-process-installation.js";
import { prepareWindowsReleaseStorage, assertWindowsReleaseStorage } from "./windows-release-storage.js";
import { physicalWindowsDirectory, windowsPathsOverlap } from "./windows-local-acl.js";
import { prepareVerificationProfiles, attachWindowsVerificationBackend, assertLocallyPreparedVerificationProfile, assertImportedValidationVerificationProfile, type PreparedVerificationProfile } from "./verification.js";
import { prepareReleaseProfiles, readReleaseCapabilities, type PreparedReleaseProfile } from "./product-release.js";
import { readAuthenticatedSourceCleanRestartGrant, consumeAuthenticatedSourceCleanRestartGrant, sourceLifecycleObserverIdentity,
  type AuthenticatedSourceCleanRestartGrant, type PreparedSourceLifecycleObserver } from "./source-lifecycle-observer.js";
import { readWindowsDaemonSupervisorAuthority, type PreparedWindowsDaemonSupervisorAuthority } from "./windows-supervisor-authority.js";
import { readWindowsGuardianLocalRuntime, type PreparedWindowsGuardian } from "./owned/windows-runtime-guardian.js";
import { prepareProductBootstrapGit, readProductBootstrapGit, describeProductBootstrapGit,
  type PreparedProductBootstrapGit } from "./product-bootstrap-git.js";

const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hash = (value: unknown) => sha(canonical(value));
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const localConfiguration = z.object({ version: z.literal(1), storeFamily: z.string(), genesisStore: z.string() }).strict();
const member = z.string().min(1).refine(value => !isAbsolute(value) && !/[\\:\u0000-\u001f]/u.test(value)
  && value.split("/").every(part => !!part && part !== "." && part !== ".."));
const manifestSchema = z.object({ format: z.literal("artoo.desktop-daemon.v1"), node_target: z.literal("node24"),
  tree: z.object({ directories: z.array(member).max(4096), files: z.array(z.object({ path: member,
    size: z.number().int().nonnegative().max(512 * 1024 * 1024), sha256: digest }).strict()).min(1).max(4096) }).strict() }).passthrough();
export interface CleanFilePin { readonly path: string; readonly bytes: number; readonly sha256: string }
function identity(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || realpathSync.native(path) !== path || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n))
    throw Error("Clean lifecycle input must be its original physical directory or single-link file");
  return { path, dev: String(stat.dev), ino: String(stat.ino), directory: stat.isDirectory() };
}
function pin(path: string, maximum = 512 * 1024 * 1024): CleanFilePin {
  if (!isAbsolute(path)) throw Error("Absolute clean lifecycle input required");
  const fixed = identity(path), before = lstatSync(path, { bigint: true });
  if (fixed.directory || before.size > BigInt(maximum)) throw Error("Clean lifecycle input exceeds its bound");
  const bytes = readFileSync(path), after = lstatSync(path, { bigint: true });
  if (BigInt(bytes.length) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs
    || canonical(identity(path)) !== canonical(fixed)) throw Error("Clean lifecycle input changed during inspection");
  return Object.freeze({ path, bytes: bytes.length, sha256: sha(bytes) });
}
function samePin(value: CleanFilePin) { if (canonical(pin(value.path)) !== canonical(value)) throw Error("Clean lifecycle fixed bytes changed"); }
function inventory(root: string) {
  physicalWindowsDirectory(root); const files: { path: string; bytes: number; sha256: string }[] = [], directories: string[] = [], keys = new Set<string>(); let bytes = 0;
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), local = member.parse(relative(root, path).split(sep).join("/"));
      if (keys.has(local.toLowerCase()) || keys.size >= 4096) throw Error("Clean lifecycle inventory is duplicate or exceeds its bound"); keys.add(local.toLowerCase());
      const fixed = identity(path);
      if (fixed.directory) { directories.push(local); visit(path); }
      else { const value = pin(path); bytes += value.bytes; if (bytes > 2 * 1024 * 1024 * 1024) throw Error("Clean lifecycle inventory byte bound exceeded");
        files.push({ path: local, bytes: value.bytes, sha256: value.sha256 }); }
    }
  }; visit(root); return { directories: directories.sort(), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}
function bundle(entry: string, expected: string | undefined, roots: readonly string[]) {
  digest.parse(expected); if (basename(entry) !== "artood.mjs") throw Error("Clean lifecycle requires the complete production daemon bundle");
  const root = physicalWindowsDirectory(dirname(entry)), storage = prepareWindowsReleaseStorage({ directory: root, writableWorkspaceRoots: roots });
  const manifest = pin(join(root, "bundle-manifest.json"), 4 * 1024 * 1024);
  if (manifest.sha256 !== expected) throw Error("Clean lifecycle bundle manifest differs from its fixed version");
  const parsed = manifestSchema.parse(JSON.parse(readFileSync(manifest.path, "utf8"))), actual = inventory(root);
  if (canonical({ directories: actual.directories, files: actual.files.filter(file => file.path !== "bundle-manifest.json")
    .map(file => ({ path: file.path, size: file.bytes, sha256: file.sha256 })) }) !== canonical(parsed.tree)) throw Error("Clean lifecycle complete bundle inventory changed");
  samePin(manifest); return { root, storage, manifest, inventory: actual };
}
declare const configurationBrand: unique symbol;
export interface PreparedCleanSupervisorConfiguration { readonly [configurationBrand]: true }
interface Configuration {
  nodeId: string; backend: NonNullable<ArtoodConfig["windowsProcessBackend"]>; env: NodeJS.ProcessEnv;
  entry: CleanFilePin; node: CleanFilePin; nativeManifest: CleanFilePin; nativeImage: CleanFilePin;
  local: ReturnType<typeof prepareProductSourceConfiguration>; localFile: CleanFilePin; lineageFile: CleanFilePin;
  bundle: ReturnType<typeof bundle>; storeFamily: string; genesisStore: string; familyStorage: ReturnType<typeof prepareWindowsReleaseStorage>;
  roots: readonly string[]; physical: ReturnType<typeof identity>[]; policyDigest: string; familyDigest: string;
  profiles: ReturnType<typeof prepareVerificationProfiles>; releases: ReturnType<typeof prepareReleaseProfiles>;
  files: CleanFilePin[]; sourcePolicy: unknown;
  codexConfiguration: { path: string; present: boolean }[];
  bootstrapGit?: PreparedProductBootstrapGit;
  generation?: PreparedCleanSourceGeneration;
}
const configurations = new WeakMap<object, Configuration>();
declare const generationBrand: unique symbol;
export interface PreparedCleanSourceGeneration { readonly [generationBrand]: true }
interface History {
  version: 1; stop_id: string; lineage_id: string; generation_id: string; stable: SourceStableConfigurationV1;
  intent: SourceCleanStopIntentV1;
  stores: { identity: ReturnType<typeof identity>; tree: ReturnType<typeof inventory> }[];
  source_configurations: CleanFilePin[]; predecessors: CleanFilePin[];
}
interface RetainedGeneration {
  grant: SourceCleanRestartGrantV1;
  root: string; store: string; control: string; source: CleanFilePin; history: History; historyFile: CleanFilePin;
  files: CleanFilePin[]; physical: ReturnType<typeof identity>[];
}
interface Generation extends RetainedGeneration {
  predecessor: PreparedCleanSupervisorConfiguration; observer: PreparedSourceLifecycleObserver;
}
const generations = new WeakMap<object, Generation>();
declare const daemonConfigurationBrand: unique symbol;
/** Local quarantine only. This object cannot launch a Supervisor, activate a
 * source runtime or reconstruct a parent observer/grant object. */
export interface PreparedCleanDaemonConfiguration { readonly [daemonConfigurationBrand]: true }
const daemonConfigurations = new WeakMap<object, { configuration: Configuration; supervisor: PreparedWindowsDaemonSupervisorAuthority;
  observerId: string; successor?: RetainedGeneration }>();
interface ConfigurationInput { config: ArtoodConfig; env: NodeJS.ProcessEnv; entry: string; lineageFile: string }
const stableEnvKeys = ["SystemRoot", "WINDIR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "LANG", "TZ", "CODEX_HOME",
  "ARTOO_REPORT_ARTIFACTS", "ARTOO_TRUSTED_EXECUTION", "ARTOO_CODEX_BINARY", "ARTOO_CODEX_MODEL", "ARTOO_CODEX_PROVIDER_URL",
  "ARTOO_HEARTBEAT_INTERVAL_MS", "ARTOO_VERIFICATION_PROFILES_FILE", "ARTOO_RELEASE_PROFILES_FILE",
  "ARTOO_RESEARCH_ENABLED", "ARTOO_RESEARCH_RECEIPTS_DIR", "ARTOO_INITIALIZE_REPOSITORY"] as const;
const secretKeys = ["ARTOO_CODEX_PROVIDER_KEY", "ARTOO_RESEARCH_BRAVE_KEY"] as const;

/** Local protected preparation, not a launch authority. Native workspace/genesis
 * identities are supplied later by the real daemon's qualified Guardian and
 * independently compared on Server. They are never guessed from Node stat IDs. */
function prepareConfigurationRecord(input: ConfigurationInput, successor?: RetainedGeneration): Configuration {
  const { config, env } = input;
  if (process.platform !== "win32" || !config.windowsProcessBackend || !config.productSourceConfigFile || config.managedJournal
    || config.worktreeBaseRepo || config.runtimes.length !== 1 || config.runtimes[0] !== "codex" || !config.codex?.binaryPath
    || !config.codex.model || !config.codex.baseUrl || !env.CODEX_HOME)
    throw Error("Clean lifecycle requires the original ordinary native Codex configuration");
  const roots = config.allowedRoots.map(physicalWindowsDirectory);
  const local = prepareProductSourceConfiguration({ file: config.productSourceConfigFile, allowedRoots: roots });
  if (!local.config.recovery) throw Error("Clean lifecycle requires the existing Guardian recovery configuration");
  const lineageFile = pin(input.lineageFile, 1024 * 1024);
  prepareWindowsReleaseStorage({ directory: dirname(lineageFile.path), writableWorkspaceRoots: roots });
  const lineage = localConfiguration.parse(JSON.parse(readFileSync(lineageFile.path, "utf8")));
  const storeFamily = physicalWindowsDirectory(lineage.storeFamily), genesisStore = physicalWindowsDirectory(lineage.genesisStore);
  if (roots.some(root => windowsPathsOverlap(storeFamily, root)) || windowsPathsOverlap(storeFamily, genesisStore)
    || local.config.storeRoot !== (successor?.store ?? genesisStore)
    || successor && (local.config.recovery.controlDirectory !== successor.control || local.file !== successor.source.path))
    throw Error("Clean lifecycle requires its exact original genesis or authenticated successor generation");
  const familyStorage = prepareWindowsReleaseStorage({ directory: storeFamily, writableWorkspaceRoots: roots });
  const runtime = bundle(input.entry, env.ARTOO_SUPERVISED_BUNDLE_MANIFEST_SHA256, roots);
  const installation = describeWindowsProcessInstallation(config.windowsProcessBackend);
  if (canonical([...installation.writableWorkspaceRoots].sort()) !== canonical([...roots].sort())) throw Error("Native installation belongs to different coding roots");
  const nativeManifest = pin(join(installation.directory, "manifest.json"), 1024 * 1024);
  const nativeMetadata = JSON.parse(readFileSync(nativeManifest.path, "utf8")) as { executable: string; capabilities?: string[] };
  if (!nativeMetadata.capabilities?.includes("artoo.windows-daemon-supervisor-lifetime.v1")) throw Error("Native shared lifetime ownership required");
  const nativeImage = pin(join(installation.directory, member.parse(nativeMetadata.executable))), node = pin(realpathSync.native(process.execPath));
  if (basename(node.path).toLowerCase() !== "node.exe") throw Error("Native Node executable required");
  const profiles = prepareVerificationProfiles(config.verificationProfiles, roots); profiles.forEach(profile => attachWindowsVerificationBackend(profile, config.windowsProcessBackend!));
  const releases = prepareReleaseProfiles(config.releaseProfiles, profiles, { windowsStorage: config.windowsReleaseStorage, writableRoots: roots });
  const files = [pin(local.config.gitExecutable), pin(config.codex.binaryPath)];
  const codexHome = physicalWindowsDirectory(env.CODEX_HOME); prepareWindowsReleaseStorage({ directory: codexHome, writableWorkspaceRoots: roots });
  const codexConfiguration = ["config.toml", "auth.json"].map(name => ({ path: join(codexHome, name), present: existsSync(join(codexHome, name)) }));
  for (const file of codexConfiguration) if (file.present) files.push(pin(file.path, 4 * 1024 * 1024));
  const endpoint = new URL(config.url); endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  const physical = [storeFamily, genesisStore, local.config.recovery.workspaceRoot, ...roots].map(identity);
  // Only current store/control locations are generation-specific. Every policy,
  // complete measurement mapping and recovery workspace/device remains stable.
  const sourcePolicy = { ...local.config, storeRoot: "<current-generation-store>",
    recovery: { ...local.config.recovery, controlDirectory: "<current-generation-control>" } };
  const fixedEnvironment = Object.fromEntries(stableEnvKeys.map(key => [key, env[key] ?? null]));
  const secretBindings = Object.fromEntries(secretKeys.map(key => [key, env[key] === undefined ? null : sha(env[key]!)]));
  const familyDigest = hash(identity(storeFamily));
  const policyDigest = hash({ version: 1, nodeId: config.nodeId, deviceId: local.config.recovery.deviceId, serverOrigin: endpoint.origin,
    physical, roots: [...roots].sort(), familyDigest, sourcePolicy, runtimeManifest: runtime.manifest, node, nativeManifest,
    programs: files, codexConfiguration, environment: fixedEnvironment, credentialBindings: secretBindings,
    profiles: profiles.map(profile => ({ id: profile.id, project: profile.project_id, workspace: profile.workspace_root, digest: profile.digest })),
    releases: releases.map(profile => ({ id: profile.id, digest: profile.digest, capabilities: readReleaseCapabilities(profile) })) });
  if (successor && (successor.grant.stable.stable_configuration_digest !== policyDigest
    || successor.grant.stable.store_family_identity_digest !== familyDigest)) throw Error("Successor changed the original stable policy or store family");
  const bootstrapGit = config.initializeRepository ? prepareProductBootstrapGit({ file: local.config.gitExecutable, allowedRoots: roots,
    assertConfigurationUnchanged: () => { if (local.read().identity !== local.original.identity) throw Error("Clean bootstrap source configuration changed"); } }) : undefined;
  return { nodeId: config.nodeId, backend: config.windowsProcessBackend, env: Object.freeze({ ...env }), entry: pin(input.entry), node, nativeManifest, nativeImage,
    local, localFile: pin(local.file, 1024 * 1024), lineageFile, bundle: runtime, storeFamily, genesisStore, familyStorage,
    roots: Object.freeze(roots), physical, policyDigest, familyDigest, profiles, releases, files, sourcePolicy, codexConfiguration,
    ...(bootstrapGit ? { bootstrapGit } : {}) };
}
export function prepareCleanSupervisorConfiguration(input: ConfigurationInput & { generation?: PreparedCleanSourceGeneration }): PreparedCleanSupervisorConfiguration {
  const successor = input.generation ? checkedSourceLineage(input.generation) : undefined;
  const saved = prepareConfigurationRecord(input, successor);
  if (input.generation) saved.generation = input.generation;
  const token = Object.freeze({}) as PreparedCleanSupervisorConfiguration; configurations.set(token, saved); return token;
}
function checkConfigurationRecord(saved: Configuration): void {
  describeWindowsProcessInstallation(saved.backend);
  for (const file of [saved.entry, saved.node, saved.nativeManifest, saved.nativeImage, saved.localFile, saved.lineageFile, ...saved.files]) samePin(file);
  if (saved.codexConfiguration.some(file => existsSync(file.path) !== file.present)) throw Error("Execution-relevant Codex configuration presence changed");
  for (const value of saved.physical) if (canonical(identity(value.path)) !== canonical(value)) throw Error("Clean lifecycle physical configuration changed");
  if (saved.local.read().identity !== saved.local.original.identity) throw Error("Clean lifecycle source policy changed");
  assertWindowsReleaseStorage(saved.familyStorage, saved.storeFamily); assertWindowsReleaseStorage(saved.bundle.storage, saved.bundle.root);
  if (canonical(inventory(saved.bundle.root)) !== canonical(saved.bundle.inventory)) throw Error("Clean lifecycle runtime bundle changed");
  if (saved.generation) assertCleanSourceLineage(saved.generation);
  if (saved.bootstrapGit) readProductBootstrapGit(saved.bootstrapGit);
  saved.profiles.forEach(assertLocallyPreparedVerificationProfile); saved.releases.forEach(readReleaseCapabilities);
}
function checkedConfiguration(token: PreparedCleanSupervisorConfiguration): Configuration {
  const saved = configurations.get(token); if (!saved) throw Error("Original prepared clean supervisor configuration required");
  checkConfigurationRecord(saved);
  return saved;
}
/** The original mutable preparation record never leaves this module. The owner
 * needs only fixed primitive configuration and already frozen file references. */
export function readCleanSupervisorConfiguration(token: PreparedCleanSupervisorConfiguration) {
  const saved = checkedConfiguration(token);
  return Object.freeze({ nodeId: saved.nodeId, env: saved.env, entry: saved.entry, node: saved.node,
    nativeManifest: saved.nativeManifest, nativeImage: saved.nativeImage, localFile: saved.localFile,
    lineageFile: saved.lineageFile, runtimeManifest: saved.bundle.manifest,
    ...(saved.bootstrapGit ? { bootstrapGit: describeProductBootstrapGit(saved.bootstrapGit) } : {}) });
}
export function assertCleanStableDescriptor(token: PreparedCleanSupervisorConfiguration, input: SourceStableConfigurationV1): SourceStableConfigurationV1 {
  const saved = checkedConfiguration(token), value = SourceStableConfigurationV1Schema.parse(input);
  if (value.node_id !== saved.nodeId || value.device_id !== saved.local.config.recovery!.deviceId
    || value.workspace_root !== saved.local.config.recovery!.workspaceRoot || value.store_family_identity_digest !== saved.familyDigest
    || value.stable_configuration_digest !== saved.policyDigest) throw Error("Original daemon clean descriptor changed local stable configuration");
  if (saved.generation && canonical(value) !== canonical(generations.get(saved.generation)!.grant.stable))
    throw Error("Successor descriptor changed its authenticated predecessor stable binding");
  return value;
}
export function describeCleanLocalPolicy(token: PreparedCleanSupervisorConfiguration) {
  const saved = checkedConfiguration(token); return Object.freeze({ stable_configuration_digest: saved.policyDigest,
    store_family_identity_digest: saved.familyDigest, genesis_store: saved.genesisStore, store_family: saved.storeFamily });
}
/** Called only after original native closure. This captures retained history as
 * evidence; the returned digest grants no restart or workspace admission. */
export function captureClosedSourceHistory(token: PreparedCleanSupervisorConfiguration, intent: SourceCleanStopIntentV1) {
  const saved = checkedConfiguration(token);
  assertCleanStableDescriptor(token, intent.launch.stable);
  const store = physicalWindowsDirectory(saved.local.config.storeRoot), control = physicalWindowsDirectory(saved.local.config.recovery!.controlDirectory);
  const previous = saved.generation ? checkedSourceLineage(saved.generation) : undefined;
  const stores = [...(previous?.history.stores ?? []), ...[store, control].map(root => ({ identity: identity(root), tree: inventory(root) }))];
  const value: History = { version: 1, stop_id: intent.stop_id, lineage_id: intent.lineage_id, generation_id: intent.generation_id,
    stable: intent.launch.stable, intent: SourceCleanStopIntentV1Schema.parse(intent), stores,
    source_configurations: [...(previous?.history.source_configurations ?? []), saved.localFile],
    predecessors: previous ? [...previous.history.predecessors, previous.historyFile] : [] };
  const encoded = canonical(value), retainedHistoryDigest = sha(encoded), directory = join(saved.storeFamily, "closures");
  if (!existsSync(directory)) mkdirSync(directory); physicalWindowsDirectory(directory);
  const output = join(directory, intent.stop_id + ".json"), fd = openSync(output, "wx", 0o600);
  try { writeFileSync(fd, encoded); fsyncSync(fd); } finally { closeSync(fd); }
  if (pin(output).sha256 !== retainedHistoryDigest || canonical(stores.map(item => ({ identity: identity(item.identity.path), tree: inventory(item.identity.path) }))) !== canonical(stores))
    throw Error("Retained source history changed while recording original closure");
  return Object.freeze({ retained_history_digest: retainedHistoryDigest, file: pin(output) });
}

function assertHistory(value: History): void {
  if (value.version !== 1 || !Array.isArray(value.stores) || value.stores.length < 2 || value.stores.length > 64
    || !Array.isArray(value.source_configurations) || !Array.isArray(value.predecessors)
    || value.predecessors.length > 32 || value.source_configurations.length > 32
    || new Set(value.stores.map(item => item.identity.path.toLowerCase())).size !== value.stores.length)
    throw Error("Retained source lineage history is incomplete or ambiguous");
  SourceStableConfigurationV1Schema.parse(value.stable);
  const intent = SourceCleanStopIntentV1Schema.parse(value.intent);
  if (intent.stop_id !== value.stop_id || intent.lineage_id !== value.lineage_id || intent.generation_id !== value.generation_id
    || canonical(intent.launch.stable) !== canonical(value.stable)) throw Error("Retained clean intent changed its original stop or lineage");
  for (const file of [...value.source_configurations, ...value.predecessors]) samePin(file);
  for (const item of value.stores) if (canonical(identity(item.identity.path)) !== canonical(item.identity)
    || canonical(inventory(item.identity.path)) !== canonical(item.tree)) throw Error("Retained predecessor store changed; workspace remains fenced");
}
/** Parent preparation consumes a real reply on its original observer. It creates
 * only fresh protected storage; no writer/verifier/release authority is returned. */
export function prepareCleanRestartGeneration(input: { predecessor: PreparedCleanSupervisorConfiguration;
  observer: PreparedSourceLifecycleObserver; grant: AuthenticatedSourceCleanRestartGrant }): PreparedCleanSourceGeneration {
  const previous = checkedConfiguration(input.predecessor);
  const grant = readAuthenticatedSourceCleanRestartGrant(input.grant, input.observer);
  assertCleanStableDescriptor(input.predecessor, grant.stable);
  const historyPath = join(previous.storeFamily, "closures", grant.predecessor.stop_id + ".json"), historyFile = pin(historyPath);
  if (historyFile.sha256 !== grant.predecessor_history_digest) throw Error("Restart grant does not bind the retained local history");
  const bytes = readFileSync(historyPath, "utf8"), history = JSON.parse(bytes) as History;
  if (canonical(history) !== bytes || history.stop_id !== grant.predecessor.stop_id || history.lineage_id !== grant.lineage_id
    || history.generation_id !== grant.predecessor_generation_id || canonical(history.stable) !== canonical(grant.stable))
    throw Error("Restart predecessor history changed its original committed lineage");
  assertHistory(history);
  if (sourceCleanDigestV1(history.intent, sha) !== grant.predecessor.intent_digest || canonical(history.intent.origin) !== canonical(grant.origin))
    throw Error("Restart grant changed its retained original stop intent");
  const family = join(previous.storeFamily, "generations");
  if (!existsSync(family)) mkdirSync(family); physicalWindowsDirectory(family);
  const known = new Set(history.stores.map(item => relative(family, item.identity.path).split(sep)[0]).filter(value => value && value !== ".."));
  for (const entry of readdirSync(family)) if (!known.has(entry)) throw Error("An unknown or unclosed generation retains the workspace fence");
  const closuresDirectory = join(previous.storeFamily, "closures"), expectedClosures = new Set([...history.predecessors.map(item => basename(item.path)), basename(historyFile.path)]);
  if (readdirSync(closuresDirectory).some(name => !expectedClosures.has(name))) throw Error("Unknown closure history retains the workspace fence");
  // Consumption is sticky even if exclusive creation or later qualification
  // fails. A subsequent process cannot reopen a partial successor as fresh.
  consumeAuthenticatedSourceCleanRestartGrant(input.grant, input.observer);
  const root = join(family, grant.generation_id); mkdirSync(root);
  const store = join(root, "store"), control = join(root, "control"); mkdirSync(store); mkdirSync(control);
  const source = join(root, "source.json"), sourceValue = { ...previous.local.config, storeRoot: store,
    recovery: { ...previous.local.config.recovery!, controlDirectory: control } };
  const write = (file: string, value: unknown) => { const fd = openSync(file, "wx", 0o600);
    try { writeFileSync(fd, canonical(value)); fsyncSync(fd); } finally { closeSync(fd); } return pin(file); };
  const sourcePin = write(source, sourceValue), grantFile = write(join(root, "grant.json"), grant);
  const predecessorFile = write(join(root, "predecessor.json"), { version: 1, history: historyFile,
    grant_digest: sourceCleanDigestV1(grant, sha), lineage_id: grant.lineage_id, generation_id: grant.generation_id });
  const token = Object.freeze({}) as PreparedCleanSourceGeneration;
  generations.set(token, { predecessor: input.predecessor, observer: input.observer, grant, root, store, control, source: sourcePin,
    history, historyFile, files: [sourcePin, grantFile, predecessorFile], physical: [root, store, control].map(identity) });
  assertCleanSourceLineage(token); return token;
}
/** Use this at each common and semantic admission boundary. It only confirms
 * retained history; it never replaces native Guardian or current-session checks. */
function checkedSourceLineage(token: PreparedCleanSourceGeneration): Generation {
  const value = generations.get(token); if (!value) throw Error("Original in-process source store lineage required");
  sourceLifecycleObserverIdentity(value.observer); checkRetainedGeneration(value);
  return value;
}
function checkRetainedGeneration(value: RetainedGeneration): void {
  samePin(value.historyFile); value.files.forEach(samePin); assertHistory(value.history);
  if (sourceCleanDigestV1(value.history.intent, sha) !== value.grant.predecessor.intent_digest
    || canonical(value.history.intent.origin) !== canonical(value.grant.origin))
    throw Error("Retained clean history lost its Server-committed stop intent");
  for (const original of value.physical) if (canonical(identity(original.path)) !== canonical(original)) throw Error("Successor physical generation changed");
}
export function assertCleanSourceLineage(token: PreparedCleanSourceGeneration): void {
  checkedSourceLineage(token);
}
export function describeCleanRestartGeneration(token: PreparedCleanSourceGeneration) {
  const value = checkedSourceLineage(token); return Object.freeze({ source_configuration_file: value.source.path,
    store_root: value.store, control_directory: value.control, generation_id: value.grant.generation_id,
    predecessor_history_digest: value.grant.predecessor_history_digest, grant_digest: sourceCleanDigestV1(value.grant, sha) });
}
/** An empty successor store cannot grant ordinary work over an old source claim.
 * Dedicated H7 admission must independently require its committed new-session
 * checkpoint, original native runtime and fresh validation/review chain. */
export function assertNoOrdinaryCleanRestartAdmission(token: PreparedCleanSourceGeneration, workspace: string): void {
  const value = checkedSourceLineage(token);
  if (windowsPathsOverlap(physicalWindowsDirectory(workspace), value.grant.stable.workspace_root))
    throw Error("Clean restart source remains quarantined from ordinary execution");
}

/** A new daemon may read predecessor integrity inputs in quarantine. Reading
 * these files creates no authenticated grant and no admission object. The actual
 * lifecycle ACK must independently return the same Server-committed grant. */
function readQuarantinedGeneration(input: ConfigurationInput): RetainedGeneration | undefined {
  const roots = input.config.allowedRoots.map(physicalWindowsDirectory);
  if (!input.config.productSourceConfigFile) throw Error("Clean daemon requires protected source configuration");
  const local = prepareProductSourceConfiguration({ file: input.config.productSourceConfigFile, allowedRoots: roots });
  const lineagePin = pin(input.lineageFile, 1024 * 1024);
  const lineage = localConfiguration.parse(JSON.parse(readFileSync(lineagePin.path, "utf8")));
  const family = physicalWindowsDirectory(lineage.storeFamily), genesis = physicalWindowsDirectory(lineage.genesisStore);
  if (local.config.storeRoot === genesis) return undefined;
  const root = physicalWindowsDirectory(dirname(local.config.storeRoot)), generationId = z.string().uuid().parse(basename(root));
  if (dirname(root) !== join(family, "generations") || local.config.storeRoot !== join(root, "store")
    || local.config.recovery?.controlDirectory !== join(root, "control") || local.file !== join(root, "source.json"))
    throw Error("Clean daemon successor is not the fixed local generation layout");
  prepareWindowsReleaseStorage({ directory: family, writableWorkspaceRoots: roots });
  const source = pin(local.file, 1024 * 1024), grantFile = pin(join(root, "grant.json")), predecessorFile = pin(join(root, "predecessor.json"));
  const grantBytes = readFileSync(grantFile.path, "utf8"), grant = SourceCleanRestartGrantV1Schema.parse(JSON.parse(grantBytes));
  if (canonical(grant) !== grantBytes || grant.generation_id !== generationId) throw Error("Clean daemon grant projection differs from its fixed generation");
  const historyFile = pin(join(family, "closures", grant.predecessor.stop_id + ".json"));
  if (historyFile.sha256 !== grant.predecessor_history_digest) throw Error("Clean daemon predecessor history does not match its public grant");
  const historyBytes = readFileSync(historyFile.path, "utf8"), history = JSON.parse(historyBytes) as History;
  if (canonical(history) !== historyBytes || history.stop_id !== grant.predecessor.stop_id || history.lineage_id !== grant.lineage_id
    || history.generation_id !== grant.predecessor_generation_id || canonical(history.stable) !== canonical(grant.stable))
    throw Error("Clean daemon predecessor history changed its original lineage");
  if (readFileSync(predecessorFile.path, "utf8") !== canonical({ version: 1, history: historyFile,
    grant_digest: sourceCleanDigestV1(grant, sha), lineage_id: grant.lineage_id, generation_id: grant.generation_id }))
    throw Error("Clean daemon predecessor reference changed");
  const generation: RetainedGeneration = { grant, root, store: local.config.storeRoot, control: local.config.recovery.controlDirectory,
    source, history, historyFile, files: [source, grantFile, predecessorFile], physical: [root, local.config.storeRoot, local.config.recovery.controlDirectory].map(identity) };
  checkRetainedGeneration(generation);
  const known = new Set([generationId, ...history.stores.map(item => relative(join(family, "generations"), item.identity.path).split(sep)[0])]);
  if (readdirSync(join(family, "generations")).some(name => !known.has(name))) throw Error("Unknown successor generation keeps the daemon quarantined");
  const closures = new Set([...history.predecessors.map(item => basename(item.path)), basename(historyFile.path)]);
  if (readdirSync(join(family, "closures")).some(name => !closures.has(name))) throw Error("Unknown predecessor closure keeps the daemon quarantined");
  return generation;
}
export function prepareCleanDaemonConfiguration(input: ConfigurationInput & { observerId: string;
  supervisor: PreparedWindowsDaemonSupervisorAuthority }): PreparedCleanDaemonConfiguration {
  const observerId = z.string().uuid().parse(input.observerId);
  if (!input.config.windowsProcessBackend) throw Error("Clean daemon requires its original native installation");
  const original = readWindowsDaemonSupervisorAuthority(input.supervisor, input.config.windowsProcessBackend);
  if (!original.lifetimeOwnership?.runtimeManifest) throw Error("Clean daemon requires its actual Supervisor lifetime and runtime binding");
  const successor = readQuarantinedGeneration(input), configuration = prepareConfigurationRecord(input, successor);
  if (canonical(original.lifetimeOwnership.runtimeManifest) !== canonical(configuration.bundle.manifest))
    throw Error("Clean daemon native runtime differs from its protected local configuration");
  const token = Object.freeze({}) as PreparedCleanDaemonConfiguration;
  daemonConfigurations.set(token, { configuration, supervisor: input.supervisor, observerId, ...(successor ? { successor } : {}) });
  return token;
}
function checkedDaemonConfiguration(token: PreparedCleanDaemonConfiguration) {
  const saved = daemonConfigurations.get(token); if (!saved) throw Error("Original native clean daemon configuration required");
  checkConfigurationRecord(saved.configuration);
  readWindowsDaemonSupervisorAuthority(saved.supervisor, saved.configuration.backend);
  if (saved.successor) checkRetainedGeneration(saved.successor);
  return saved;
}
/** Provisional public description only. Its workspace/store facts come from the
 * actual current Guardian, never from saved files or a fabricated stat digest. */
export function describeCleanDaemonLaunch(token: PreparedCleanDaemonConfiguration, guardian: PreparedWindowsGuardian) {
  const saved = checkedDaemonConfiguration(token), local = saved.configuration;
  const live = readWindowsGuardianLocalRuntime(guardian), native = readWindowsDaemonSupervisorAuthority(saved.supervisor, local.backend);
  if (live.backend !== local.backend || live.local.supervisor !== saved.supervisor || live.binding.node_id !== local.nodeId
    || live.binding.device_id !== local.local.config.recovery!.deviceId || live.binding.workspace_root !== local.local.config.recovery!.workspaceRoot
    || live.local.storeDirectory !== local.local.config.storeRoot || live.local.controlDirectory !== local.local.config.recovery!.controlDirectory)
    throw Error("Clean daemon descriptor requires its exact original Guardian configuration");
  const grant = saved.successor?.grant;
  const launch = SourceSupervisorLaunchV1Schema.parse({ version: 1, observer_id: saved.observerId, supervisor: native.supervisor,
    launch_identity_digest: native.launchIdentityDigest, runtime_manifest_digest: local.bundle.manifest.sha256,
    stable: { version: 1, node_id: live.binding.node_id, device_id: live.binding.device_id, store_family_identity_digest: local.familyDigest,
      genesis_store_identity_digest: grant?.stable.genesis_store_identity_digest ?? live.binding.store_identity_digest,
      workspace_root: live.binding.workspace_root, workspace_identity_digest: live.binding.workspace_identity_digest,
      stable_configuration_digest: local.policyDigest } });
  if (grant && (grant.claimant_observer_id !== saved.observerId || canonical(launch.stable) !== canonical(grant.stable)))
    throw Error("Clean daemon descriptor changed its reserved public predecessor binding");
  return launch;
}
export function readCleanDaemonQuarantine(token: PreparedCleanDaemonConfiguration) {
  const saved = checkedDaemonConfiguration(token), config = saved.configuration;
  // The parsed grant is copied so no public reader can mutate the retained
  // comparison baseline. It remains untrusted until the real paired ACK.
  return Object.freeze({ node_id: config.nodeId, store_root: config.local.config.storeRoot,
    workspace_root: config.local.config.recovery!.workspaceRoot,
    predecessor_operations: saved.successor ? structuredClone(saved.successor.history.intent.operations) : undefined,
    expected_grant: saved.successor ? structuredClone(saved.successor.grant) : undefined });
}
/** Discovery of the installed clean controllers, before the current Guardian
 * handshake. It grants no checkpoint or execution authority and exposes none of
 * the private configuration. The paired session still gates every dispatch. */
export function assertCleanDaemonControllerConfiguration(token: PreparedCleanDaemonConfiguration, input: {
  nodeId: string; profiles: readonly PreparedVerificationProfile[]; releases: readonly PreparedReleaseProfile[];
}): void {
  const local = checkedDaemonConfiguration(token).configuration, policy = local.local.config, operations = policy.operations;
  if (local.nodeId !== input.nodeId || !policy.recovery || !policy.measurementV2
    || !operations?.importedReview || !operations.importedDesign || !operations.importedDesignReview
    || !operations.importedExecution || !operations.importedExecutionReview || !operations.importedValidation)
    throw Error("Clean controller discovery requires its protected complete H7 configuration");
  const profileIds = new Set((policy.measurementV2.destinationResearchMappings ?? [])
    .filter(mapping => local.profiles.some(profile => profile.id === mapping.destinationProfileId
      && profile.workspace_root === policy.recovery!.workspaceRoot)).map(mapping => mapping.destinationProfileId));
  if (!profileIds.size) throw Error("Clean controller discovery has no protected fixed-workspace mapping");
  for (const id of profileIds) {
    const original = local.profiles.find(profile => profile.id === id)!;
    const matches = input.profiles.filter(profile => profile.id === id && profile.digest === original.digest
      && profile.project_id === original.project_id && profile.workspace_root === original.workspace_root);
    if (matches.length !== 1) throw Error("Clean controller discovery changed its prepared verifier");
    const profile = matches[0]!;
    assertLocallyPreparedVerificationProfile(profile); assertImportedValidationVerificationProfile(profile);
    const selected = local.releases.filter(release => policy.measurementV2!.releaseProfileIds.includes(release.id)
      && release.verifier === original);
    if (selected.length !== 1) throw Error("Clean controller discovery requires its exact protected release selection");
    const release = selected[0]!, prepared = input.releases.filter(value => value.id === release.id
      && value.digest === release.digest && value.verifier === profile);
    if (prepared.length !== 1) throw Error("Clean controller discovery changed its prepared publisher");
    const expected = readReleaseCapabilities(release), current = readReleaseCapabilities(prepared[0]!);
    if (!expected || !current || canonical(current) !== canonical(expected))
      throw Error("Clean controller discovery changed its protected publication capabilities");
  }
}
export function readCleanDaemonVerificationProfile(token: PreparedCleanDaemonConfiguration, profileId: string) {
  const saved = checkedDaemonConfiguration(token), workspace = saved.configuration.local.config.recovery!.workspaceRoot;
  const profile = saved.configuration.profiles.find(item => item.id === profileId && item.workspace_root === workspace);
  if (!profile) throw Error("Clean daemon requires the original local verification profile");
  assertLocallyPreparedVerificationProfile(profile); return profile;
}

// Binding is permanent for this original Guardian object. A source factory must
// discover it even when its caller omits clean options; no callback or JSON flag
// can convert the same fresh generation into an ordinary empty-store runtime.
const cleanGuardians = new WeakMap<PreparedWindowsGuardian, { configuration: PreparedCleanDaemonConfiguration; epoch: string }>();
export function bindCleanDaemonGuardian(configuration: PreparedCleanDaemonConfiguration, guardian: PreparedWindowsGuardian): void {
  describeCleanDaemonLaunch(configuration, guardian);
  const live = readWindowsGuardianLocalRuntime(guardian), prior = cleanGuardians.get(guardian);
  if (live.mode !== "active" || prior && (prior.configuration !== configuration || prior.epoch !== live.epoch.epoch_id))
    throw Error("Clean daemon Guardian binding cannot change its original configuration or epoch");
  if (!prior) cleanGuardians.set(guardian, { configuration, epoch: live.epoch.epoch_id });
}
/** Consumer of the actual same-process registration binding, never a producer. */
export function readCleanDaemonGuardian(guardian: PreparedWindowsGuardian): PreparedCleanDaemonConfiguration | undefined {
  const prior = cleanGuardians.get(guardian); if (!prior) return undefined;
  describeCleanDaemonLaunch(prior.configuration, guardian);
  const live = readWindowsGuardianLocalRuntime(guardian);
  if (live.mode !== "active" || live.epoch.epoch_id !== prior.epoch) throw Error("Clean daemon Guardian epoch is no longer current");
  return prior.configuration;
}
