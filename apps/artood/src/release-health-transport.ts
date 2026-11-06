import { performance } from "node:perf_hooks";

function assertDeadline(signal: AbortSignal, deadline: number): void {
  signal.throwIfAborted();
  if (performance.now() >= deadline) throw new DOMException("Release health deadline exceeded", "TimeoutError");
}

/** Only health GETs may retry a stale connection, once, before receiving a Response. */
export async function fetchReleaseHealthGet(url: URL, signal: AbortSignal, deadline: number): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    assertDeadline(signal, deadline);
    let response: Response;
    try {
      response = await fetch(url, { method: "GET", redirect: "error", cache: "no-store", signal });
    } catch (error) {
      const cause = error instanceof TypeError ? error.cause : undefined;
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      // Reusing the original signal and monotonic deadline cannot grant a second timeout budget.
      // HTTP errors, body failures, cancellations and all other transport failures are not retried.
      if (attempt !== 0 || signal.aborted || performance.now() >= deadline
        || code !== "ECONNRESET" && code !== "UND_ERR_SOCKET") throw error;
      continue;
    }
    assertDeadline(signal, deadline);
    return response;
  }
}
