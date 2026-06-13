import type {
  ArtifactCollectCommand,
  CommandAck,
  NodeHeartbeat,
  NodeHello,
  RunStopCommand
} from "./node-messages.js";

/**
 * Transport seam between the server and a node (design discussion: NodeTransport).
 * `InProcessTransport` (testkit) drives the mock loop with zero IO; a
 * `WebSocketTransport` (artood) carries the same messages over the wire. Both
 * implement this one interface so the mock loop (step 3) and the real node
 * protocol (step 6) share a single command/event contract.
 *
 * NOTE: the message unions below are the domain-independent subset. The
 * run.start command and run.event message — which carry @artoo/domain payloads
 * (RunStartPayload, RunEvent) — are folded in during the domain-dependent phase.
 * Their wire envelopes belong here; their payloads are imported from
 * @artoo/domain (single source of truth), never redefined.
 */
export type NodeToServerMessage = NodeHello | NodeHeartbeat | CommandAck;

export type ServerToNodeMessage = RunStopCommand | ArtifactCollectCommand;

export type Unsubscribe = () => void;

export interface NodeTransport {
  send(message: ServerToNodeMessage): Promise<void>;
  subscribe(handler: (message: NodeToServerMessage) => void): Unsubscribe;
  close(): Promise<void>;
}
