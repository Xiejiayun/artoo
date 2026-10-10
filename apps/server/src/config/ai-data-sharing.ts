import { createHash } from "node:crypto";
import { isIP } from "node:net";

export interface AiProviderDisclosure {
  readonly id: string;
  readonly name: string;
  readonly privacy_url: string;
}

export interface AiDataSharingPolicy {
  readonly version: string;
  readonly mode: "local" | "external";
  readonly providers: readonly AiProviderDisclosure[];
  readonly data_categories: readonly string[];
  readonly purpose: string;
}

const dataCategories = Object.freeze([
  "prompts_and_messages", "task_and_goal_context", "workspace_files",
  "execution_results", "account_and_workspace_identifiers",
]);

function invalid(reason: string): never {
  // Never include submitted configuration: an operator may have pasted a key.
  throw new Error(`ARTOO_AI_DATA_SHARING_POLICY ${reason}`);
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    invalid(`requires exactly these public fields: ${keys.join(", ")}`);
  }
  return value as Record<string, unknown>;
}

function providerDisclosure(value: unknown): AiProviderDisclosure {
  const item = object(value, ["id", "name", "privacy_url"]);
  if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id)) invalid("requires a stable lowercase provider ID");
  if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 100 || /[\u0000-\u001f\u007f]/.test(item.name)) invalid("requires a readable provider name");
  if (typeof item.privacy_url !== "string" || item.privacy_url.length > 2048) invalid("requires a public HTTPS privacy URL");
  let url: URL;
  try { url = new URL(item.privacy_url); }
  catch { return invalid("requires a valid privacy URL"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || !host.includes(".")
    || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host.startsWith("[") || isIP(host)) invalid("requires a public HTTPS privacy URL without credentials or query parameters");
  return Object.freeze({ id: item.id, name: item.name.trim(), privacy_url: url.href });
}

/** Missing disclosure is not a claim that an executor only processes locally. */
export function loadAiDataSharingPolicy(env: NodeJS.ProcessEnv): AiDataSharingPolicy | null {
  const value = env.ARTOO_AI_DATA_SHARING_POLICY;
  if (value === undefined || value.trim() === "") return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { return invalid("must contain valid JSON public metadata"); }
  return buildAiDataSharingPolicy(parsed);
}

export function buildAiDataSharingPolicy(value: unknown): AiDataSharingPolicy {
  const input = object(value, ["mode", "providers"]);
  if (input.mode !== "local" && input.mode !== "external") invalid("mode must be local or external");
  if (!Array.isArray(input.providers) || input.providers.length > 16) invalid("providers must be a list of at most sixteen recipients");
  if ((input.mode === "local" && input.providers.length !== 0)
    || (input.mode === "external" && input.providers.length === 0)) invalid("external mode needs named recipients; local mode cannot name an external recipient");
  const providers = input.providers.map(providerDisclosure).sort((a, b) => a.id.localeCompare(b.id, "en"));
  if (new Set(providers.map((item) => item.id)).size !== providers.length) invalid("provider IDs must be unique");
  const disclosure: Omit<AiDataSharingPolicy, "version"> = {
    mode: input.mode, providers: Object.freeze(providers), data_categories: dataCategories,
    purpose: "Generate responses and carry out the agent work you request.",
  };
  const version = "sha256:" + createHash("sha256").update(JSON.stringify({ format: 1, ...disclosure })).digest("hex");
  return Object.freeze({ version, ...disclosure });
}
