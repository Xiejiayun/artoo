import { createHash } from "node:crypto";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { ImportedValidationBaselineV1Schema, type ImportedValidationBaselineV1, type ContextPack } from "@artoo/domain";
import type { AgentInstanceConfig } from "@artoo/protocol";
import { assertLocallyPreparedVerificationProfile, subjectManifest, type PreparedVerificationProfile } from "./verification.js";

declare const readOnlyGrantBrand: unique symbol;
export interface WorkspaceReadOnlyGrant { readonly [readOnlyGrantBrand]: true }
export interface WorkspaceReadOnlyEvidenceIndexV1 {
  readonly version: 1;
  readonly bundles: readonly { readonly reference: string; readonly request_id: string; readonly check_id: string; readonly scope: "final" }[];
  readonly baseline?: ImportedValidationBaselineV1;
}
export interface WorkspaceReadOnlyBinding {
  /** Accepted local project/workspace identity, after the node's workspace admission. */
  projectId: string;
  workspaceRoot: string;
  /** Synchronous node run-lifetime check; a serialized context cannot supply it. */
  assertCurrent: () => void;
  /** Node-bound reference discovery only; reading bytes still requires the separate evidence reader. */
  readEvidenceIndex?: () => WorkspaceReadOnlyEvidenceIndexV1;
  /** Only the node's selected profile and admitted source version may grant source reads. */
  source?: { profile: PreparedVerificationProfile; subjectDigest: string; importedReviewId?: string; importedDesignReviewId?: string; importedExecutionReviewId?: string; importedValidationReviewId?: string; importedRecoveryValidationReviewId?: string; importedCleanValidationReviewId?: string };
}
interface BindingState {
  config: AgentInstanceConfig;
  configDigest: string;
  contextDigest: string;
  projectId: string;
  workspaceRoot: string;
  rootStat: Stats;
  assertCurrent: () => void;
  readEvidenceIndex?: () => WorkspaceReadOnlyEvidenceIndexV1;
  evidenceIndexDigest?: string;
  source?: { profile: PreparedVerificationProfile; subjectDigest: string; importedReviewId?: string; importedDesignReviewId?: string; importedExecutionReviewId?: string; importedValidationReviewId?: string; importedRecoveryValidationReviewId?: string; importedCleanValidationReviewId?: string; manifest: ReturnType<typeof subjectManifest> };
  claimed: boolean;
}
export interface WorkspaceReadOnlySessionAuthority {
  readonly source: boolean;
  assertCurrent(): void;
  readEvidenceIndex?(): WorkspaceReadOnlyEvidenceIndexV1;
  assertRead(path: string, checksum?: string, size?: number): void;
  list(path: string): readonly { name: string; kind: "file" | "directory"; size?: number }[];
}
const configs = new WeakMap<AgentInstanceConfig, WorkspaceReadOnlyGrant>();
const boundConfigs = new WeakSet<AgentInstanceConfig>();
const grants = new WeakMap<WorkspaceReadOnlyGrant, BindingState>();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const allowedPath = (path: string) => path === "product" || path.startsWith("product/") || path === ".artoo/product" || path.startsWith(".artoo/product/");
const evidenceIndexSchema = z.object({ version: z.literal(1), bundles: z.array(z.object({
  reference: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/), request_id: z.string().min(1).max(128),
  check_id: z.string().min(1).max(128), scope: z.literal("final"),
}).strict()).min(1).max(64), baseline: ImportedValidationBaselineV1Schema.optional() }).strict();
const readIndex = (read: () => WorkspaceReadOnlyEvidenceIndexV1) => evidenceIndexSchema.parse(read());
function assertState(state: BindingState): void {
  const result: unknown = state.assertCurrent();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new Error("Read-only workspace lifetime must be checked synchronously");
  }
  if (state.readEvidenceIndex && digest(readIndex(state.readEvidenceIndex)) !== state.evidenceIndexDigest) throw new Error("Read-only evidence index changed");
  const config = state.config, payload = config.runStart, context = payload.context_pack.payload;
  const now = lstatSync(state.workspaceRoot);
  if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== state.rootStat.dev || now.ino !== state.rootStat.ino
    || realpathSync.native(state.workspaceRoot) !== state.workspaceRoot || digest(config) !== state.configDigest
    || config.runId !== payload.run_id || config.taskId !== payload.task_id || config.agentInstanceId !== payload.agent_instance_id
    || config.runtime !== payload.runtime || config.workspaceRoot !== state.workspaceRoot || payload.workspace.root !== state.workspaceRoot
    || payload.workspace.branch != null || payload.workspace_allocation !== undefined
    || context?.workspace.root !== state.workspaceRoot || context.project.id !== state.projectId || context.task.id !== config.taskId
    || context.policy.execution_mode !== "discussion" || context.policy.filesystem_write_scope.length !== 0
    || context.product_development !== undefined || context.imported_execution !== undefined || context.imported_execution_repair !== undefined
    || context.imported_validation !== undefined || context.imported_recovery_validation !== undefined || context.imported_clean_validation !== undefined) throw new Error("Read-only workspace binding changed or is not supported");
  if (state.source) {
    const source = state.source;
    if (source.importedCleanValidationReviewId !== undefined) {
      const subject = context.imported_clean_validation_review_subject;
      if (source.importedReviewId || source.importedDesignReviewId || source.importedExecutionReviewId || source.importedValidationReviewId
        || source.importedRecoveryValidationReviewId || context.review_subject || context.imported_review_subject
        || context.imported_design_review_subject || context.imported_execution_review_subject || context.imported_validation_review_subject
        || context.imported_recovery_validation_review_subject || context.product_design_revision || !context.transferred_product_input
        || subject?.review_id !== source.importedCleanValidationReviewId || subject.subject_digest !== source.subjectDigest
        || !state.readEvidenceIndex || readIndex(state.readEvidenceIndex).baseline?.manifest_digest !== subject.baseline_digest
        || source.profile.project_id !== state.projectId || source.profile.workspace_root !== state.workspaceRoot
        || payload.verification?.profile_id !== source.profile.id || payload.verification.expected_subject_digest !== source.subjectDigest
        || subjectManifest(source.profile).digest !== source.subjectDigest)
        throw Error("Read-only clean review differs from its original fresh author and complete source");
      return;
    }
    if (context.imported_clean_validation_review_subject) throw Error("Clean review requires its own original read-only source binding");
    if (source.importedRecoveryValidationReviewId !== undefined) {
      const subject = context.imported_recovery_validation_review_subject;
      if (source.importedReviewId || source.importedDesignReviewId || source.importedExecutionReviewId || source.importedValidationReviewId
        || context.review_subject || context.imported_review_subject || context.imported_design_review_subject || context.imported_execution_review_subject
        || context.imported_validation_review_subject || context.product_design_revision || !context.transferred_product_input
        || subject?.review_id !== source.importedRecoveryValidationReviewId || subject.subject_digest !== source.subjectDigest
        || !state.readEvidenceIndex || readIndex(state.readEvidenceIndex).baseline?.manifest_digest !== subject.baseline_digest
        || source.profile.project_id !== state.projectId || source.profile.workspace_root !== state.workspaceRoot
        || payload.verification?.profile_id !== source.profile.id || payload.verification.expected_subject_digest !== source.subjectDigest
        || subjectManifest(source.profile).digest !== source.subjectDigest)
        throw Error("Read-only recovery review differs from its current original author and complete source");
      return;
    }
    if (context.imported_recovery_validation_review_subject) throw Error("Recovery review requires its own original read-only source binding");
    if (source.profile.project_id !== state.projectId || source.profile.workspace_root !== state.workspaceRoot
      || payload.verification?.profile_id !== source.profile.id || payload.verification.expected_subject_digest !== source.subjectDigest
      || (source.importedValidationReviewId
        ? source.importedReviewId !== undefined || source.importedDesignReviewId !== undefined || source.importedExecutionReviewId !== undefined
          || context.review_subject !== undefined || context.imported_review_subject !== undefined || context.imported_design_review_subject !== undefined
          || context.imported_execution_review_subject !== undefined || !context.transferred_product_input || context.product_design_revision !== undefined
          || context.imported_validation_review_subject?.review_id !== source.importedValidationReviewId
          || context.imported_validation_review_subject.subject_digest !== source.subjectDigest
          || !state.readEvidenceIndex || readIndex(state.readEvidenceIndex).baseline?.manifest_digest !== context.imported_validation_review_subject.baseline_digest
        : context.imported_validation_review_subject !== undefined || (source.importedExecutionReviewId
        ? source.importedReviewId !== undefined || source.importedDesignReviewId !== undefined || context.review_subject !== undefined
          || context.imported_review_subject !== undefined || context.imported_design_review_subject !== undefined
          || context.imported_execution_review_subject?.review_id !== source.importedExecutionReviewId
          || context.imported_execution_review_subject.subject_digest !== source.subjectDigest
          || !context.transferred_product_input || context.product_design_revision !== undefined
        : context.imported_execution_review_subject !== undefined || (source.importedDesignReviewId
        ? source.importedReviewId !== undefined || context.review_subject !== undefined || context.imported_review_subject !== undefined
          || context.imported_design_review_subject?.review_id !== source.importedDesignReviewId || context.imported_design_review_subject.subject_digest !== source.subjectDigest
          || !context.transferred_product_input || context.product_design_revision !== undefined
        : source.importedReviewId
          ? context.imported_design_review_subject !== undefined || context.review_subject!==undefined||context.imported_review_subject?.review_id!==source.importedReviewId||context.imported_review_subject.subject_digest!==source.subjectDigest
          : context.imported_design_review_subject !== undefined || context.imported_review_subject!==undefined||context.review_subject?.subject_digest!==source.subjectDigest)))
      || subjectManifest(source.profile).digest !== source.subjectDigest) {
      throw new Error("Read-only workspace source differs from the admitted review");
    }
  } else if (context.review_subject || context.imported_review_subject || context.imported_design_review_subject || context.imported_execution_review_subject || context.imported_validation_review_subject || context.imported_recovery_validation_review_subject || context.imported_clean_validation_review_subject || payload.verification) {
    throw new Error("Read-only review requires a local source binding");
  }
}

