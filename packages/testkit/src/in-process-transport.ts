import type {
  NodeToServerMessage,
  NodeTransport,
  ServerToNodeMessage,
  Unsubscribe
} from "@artoo/protocol";

/**
 * In-process implementation of the NodeTransport seam. Bridges a server-facing
 * `NodeTransport` and a node-facing `NodeEndpoint` with synchronous in-memory
 * delivery, so the mock loop (create task -> run -> events -> review) runs in a
 * single process with zero IO. A real artood swaps this for a WebSocketTransport
 * over the identical message contract.
 */
type Handler<M> = (message: M) => void;

class Hub<M> {
  private readonly handlers = new Set<Handler<M>>();

  subscribe(handler: Handler<M>): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(message: M): void {
    for (const handler of [...this.handlers]) {
      handler(message);
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}

/** The node side of an in-process channel (mirror of the server's NodeTransport). */
export interface NodeEndpoint {
  /** node -> server */
  send(message: NodeToServerMessage): Promise<void>;
  /** subscribe to server -> node */
  subscribe(handler: (message: ServerToNodeMessage) => void): Unsubscribe;
}

export interface InProcessChannel {
  serverTransport: NodeTransport;
  node: NodeEndpoint;
  close(): Promise<void>;
}

export function createInProcessChannel(): InProcessChannel {
  const toNode = new Hub<ServerToNodeMessage>(); // server -> node
  const toServer = new Hub<NodeToServerMessage>(); // node -> server
  let closed = false;

  const ensureOpen = (): void => {
    if (closed) {
      throw new Error("InProcessChannel is closed");
    }
  };

  const serverTransport: NodeTransport = {
    async send(message: ServerToNodeMessage): Promise<void> {
      ensureOpen();
      toNode.emit(message);
    },
    subscribe(handler): Unsubscribe {
      return toServer.subscribe(handler);
    },
    async close(): Promise<void> {
      closed = true;
      toNode.clear();
      toServer.clear();
    }
  };

  const node: NodeEndpoint = {
    async send(message: NodeToServerMessage): Promise<void> {
      ensureOpen();
      toServer.emit(message);
    },
    subscribe(handler): Unsubscribe {
      return toNode.subscribe(handler);
    }
  };

  return {
    serverTransport,
    node,
    async close(): Promise<void> {
      await serverTransport.close();
    }
  };
}
