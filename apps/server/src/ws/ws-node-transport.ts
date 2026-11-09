import { importedCleanValidationAckSchema, importedCleanValidationResultSchema, importedCleanValidationReviewAckSchema, importedCleanValidationReviewResultSchema } from "@artoo/protocol";
import {productSourceOperationAckSchema,productSourceOperationResultSchema} from "@artoo/protocol";
import { sourceLifecycleRegisterSchema, sourceCleanCheckpointSchema } from "@artoo/protocol";
import { applicationPublicationReceiptMessageSchema, applicationPublicationObservationMessageSchema } from "@artoo/protocol";
import { importedProductReviewAckSchema, importedProductReviewResultSchema } from "@artoo/protocol";
import { importedDesignContinuationAckSchema, importedDesignContinuationResultSchema } from "@artoo/protocol";
import { importedDesignReviewAckSchema, importedDesignReviewResultSchema } from "@artoo/protocol";
import { importedExecutionAckSchema, importedExecutionResultSchema } from "@artoo/protocol";
import { importedExecutionReviewAckSchema, importedExecutionReviewResultSchema,
  importedExecutionRepairAckSchema, importedExecutionRepairResultSchema } from "@artoo/protocol";
import { importedValidationAckSchema, importedValidationResultSchema,
  importedValidationReviewAckSchema, importedValidationReviewResultSchema } from "@artoo/protocol";
import { productSourceRecoveryRegisterSchema, productSourceRecoveryAvailableSchema, productSourceRecoveryAckSchema, productSourceRecoveryResultSchema,
  importedRecoveryValidationAckSchema, importedRecoveryValidationResultSchema,
  importedRecoveryValidationReviewAckSchema, importedRecoveryValidationReviewResultSchema } from "@artoo/protocol";
import {
  commandAckSchema,
  nodeHeartbeatSchema,
  nodeHelloSchema,
  nodeSessionProbeSchema,
  runEventMessageSchema,
  productReleaseReceiptMessageSchema,
  productReleaseHealthMessageSchema,
  type NodeToServerMessage,
  type NodeTransport,
  type ServerToNodeMessage,
  type Unsubscribe,
} from "@artoo/protocol";

/** The minimal surface of a `ws` WebSocket we use (avoids a direct ws dep). */
export interface RawServerSocket {
  readonly readyState?: number;
  send(data: string, callback?: (error?: Error) => void): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  close(code?: number, reason?: string): void;
}

/**
 * Server-side {@link NodeTransport} over a Fastify WebSocket connection to
 * `ws /api/v1/node`. Frames are bare protocol JSON (WS wire format v0.1):
 * Server->Node sends `command`, Node->Server delivers node.hello / node.heartbeat
 * / command.ack / run.event. Incoming frames are validated by their protocol
 * schema (by `kind`); unknown/invalid frames are dropped (forward-compat).
 */
export function createServerNodeTransport(socket: RawServerSocket): NodeTransport {
  const handlers = new Set<(message: NodeToServerMessage) => void>();

  socket.on("message", (data: unknown) => {
    const message = parseNodeToServer(data);
    if (message === null) {
      return;
    }
    for (const handler of [...handlers]) {
      handler(message);
    }
  });

  return {
    async send(message: ServerToNodeMessage): Promise<void> {
      if (message.type === "node.session.ready" || message.type === "node.session.pong") {
        // This proves only local write completion. A peer's matching probe is
        // still required; local completion is never a run-event receipt.
        if (socket.readyState !== 1) throw new Error("Managed session socket is not open");
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Managed session local write expired")), 10000);
          try { socket.send(JSON.stringify(message), (error) => {
            clearTimeout(timer);
            if (error) reject(error);
            else if (socket.readyState !== 1) reject(new Error("Managed session socket closed during local write"));
            else resolve();
          }); } catch (error) { clearTimeout(timer); reject(error); }
        });
        return;
      }
      socket.send(JSON.stringify(message));
    },
    subscribe(handler): Unsubscribe {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async close(): Promise<void> {
      handlers.clear();
      socket.close();
    },
  };
}

function toText(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Uint8Array) {
    return new TextDecoder().decode(data);
  }
  if (data !== null && typeof data === "object" && "toString" in data) {
    return String(data);
  }
  return null;
}