/** Local object identity grants only context or pinned source reads; it never grants execution. */
export function bindWorkspaceReadOnlyTools(config: AgentInstanceConfig, binding: WorkspaceReadOnlyBinding): void {
  if (boundConfigs.has(config) || typeof binding.assertCurrent !== "function" || !binding.projectId
    || !isAbsolute(binding.workspaceRoot) || binding.readEvidenceIndex !== undefined && typeof binding.readEvidenceIndex !== "function") throw new Error("Invalid read-only workspace binding");
  const rootStat = lstatSync(binding.workspaceRoot);
  let source: BindingState["source"];
  if (binding.source) {
    const { profile, subjectDigest } = binding.source;
    assertLocallyPreparedVerificationProfile(profile);
    if (!/^sha256:[a-f0-9]{64}$/.test(subjectDigest)) throw new Error("Invalid read-only source digest");
    const manifest = subjectManifest(profile);
    if (manifest.digest !== subjectDigest) throw new Error("Read-only workspace source differs from the admitted review");
    source = { profile, subjectDigest, manifest, ...(binding.source.importedReviewId ? {importedReviewId:binding.source.importedReviewId} : {}),
      ...(binding.source.importedDesignReviewId ? { importedDesignReviewId: binding.source.importedDesignReviewId } : {}),
      ...(binding.source.importedExecutionReviewId ? { importedExecutionReviewId: binding.source.importedExecutionReviewId } : {}),
      ...(binding.source.importedValidationReviewId ? { importedValidationReviewId: binding.source.importedValidationReviewId } : {}),
      ...(binding.source.importedCleanValidationReviewId ? { importedCleanValidationReviewId: binding.source.importedCleanValidationReviewId } : {}),
      ...(binding.source.importedRecoveryValidationReviewId ? { importedRecoveryValidationReviewId: binding.source.importedRecoveryValidationReviewId } : {}) };
  }
  const state: BindingState = { config, configDigest: digest(config), contextDigest: digest(config.runStart.context_pack.payload),
    projectId: binding.projectId, workspaceRoot: binding.workspaceRoot, rootStat, assertCurrent: binding.assertCurrent, source, claimed: false,
    ...(binding.readEvidenceIndex ? { readEvidenceIndex: binding.readEvidenceIndex, evidenceIndexDigest: digest(readIndex(binding.readEvidenceIndex)) } : {}) };
  assertState(state);
  const grant = Object.freeze({}) as WorkspaceReadOnlyGrant;
  boundConfigs.add(config); configs.set(config, grant); grants.set(grant, state);
}
export function takeWorkspaceReadOnlyTools(config: AgentInstanceConfig): WorkspaceReadOnlyGrant | undefined {
  const grant = configs.get(config); configs.delete(config);
  if (grant) assertState(grants.get(grant)!);
  return grant;
}

