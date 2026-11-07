import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createWebSocketTransport } from "./ws-transport.js";

it("does not reuse publication retry session identity after an actual WebSocket reconnect", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const sockets: WebSocket[] = []; server.on("connection", socket => { sockets.push(socket); });
  let secondResolve!: () => void, connectionCount = 0;
  const second = new Promise<void>(resolve => { secondResolve = resolve; });
  const transport = createWebSocketTransport({ url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/node`,
    hello: { kind: "node.hello", node_id: "fixture-node", protocol_version: "2026-06-11", artood_version: "0.1.0",
      machine: { hostname: "fixture", os: "windows", arch: "x64" } },
    reconnectDelayMs: 1, onConnected: () => { if (++connectionCount === 2) secondResolve(); } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(transport.currentSessionIdentity()).toBeUndefined(); await transport.ready;
    const original = transport.currentSessionIdentity(); expect(original).toBeDefined();
    sockets[0]!.close(1000, "controlled reconnect");
    await Promise.race([second, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Reconnect deadline exceeded")), 5000); })]);
    expect(transport.currentSessionIdentity()).toBeDefined(); expect(transport.currentSessionIdentity()).not.toBe(original);
    await transport.close(); expect(transport.currentSessionIdentity()).toBeUndefined();
  } finally {
    clearTimeout(timer); await transport.close(); for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
