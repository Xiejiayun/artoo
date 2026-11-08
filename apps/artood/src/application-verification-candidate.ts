import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { ApplicationCandidateV1Schema, type ApplicationCandidateV1 } from "@artoo/domain";
import { prepareApplicationCompilerProcess, startApplicationCompilerProcess, type ApplicationCompilerProcessReceipt } from "./application-compiler-process.js";
import type { ApplicationBuildTextFile } from "./application-build-kernel.js";
import { createApplicationInstallationOwner, auditApplicationInstallation, invalidateApplicationInstallation,
  type PreparedApplicationInstallation, type ApplicationInstallationPlan } from "./application-installation.js";
import { readApplicationRuntimePin } from "./application-runtime-installation.js";
import type { ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";
import { assertWindowsProcessBackend, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { readApplicationVerificationProfile, assertApplicationVerificationProfile,
  type PreparedApplicationVerificationProfile } from "./application-verification-profile.js";
import type { ApplicationVerificationDefinition } from "./application-verification-definition.js";
import { VerificationCleanupError } from "./verification-cleanup-error.js";

const sha = (bytes: Uint8Array | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const order = (a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
declare const brand: unique symbol;
export interface PreparedApplicationVerificationCandidate { readonly [brand]: true }
interface Saved {
  readonly profile: PreparedApplicationVerificationProfile; readonly installation: PreparedApplicationInstallation;
  readonly identity: ApplicationCandidateV1; readonly manifest: ApplicationRuntimeFilePin;
  readonly originRunId: string; readonly originRequestId: string; readonly compiler: ApplicationCompilerProcessReceipt;
}
const candidates = new WeakMap<object, Saved>();

/** Called only after the actual author is closed. Compilation and the package
 * writer remain original owners; neither a manifest nor compiler JSON can mint this token. */
export async function createApplicationVerificationCandidate(profile: PreparedApplicationVerificationProfile,
  input: { nodeId: string; projectId: string; runId: string; requestId: string; subjectDigest: string;
    source: readonly ApplicationBuildTextFile[]; definition: ApplicationVerificationDefinition;
    backend: PreparedWindowsProcessBackend; deadline: number; signal: AbortSignal }): Promise<PreparedApplicationVerificationCandidate> {
  const selected = readApplicationVerificationProfile(profile);
  assertWindowsProcessBackend(input.backend); input.signal.throwIfAborted();
  const request = Buffer.from(JSON.stringify({ version: 1, kind: "compile", request_id: sha(`${input.runId}\0${input.requestId}`).slice(7),
    source: input.source.map(file => ({ path: file.path, text: file.text })) }));
  const compiler = startApplicationCompilerProcess(prepareApplicationCompilerProcess({ ...selected.config.compiler,
    assertLocalAdmission: () => assertApplicationVerificationProfile(profile) }), request, Math.min(input.deadline, performance.now() + 30_000));
  const cancel = () => { void compiler.cancel().catch(() => {}); };
  input.signal.addEventListener("abort", cancel, { once: true }); if (input.signal.aborted) cancel();
  let content: ReturnType<typeof compiler.read>, closure: ApplicationCompilerProcessReceipt;
  try {
    const captured = await compiler.completed; closure = await compiler.closed;
    input.signal.throwIfAborted();
    if (!closure.normalShutdown || !closure.closureConfirmed || !closure.inputsUnchanged || !closure.contentValidated) throw Error("Original application compiler did not qualify its content");
    content = compiler.read(captured);
  } catch (error) {
    cancel(); const receipt = await compiler.closed;
    if (!receipt.closureConfirmed) throw new VerificationCleanupError("Application compiler closure remains uncertain", { cause: error });
    throw error;
  } finally { input.signal.removeEventListener("abort", cancel); }
  const current = readApplicationVerificationProfile(profile);
  if (performance.now() >= input.deadline) throw Error("Application verification deadline elapsed before staging");
  const owner = createApplicationInstallationOwner({ parent: current.config.candidate_parent, nodeId: input.nodeId,
    allowedRoots: current.roots, node: current.config.node, backend: input.backend, signal: input.signal });
  let installed: PreparedApplicationInstallation | undefined;
  try {
    const files = new Map<string, ApplicationInstallationPlan["files"][number]>();
    const put = (path: string, value: Uint8Array | ApplicationRuntimeFilePin): ApplicationRuntimeFilePin => {
      if (files.has(path)) throw Error("Application candidate package member collides");
      const original = value instanceof Uint8Array ? Buffer.from(value) : undefined;
      const bytes = original?.length ?? (value as ApplicationRuntimeFilePin).bytes;
      const checksum = original ? sha(original) : (value as ApplicationRuntimeFilePin).sha256;
      files.set(path, { path, bytes, sha256: checksum, ...(original ? { content: original } : { source: value as ApplicationRuntimeFilePin }) });
      return Object.freeze({ path: win32.join(owner.directory, ...path.split("/")), bytes, sha256: checksum });
    };
    const encoded = (path: string, value: unknown) => put(path, Buffer.from(JSON.stringify(value) + "\n"));
    const fixed = new Map<string, ApplicationRuntimeFilePin>();
    for (const file of current.packageFiles) fixed.set(file.name, put(file.name, file.pin));
    const get = (name: string) => { const value = fixed.get(name); if (!value) throw Error("Required package tool is absent"); return value; };
    const source = content.source.map(file => ({ logicalPath: file.path, file: put(`source/${file.path}`, Buffer.from(file.text)) }));
    const artifacts = content.result.files.map(file => ({ logicalPath: file.path, file: put(`compiled/${file.path}`, Buffer.from(file.text)) }));
    const toolchain = [...fixed].map(([logicalPath, file]) => ({ logicalPath, file }));
    const toolchainPins = toolchain.map(file => ({ path: file.logicalPath, bytes: file.file.bytes, sha256: file.file.sha256 })).sort(order);
    const configuration = encoded("application-runtime.json", { version: 1, protocol: "artoo.application-runtime.v1",
      vendorManifest: get("vendor/manifest.json"), source, artifacts, toolchain,
      expectation: { version: 1, source: { files: content.result.manifest.source_files, digest: content.result.manifest.source_digest },
        artifacts: { files: content.result.manifest.artifact_files, digest: content.result.manifest.artifact_digest },
        toolchain: { files: toolchainPins, digest: sha(JSON.stringify(toolchainPins)) } } });
    const broker = { version: 1, protocol: "artoo.application-broker.v1", databasePath: win32.join(owner.storageDirectory, "application.sqlite"), schemaJson: input.definition.schemaJson,
      scope: { product_id: input.projectId, data_generation: owner.generationId, service_generation: 1,
        artifact_digest: content.result.manifest.artifact_digest }, maximumAccess: "write" };
    const createConfiguration = encoded("application-broker-create.json", { ...broker, mode: "create" });
    const openConfiguration = encoded("application-broker-open.json", { ...broker, mode: "open" });
    const helperManifestName = `native/${win32.basename(current.config.runtime.helperManifest.path)}`;
    const helperName = `native/${win32.basename(current.config.runtime.helper.path)}`;
    const serviceProfile = encoded("application-service.json", { version: 1, format: "artoo.application-service-profile.v1",
      node_id: input.nodeId, writable_workspace_roots: current.roots, installation: { version: 1, generation_id: owner.generationId },
      installation_directory: owner.directory, storage_directory: owner.storageDirectory,
      runtime: { node: current.config.node, helper: get(helperName), helperManifest: get(helperManifestName), entry: get("application-runtime.mjs"), configuration },
      broker: { node: current.config.node, entry: get("application-broker.mjs"), create_configuration: createConfiguration, open_configuration: openConfiguration },
      http: { origin: current.config.origin, timeout_ms: current.config.operation_timeout_ms, maximum_concurrent: 1, access: "write",
        same_origin: { version: 1, api_prefix: "/api" } } });
    const manifest = encoded("application-install-package.json", { version: 1, format: "artoo.application-install-package.v1",
      profile: "application-service.json", files: [...files.values()].map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort(order) });
    const directories = new Set<string>();
    for (const name of files.keys()) { const parts = name.split("/"); parts.pop(); while (parts.length) { directories.add(parts.join("/")); parts.pop(); } }
    assertApplicationVerificationProfile(profile); input.signal.throwIfAborted();
    installed = owner.install({ version: 1, directories: [...directories].sort(), files: [...files.values()], profile: serviceProfile });
    auditApplicationInstallation(installed); readApplicationRuntimePin(manifest);
    if (performance.now() >= input.deadline) throw Error("Application verification deadline elapsed during staging");
    const identity = ApplicationCandidateV1Schema.parse({ version: 1, subject_digest: input.subjectDigest,
      source_digest: content.result.manifest.source_digest, artifact_digest: content.result.manifest.artifact_digest,
      toolchain_digest: current.toolchainDigest, package_digest: manifest.sha256, schema_digest: input.definition.schemaDigest, qualified_for_product: false });
    const token = Object.freeze({}) as PreparedApplicationVerificationCandidate;
    candidates.set(token, { profile, installation: installed, identity: Object.freeze(identity), manifest,
      originRunId: input.runId, originRequestId: input.requestId, compiler: closure });
    return token;
  } catch (error) {
    if (installed) invalidateApplicationInstallation(installed); else owner.abandon();
    throw error;
  }
}

export function readApplicationVerificationCandidate(token: PreparedApplicationVerificationCandidate): Readonly<Saved> {
  const saved = candidates.get(token); if (!saved) throw Error("Original application candidate required");
  assertApplicationVerificationProfile(saved.profile); auditApplicationInstallation(saved.installation);
  readApplicationRuntimePin(saved.manifest); return saved;
}
