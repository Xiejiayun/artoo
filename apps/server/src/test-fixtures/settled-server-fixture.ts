import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, aroundEach, beforeEach, it as nativeIt, type TestAPI, type TestContext } from "vitest";

type Closeable = { close(): Promise<void> };
type Outcome = { status: "fulfilled" } | { status: "rejected"; error: unknown };
type Resource = { resource: Closeable; closed: boolean; closing?: Promise<void> };
interface CaseState<T> {
  context: TestContext;
  value: T;
  roots: string[];
  resources: Resource[];
  work: Promise<Outcome>[];
  retained: boolean;
  errors: unknown[];
  finish?: Promise<void>;
}
interface FixtureOptions {
  /** Regression fixtures may shorten the drain; the real suite retains its existing 30s hook limit. */
  drainMs?: number;
  observe?: (event: string, context: TestContext, details: Record<string, unknown>) => void;
}

/** A file-local fixture owner. Original setup/body promises outlive Vitest's timeout wrapper. */
export function settledServerFixture<T>(create: () => T, options: FixtureOptions = {}) {
  const local = new AsyncLocalStorage<CaseState<T>>();
  const cases = new WeakMap<TestContext, CaseState<T>>();
  const drainMs = options.drainMs ?? 25_000;
  if (!Number.isFinite(drainMs) || drainMs <= 0 || drainMs > 25_000) throw new Error("Fixture drain must be at most 25000ms");
  let poisoned: unknown;
  const observe = (state: CaseState<T>, event: string, details: Record<string, unknown> = {}) => options.observe?.(event, state.context, details);
  const stateFor = (context?: TestContext) => {
    const state = local.getStore();
    if (!state || context && (state.context !== context || cases.get(context) !== state)) throw new Error("Fixture lost its original Vitest context");
    return state;
  };
  const retain = (state: CaseState<T>, error: unknown) => {
    state.retained = true;
    if (!state.errors.includes(error)) state.errors.push(error);
  };
  const track = (state: CaseState<T>, phase: "setup" | "body", fn: () => unknown) => {
    observe(state, phase + "-started");
    const work = Promise.resolve().then(fn);
    const settled = work.then<Outcome, Outcome>(
      () => { observe(state, phase + "-settled", { outcome: "fulfilled" }); return { status: "fulfilled" }; },
      error => { observe(state, phase + "-settled", { outcome: "rejected", error: String(error) }); return { status: "rejected", error }; },
    );
    state.work.push(settled);
    return work;
  };

  // This encloses beforeEach, the original callback (including native it.each), and afterEach.
  // An old continuation keeps its own state even after Vitest advances to another case.
  aroundEach((runTest, context) => {
    if (poisoned !== undefined) throw new Error("An earlier fixture did not settle safely; refusing another case", { cause: poisoned });
    const state: CaseState<T> = { context, value: create(), roots: [], resources: [], work: [], retained: false, errors: [] };
    cases.set(context, state);
    return local.run(state, runTest);
  });

  // Keep Vitest's own registration, argument expansion, titles and timeout/options handling.
  // Only the original callback is wrapped, before Vitest installs timeout/cancellation handling.
  function registration<F extends (...args: never[]) => unknown>(register: F): F {
    return new Proxy(register, {
      apply(target, receiver, argumentsList: unknown[]) {
        const args = [...argumentsList], index = args.findIndex((value, at) => at > 0 && typeof value === "function");
        if (index >= 0) {
          const original = args[index] as (...values: unknown[]) => unknown;
          args[index] = function (this: unknown, ...values: unknown[]) {
            const state = stateFor();
            state.context.signal.throwIfAborted();
            return track(state, "body", () => Reflect.apply(original, this, values));
          };
        }
        return Reflect.apply(target, receiver, args);
      },
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (key === "each") return (...table: unknown[]) => registration(Reflect.apply(value as (...args: unknown[]) => F, target, table));
        if (["only", "skip", "todo", "concurrent", "sequential", "fails", "for", "extend", "scoped", "skipIf", "runIf"].includes(String(key)))
          throw new Error("This fixture supports native it and it.each only; unsupported test chain: " + String(key));
        return value;
      },
    });
  }
  const scopedIt: TestAPI = registration(nativeIt);

  async function closeOwned(state: CaseState<T>): Promise<void> {
    for (const owned of [...state.resources].reverse()) {
      if (owned.closed) continue;
      owned.closing ??= Promise.resolve().then(() => {
        observe(state, "close-started");
        return owned.resource.close();
      }).then(() => { owned.closed = true; observe(state, "close-confirmed"); }, error => { retain(state, error); throw error; });
      // A failed predecessor may still use lower-level resources. Do not close through that failure.
      await owned.closing;
    }
  }
  async function finish(state: CaseState<T>, cleanup?: (value: T, context: TestContext) => unknown): Promise<void> {
    observe(state, "drain-started", { aborted: state.context.signal.aborted });
    const deadline = performance.now() + drainMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const draining = (async () => {
      let settled: Outcome[] = [], count = -1;
      while (count !== state.work.length) { count = state.work.length; settled = await Promise.all(state.work); }
      await closeOwned(state);
      // Restore global mocks only after transports, app and DB have actually closed.
      // After expiry, late resource closure remains safe but global mock cleanup must not run.
      if (!state.retained) await cleanup?.(state.value, state.context);
      return settled;
    })();
    let outcomes: Outcome[];
    try {
      outcomes = await Promise.race([draining, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Original fixture work did not settle within the cleanup drain")), drainMs);
      })]);
      if (performance.now() >= deadline) throw new Error("Fixture cleanup exceeded its fixed drain deadline");
    } catch (error) {
      retain(state, error); poisoned = error;
      // Observe a late close failure without replacing the original timeout or producing an unhandled rejection.
      void draining.catch(late => { retain(state, late); observe(state, "late-cleanup-failed", { error: String(late) }); });
      observe(state, "retained", { roots: [...state.roots] });
      throw new AggregateError(state.errors, "Fixture closure is unconfirmed; temporary roots retained: " + state.roots.join(", "));
    } finally { clearTimeout(timer); }
    if (state.retained) {
      poisoned = state.errors[0] ?? new Error("Fixture acquisition or cleanup failed");
      observe(state, "retained", { roots: [...state.roots] });
      throw new AggregateError(state.errors, "Fixture acquisition or cleanup failed; temporary roots retained: " + state.roots.join(", "));
    }
    const temporary = await realpath(tmpdir());
    for (const root of state.roots) {
      const tail = relative(temporary, root);
      if (!tail || isAbsolute(tail) || tail === ".." || tail.startsWith(`..${sep}`) || await realpath(root) !== root)
        throw new Error("Fixture path changed; refusing directory removal: " + root);
      await rm(root, { recursive: true, force: true });
      observe(state, "root-removed", { root });
    }
    observe(state, "drain-completed");
    cases.delete(state.context);
    const lateFailure = outcomes.find(outcome => outcome.status === "rejected" && outcome.error !== state.context.signal.reason);
    if (state.context.signal.aborted && lateFailure?.status === "rejected") throw lateFailure.error;
  }

  return {
    it: scopedIt,
    context(): TestContext { return stateFor().context; },
    current(): T { const state = stateFor(); state.context.signal.throwIfAborted(); return state.value; },
    checkpoint(): void { stateFor().context.signal.throwIfAborted(); },
    own<R extends Closeable>(resource: R): R {
      const state = stateFor();
      // Acquisition can finish after the timeout. Register before checking cancellation.
      if (!state.resources.some(owned => owned.resource === resource)) state.resources.push({ resource, closed: false });
      observe(state, "resource-acquired");
      return resource;
    },
    async acquire<R>(operation: Promise<R>): Promise<R> {
      const state = stateFor();
      try { return await operation; }
      catch (error) { retain(state, error); throw error; }
    },
    async temporary(prefix = "artoo-semantic-transfer-"): Promise<string> {
      if (!/^artoo-[a-z0-9-]+-$/.test(prefix)) throw new Error("Unexpected fixture directory prefix");
      const state = stateFor(), created = await mkdtemp(join(tmpdir(), prefix));
      const index = state.roots.push(created) - 1;
      try { state.roots[index] = await realpath(created); }
      catch (error) { retain(state, error); throw error; }
      observe(state, "root-created", { root: state.roots[index] });
      state.context.signal.throwIfAborted(); return state.roots[index]!;
    },
    beforeEach(setup: (value: T, context: TestContext) => unknown, timeout?: number): void {
      beforeEach(context => {
        const state = stateFor(context);
        return track(state, "setup", () => setup(state.value, context));
      }, timeout);
    },
    afterEach(cleanup?: (value: T, context: TestContext) => unknown): void {
      afterEach(context => { const state = stateFor(context); return state.finish ??= finish(state, cleanup); });
    },
  };
}
