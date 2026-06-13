import type {
  ArtifactCollectCommand,
  CommandAck,
  NodeHeartbeat,
  NodeHello,
  RunEventMessage,
  RunStartCommand,
  RunStopCommand
} from "./node-messages.js";

/**
 * Transport seam between the server and a node (design discussion: NodeTransport).
 * `InProcessTransport` (testkit) drives the mock loop with zero IO; a
 * `WebSocketTransport` (artood) carries the same messages over the wire. Both
 * implement this one interface so the mock loop (step 3) and the real node
 * protocol (step 6) share a single command/event contract.
 *
 * Payloads inside run.start / run.event are owned by @artoo/domain; the wire
 * envelopes are owned by this package (single source of truth, no redefinition).
 */
export type NodeToServerMessage = NodeHello | NodeHeartbeat | CommandAck | RunEventMessage;

export type ServerToNodeMessage = RunStartCommand | RunStopCommand | ArtifactCollectCommand;

export type Unsubscribe = () => void;

export interface NodeTransport {
  send(message: ServerToNodeMessage): Promise<void>;
  subscribe(handler: (message: NodeToServerMessage) => void): Unsubscribe;
  close(): Promise<void>;
}
