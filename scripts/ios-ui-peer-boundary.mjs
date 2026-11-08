import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export function remainingPeerBudget(deadline, now = performance.now.bind(performance)) {
  assert.ok(Number.isFinite(deadline), "The original native parent deadline is required");
  const remaining = Math.ceil(deadline - now());
  assert.ok(remaining > 0, "Native peer boundary exceeded the original parent deadline");
  return remaining;
}

/** Read-only synchronization with the native sender, not a substitute for the
 * subsequent Web UI assertion. Waiting for native UI actions consumes the same
 * original parent budget; it must not start a shorter Web delivery timer. */
export async function waitForNativeThreadReply({ readMessages, rootId, body, deadline, signal,
  now = performance.now.bind(performance), wait = delay }) {
  assert.ok(typeof rootId === "string" && rootId.length > 0 && typeof body === "string" && body.length > 0);
  const expired = new AbortController();
  const timer = setTimeout(() => expired.abort(new Error("Native peer boundary exceeded the original parent deadline")),
    remainingPeerBudget(deadline, now));
  timer.unref();
  const cancellation = AbortSignal.any([signal, expired.signal]);
  try {
    for (;;) {
      cancellation.throwIfAborted();
      remainingPeerBudget(deadline, now);
      const { messages } = await readMessages(cancellation);
      cancellation.throwIfAborted();
      remainingPeerBudget(deadline, now);
      assert.ok(Array.isArray(messages), "Native thread response must contain messages");
      const matches = messages.filter(message => message?.body === body);
      assert.ok(matches.length <= 1, "Native reply must be persisted exactly once");
      if (matches.length) {
        const reply = matches[0];
        assert.ok(reply.thread_root_id === rootId && typeof reply.id === "string" && reply.id.length > 0,
          "Native reply must belong to the observed root");
        return reply.id;
      }
      await wait(Math.min(150, remainingPeerBudget(deadline, now)), undefined, { signal: cancellation });
    }
  } finally { clearTimeout(timer); }
}
