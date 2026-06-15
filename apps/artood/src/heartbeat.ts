import type { NodeHeartbeat, RuntimeStatus } from "@artoo/protocol";

import type { AdapterRegistry } from "./adapter-registry.js";

/**
 * Default `node.heartbeat` producer for registry-mode nodes. It advertises every
 * registered runtime together with its capability tags (from
 * {@link AdapterRegistry.runtimes}) so the server can persist runtime capabilities
 * and the scheduler can route capability-gated tasks to the right runtime.
 *
 * The returned closure is called on the transport's heartbeat interval; it keeps a
 * monotonically increasing `sequence` per node process. Capabilities are always a
 * concrete array (never `undefined`). `status` defaults to `available` (the runtime
 * is registered/usable); live binary probing is a later concern. `resources` and
 * `running_instances` are injectable samplers, defaulting to zeros / empty.
 */
export interface RegistryHeartbeatOptions {
  nodeId: string;
  registry: AdapterRegistry;
  /** Status reported for each registered runtime. Defaults to "available". */
  status?: RuntimeStatus["status"];
  /** Resource sampler; defaults to zeros. */
  resources?: () => NodeHeartbeat["resources"];
  /** Active agent-instance ids; defaults to []. */
  runningInstances?: () => readonly string[];
}

export function createRegistryHeartbeat(options: RegistryHeartbeatOptions): () => NodeHeartbeat {
  const status = options.status ?? "available";
  let sequence = 0;
  return () => ({
    kind: "node.heartbeat",
    node_id: options.nodeId,
    sequence: sequence++,
    resources: options.resources?.() ?? { cpu_load: 0, memory_used_pct: 0, disk_free_gb: 0 },
    runtimes: options.registry.runtimes().map(
      (rt): RuntimeStatus => ({
        runtime: rt.runtime,
        status,
        capabilities: [...rt.capabilities]
      })
    ),
    running_instances: [...(options.runningInstances?.() ?? [])]
  });
}
