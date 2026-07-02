import {
  GoalAuditBundleSchema,
  TaskAuditBundleSchema,
  type GoalAuditBundle,
  type TaskAuditBundle,
} from "@artoo/domain";

const REDACTED_SECRET = "<redacted:secret>";

const ENV_SECRET_ASSIGNMENT =
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY|REFRESH_TOKEN|CREDENTIAL)[A-Z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/g;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const AGENT_TOKEN = /\bsk_(agent|machine|device|session)_[A-Za-z0-9_-]+/g;
const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{16,}/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9_]{20,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

export function isSensitiveFieldName(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-\s]/g, "_");
  if (normalized === "idempotency_key") return false;
  return (
    normalized === "authorization" ||
    normalized === "auth" ||
    normalized === "token" ||
    normalized.endsWith("_token") ||
    normalized.includes("access_token") ||
    normalized.includes("refresh_token") ||
    normalized.includes("api_key") ||
    normalized.includes("private_key") ||
    normalized.includes("password") ||
    normalized.includes("secret") ||
    normalized.includes("credential")
  );
}

export function redactSecretText(text: string): string {
  return text
    .replace(ENV_SECRET_ASSIGNMENT, (_match, name: string) => `${name}=${REDACTED_SECRET}`)
    .replace(BEARER_TOKEN, `Bearer ${REDACTED_SECRET}`)
    .replace(AGENT_TOKEN, (_match, kind: string) => `sk_${kind}_${REDACTED_SECRET}`)
    .replace(OPENAI_STYLE_KEY, `sk-${REDACTED_SECRET}`)
    .replace(GITHUB_TOKEN, (match) => `${match.slice(0, 4)}${REDACTED_SECRET}`)
    .replace(JWT, `<redacted:jwt>`);
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecretText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item));
  }
  if (value !== null && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      redacted[key] = isSensitiveFieldName(key) ? REDACTED_SECRET : redactUnknown(nested);
    }
    return redacted;
  }
  return value;
}

export function redactTaskAuditBundle(bundle: TaskAuditBundle): TaskAuditBundle {
  return TaskAuditBundleSchema.parse(redactUnknown(bundle));
}

export function redactGoalAuditBundle(bundle: GoalAuditBundle): GoalAuditBundle {
  return GoalAuditBundleSchema.parse(redactUnknown(bundle));
}
