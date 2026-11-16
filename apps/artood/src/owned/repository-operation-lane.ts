import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { gitOperation, type GitReadOptions } from "./git-operations.js";
import { OwnedGitError } from "./owned-git.js";

interface Lane { tail: Promise<void>; waiting: number; retained?: Error }
// Every runner in this daemon shares the actual Git common-directory lane.
// Model execution stays concurrent after the short metadata operation ends.
const lanes = new Map<string, Lane>();
const error = (cause: unknown) => cause instanceof Error ? cause : new Error("Repository operation failed");
function uncertainGit(cause: unknown): boolean {
  const pending = [cause], seen = new Set<unknown>();
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (item instanceof OwnedGitError && (!item.receipt.cleanupConfirmed || !item.receipt.observersDisposed)) return true;
    pending.push((item as { cause?: unknown }).cause);
    if (item instanceof AggregateError) pending.push(...item.errors);
  }
  return false;
}
function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return previous;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    void previous.then(() => { signal.removeEventListener("abort", abort); resolve(); }, (cause) => { signal.removeEventListener("abort", abort); reject(cause); });
  });
}

/** Serializes local worktree/cache/ref mutations by physical repository identity.
 * A cancelled waiter cannot release its predecessor's lane. Unknown subprocess
 * closure fences this common directory for the rest of the daemon lifetime. */
export async function withRepositoryOperation<T>(input: {
  sourceRepo: string; options: GitReadOptions; assertStartCurrent?: () => void;
}, operation: () => Promise<T>): Promise<T> {
  const { sourceRepo, options, assertStartCurrent } = input;
  assertStartCurrent?.(); options.signal?.throwIfAborted();
  const observed = await gitOperation(sourceRepo, ["rev-parse", "--path-format=absolute", "--git-common-dir"], options);
  assertStartCurrent?.(); options.signal?.throwIfAborted();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(observed.stdout);
  if (observed.status !== 0 || !text.endsWith("\n") || !isAbsolute(text.slice(0, -1)) || /[\u0000-\u001f\u007f]/u.test(text.slice(0, -1)))
    throw new Error("Cannot establish the repository's physical common directory");
  const commonDirectory = realpathSync.native(text.slice(0, -1));
  const identity = lstatSync(commonDirectory, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error("Repository common directory is not a plain physical directory");
  const key = `${identity.dev}:${identity.ino}`;
  const lane: Lane = lanes.get(key) ?? { tail: Promise.resolve(), waiting: 0 };
  if (lane.retained) throw new Error("Repository subprocess closure remains uncertain; metadata owner retained", { cause: lane.retained });
  if (lane.waiting >= 64) throw new Error("Repository operation queue is full");
  lanes.set(key, lane);
  const previous = lane.tail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  lane.tail = tail; lane.waiting += 1;
  try {
    await waitForTurn(previous, options.signal);
    if (lane.retained) throw new Error("Repository subprocess closure remains uncertain; metadata owner retained", { cause: lane.retained });
    assertStartCurrent?.(); options.signal?.throwIfAborted();
    const current = lstatSync(commonDirectory, { bigint: true });
    if (realpathSync.native(text.slice(0, -1)) !== commonDirectory || current.dev !== identity.dev || current.ino !== identity.ino)
      throw new Error("Repository common directory changed while queued");
    return await operation();
  } catch (cause) {
    if (uncertainGit(cause)) lane.retained ??= error(cause);
    throw cause;
  } finally {
    lane.waiting -= 1; release();
    void tail.then(() => {
      // Wait until the predecessor really ends before deleting a cancelled
      // waiter's entry, otherwise a newcomer could overtake the live owner.
      if (!lane.retained && lane.waiting === 0 && lane.tail === tail) lanes.delete(key);
    });
  }
}
