import { prepareProductSourceConfiguration } from "./product-source-config.js";
import { createHash } from "node:crypto";
import { parseDeviceToken, ProductSourceRoutingV1Schema } from "@artoo/domain";
import { auditWindowsReleaseStorage } from "./windows-release-storage.js";
import { assertWindowsProcessBackend, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { assertImportedDesignVerificationProfile, assertImportedDesignReviewVerificationProfile, assertImportedExecutionVerificationProfile, assertImportedValidationVerificationProfile, type PreparedVerificationProfile } from "./verification.js";
import { readReleaseCapabilities, type PreparedReleaseProfile } from "./product-release.js";
import type { ResearchOptions } from "./research.js";
import { type ProductSourceRuntimeOptions, prepareProductSourceRuntime, assertProductSourceRuntimeConfiguration, closeProductSourceRuntime,
  readProductSourceRuntimeCapabilities } from "./product-source-runtime.js";
import { createProductSourceSemanticClient } from "./product-source-semantic-client.js";
import { prepareWindowsSourceRecoveryConfiguration, readWindowsRecoverySourceRuntime, withWindowsSourceRecoveryOperation, assertWindowsSourceRuntimeConfiguration,
  type PreparedWindowsSourceRecoveryRuntime } from "./windows-source-recovery.js";
import type { PreparedWindowsDaemonSupervisorAuthority } from "./windows-supervisor-authority.js";
import { PRODUCT_SOURCE_TRANSFER_FEATURE_V1, PRODUCT_SOURCE_TRANSFER_FEATURE_V2, PRODUCT_SOURCE_TRANSFER_MEASUREMENT_V2_FEATURE_V1,
  PRODUCT_SOURCE_OPERATIONS_FEATURE_V1, IMPORTED_PRODUCT_REVIEW_FEATURE_V1, IMPORTED_DESIGN_CONTINUATION_FEATURE_V1,
  IMPORTED_DESIGN_REVIEW_FEATURE_V1, IMPORTED_EXECUTION_FEATURE_V1, IMPORTED_EXECUTION_REVIEW_FEATURE_V1, IMPORTED_VALIDATION_FEATURE_V1,
  PRODUCT_SOURCE_RECOVERY_FEATURE_V1, IMPORTED_RECOVERY_VALIDATION_FEATURE_V1, IMPORTED_RECOVERY_VALIDATION_REVIEW_FEATURE_V1,
  PRODUCT_RESEARCH_REVISION_FEATURE_V1 } from "@artoo/domain";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function freezeRouting<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeRouting(child);
    Object.freeze(value);
  }
  return value;
}
/** The credential is reused only inside this node; no task or source file supplies an endpoint. */
function pairedConnection(nodeUrl: string, nodeId: string) {
  const url = new URL(nodeUrl), tokens = url.searchParams.getAll("token");
  if (!nodeId || !["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash
    || url.pathname !== "/api/v1/node" || tokens.length !== 1 || !parseDeviceToken(tokens[0]!)
    || [...url.searchParams.keys()].some(key => key !== "token")
    || url.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Product source startup requires an exact paired node endpoint using WSS or loopback WS");
  }
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return { serverOrigin: url.origin, nodeId, nodeToken: tokens[0]! };
}

/** Runs before any hello. The configuration directory must be dedicated protected local storage. */
export function prepareProductSourceNode(options: { file: string; url: string; nodeId: string; allowedRoots: readonly string[];
  windowsBackend: PreparedWindowsProcessBackend; profiles: readonly PreparedVerificationProfile[];
  releaseProfiles: readonly PreparedReleaseProfile[]; research?: ResearchOptions; acknowledgeRunEvents: boolean }) {
  if (process.platform !== "win32" || !options.allowedRoots.length || !options.profiles.length) {
    throw new Error("Product source startup requires native Windows, complete write roots and prepared verification profiles");
  }
  assertWindowsProcessBackend(options.windowsBackend);
  const connection = pairedConnection(options.url, options.nodeId);
  const { directory, storage, original, config, read } = prepareProductSourceConfiguration(options);
  if (config.sourceResearch && !options.research) throw new Error("Source research must reuse this node's configured research receipt store");
  if (config.operations?.importedDesign && (!config.operations.importedReview || !options.acknowledgeRunEvents)) {
    throw new Error("Imported design requires imported review and committed run-event receipts");
  }
  if (config.operations?.importedDesignReview && !config.operations.importedDesign) throw new Error("H4 requires explicit imported design continuation support");
  if (config.operations?.importedExecution && !config.operations.importedDesignReview) throw new Error("H5 requires explicit H4 support");
  if (config.operations?.importedExecutionReview && (!config.operations.importedExecution || !options.acknowledgeRunEvents))
    throw new Error("H6 and repair require explicit H5 support and committed run-event receipts");
  if (config.operations?.importedValidation && (!config.operations.importedExecutionReview || !options.acknowledgeRunEvents))
    throw Error("H7 requires explicit H6 support and committed run-event receipts");
  if (config.recovery && (!config.operations?.importedValidation || !options.acknowledgeRunEvents
    || !options.profiles.some(profile => profile.workspace_root === config.recovery!.workspaceRoot))) {
    throw Error("Recovery requires explicit complete H7 support, a fixed prepared workspace and committed run-event receipts");
  }
  const v1Mappings = config.destinationResearchMappings ?? [], v2Mappings = config.measurementV2?.destinationResearchMappings ?? [];
  if (config.operations && !config.sourceResearch && !v1Mappings.length && !v2Mappings.length) {
    throw new Error("Source operations require a local semantic export or destination mapping");
  }
  if (config.operations?.importedReview && !v1Mappings.length && !v2Mappings.length) throw new Error("Imported review requires a local destination mapping");
  if (config.operations?.importedDesign && !v2Mappings.length) throw new Error("Imported design requires a local policy-v2 destination mapping");
  const ids = config.measurementV2?.releaseProfileIds ?? [];
  if (new Set(ids).size !== ids.length) throw new Error("Product source release profile selections must be unique");
  const releases = ids.map(id => {
    const matches = options.releaseProfiles.filter(profile => profile.id === id);
    if (matches.length !== 1) throw new Error("Product source release profile selection is absent or ambiguous");
    return matches[0]!;
  });
  if (config.operations?.importedDesign) for (const entry of v2Mappings) {
    const profile = options.profiles.find(profile => profile.id === entry.destinationProfileId);
    if (!profile) throw new Error("Imported design verifier selection is absent");
    // Each higher tier calls every lower-tier assertion. Qualify this exact
    // profile once at the strongest enabled tier within this synchronous setup.
    if (config.operations.importedValidation) assertImportedValidationVerificationProfile(profile);
    else if (config.operations.importedExecution) assertImportedExecutionVerificationProfile(profile);
    else if (config.operations.importedDesignReview) assertImportedDesignReviewVerificationProfile(profile);
    else assertImportedDesignVerificationProfile(profile);
  }
  const semanticClient = config.operations ? createProductSourceSemanticClient(connection) : undefined;
  // Describe only selected protected configuration and original prepared readers.
  // A recovering daemon has not opened a source owner yet: discovery must not do so.
  const describeRouting = () => ProductSourceRoutingV1Schema.parse({ version: 1,
    source_exports: config.sourceResearch && config.operations ? releases.map(release => {
      const capabilities = readReleaseCapabilities(release);
      if (!capabilities || release.verifier.capabilities?.measurement_plan_policy?.version !== 2) {
        throw Error("Automatic source discovery requires prepared policy-v2 release capabilities");
      }
      return capabilities;
    }) : [],
    destination_mappings: config.operations?.importedValidation ? v2Mappings.map(mapping => {
      const profile = options.profiles.find(profile => profile.id === mapping.destinationProfileId);
      const selected = releases.filter(release => release.verifier === profile);
      if (!profile?.capabilities || selected.length !== 1
        || mapping.sourceProfileDigest !== mapping.sourceRelease.binding.verification_profile_digest
        || mapping.commandPairs.length !== profile.capabilities.checks.length
        || mapping.commandPairs.some(pair => !profile.capabilities!.checks.some(check => check.command_id === pair.destination_command_id))) {
        throw Error("Automatic destination discovery requires its exact prepared complete mapping");
      }
      return { source_release: mapping.sourceRelease, destination_release: readReleaseCapabilities(selected[0]!), command_pairs: mapping.commandPairs };
    }) : [],
  });
  // Preserve the exact profiles prepared by the runner. Parsing a second copy
  // would lose the private Windows backend and release reader associations.
  const runtimeOptions: ProductSourceRuntimeOptions = { nodeId: options.nodeId, storeRoot: config.storeRoot, gitExecutable: config.gitExecutable,
    allowedRoots: options.allowedRoots, windowsBackend: options.windowsBackend, profiles: options.profiles,
    ...(config.sourceResearch ? { sourceResearch: options.research! } : {}),
    ...(config.destinationResearchMappings ? { destinationResearchMappings: config.destinationResearchMappings } : {}),
    ...(config.measurementV2 ? { measurementV2: { version: 1, releaseProfiles: releases, destinationResearchMappings: v2Mappings } } : {}),
  };
  let recoveryConfiguration: ReturnType<typeof prepareWindowsSourceRecoveryConfiguration> | undefined;
  const recoveryRequired = config.recovery !== undefined;
  let recoveredRuntime: PreparedWindowsSourceRecoveryRuntime | undefined;
  let runtime = recoveryRequired ? undefined : prepareProductSourceRuntime(runtimeOptions);
  // After this point failure retains the runtime's durable owner fence; callers
  // may close only after controller settlement proves that no writer remains.
  function assertCurrent() {
    if (read().identity !== original.identity) throw new Error("Product source configuration changed after preparation");
    if (runtime) {
      const inspect = () => recoveredRuntime ? assertWindowsSourceRuntimeConfiguration(recoveredRuntime, options.nodeId, options.allowedRoots, options.profiles)
        : assertProductSourceRuntimeConfiguration(runtime!, options.nodeId, options.allowedRoots, options.profiles);
      if (recoveredRuntime) withWindowsSourceRecoveryOperation(recoveredRuntime, { operationId: "source-configuration",
        bindingDigest: "sha256:" + digest(original.bytes), serverOperation: null }, inspect);
      else { assertWindowsProcessBackend(options.windowsBackend); inspect(); }
    }
  }
  function assertDiscovery() {
    // The cheap physical check used during a session is not an ACL audit.
    // Re-audit the complete protected configuration at startup/discovery.
    auditWindowsReleaseStorage(storage, directory);
    assertCurrent();
  }
  assertDiscovery();
  const roles = runtime ? readProductSourceRuntimeCapabilities(runtime) : undefined;
  if (config.operations && roles && !roles.semantic) throw new Error("Prepared source runtime has no semantic role");
  const features = Object.freeze([PRODUCT_SOURCE_TRANSFER_FEATURE_V1,
    ...(config.sourceResearch && config.measurementV2 ? [PRODUCT_RESEARCH_REVISION_FEATURE_V1] : []),
    ...(config.sourceResearch || v1Mappings.length || v2Mappings.length ? [PRODUCT_SOURCE_TRANSFER_FEATURE_V2] : []),
    ...(config.measurementV2 ? [PRODUCT_SOURCE_TRANSFER_MEASUREMENT_V2_FEATURE_V1] : []),
    ...(config.operations ? [PRODUCT_SOURCE_OPERATIONS_FEATURE_V1] : []),
    ...(config.operations?.importedReview ? [IMPORTED_PRODUCT_REVIEW_FEATURE_V1] : []),
    ...(config.operations?.importedDesign ? [IMPORTED_DESIGN_CONTINUATION_FEATURE_V1] : []),
    ...(config.operations?.importedDesignReview ? [IMPORTED_DESIGN_REVIEW_FEATURE_V1] : []),
    ...(config.operations?.importedExecution ? [IMPORTED_EXECUTION_FEATURE_V1] : []),
    ...(config.operations?.importedExecutionReview ? [IMPORTED_EXECUTION_REVIEW_FEATURE_V1] : []),
    ...(config.operations?.importedValidation ? [IMPORTED_VALIDATION_FEATURE_V1] : []),
    ...(recoveryRequired ? [PRODUCT_SOURCE_RECOVERY_FEATURE_V1, IMPORTED_RECOVERY_VALIDATION_FEATURE_V1, IMPORTED_RECOVERY_VALIDATION_REVIEW_FEATURE_V1] : [])]);
  return Object.freeze({ get runtime() { if (!runtime) throw Error("Source runtime awaits guardian registration"); return runtime; },
    recoveryRequired,
    get recoveryConfiguration() { return recoveryConfiguration; },
    get features() { if (recoveryRequired && !recoveryConfiguration) throw Error("Recovery discovery requires the original qualified native supervisor"); return features; },
    get routing() {
      if (recoveryRequired && !recoveryConfiguration) throw Error("Recovery routing requires the original qualified native supervisor");
      assertCurrent(); return freezeRouting(describeRouting());
    },
    qualifyRecovery(supervisor: PreparedWindowsDaemonSupervisorAuthority) {
      if (!config.recovery || recoveryConfiguration || runtime) throw Error("Recovery supervisor qualification is unavailable or already consumed");
      assertDiscovery(); recoveryConfiguration = prepareWindowsSourceRecoveryConfiguration({ ...config.recovery, source: runtimeOptions, supervisor });
    },
    activateRecovery(prepared: PreparedWindowsSourceRecoveryRuntime) {
      if (!recoveryConfiguration || runtime || recoveredRuntime) throw Error("Source recovery activation is unavailable or already consumed");
      const source = readWindowsRecoverySourceRuntime(prepared);
      recoveredRuntime = prepared; runtime = source; assertCurrent(); return source;
    }, semanticClient, importedReview: config.operations?.importedReview === true,
    importedDesign: config.operations?.importedDesign === true, importedDesignReview: config.operations?.importedDesignReview === true,
    importedExecution: config.operations?.importedExecution === true, importedExecutionReview: config.operations?.importedExecutionReview === true,
    importedValidation: config.operations?.importedValidation === true, assertCurrent, assertDiscovery,
    close() { if (runtime && !recoveryRequired) closeProductSourceRuntime(runtime); } });
}
