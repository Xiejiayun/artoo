import { performance } from "node:perf_hooks";

const networkCodes = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ABORT_ERR",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "UND_ERR_DESTROYED",
  "UND_ERR_CLOSED",
]);
const ownValue = (value, key) =>
  value !== null && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;

/** Retain transport codes, never exception messages, stacks or request secrets. */
function transportCause(error, depth = 0, seen = new Set()) {
  if (error === null || typeof error !== "object") return { kind: "unknown" };
  if (depth >= 4 || seen.has(error)) return { truncated: true };
  seen.add(error);
  const code = ownValue(error, "code"),
    cause = ownValue(error, "cause"),
    errors = ownValue(error, "errors");
  const result = {
    kind:
      error instanceof AggregateError
        ? "AggregateError"
        : error instanceof TypeError
          ? "TypeError"
          : error instanceof Error
            ? "Error"
            : "unknown",
    code: null,
  };
  if (networkCodes.has(code)) result.code = code;
  if (cause !== undefined) result.cause = transportCause(cause, depth + 1, seen);
  if (Array.isArray(errors)) {
    result.errors = errors.slice(0, 4).map((entry) => transportCause(entry, depth + 1, seen));
    if (errors.length > 4) result.omitted_errors = errors.length - 4;
  }
  return result;
}

/** Observe an existing fixture request once; its result/error and deadline stay owned by the caller. */
export async function observeNativeFixtureRequest(operation, { method, path, signal, failures }) {
  const started = performance.now();
  try {
    return await operation();
  } catch (error) {
    const entry = {
      method,
      route: new URL(path, "http://fixture.invalid").pathname,
      elapsed_ms: performance.now() - started,
      aborted: signal.aborted,
    };
    try {
      entry.transport = transportCause(error);
    } catch {
      entry.transport = { diagnostic_unavailable: true };
    }
    failures.push(entry);
    throw error;
  }
}
