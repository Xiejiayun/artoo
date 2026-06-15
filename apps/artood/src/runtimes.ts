import type { RuntimeRegistration } from "./adapter-registry.js";
import { createProcessAdapter, type ArtifactSpec } from "./process-adapter.js";

/**
 * Runtime presets: ready-to-register {@link RuntimeRegistration}s for the
 * supported coding-agent CLIs, each pairing the generic {@link createProcessAdapter}
 * with that CLI's command template + capability tags. The node registers these so
 * `run.start.runtime` can select between them.
 *
 * The `command` is overridable: tests inject a deterministic fixture, and ops can
 * pin a binary path. Defaults target verified CLI versions (codex 0.139.0,
 * claude-code 2.1.177); `{{workspace_root}}` / `{{context_pack_path}}` are
 * substituted by the adapter.
 */
export interface RuntimePresetOptions {
  allowedRoots: string[];
  /** Override the spawn command (defaults to the CLI below). */
  command?: string[];
  artifacts?: ArtifactSpec[];
  capabilities?: readonly string[];
}

const DEFAULT_ARTIFACTS: ArtifactSpec[] = [{ type: "patch", path: "changes.patch" }];

const TASK_PROMPT =
  "Read the file {{context_pack_path}}. Implement the task in this directory only, " +
  "do not access the network, create changes.patch as the run artifact, then finish.";

export function codexRuntime(options: RuntimePresetOptions): RuntimeRegistration {
  return {
    runtime: "codex",
    capabilities: options.capabilities ?? ["code.read", "code.modify"],
    adapter: createProcessAdapter({
      runtimeId: "codex",
      // `codex exec` is already the non-interactive entrypoint: `-s workspace-write`
      // is its only approval/sandbox control (verified v0.139.0). There is NO
      // `--ask-for-approval` flag on `exec` — passing it aborts with exit 2
      // ("unexpected argument"), so non-interactiveness comes from `-s` alone.
      command: options.command ?? [
        "codex",
        "exec",
        "--skip-git-repo-check",
        "--ephemeral",
        "-s",
        "workspace-write",
        "-C",
        "{{workspace_root}}",
        TASK_PROMPT,
      ],
      allowedRoots: options.allowedRoots,
      artifacts: options.artifacts ?? DEFAULT_ARTIFACTS,
    }),
  };
}

export function claudeCodeRuntime(options: RuntimePresetOptions): RuntimeRegistration {
  return {
    runtime: "claude-code",
    capabilities: options.capabilities ?? ["code.read", "code.modify", "code.review"],
    adapter: createProcessAdapter({
      runtimeId: "claude-code",
      // claude runs in the adapter-set cwd (= workspace root); -p is non-interactive,
      // bypassPermissions lets it write the artifact without prompting.
      command: options.command ?? [
        "claude",
        "-p",
        TASK_PROMPT,
        "--permission-mode",
        "bypassPermissions",
      ],
      allowedRoots: options.allowedRoots,
      artifacts: options.artifacts ?? DEFAULT_ARTIFACTS,
    }),
  };
}
