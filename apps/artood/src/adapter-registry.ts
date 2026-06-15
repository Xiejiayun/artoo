import type { RuntimeAdapter } from "@artoo/protocol";

/**
 * Maps a run's `runtime` id to the {@link RuntimeAdapter} that executes it.
 *
 * The node uses `run.start.runtime` as the ONLY adapter-selection key — routing
 * is deterministic and artood makes no scheduling decisions (the server's
 * scheduler picks the runtime; the node only resolves it to an adapter and runs
 * it). An unknown runtime resolves to `undefined` so the node-client rejects
 * `run.start` via the closed protocol error path (`runtime_missing`) rather than
 * silently falling back.
 *
 * `runtimes()` exposes the registered runtimes + their capability tags for
 * `node.heartbeat` reporting, which the server scheduler consumes for
 * capability-based routing.
 */
export interface RuntimeRegistration {
  runtime: string;
  adapter: RuntimeAdapter;
  capabilities?: readonly string[];
}

export interface RuntimeDescriptor {
  runtime: string;
  capabilities: readonly string[];
}

export interface AdapterRegistry {
  resolve(runtime: string): RuntimeAdapter | undefined;
  runtimes(): readonly RuntimeDescriptor[];
}

export function createAdapterRegistry(registrations: readonly RuntimeRegistration[]): AdapterRegistry {
  const byRuntime = new Map<string, RuntimeRegistration>();
  for (const registration of registrations) {
    byRuntime.set(registration.runtime, registration);
  }
  return {
    resolve(runtime: string): RuntimeAdapter | undefined {
      return byRuntime.get(runtime)?.adapter;
    },
    runtimes(): readonly RuntimeDescriptor[] {
      return [...byRuntime.values()].map((registration) => ({
        runtime: registration.runtime,
        capabilities: registration.capabilities ?? []
      }));
    }
  };
}
