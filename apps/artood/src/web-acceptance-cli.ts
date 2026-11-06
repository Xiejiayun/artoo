import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import { ContextPackSchema, canonicalProductSourceTransferValueV1 as canonical, inspectProductSourceVerificationEnvelope,
  type StaticWebCapabilityBinding } from "@artoo/domain";
import { runWebAcceptance, validateStaticWebCapabilitySnapshot, type WebAcceptanceOptions } from "./web-acceptance.js";
import { STATIC_WEB_MAX_CONFIG_BYTES, isV3WebAcceptanceOptions } from "./web-acceptance-config.js";
import { prepareWindowsBrowserProcessFromDescriptor } from "./windows-browser-process-authority.js";
import { readWindowsBrowserPrivateContext } from "./windows-browser-private-context.js";
import { isDeepStrictEqual } from "node:util";
import { inspectProductDesignRevision } from "./product-design-revision.js";
import { bindImportedDesignVerifierContext } from "./imported-design-verifier-context.js";
import { bindImportedDesignReviewVerifierContext, recheckImportedDesignReviewVerifierContext } from "./imported-design-review-verifier-context.js";
import { bindImportedExecutionVerifierContext, recheckImportedExecutionVerifierContext } from "./imported-execution-verifier-context.js";
import { bindImportedExecutionReviewVerifierContext, bindImportedExecutionRepairVerifierContext,
  recheckImportedImplementationVerifierContext } from "./imported-implementation-verifier-context.js";
import { readProductFile } from "./product-stage.js";
import { bindImportedValidationVerifierContext, bindImportedValidationReviewVerifierContext, recheckImportedValidationVerifierContext } from "./imported-validation-verifier-context.js";
import { bindImportedRecoveryValidationVerifierContext, bindImportedRecoveryValidationReviewVerifierContext,
  recheckImportedRecoveryValidationVerifierContext } from "./imported-recovery-validation-verifier-context.js";
import { bindImportedCleanValidationVerifierContext, bindImportedCleanValidationReviewVerifierContext,
  recheckImportedCleanValidationVerifierContext } from "./imported-clean-validation-verifier-context.js";
import { formatBrowserFailure } from "./browser-failure-diagnostic.js";