/** Validate a raw frame against the protocol Node->Server messages by `kind`. */
export function parseNodeToServer(data: unknown): NodeToServerMessage | null {
  const text = toText(data);
  if (text === null) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || !("kind" in raw)) {
    return null;
  }
  const kind = (raw as { kind: unknown }).kind;
  switch (kind) {
    case "node.hello":
      return ok(nodeHelloSchema.safeParse(raw));
    case "node.session.probe":
      return ok(nodeSessionProbeSchema.safeParse(raw));
    case "node.heartbeat":
      return ok(nodeHeartbeatSchema.safeParse(raw));
    case "command.ack":
      return ok(commandAckSchema.safeParse(raw));
    case "run.event":
      return ok(runEventMessageSchema.safeParse(raw));
    case "product.source.operation.ack.v1": return ok(productSourceOperationAckSchema.safeParse(raw));
    case "product.source.review.ack.v1": return ok(importedProductReviewAckSchema.safeParse(raw));
    case "product.source.review.result.v1": return ok(importedProductReviewResultSchema.safeParse(raw));
    case "product.source.design-review.ack.v1": return ok(importedDesignReviewAckSchema.safeParse(raw));
    case "product.source.design-review.result.v1": return ok(importedDesignReviewResultSchema.safeParse(raw));
    case "product.source.execution.ack.v1": return ok(importedExecutionAckSchema.safeParse(raw));
    case "product.source.execution.result.v1": return ok(importedExecutionResultSchema.safeParse(raw));
    case "product.source.execution-review.ack.v1": return ok(importedExecutionReviewAckSchema.safeParse(raw));
    case "product.source.execution-review.result.v1": return ok(importedExecutionReviewResultSchema.safeParse(raw));
    case "product.source.execution-repair.ack.v1": return ok(importedExecutionRepairAckSchema.safeParse(raw));
    case "product.source.execution-repair.result.v1": return ok(importedExecutionRepairResultSchema.safeParse(raw));
    case "product.source.validation.ack.v1": return ok(importedValidationAckSchema.safeParse(raw));
    case "product.source.recovery.register.v1": return ok(productSourceRecoveryRegisterSchema.safeParse(raw));
    case "product.source.lifecycle.register.v1": return ok(sourceLifecycleRegisterSchema.safeParse(raw));
    case "product.source.clean-restart.checkpoint.v1": return ok(sourceCleanCheckpointSchema.safeParse(raw));
    case "product.source.recovery.available.v1": return ok(productSourceRecoveryAvailableSchema.safeParse(raw));
    case "product.source.recovery.ack.v1": return ok(productSourceRecoveryAckSchema.safeParse(raw));
    case "product.source.recovery.result.v1": return ok(productSourceRecoveryResultSchema.safeParse(raw));
    case "product.source.recovery-validation.ack.v1": return ok(importedRecoveryValidationAckSchema.safeParse(raw));
    case "product.source.clean-validation.ack.v1": return ok(importedCleanValidationAckSchema.safeParse(raw));
    case "product.source.recovery-validation.result.v1": return ok(importedRecoveryValidationResultSchema.safeParse(raw));
    case "product.source.clean-validation.result.v1": return ok(importedCleanValidationResultSchema.safeParse(raw));
    case "product.source.recovery-validation-review.ack.v1": return ok(importedRecoveryValidationReviewAckSchema.safeParse(raw));
    case "product.source.clean-validation-review.ack.v1": return ok(importedCleanValidationReviewAckSchema.safeParse(raw));
    case "product.source.recovery-validation-review.result.v1": return ok(importedRecoveryValidationReviewResultSchema.safeParse(raw));
    case "product.source.clean-validation-review.result.v1": return ok(importedCleanValidationReviewResultSchema.safeParse(raw));
    case "product.source.validation.result.v1": return ok(importedValidationResultSchema.safeParse(raw));
    case "product.source.validation-review.ack.v1": return ok(importedValidationReviewAckSchema.safeParse(raw));
    case "product.source.validation-review.result.v1": return ok(importedValidationReviewResultSchema.safeParse(raw));
    case "product.source.design.ack.v1": return ok(importedDesignContinuationAckSchema.safeParse(raw));
    case "product.source.design.result.v1": return ok(importedDesignContinuationResultSchema.safeParse(raw));
    case "product.source.operation.result.v1": return ok(productSourceOperationResultSchema.safeParse(raw));
    case "product.release.receipt":
      return ok(productReleaseReceiptMessageSchema.safeParse(raw));
    case "application.publication.receipt": return ok(applicationPublicationReceiptMessageSchema.safeParse(raw));
    case "application.publication.observation": return ok(applicationPublicationObservationMessageSchema.safeParse(raw));
    case "product.release.health":
      return ok(productReleaseHealthMessageSchema.safeParse(raw));
    default:
      return null;
  }
}

function ok<T>(result: { success: true; data: T } | { success: false }): T | null {
  return result.success ? result.data : null;
}
