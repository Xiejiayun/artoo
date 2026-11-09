import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { z } from "zod";
import { describeApplicationInitializationPackage, readApplicationInitializationFile,
  type ApplicationInitializationTarget, type PreparedApplicationInitializationAdmission } from "./application-bootstrap-admission.js";
import type { ApplicationInstallationOwner, ApplicationInstallationPlan } from "./application-installation.js";
import { ApplicationServiceProfileSchema } from "./application-service-profile.js";
import { ApplicationBrokerConfigurationSchema } from "./application-broker-control.js";
import { parseApplicationDataSchema } from "./application-data-contract.js";
import { ApplicationRuntimeConfigurationSchema, ApplicationRuntimeFilePinSchema,
  APPLICATION_RUNTIME_PROCESS_LIMITS as limits, type ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";
import { ApplicationRuntimeVendorManifestSchema, ApplicationRuntimeHelperManifestSchema } from "./application-runtime-installation.js";
import { assertCanonicalWindowsPath, windowsPathsOverlap } from "./windows-local-acl.js";

const digest = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const samePin = (a: ApplicationRuntimeFilePin, b: ApplicationRuntimeFilePin): boolean =>
  a.path === b.path && a.bytes === b.bytes && a.sha256 === b.sha256;
const portable = (value: string): boolean => value.length > 0 && value.length <= 512 && value.split("/").every(part =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(part) && !/[. ]$/u.test(part)
  && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
function fail(reason: string): never { throw Error(`Application install package: ${reason}`); }

type Destination = Pick<ApplicationInstallationOwner, "generationId" | "directory" | "storageDirectory">;
type MemberPin = Readonly<{ path: string; bytes: number; sha256: string }>;
type ConfigurationRole = "runtime" | "broker-create" | "broker-open" | "service-profile";
export interface ApplicationInstallationRelocationProvenanceV1 {
  readonly version: 1;
  readonly format: "artoo.application-installation-relocation.v1";
  readonly scope: "fixed-configuration-plan-only";
  readonly source: Readonly<{ manifest: Readonly<ApplicationRuntimeFilePin>; directory: string; storage_directory: string;
    profile: Readonly<ApplicationRuntimeFilePin>; plan_digest: string }>;
  readonly target: Readonly<{ generation_id: string; directory: string; storage_directory: string;
    profile: Readonly<ApplicationRuntimeFilePin>; plan_digest: string }>;
  readonly rewritten: readonly Readonly<{ role: ConfigurationRole; path: string;
    source: Readonly<{ bytes: number; sha256: string }>; target: Readonly<{ bytes: number; sha256: string }> }>[];
  readonly retained: readonly MemberPin[];
  readonly preserved: Readonly<{
    source_members_digest: string; artifact_members_digest: string; toolchain_members_digest: string;
    runtime_expectation_digest: string; schema_json_digest: string; http_digest: string;
    http_origin: string; maximum_access: "read" | "write";
    candidate_scope: Readonly<{ product_id: string; data_generation: string; service_generation: number; artifact_digest: string }>;
  }>;
}
const valueDigest = (value: unknown): string => digest(Buffer.from(JSON.stringify(value)));
function freezeData<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

/** Fixed-schema data relocation only. No filesystem reads, product evaluation,
 * native launch or authority reconstruction occurs here. The original package
 * reader checks admission; install() later reads unchanged members by source pin. */
export function materializeApplicationInstallationPlan(token: PreparedApplicationInitializationAdmission,
  target: ApplicationInitializationTarget, owner: Destination): ApplicationInstallationPlan {
  return materialize(token, target, owner, false).plan;
}

/** Data provenance from this same materialization, not a publication permit or
 * proof of installation, database creation/identity, or a running service. The
 * source manifest is already bound by the original initialization admission.
 * Plan digests cover version/directories/logical member pins/absolute profile;
 * they describe intended bytes, not a subsequent scan of an installed tree. */
export function materializeApplicationInstallationPlanWithProvenance(token: PreparedApplicationInitializationAdmission,
  target: ApplicationInitializationTarget, owner: Destination): Readonly<{
    plan: ApplicationInstallationPlan; provenance: ApplicationInstallationRelocationProvenanceV1;
  }> {
  // Capture data before admission, then use these same values for every original
  // audit/read and for the plan/proof. An accessor cannot swap a claimed manifest
  // between the admission comparison and provenance capture. Opaque authorities
  // remain the original objects; this data copy cannot manufacture admission.
  const pin = (value: ApplicationRuntimeFilePin) => Object.freeze({ path: value.path, bytes: value.bytes, sha256: value.sha256 });
  const selected: ApplicationInitializationTarget = Object.freeze({ parent: target.parent, sourceManifest: pin(target.sourceManifest),
    nodeId: target.nodeId, allowedRoots: Object.freeze([...target.allowedRoots]), node: pin(target.node),
    backend: target.backend, hostCode: target.hostCode, hostDirectory: target.hostDirectory });
  const destination = Object.freeze({ generationId: owner.generationId, directory: owner.directory, storageDirectory: owner.storageDirectory });
  const result = materialize(token, selected, destination, true);
  return Object.freeze({ plan: result.plan, provenance: result.provenance! });
}

function materialize(token: PreparedApplicationInitializationAdmission, target: ApplicationInitializationTarget,
  owner: Destination, withProvenance: boolean): {
    plan: ApplicationInstallationPlan; provenance?: ApplicationInstallationRelocationProvenanceV1;
  } {
  const pkg = describeApplicationInitializationPackage(token, target);
  // describe() checks this exact pin against the original admission and audits
  // it; no caller-supplied digest can independently establish candidate lineage.
  const sourceManifest = withProvenance ? { ...target.sourceManifest } : undefined;
  assertCanonicalWindowsPath(pkg.directory); assertCanonicalWindowsPath(target.parent);
  assertCanonicalWindowsPath(owner.directory); assertCanonicalWindowsPath(owner.storageDirectory);
  if (!portable(owner.generationId) || owner.generationId.includes("/")
    || owner.directory !== win32.join(target.parent, owner.generationId, "code")
    || owner.storageDirectory !== win32.join(target.parent, owner.generationId, "store")
    || windowsPathsOverlap(pkg.directory, target.parent)) fail("original generation destinations required");
  const files = new Map<string, ApplicationRuntimeFilePin>(), aliases = new Set<string>(); let total = 0;
  if (!pkg.files.length || pkg.files.length > limits.files) fail("package file count exceeds bound");
  for (const member of pkg.files) {
    if (!portable(member.path) || aliases.has(member.path.toLowerCase())) fail("package path escapes or aliases");
    const pin = ApplicationRuntimeFilePinSchema.parse({ ...member, path: win32.join(pkg.directory, ...member.path.split("/")) });
    total += pin.bytes; if (total > limits.allFileBytes) fail("package bytes exceed bound");
    aliases.add(member.path.toLowerCase()); files.set(member.path, Object.freeze(pin));
  }
  const local = (pin: ApplicationRuntimeFilePin): string => {
    assertCanonicalWindowsPath(pin.path);
    const name = win32.relative(pkg.directory, pin.path).split(win32.sep).join("/"), actual = files.get(name);
    if (!actual || !samePin(actual, pin)) fail("reference differs from complete package manifest");
    return name;
  };
  const relocate = (pin: ApplicationRuntimeFilePin): ApplicationRuntimeFilePin =>
    Object.freeze({ ...pin, path: win32.join(owner.directory, ...local(pin).split("/")) });
  const readJson = (pin: ApplicationRuntimeFilePin, maximum = 65_536): unknown => {
    local(pin); if (pin.bytes > maximum) fail("configuration exceeds byte bound");
    const bytes = readApplicationInitializationFile(token, target, pin.path);
    if (bytes.length !== pin.bytes || digest(bytes) !== pin.sha256) fail("configuration bytes differ from original pin");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  };
  const profileName = local(pkg.profile);
  if (win32.dirname(pkg.profile.path) !== pkg.directory) fail("profile must be a direct package child");
  const profile = ApplicationServiceProfileSchema.parse(readJson(pkg.profile));
  const roots = (values: readonly string[]): string[] => {
    for (const path of values) assertCanonicalWindowsPath(path);
    if (new Set(values.map(value => value.toLowerCase())).size !== values.length) fail("write roots alias");
    return [...values].sort();
  };
  if (profile.installation_directory !== pkg.directory || profile.node_id !== target.nodeId
    || JSON.stringify(roots(profile.writable_workspace_roots)) !== JSON.stringify(roots(target.allowedRoots))
    || !samePin(profile.runtime.node, target.node) || !samePin(profile.broker.node, target.node)) fail("profile differs from selected package or node");
  assertCanonicalWindowsPath(profile.storage_directory);
  if ([pkg.directory, win32.dirname(target.node.path)].some(directory => windowsPathsOverlap(profile.storage_directory, directory)))
    fail("source storage must be separate from package and Node code");
  if (win32.basename(profile.runtime.entry.path) !== "application-runtime.mjs"
    || win32.basename(profile.runtime.configuration.path) !== "application-runtime.json"
    || win32.dirname(profile.runtime.configuration.path) !== win32.dirname(profile.runtime.entry.path)
    || win32.basename(profile.broker.entry.path) !== "application-broker.mjs") fail("fixed runtime and broker entries required");
  const generated = new Set([profileName, local(profile.runtime.configuration), local(profile.broker.create_configuration), local(profile.broker.open_configuration)]);
  if (generated.size !== 4) fail("four distinct generated configuration paths required");
  const retained = (pin: ApplicationRuntimeFilePin): ApplicationRuntimeFilePin => {
    if (generated.has(local(pin))) fail("retained file references a generated configuration");
    return relocate(pin);
  };
  const runtime = ApplicationRuntimeConfigurationSchema.parse(readJson(profile.runtime.configuration));
  const create = ApplicationBrokerConfigurationSchema.parse(readJson(profile.broker.create_configuration));
  const open = ApplicationBrokerConfigurationSchema.parse(readJson(profile.broker.open_configuration));
  if (create.mode !== "create" || open.mode !== "open" || JSON.stringify({ ...create, mode: "open" }) !== JSON.stringify(open)
    || open.maximumAccess !== profile.http.access) fail("create and open configuration bindings differ");
  parseApplicationDataSchema(open.schemaJson);
  const expectation = z.object({ artifacts: z.object({ digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }).passthrough() })
    .passthrough().parse(runtime.expectation);
  if (expectation.artifacts.digest !== open.scope.artifact_digest) fail("runtime and broker artifact bindings differ");
  assertCanonicalWindowsPath(open.databasePath);
  if (win32.dirname(open.databasePath) !== profile.storage_directory) fail("database must be a direct storage child");
  const databasePath = win32.join(owner.storageDirectory, win32.basename(open.databasePath));

  // Relative helper/vendor manifests remain byte-for-byte unchanged. Their pins
  // must still name exact retained members; relocation never rewrites strings in
  // manifests, product source, artifacts, toolchain or expectation metadata.
  const helper = ApplicationRuntimeHelperManifestSchema.parse(readJson(profile.runtime.helperManifest, 4_194_304));
  const helperDirectory = win32.dirname(profile.runtime.helperManifest.path);
  if (win32.basename(profile.runtime.helperManifest.path) !== "quickjs-native-manifest.json"
    || profile.runtime.helper.path !== win32.join(helperDirectory, helper.entry)) fail("fixed helper manifest and entry required");
  const helperFiles = new Set<string>();
  for (const member of helper.files) {
    if (!portable(member.path)) fail("helper member escapes package");
    const pin = { ...member, path: win32.join(helperDirectory, ...member.path.split("/")) };
    const name = local(pin); if (helperFiles.has(name) || name === local(profile.runtime.helperManifest)) fail("helper members alias");
    helperFiles.add(name); retained(pin);
  }
  if (!helperFiles.has(local(profile.runtime.helper))) fail("helper entry missing from manifest");
  const helperInventory = [...files].filter(([, pin]) => win32.relative(helperDirectory, pin.path) !== ".."
    && !win32.relative(helperDirectory, pin.path).startsWith("..\\") && !win32.isAbsolute(win32.relative(helperDirectory, pin.path)))
    .map(([name]) => name).sort();
  if (JSON.stringify(helperInventory) !== JSON.stringify([...helperFiles, local(profile.runtime.helperManifest)].sort())) fail("complete helper inventory differs");
  const vendor = ApplicationRuntimeVendorManifestSchema.parse(readJson(runtime.vendorManifest, 4_194_304));
  const vendorDirectory = win32.dirname(runtime.vendorManifest.path), vendorFiles = new Set<string>();
  for (const member of vendor.files) {
    if (!portable(member.path)) fail("vendor member escapes package");
    const pin = { path: win32.join(vendorDirectory, ...member.path.split("/")), bytes: member.bytes, sha256: `sha256:${member.sha256}` };
    const name = local(pin); if (vendorFiles.has(name)) fail("vendor members alias"); vendorFiles.add(name); retained(pin);
  }
  const rewritten = new Map<string, { bytes: number; sha256: string; content: Buffer }>();
  const generate = (pin: ApplicationRuntimeFilePin, value: unknown): ApplicationRuntimeFilePin => {
    const content = Buffer.from(JSON.stringify(value) + "\n");
    if (content.length > 65_536) fail("generated configuration exceeds byte bound");
    const result = { bytes: content.length, sha256: digest(content), content };
    rewritten.set(local(pin), result); return Object.freeze({ path: relocate(pin).path, bytes: result.bytes, sha256: result.sha256 });
  };
  const configuration = generate(profile.runtime.configuration, { ...runtime, vendorManifest: retained(runtime.vendorManifest),
    source: runtime.source.map(member => ({ ...member, file: retained(member.file) })),
    artifacts: runtime.artifacts.map(member => ({ ...member, file: retained(member.file) })),
    toolchain: runtime.toolchain.map(member => ({ ...member, file: retained(member.file) })) });
  const createConfiguration = generate(profile.broker.create_configuration, { ...create, databasePath });
  const openConfiguration = generate(profile.broker.open_configuration, { ...open, databasePath });
  const profilePin = generate(pkg.profile, { ...profile, installation: { version: 1, generation_id: owner.generationId },
    installation_directory: owner.directory, storage_directory: owner.storageDirectory,
    runtime: { ...profile.runtime, helper: retained(profile.runtime.helper), helperManifest: retained(profile.runtime.helperManifest),
      entry: retained(profile.runtime.entry), configuration },
    broker: { ...profile.broker, entry: retained(profile.broker.entry), create_configuration: createConfiguration, open_configuration: openConfiguration } });
  const directories = new Set<string>(); total = 0;
  const planFiles = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, source]) => {
    const parent = path.split("/"); parent.pop(); while (parent.length) { directories.add(parent.join("/")); parent.pop(); }
    const result = rewritten.get(path); total += result?.bytes ?? source.bytes;
    return Object.freeze(result ? { path, ...result } : { path, bytes: source.bytes, sha256: source.sha256, source });
  });
  if (total > limits.allFileBytes) fail("generated plan exceeds byte bound");
  const plan: ApplicationInstallationPlan = Object.freeze({ version: 1, directories: Object.freeze([...directories].sort()),
    files: Object.freeze(planFiles), profile: profilePin });
  let provenance: ApplicationInstallationRelocationProvenanceV1 | undefined;
  if (withProvenance) {
    const member = (pin: { bytes: number; sha256: string }) => ({ bytes: pin.bytes, sha256: pin.sha256 });
    const sourceMembers = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([path, pin]) => ({ path, ...member(pin) }));
    const targetMembers = plan.files.map(file => ({ path: file.path, ...member(file) }));
    const targetFiles = new Map(plan.files.map(file => [file.path, file]));
    const planDigest = (members: readonly MemberPin[], profile: ApplicationRuntimeFilePin) =>
      valueDigest({ version: 1, directories: plan.directories, files: members, profile: { ...profile } });
    const configurations: readonly [ConfigurationRole, ApplicationRuntimeFilePin][] = [
      ["runtime", profile.runtime.configuration], ["broker-create", profile.broker.create_configuration],
      ["broker-open", profile.broker.open_configuration], ["service-profile", pkg.profile],
    ];
    const rewrittenMembers = configurations.map(([role, pin]) => {
      const path = local(pin), output = rewritten.get(path);
      if (!output) fail("relocation omitted a fixed configuration");
      return { role, path, source: member(pin), target: member(output) };
    });
    if (rewritten.size !== 4 || rewrittenMembers.some(file => !generated.has(file.path))) fail("relocation configuration set differs");
    const retainedMembers = sourceMembers.filter(file => !generated.has(file.path));
    for (const original of retainedMembers) {
      const output = targetFiles.get(original.path);
      if (!output || !("source" in output) || output.bytes !== original.bytes || output.sha256 !== original.sha256
        || !samePin(output.source, files.get(original.path)!)) fail("relocation changed a retained package member");
    }
    // Logical paths and exact member pins remain unchanged even though their
    // absolute installation paths move. Expectation/schema/scope/HTTP data is
    // copied unchanged by the four fixed generators above, never reinterpreted.
    const runtimeMembers = (members: typeof runtime.source) => members.map(item => ({
      logicalPath: item.logicalPath, file: { path: local(item.file), ...member(item.file) },
    }));
    provenance = freezeData<ApplicationInstallationRelocationProvenanceV1>({ version: 1,
      format: "artoo.application-installation-relocation.v1", scope: "fixed-configuration-plan-only",
      source: { manifest: sourceManifest!, directory: pkg.directory, storage_directory: profile.storage_directory,
        profile: { ...pkg.profile }, plan_digest: planDigest(sourceMembers, pkg.profile) },
      target: { generation_id: owner.generationId, directory: owner.directory, storage_directory: owner.storageDirectory,
        profile: { ...plan.profile }, plan_digest: planDigest(targetMembers, plan.profile) },
      rewritten: rewrittenMembers, retained: retainedMembers,
      preserved: { source_members_digest: valueDigest(runtimeMembers(runtime.source)),
        artifact_members_digest: valueDigest(runtimeMembers(runtime.artifacts)), toolchain_members_digest: valueDigest(runtimeMembers(runtime.toolchain)),
        runtime_expectation_digest: valueDigest(runtime.expectation), schema_json_digest: digest(Buffer.from(open.schemaJson)),
        http_digest: valueDigest(profile.http), http_origin: profile.http.origin, maximum_access: open.maximumAccess,
        candidate_scope: { ...open.scope } },
    });
  }
  // The final read-side admission is still the original object, never a package
  // snapshot minted from the materialized output or the current disk contents.
  describeApplicationInitializationPackage(token, target);
  return { plan, ...(provenance ? { provenance } : {}) };
}