// Invoke only from a protected verification profile. The optional JSON config is
// itself an absolute argv file, so the node fingerprints it along with this program.
async function main(): Promise<void> {
  const contextFile = process.env.ARTOO_VERIFICATION_CONTEXT_FILE;
  if (!contextFile || !isAbsolute(contextFile)) throw new Error("Missing node verification context");
  const root = realpathSync.native(process.cwd()), path = process.argv[2];
  let configuredOptions: WebAcceptanceOptions = {};
  if (path) {
    const physical = realpathSync.native(path), tail = relative(root, physical), stat = lstatSync(path);
    if (!isAbsolute(path) || !(tail === ".." || tail.startsWith(`..${sep}`) || isAbsolute(tail)) || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > STATIC_WEB_MAX_CONFIG_BYTES) throw new Error("Browser verifier config must be a protected external file");
    configuredOptions = JSON.parse(readFileSync(path, "utf8")) as WebAcceptanceOptions;
  }
  const privateSha256 = process.env.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256;
  // The protected argv config identifies opt-in before any envelope JSON parse.
  // Actual execution options still come only from the immutable bound snapshot.
  const privateRequired = configuredOptions?.windows_browser_process !== undefined || privateSha256 !== undefined;
  const envelope = JSON.parse(privateRequired
    ? readWindowsBrowserPrivateContext(contextFile, privateSha256 ?? "").toString("utf8")
    : readFileSync(contextFile, "utf8")) as {
    version: number; request_id: string; profile_id?: unknown; profile_digest?: unknown; subject_digest?: unknown; context: unknown;
    static_web_capabilities?: unknown; windows_browser_process?: unknown; product_source_verification?: unknown;
    product_source_design_verification?: unknown; product_source_design_review_verification?: unknown; product_source_execution_verification?: unknown; scope?: unknown;
    product_source_execution_review_verification?: unknown; product_source_execution_repair_verification?: unknown;
    product_source_validation_verification?: unknown; product_source_validation_review_verification?: unknown;
    product_source_recovery_validation_verification?: unknown; product_source_recovery_validation_review_verification?: unknown;
    product_source_clean_validation_verification?: unknown; product_source_clean_validation_review_verification?: unknown;
  };
  if (envelope.version !== 1 || typeof envelope.request_id !== "string") throw new Error("Invalid node verification context");
  const context = ContextPackSchema.parse(envelope.context);
  if (realpathSync.native(context.workspace.root) !== root) throw new Error("Verification context workspace differs from current directory");
  let options: WebAcceptanceOptions = configuredOptions;
  let binding: StaticWebCapabilityBinding | undefined;
  if (envelope.static_web_capabilities !== undefined) {
    const snapshot = validateStaticWebCapabilitySnapshot(envelope.static_web_capabilities);
    if (snapshot.binding.profile_digest !== envelope.profile_digest || process.argv.length !== 3) {
      throw new Error("Static web capability snapshot does not match the protected verifier invocation");
    }
    // The node freezes this private snapshot before spawning; do not adopt a second,
    // potentially different options object from the argv file during execution.
    options = snapshot.options; binding = snapshot.binding;
  }
  if (options.windows_browser_process !== undefined && privateSha256 === undefined) throw new Error("Windows browser Job requires an independently bound private context");
  if (options.windows_browser_process === undefined && privateRequired) throw new Error("Unsolicited Windows browser private context");
  if (options.windows_browser_process !== undefined && !binding) throw new Error("Windows browser Job requires a protected capability snapshot");
  const windowsProcessBackend = prepareWindowsBrowserProcessFromDescriptor(envelope.windows_browser_process, {
    request_id: envelope.request_id, command_id: binding?.command_id, profile_digest: envelope.profile_digest,
    subject_digest: envelope.subject_digest, workspace_root: root,
  }, options.windows_browser_process !== undefined);
  let productDesignRevision: unknown;
  const foreignEnvelopes = [envelope.product_source_verification, envelope.product_source_design_verification,
    envelope.product_source_design_review_verification, envelope.product_source_execution_verification,
    envelope.product_source_execution_review_verification, envelope.product_source_execution_repair_verification,
    envelope.product_source_validation_verification, envelope.product_source_validation_review_verification,
    envelope.product_source_recovery_validation_verification, envelope.product_source_recovery_validation_review_verification,
    envelope.product_source_clean_validation_verification, envelope.product_source_clean_validation_review_verification].filter(value => value !== undefined);
  if (foreignEnvelopes.length > 1 || (context.product_design_revision && foreignEnvelopes.length)
    || (!!context.imported_design_review_subject !== (envelope.product_source_design_review_verification !== undefined))
    || (!!context.imported_execution !== (envelope.product_source_execution_verification !== undefined))
    || (!!context.imported_execution_review_subject !== (envelope.product_source_execution_review_verification !== undefined))
    || (!!context.imported_execution_repair !== (envelope.product_source_execution_repair_verification !== undefined))
    || (!!context.imported_validation !== (envelope.product_source_validation_verification !== undefined))
    || (!!context.imported_validation_review_subject !== (envelope.product_source_validation_review_verification !== undefined))
    || (!!context.imported_recovery_validation !== (envelope.product_source_recovery_validation_verification !== undefined))
    || (!!context.imported_recovery_validation_review_subject !== (envelope.product_source_recovery_validation_review_verification !== undefined))
    || (!!context.imported_clean_validation !== (envelope.product_source_clean_validation_verification !== undefined))
    || (!!context.imported_clean_validation_review_subject !== (envelope.product_source_clean_validation_review_verification !== undefined))) {
    throw new Error("Imported verifier phases and local revision context must be exclusive");
  }
  if (context.product_design_revision) {
    if (!privateRequired || !privateSha256 || !windowsProcessBackend || !binding || !options.design_capture_cases
      || foreignEnvelopes.length) {
      throw new Error("Design revision requires its exclusive private native Job context and all declared cases");
    }
    productDesignRevision = inspectProductDesignRevision(context, readProductFile(root, ".artoo/product/research.json"),
      readProductFile(root, ".artoo/product/design.json"));
  }
  let productSourceDesignReviewMapping: unknown;
  if (envelope.product_source_design_review_verification !== undefined) {
    if (!privateRequired || !privateSha256 || !windowsProcessBackend || !binding
      || !isV3WebAcceptanceOptions(options) || !options.windows_browser_process || options.design_capture_cases !== true) {
      throw new Error("H4 requires its exclusive private native Job context and all declared v3 cases");
    }
    productSourceDesignReviewMapping = bindImportedDesignReviewVerifierContext({ envelope: envelope.product_source_design_review_verification,
      root, context, researchBytes: readProductFile(root, ".artoo/product/research.json"), designBytes: readProductFile(root, ".artoo/product/design.json"),
      requestId: envelope.request_id, scope: envelope.scope, profileId: envelope.profile_id, profileDigest: envelope.profile_digest,
      subjectDigest: envelope.subject_digest, binding, options, backend: windowsProcessBackend });
  }
  let productSourceExecutionMapping: unknown;
  if (envelope.product_source_execution_verification !== undefined) {
    if (!privateRequired || !privateSha256 || !windowsProcessBackend || !binding
      || !isV3WebAcceptanceOptions(options) || !options.windows_browser_process || options.design_capture_cases !== true) {
      throw new Error("H5 requires its exclusive protected native v3 implementation context");
    }
    productSourceExecutionMapping = bindImportedExecutionVerifierContext({ envelope: envelope.product_source_execution_verification,
      root, context, researchBytes: readProductFile(root, ".artoo/product/research.json"), designBytes: readProductFile(root, ".artoo/product/design.json"),
      requestId: envelope.request_id, scope: envelope.scope, profileId: envelope.profile_id, profileDigest: envelope.profile_digest,
      subjectDigest: envelope.subject_digest, binding, options, backend: windowsProcessBackend });
  }
  let productSourceExecutionReviewMapping: unknown, productSourceExecutionRepairMapping: unknown;
  if (envelope.product_source_execution_review_verification !== undefined || envelope.product_source_execution_repair_verification !== undefined) {
    if (!privateRequired || !privateSha256 || !windowsProcessBackend || !binding
      || !isV3WebAcceptanceOptions(options) || !options.windows_browser_process || options.design_capture_cases !== true)
      throw new Error("Implementation review and repair require an exclusive protected native v3 context");
    const input = { root, context, researchBytes: readProductFile(root, ".artoo/product/research.json"), designBytes: readProductFile(root, ".artoo/product/design.json"),
      requestId: envelope.request_id, scope: envelope.scope, profileId: envelope.profile_id, profileDigest: envelope.profile_digest,
      subjectDigest: envelope.subject_digest, binding, options, backend: windowsProcessBackend };
    if (envelope.product_source_execution_review_verification !== undefined)
      productSourceExecutionReviewMapping = bindImportedExecutionReviewVerifierContext({ ...input, envelope: envelope.product_source_execution_review_verification });
    else productSourceExecutionRepairMapping = bindImportedExecutionRepairVerifierContext({ ...input, envelope: envelope.product_source_execution_repair_verification });
  }
  let productSourceValidationMapping: unknown, productSourceValidationReviewMapping: unknown;
  if (envelope.product_source_validation_verification !== undefined || envelope.product_source_validation_review_verification !== undefined) {
    if (!privateRequired || !privateSha256 || !windowsProcessBackend || !binding
      || !isV3WebAcceptanceOptions(options) || !options.windows_browser_process || options.design_capture_cases !== true)
      throw Error("H7 requires its exclusive protected native v3 validation context");
    const input = { root, context, researchBytes: readProductFile(root, ".artoo/product/research.json"), designBytes: readProductFile(root, ".artoo/product/design.json"),
      requestId: envelope.request_id, scope: envelope.scope, profileId: envelope.profile_id, profileDigest: envelope.profile_digest,
      subjectDigest: envelope.subject_digest, binding, options, backend: windowsProcessBackend };
    if (envelope.product_source_validation_review_verification !== undefined)
      productSourceValidationReviewMapping = bindImportedValidationReviewVerifierContext({ ...input, envelope: envelope.product_source_validation_review_verification });
    else productSourceValidationMapping = bindImportedValidationVerifierContext({ ...input, envelope: envelope.product_source_validation_verification });
  }
  let productSourceRecoveryValidationMapping: unknown, productSourceRecoveryValidationReviewMapping: unknown;
  if (envelope.product_source_recovery_validation_verification !== undefined || envelope.product_source_recovery_validation_review_verification !== undefined) {
    if (!privateRequired || !privateSha256 || !windowsProcessBackend || !binding
      || !isV3WebAcceptanceOptions(options) || !options.windows_browser_process || options.design_capture_cases !== true)
      throw Error("H9 requires its exclusive protected native v3 validation context");
    const input = { root, context, researchBytes: readProductFile(root, ".artoo/product/research.json"), designBytes: readProductFile(root, ".artoo/product/design.json"),
      requestId: envelope.request_id, scope: envelope.scope, profileId: envelope.profile_id, profileDigest: envelope.profile_digest,
      subjectDigest: envelope.subject_digest, binding, options, backend: windowsProcessBackend };
    if (envelope.product_source_recovery_validation_review_verification !== undefined)
      productSourceRecoveryValidationReviewMapping = bindImportedRecoveryValidationReviewVerifierContext({ ...input, envelope: envelope.product_source_recovery_validation_review_verification });
    else productSourceRecoveryValidationMapping = bindImportedRecoveryValidationVerifierContext({ ...input, envelope: envelope.product_source_recovery_validation_verification });
  }
  let productSourceCleanValidationMapping: unknown, productSourceCleanValidationReviewMapping: unknown;
  if (envelope.product_source_clean_validation_verification !== undefined || envelope.product_source_clean_validation_review_verification !== undefined) {
    if (!privateRequired || !privateSha256 || !windowsProcessBackend || !binding
      || !isV3WebAcceptanceOptions(options) || !options.windows_browser_process || options.design_capture_cases !== true)
      throw Error("Clean restart requires its exclusive protected native v3 validation context");
    const input = { root, context, researchBytes: readProductFile(root, ".artoo/product/research.json"), designBytes: readProductFile(root, ".artoo/product/design.json"),
      requestId: envelope.request_id, scope: envelope.scope, profileId: envelope.profile_id, profileDigest: envelope.profile_digest,
      subjectDigest: envelope.subject_digest, binding, options, backend: windowsProcessBackend };
    if (envelope.product_source_clean_validation_review_verification !== undefined)
      productSourceCleanValidationReviewMapping = bindImportedCleanValidationReviewVerifierContext({ ...input, envelope: envelope.product_source_clean_validation_review_verification });
    else productSourceCleanValidationMapping = bindImportedCleanValidationVerifierContext({ ...input, envelope: envelope.product_source_clean_validation_verification });
  }
  let productSourceDesignMapping: unknown;
  if (envelope.product_source_design_verification !== undefined) {
    if (!privateRequired || !privateSha256 || !windowsProcessBackend || !binding
      || envelope.product_source_verification !== undefined) {
      throw new Error("Imported design verification requires its exclusive private Windows Job command context");
    }
    productSourceDesignMapping = bindImportedDesignVerifierContext({ envelope: envelope.product_source_design_verification,
      root, context, researchBytes: readProductFile(root, ".artoo/product/research.json"), requestId: envelope.request_id,
      scope: envelope.scope, profileId: envelope.profile_id, profileDigest: envelope.profile_digest,
      subjectDigest: envelope.subject_digest, binding, backend: windowsProcessBackend });
  } else if (context.transferred_product_input && !productSourceDesignReviewMapping && !productSourceExecutionMapping
    && !productSourceExecutionReviewMapping && !productSourceExecutionRepairMapping && !productSourceValidationMapping && !productSourceValidationReviewMapping
    && !productSourceRecoveryValidationMapping && !productSourceRecoveryValidationReviewMapping && !productSourceCleanValidationMapping && !productSourceCleanValidationReviewMapping) {
    throw new Error("Transferred design context is missing its private verifier binding");
  }
  let productSourceMapping: unknown;
  if (envelope.product_source_verification !== undefined) {
    const sha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const inspected = inspectProductSourceVerificationEnvelope(envelope.product_source_verification,
      readProductFile(root, ".artoo/product/research.json"), sha);
    const start = inspected.envelope.run_start, destination = inspected.envelope.ready.destination;
    if (!binding || start.verification?.request_id !== envelope.request_id || binding.profile_digest !== envelope.profile_digest
      || envelope.profile_id !== destination.profile_id || envelope.profile_digest !== destination.profile_digest
      || envelope.subject_digest !== destination.subject_digest
      || canonical(start.context_pack.payload) !== canonical(context)
      || !inspected.mapping.checks.some(check => check.destination.command_id === binding!.command_id
        && check.destination.config_digest === binding!.config_digest && check.destination.contract_digest === binding!.contract_digest)) {
      throw new Error("Foreign research mapping differs from the protected command context");
    }
    productSourceMapping = { version: 1, admission_digest: inspected.admission_digest, mapping_digest: sha(canonical(inspected.mapping)),
      request_digest: inspected.envelope.request_digest, source_export_digest: inspected.envelope.request.source_export_digest,
      research_provenance_digest: inspected.envelope.request.source_export.research_provenance_digest, command_id: binding.command_id };
  }
  const report = await runWebAcceptance(root, context, options, envelope.request_id, binding,
    windowsProcessBackend ? { windowsProcessBackend } : undefined);
  if (productSourceMapping && (report.stage !== "research" || report.cases.length !== 0)) throw new Error("Foreign research cannot execute browser cases");
  if (productSourceDesignMapping && report.stage !== "design") throw new Error("Imported design verifier returned another stage");
  if (productSourceExecutionMapping && (report.stage !== "implementation" || !isDeepStrictEqual(productSourceExecutionMapping,
    recheckImportedExecutionVerifierContext(root, context, readProductFile(root, ".artoo/product/research.json"), readProductFile(root, ".artoo/product/design.json"))))) {
    throw new Error("H5 verifier changed its implementation stage or accepted inputs");
  }
  if ((productSourceExecutionReviewMapping || productSourceExecutionRepairMapping) && (report.stage !== "implementation"
    || !isDeepStrictEqual(productSourceExecutionReviewMapping ?? productSourceExecutionRepairMapping,
      recheckImportedImplementationVerifierContext(root, context, readProductFile(root, ".artoo/product/research.json"), readProductFile(root, ".artoo/product/design.json"))))) {
    throw new Error("Implementation review or repair binding changed during protected browser execution");
  }
  if ((productSourceValidationMapping || productSourceValidationReviewMapping) && (report.stage !== "validation"
    || !isDeepStrictEqual(productSourceValidationMapping ?? productSourceValidationReviewMapping,
      recheckImportedValidationVerifierContext(root, context, readProductFile(root, ".artoo/product/research.json"), readProductFile(root, ".artoo/product/design.json")))))
    throw Error("H7 verifier changed its complete product subject or exact validation binding");
  if ((productSourceRecoveryValidationMapping || productSourceRecoveryValidationReviewMapping) && (report.stage !== "validation"
    || !isDeepStrictEqual(productSourceRecoveryValidationMapping ?? productSourceRecoveryValidationReviewMapping,
      recheckImportedRecoveryValidationVerifierContext(root, context, readProductFile(root, ".artoo/product/research.json"), readProductFile(root, ".artoo/product/design.json")))))
    throw Error("H9 verifier changed its complete product subject or exact validation binding");
  if ((productSourceCleanValidationMapping || productSourceCleanValidationReviewMapping) && (report.stage !== "validation"
    || !isDeepStrictEqual(productSourceCleanValidationMapping ?? productSourceCleanValidationReviewMapping,
      recheckImportedCleanValidationVerifierContext(root, context, readProductFile(root, ".artoo/product/research.json"), readProductFile(root, ".artoo/product/design.json")))))
    throw Error("Clean restart verifier changed its complete product subject or exact validation binding");
  if (productSourceDesignReviewMapping && (report.stage !== "design" || !isDeepStrictEqual(productSourceDesignReviewMapping,
    recheckImportedDesignReviewVerifierContext(root, context, readProductFile(root, ".artoo/product/research.json"), readProductFile(root, ".artoo/product/design.json"))))) {
    throw new Error("H4 phase or completed source changed during protected browser execution");
  }
  if (productDesignRevision && (report.stage !== "design" || !isDeepStrictEqual(productDesignRevision,
    inspectProductDesignRevision(context, readProductFile(root, ".artoo/product/research.json"), readProductFile(root, ".artoo/product/design.json"))))) {
    throw new Error("Design revision changed during its protected browser execution");
  }
  console.log(JSON.stringify({ ...report, ...(productSourceMapping ? { product_source_mapping: productSourceMapping } : {}),
    ...(productSourceDesignMapping ? { product_source_design_mapping: productSourceDesignMapping } : {}),
    ...(productSourceDesignReviewMapping ? { product_source_design_review_mapping: productSourceDesignReviewMapping } : {}),
    ...(productSourceExecutionMapping ? { product_source_execution_mapping: productSourceExecutionMapping } : {}),
    ...(productSourceExecutionReviewMapping ? { product_source_execution_review_mapping: productSourceExecutionReviewMapping } : {}),
    ...(productSourceExecutionRepairMapping ? { product_source_execution_repair_mapping: productSourceExecutionRepairMapping } : {}),
    ...(productSourceValidationMapping ? { product_source_validation_mapping: productSourceValidationMapping } : {}),
    ...(productSourceValidationReviewMapping ? { product_source_validation_review_mapping: productSourceValidationReviewMapping } : {}),
    ...(productSourceRecoveryValidationMapping ? { product_source_recovery_validation_mapping: productSourceRecoveryValidationMapping } : {}),
    ...(productSourceRecoveryValidationReviewMapping ? { product_source_recovery_validation_review_mapping: productSourceRecoveryValidationReviewMapping } : {}),
    ...(productSourceCleanValidationMapping ? { product_source_clean_validation_mapping: productSourceCleanValidationMapping } : {}),
    ...(productSourceCleanValidationReviewMapping ? { product_source_clean_validation_review_mapping: productSourceCleanValidationReviewMapping } : {}),
    ...(productDesignRevision ? { product_design_revision: productDesignRevision } : {}) }));
}
void main().catch((error: unknown) => { console.error(formatBrowserFailure(error)); process.exitCode = 1; });
