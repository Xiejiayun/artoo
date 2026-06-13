import type { NodeBinding } from "../node-binding.js";

/**
 * Maps a connected node (computer_id) to its {@link NodeBinding}, so the server
 * can route a queued run's run.start to the node that owns the target computer.
 * A node is registered only after its node.hello is accepted.
 */
export interface NodeRegistry {
  register(computerId: string, binding: NodeBinding): void;
  unregister(computerId: string): void;
  get(computerId: string): NodeBinding | undefined;
}

export function createNodeRegistry(): NodeRegistry {
  const bindings = new Map<string, NodeBinding>();
  return {
    register(computerId, binding): void {
      bindings.set(computerId, binding);
    },
    unregister(computerId): void {
      bindings.delete(computerId);
    },
    get(computerId): NodeBinding | undefined {
      return bindings.get(computerId);
    },
  };
}
