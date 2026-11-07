import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { TestContext } from "vitest";

type Closeable = { close(): Promise<void> };
type Resource = { closed: boolean; closing?: Promise<void> };
type Outcome = { status: "fulfilled" } | { status: "rejected"; error: unknown };
export interface PreviewStorageScope {
  temporary(): Promise<string>;
  checkpoint(): void;
  own<T extends Closeable>(resource: T): T;
  close(resource: Closeable): Promise<void>;
  /** Rejected acquisition/maintenance calls do not expose their cleanup handle. */
  maintenance<T>(operation: Promise<T>): Promise<T>;
  expectedRejection<T>(operation: Promise<T>, assertion: (operation: Promise<T>) => Promise<unknown>): Promise<void>;
}
type State = { roots: string[]; resources: Map<Closeable, Resource>; retained: boolean; cleanupErrors: unknown[];
  settled: Promise<Outcome>; scope: PreviewStorageScope };
const cases = new WeakMap<TestContext, State>();
// Keep the existing 30-second afterEach limit. One non-renewable drain leaves
// time for known-safe directory removal; it never extends the test deadline.
const DRAIN_MS = 25_000;

export function storageCase(body: (scope: PreviewStorageScope) => Promise<void>): (context: TestContext) => Promise<void> {
  return context => {
    const state: State = { roots: [], resources: new Map(), retained: false, cleanupErrors: [],
      settled: Promise.resolve({ status: "fulfilled" }), scope: undefined! };
    const retain = (error: unknown) => {
      state.retained = true;
      if (!state.cleanupErrors.includes(error)) state.cleanupErrors.push(error);
    };
    state.scope = {
      async temporary() {
        const created = await mkdtemp(join(tmpdir(), "artoo-preview-storage-"));
        const index = state.roots.push(created) - 1;
        let root: string;
        try { root = await realpath(created); }
        catch (error) { retain(error); throw error; }
        state.roots[index] = root;
        context.signal.throwIfAborted(); return root;
      },
      checkpoint() { context.signal.throwIfAborted(); },
      own(resource) {
        // Register immediately after acquisition, before any cancellation check.
        if (!state.resources.has(resource)) state.resources.set(resource, { closed: false });
        return resource;
      },
      close(resource) {
        const record = state.resources.get(resource);
        if (!record) {
          const error = new Error("Storage fixture tried to close an unowned resource");
          retain(error); return Promise.reject(error);
        }
        return record.closing ??= Promise.resolve().then(() => resource.close()).then(() => { record.closed = true; }, error => {
          retain(error); throw error;
        });
      },
      async maintenance(operation) {
        try { return await operation; }
        catch (error) { retain(error); throw error; }
      },
      async expectedRejection(operation, assertion) {
        const outcome = operation.then(() => ({ rejected: false as const }), error => ({ rejected: true as const, error }));
        try { await assertion(operation); }
        catch (assertionError) {
          const result = await outcome;
          // A different rejection may be hidden acquisition/close failure. A
          // fulfilled operation has its ordinary ownership/closure guarantees.
          if (result.rejected) retain(result.error);
          throw assertionError;
        }
      },
    };
    cases.set(context, state);
    // This is the original body promise, before Vitest's timeout/cancellation
    // wrapper. Observing its outcome does not turn a failed assertion into pass.
    const work = Promise.resolve().then(() => body(state.scope));
    state.settled = work.then(() => ({ status: "fulfilled" }), error => ({ status: "rejected", error }));
    return work;
  };
}

export async function finishStorageCase(context: TestContext): Promise<void> {
  const state = cases.get(context);
  if (!state) return;
  const deadline = performance.now() + DRAIN_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcome: Outcome;
  try {
    outcome = await Promise.race([
      state.settled.then(async result => {
        // Never close a database concurrently with its still-running test body.
        const failures: unknown[] = [];
        for (const [resource, record] of state.resources) if (!record.closed) {
          try { await state.scope.close(resource); }
          catch (error) { failures.push(error); }
        }
        if (failures.length > 0) throw new AggregateError(failures, "Owned storage resource closure failed");
        return result;
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Original storage work did not confirm closure within the cleanup drain")), DRAIN_MS); }),
    ]);
    if (performance.now() >= deadline) throw new Error("Storage cleanup drain exceeded its fixed deadline");
  } catch (error) {
    state.retained = true; state.cleanupErrors.push(error);
    throw new AggregateError(state.cleanupErrors, `Storage closure is unconfirmed; fixture retained: ${state.roots.join(", ")}`);
  } finally { clearTimeout(timer); }
  if (state.retained) {
    throw new AggregateError(state.cleanupErrors, `Storage operation or cleanup failed; fixture retained: ${state.roots.join(", ")}`);
  }
  // Assertion failure alone does not imply uncertain closure. Once the original
  // work and every owned close have settled successfully, deletion is safe.
  const temporary = await realpath(tmpdir());
  for (const root of state.roots) {
    const tail = relative(temporary, root);
    if (!tail || isAbsolute(tail) || tail === ".." || tail.startsWith(`..${sep}`) || await realpath(root) !== root) {
      state.retained = true; throw new Error(`Storage fixture cleanup path changed; retained: ${root}`);
    }
    if (state.retained) throw new Error(`Storage fixture retention is irreversible: ${root}`);
    await rm(root, { recursive: true, force: true });
  }
  cases.delete(context);
  // Preserve a distinct late failure that arrived only after the test timeout.
  if (outcome.status === "rejected" && context.signal.aborted && outcome.error !== context.signal.reason) throw outcome.error;
}