/** Called by the broker once; cloned or serialized grants carry no authority. */
export function claimWorkspaceReadOnlyTools(grant: WorkspaceReadOnlyGrant, root: string, context: ContextPack): WorkspaceReadOnlySessionAuthority {
  const state = grants.get(grant);
  if (!state || state.claimed || root !== state.workspaceRoot || digest(context) !== state.contextDigest) throw new Error("A fresh local read-only workspace grant is required");
  state.claimed = true;
  assertState(state);
  // An individual subject file also grants listing its ancestors, never unrelated siblings.
  const files = new Map([...(state.source?.manifest.files ?? [])].filter(([path]) => allowedPath(path)));
  const directories = new Set((state.source?.manifest.directories ?? []).filter(allowedPath));
  for (const path of [...files.keys(), ...directories]) {
    let parent = path.slice(0, path.lastIndexOf("/"));
    while (allowedPath(parent)) { directories.add(parent); parent = parent.slice(0, parent.lastIndexOf("/")); }
  }
  return Object.freeze({ source: !!state.source, assertCurrent: () => assertState(state),
    ...(state.readEvidenceIndex ? { readEvidenceIndex: () => { assertState(state); return readIndex(state.readEvidenceIndex!); } } : {}),
    assertRead(path: string, checksum?: string, size?: number) {
      const file = files.get(path);
      if (!file || checksum !== undefined && checksum !== file.checksum || size !== undefined && size !== file.size) {
        throw new Error("File is outside the pinned read-only source or its content changed");
      }
    },
    list(path: string) {
      if (!directories.has(path)) throw new Error("Directory is outside the pinned read-only source");
      const prefix = `${path}/`;
      const entries: { name: string; kind: "file" | "directory"; size?: number }[] = [];
      for (const directory of directories) if (directory.startsWith(prefix) && !directory.slice(prefix.length).includes("/")) {
        entries.push({ name: directory.slice(prefix.length), kind: "directory" });
      }
      for (const [file, fact] of files) if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/")) {
        entries.push({ name: file.slice(prefix.length), kind: "file", size: fact.size });
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name));
    },
  });
}
