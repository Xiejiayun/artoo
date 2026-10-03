import type { RuntimeRegistration } from "./adapter-registry.js";
import { createProcessAdapter, type ArtifactSpec } from "./process-adapter.js";
import type { ProcessOutputFormat } from "./structured-output.js";

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
  /** Custom commands must explicitly provide their restricted discussion form. */
  discussionCommand?: string[];
  artifacts?: ArtifactSpec[];
  capabilities?: readonly string[];
  /** Local operator opt-in; never read from a server-supplied task policy. */
  trustedExecution?: boolean;
  outputFormat?: ProcessOutputFormat;
  /** Local operator settings, never taken from a task or server profile. */
  codex?: CodexSettings;
}

export interface CodexSettings {
  binaryPath?: string;
  model?: string;
  baseUrl?: string;
  /** Environment variable name only; the credential is never an argument. */
  apiKeyEnv?: string;
}

const DEFAULT_ARTIFACTS: ArtifactSpec[] = [{ type: "patch", path: "changes.patch" }];

const TASK_PROMPT_BASE =
  "Read the file {{context_pack_path}}. If its payload contains conversation, respond to " +
  "conversation.current_request using its message history and the task context; otherwise implement the task. " +
  "Perform only the requested work in this directory, do not access the network, and give an explicit final " +
  "user-facing answer explaining the result. If policy.execution_mode is discussion, only read and reason: " +
  "do not modify files or run commands with side effects; follow the assigned discussion role and requested JSON synthesis format. ";

function taskPrompt(options: RuntimePresetOptions): string {
  return TASK_PROMPT_BASE + (options.artifacts?.length === 0
    ? "Automatic report artifact collection is disabled; fulfill the task's requested files in this directory."
    : "Otherwise create changes.patch when you change files; conversation may have no file changes.");
}

export function codexRuntime(options: RuntimePresetOptions): RuntimeRegistration {
  const prompt = taskPrompt(options);
  const local = options.codex;
  const settings: string[] = [];
  if (local?.model) settings.push("-c", `model=${JSON.stringify(local.model)}`);
  if (local?.baseUrl) {
    settings.push("-c", 'model_provider="artoo_desktop"',
      "-c", 'model_providers.artoo_desktop.name="Artoo Responses API"',
      "-c", `model_providers.artoo_desktop.base_url=${JSON.stringify(local.baseUrl)}`,
      "-c", 'model_providers.artoo_desktop.wire_api="responses"',
      "-c", 'model_providers.artoo_desktop.requires_openai_auth=false');
    if (local.apiKeyEnv) settings.push("-c", `model_providers.artoo_desktop.env_key=${JSON.stringify(local.apiKeyEnv)}`);
  }
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
        local?.binaryPath ?? "codex",
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--ephemeral",
        "-s",
        "workspace-write",
        "-C",
        "{{workspace_root}}",
        ...settings,
        prompt,
      ],
      allowedRoots: options.allowedRoots,
      discussionCommand: options.discussionCommand ?? (options.command ? undefined : [
        local?.binaryPath ?? "codex", "exec", "--json", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-C", "{{workspace_root}}", ...settings, prompt,
      ]),
      outputFormat: options.outputFormat ?? (options.command ? "plain" : "codex-json"),
      artifacts: options.artifacts ?? DEFAULT_ARTIFACTS,
    }),
  };
}

export function claudeCodeRuntime(options: RuntimePresetOptions): RuntimeRegistration {
  const prompt = taskPrompt(options);
  return {
    runtime: "claude-code",
    capabilities: options.capabilities ?? ["code.read", "code.modify", "code.review"],
    adapter: createProcessAdapter({
      runtimeId: "claude-code",
      // claude runs in the adapter-set cwd (= workspace root); -p is non-interactive,
      // Unattended runs fail closed on permission prompts by default. Full
      // bypass requires an explicit trusted-node operator opt-in.
      command: options.command ?? [
        "claude",
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        options.trustedExecution === true ? "bypassPermissions" : "dontAsk",
      ],
      allowedRoots: options.allowedRoots,
      discussionCommand: options.discussionCommand ?? (options.command ? undefined : [
        "claude", "-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk",
        "--tools", "Read,Glob,Grep", "--disallowedTools", "mcp__*", "--disable-slash-commands",
      ]),
      outputFormat: options.outputFormat ?? (options.command ? "plain" : "claude-json"),
      artifacts: options.artifacts ?? DEFAULT_ARTIFACTS,
    }),
  };
}
