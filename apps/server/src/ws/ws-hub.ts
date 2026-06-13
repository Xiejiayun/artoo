/**
 * Pub/sub hub for client realtime (`/api/v1/ws`). Tracks each client socket's
 * topic subscriptions and fans an event frame out to the sockets subscribed to a
 * topic. Topics: task:{id} / room:{id} / run:{id} / project:{id} / inbox:{user}.
 */
export interface HubSocket {
  send(data: string): void;
}

export interface WsHub {
  add(socket: HubSocket): void;
  remove(socket: HubSocket): void;
  subscribe(socket: HubSocket, topics: readonly string[]): void;
  unsubscribe(socket: HubSocket, topics: readonly string[]): void;
  publish(topic: string, frame: unknown): void;
}

export function createWsHub(): WsHub {
  const byTopic = new Map<string, Set<HubSocket>>();
  const bySocket = new Map<HubSocket, Set<string>>();

  return {
    add(socket): void {
      if (!bySocket.has(socket)) {
        bySocket.set(socket, new Set());
      }
    },
    remove(socket): void {
      const topics = bySocket.get(socket);
      if (topics !== undefined) {
        for (const topic of topics) {
          byTopic.get(topic)?.delete(socket);
        }
      }
      bySocket.delete(socket);
    },
    subscribe(socket, topics): void {
      const owned = bySocket.get(socket) ?? new Set<string>();
      bySocket.set(socket, owned);
      for (const topic of topics) {
        owned.add(topic);
        let set = byTopic.get(topic);
        if (set === undefined) {
          set = new Set();
          byTopic.set(topic, set);
        }
        set.add(socket);
      }
    },
    unsubscribe(socket, topics): void {
      const owned = bySocket.get(socket);
      for (const topic of topics) {
        owned?.delete(topic);
        byTopic.get(topic)?.delete(socket);
      }
    },
    publish(topic, frame): void {
      const set = byTopic.get(topic);
      if (set === undefined) {
        return;
      }
      const data = JSON.stringify(frame);
      for (const socket of [...set]) {
        try {
          socket.send(data);
        } catch {
          // best-effort delivery; a dead socket is cleaned up on close
        }
      }
    },
  };
}
