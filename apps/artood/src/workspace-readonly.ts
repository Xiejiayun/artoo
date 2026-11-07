import { createHash } from "node:crypto";
import { lstatSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute } from "node:path";
import type { ContextPack } from "@artoo/domain";
import type { AgentInstanceConfig } from "@artoo/protocol";
import { assertLocallyPreparedVerificationProfile, subjectManifest, type PreparedVerificationProfile } from "./verification.js";

declare const readOnlyGrantBrand: unique symbol;
export interface WorkspaceReadOnlyGrant { readonly [readOnlyGrantBrand]: true }
export interface WorkspaceReadOnlyBinding {
  /** Accepted local project/workspace identity, after the node's workspace admission. */
  projectId: string;
  workspaceRoot: string;
  /** Synchronous node run-lifetime check; a serialized context cannot supply it. */
  assertCurrent: () => void;
  /** Only the node's selected profile and admitted source version may grant source reads. */
  source?: { profile: PreparedVerificationProfile; subjectDigest: string; importedReviewId?: string };
}
interface BindingState {
  config: AgentInstanceConfig;
  configDigest: string;
  contextDigest: string;
  projectId: string;
  workspaceRoot: string;
  rootStat: Stats;
  assertCurrent: () => void;
  source?: { profile: PreparedVerificationProfile; subjectDigest: string; importedReviewId?: string; manifest: ReturnType<typeof subjectManifest> };
  claimed: boolean;
}
export interface WorkspaceReadOnlySessionAuthority {
  readonly source: boolean;
  assertCurrent(): void;
  assertRead(path: string, checksum?: string, size?: number): void;
  list(path: string): readonly { name: string; kind: "file" | "directory"; size?: number }[];
}
const configs = new WeakMap<AgentInstanceConfig, WorkspaceReadOnlyGrant>();
const boundConfigs = new WeakSet<AgentInstanceConfig>();
const grants = new WeakMap<WorkspaceReadOnlyGrant, BindingState>();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const allowedPath = (path: string) => path === "product" || path.startsWith("product/") || path === ".artoo/product" || path.startsWith(".artoo/product/");
function assertState(state: BindingState): void {
  const result: unknown = state.assertCurrent();
  if (result !== undefined) {
    void Promise.resolve(result).catch(() => {});
    throw new Error("Read-only workspace lifetime must be checked synchronously");
  }
  const config = state.config, payload = config.runStart, context = payload.context_pack.payload;
  const now = lstatSync(state.workspaceRoot);
  if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== state.rootStat.dev || now.ino !== state.rootStat.ino
    || realpathSync.native(state.workspaceRoot) !== state.workspaceRoot || digest(config) !== state.configDigest
    || config.runId !== payload.run_id || config.taskId !== payload.task_id || config.agentInstanceId !== payload.agent_instance_id
    || config.runtime !== payload.runtime || config.workspaceRoot !== state.workspaceRoot || payload.workspace.root !== state.workspaceRoot
    || payload.workspace.branch != null || payload.workspace_allocation !== undefined
    || context?.workspace.root !== state.workspaceRoot || context.project.id !== state.projectId || context.task.id !== config.taskId
    || context.policy.execution_mode !== "discussion" || context.policy.filesystem_write_scope.length !== 0
    || context.product_development !== undefined) throw new Error("Read-only workspace binding changed or is not supported");
  if (state.source) {
    const source = state.source;
    if (source.profile.project_id !== state.projectId || source.profile.workspace_root !== state.workspaceRoot
      || payload.verification?.profile_id !== source.profile.id || payload.verification.expected_subject_digest !== source.subjectDigest
      || (source.importedReviewId
        ? context.review_subject!==undefined||context.imported_review_subject?.review_id!==source.importedReviewId||context.imported_review_subject.subject_digest!==source.subjectDigest
        : context.imported_review_subject!==undefined||context.review_subject?.subject_digest!==source.subjectDigest)
      || subjectManifest(source.profile).digest !== source.subjectDigest) {
      throw new Error("Read-only workspace source differs from the admitted review");
    }
  } else if (context.review_subject || context.imported_review_subject || payload.verification) {
    throw new Error("Read-only review requires a local source binding");
  }
}

/** Local object identity grants only context or pinned source reads; it never grants execution. */
export function bindWorkspaceReadOnlyTools(config: AgentInstanceConfig, binding: WorkspaceReadOnlyBinding): void {
  if (boundConfigs.has(config) || typeof binding.assertCurrent !== "function" || !binding.projectId
    || !isAbsolute(binding.workspaceRoot)) throw new Error("Invalid read-only workspace binding");
  const rootStat = lstatSync(binding.workspaceRoot);
  let source: BindingState["source"];
  if (binding.source) {
    const { profile, subjectDigest } = binding.source;
    assertLocallyPreparedVerificationProfile(profile);
    if (!/^sha256:[a-f0-9]{64}$/.test(subjectDigest)) throw new Error("Invalid read-only source digest");
    const manifest = subjectManifest(profile);
    if (manifest.digest !== subjectDigest) throw new Error("Read-only workspace source differs from the admitted review");
    source = { profile, subjectDigest, manifest, ...(binding.source.importedReviewId ? {importedReviewId:binding.source.importedReviewId} : {}) };
  }
  const state: BindingState = { config, configDigest: digest(config), contextDigest: digest(config.runStart.context_pack.payload),
    projectId: binding.projectId, workspaceRoot: binding.workspaceRoot, rootStat, assertCurrent: binding.assertCurrent, source, claimed: false };
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
