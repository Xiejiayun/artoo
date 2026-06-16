import { z } from "zod";

/** True iff `value` is a ws:/wss: URL with no userinfo and no query string. */
function isCleanWsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.search !== "") return false;
  return true;
}

/**
 * Strip any userinfo/query/hash from a URL so a misconfigured value can never
 * leak a token or credentials through a printable summary. Unparseable input
 * yields "" rather than echoing the raw string.
 */
function sanitizeBaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}


/**
 * Config model for the local-node control plane (#29 v2-D slice 2). Pure — no IO.
 * A desktop client persists {@link SupervisorSettings}, validates them (a missing
 * node credential is a START-BLOCKING error), and maps them to the #23 artood
 * bootstrap env. The device-bound node credential is injected ONLY into
 * `ARTOO_NODE_URL` (the single node-credential seam); it is never placed in the
 * printable {@link summarizeSettings} status object, logs, or error messages.
 */
export const SupervisorSettingsSchema = z.object({
  /**
   * Base node WS URL WITHOUT a token, e.g. `ws://host:4000/api/v1/node`. Must be
   * `ws:`/`wss:` with NO userinfo and NO query string — the credential is added
   * separately into the env, and a token/userinfo here would leak through the
   * printable summary.
   */
  serverNodeUrl: z.string().refine((value) => isCleanWsUrl(value), {
    message: "must be a ws:// or wss:// URL with no userinfo and no query string"
  }),
  /** Computer/node id sent in node.hello. */
  nodeId: z.string().trim().min(1),
  /**
   * Device-bound node credential (#28). SECRET: only ever flows into
   * `ARTOO_NODE_URL`'s token; never logged/summarized/echoed in errors. Not
   * trimmed (preserve exact spelling), but a blank/whitespace-only value is
   * rejected.
   */
  nodeCredential: z.string().refine((value) => value.trim().length > 0, {
    message: "must not be blank"
  }),
  /** Runtime preset names to register (e.g. ["codex","claude-code"]). */
  runtimes: z.array(z.string().trim().min(1)).default([]),
  /** Filesystem roots the adapters may operate in (required, ≥1, non-blank). */
  allowedRoots: z.array(z.string().trim().min(1)).min(1),
  /** Optional git repo for per-run worktrees (#23). */
  worktreeBaseRepo: z.string().trim().min(1).optional()
});

export type SupervisorSettings = z.infer<typeof SupervisorSettingsSchema>;

export type SettingsValidation =
  | { ok: true; settings: SupervisorSettings }
  | { ok: false; errors: string[] };

/**
 * Validate raw settings. On failure returns field-identifying error strings
 * (`<path>: <message>`) that NEVER include the offending values — so a bad/missing
 * `nodeCredential` is reported by field name only, not by echoing the token.
 */
export function validateSettings(raw: unknown): SettingsValidation {
  const parsed = SupervisorSettingsSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, settings: parsed.data };
  }
  const errors = parsed.error.issues.map(
    (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`
  );
  return { ok: false, errors };
}

/**
 * Map validated settings to the #23 artood bootstrap env. The node credential is
 * injected as `ARTOO_NODE_URL`'s `token` query param (the only place it appears).
 */
export function toBootstrapEnv(settings: SupervisorSettings): Record<string, string> {
  const url = new URL(settings.serverNodeUrl);
  url.searchParams.set("token", settings.nodeCredential);
  const env: Record<string, string> = {
    ARTOO_NODE_URL: url.toString(),
    ARTOO_NODE_ID: settings.nodeId,
    ARTOO_ALLOWED_ROOTS: settings.allowedRoots.join(";")
  };
  if (settings.runtimes.length > 0) {
    env.ARTOO_RUNTIMES = settings.runtimes.join(",");
  }
  if (settings.worktreeBaseRepo !== undefined) {
    env.ARTOO_WORKTREE_BASE_REPO = settings.worktreeBaseRepo;
  }
  return env;
}

/**
 * Printable, credential-free view for UI/status/persisted snapshots. Carries the
 * base URL (no token) and only a boolean for whether a credential is configured —
 * never the credential value itself.
 */
export interface SettingsSummary {
  serverNodeUrl: string;
  nodeId: string;
  runtimes: string[];
  allowedRoots: string[];
  worktreeBaseRepo: string | null;
  nodeCredentialConfigured: boolean;
}

export function summarizeSettings(settings: SupervisorSettings): SettingsSummary {
  return {
    serverNodeUrl: sanitizeBaseUrl(settings.serverNodeUrl),
    nodeId: settings.nodeId,
    runtimes: settings.runtimes,
    allowedRoots: settings.allowedRoots,
    worktreeBaseRepo: settings.worktreeBaseRepo ?? null,
    nodeCredentialConfigured: settings.nodeCredential.length > 0
  };
}
