import {
  CliConnectionVerificationOutcomeV1Schema,
  CliDiscoveryInventoryV1Schema,
  SingleTurnTextRuntimeIdSchema,
} from "@artoo/domain";
import { z } from "zod";

const identifier = z.string().min(1).max(128);
const commandIdentifier = z.string().min(1).max(256);

/** Server -> Node request to re-probe the built-in CLI catalog without server-supplied commands. */
export const cliDiscoveryRefreshCommandSchema = z
  .object({
    kind: z.literal("command"),
    id: commandIdentifier,
    idempotency_key: commandIdentifier,
    deadline_at: z.string().datetime().optional(),
    type: z.literal("cli.discovery.refresh.v1"),
    payload: z
      .object({
        version: z.literal(1),
        request_id: identifier,
      })
      .strict(),
  })
  .strict();

/** Server -> Node request for operator-triggered connection verification; carries no argv or prompt. */
export const cliVerifyConnectionCommandSchema = z
  .object({
    kind: z.literal("command"),
    id: commandIdentifier,
    idempotency_key: commandIdentifier,
    deadline_at: z.string().datetime().optional(),
    type: z.literal("cli.verify.v1"),
    payload: z
      .object({
        version: z.literal(1),
        request_id: identifier,
        runtime: SingleTurnTextRuntimeIdSchema,
      })
      .strict(),
  })
  .strict();

/** Node -> Server immediate discovery snapshot after startup or explicit refresh. */
export const cliDiscoverySnapshotMessageSchema = z
  .object({
    kind: z.literal("cli.discovery.snapshot.v1"),
    node_id: identifier,
    request_id: identifier.optional(),
    cli_discovery: CliDiscoveryInventoryV1Schema,
  })
  .strict();

/** Node -> Server result of an operator-triggered single-turn CLI connection verification. */
export const cliVerifyResultMessageSchema = z
  .object({
    kind: z.literal("cli.verify.result.v1"),
    node_id: identifier,
    request_id: identifier,
    outcome: CliConnectionVerificationOutcomeV1Schema,
    cli_discovery: CliDiscoveryInventoryV1Schema.optional(),
  })
  .strict();

export type CliDiscoveryRefreshCommand = z.infer<typeof cliDiscoveryRefreshCommandSchema>;
export type CliVerifyConnectionCommand = z.infer<typeof cliVerifyConnectionCommandSchema>;
export type CliDiscoverySnapshotMessage = z.infer<typeof cliDiscoverySnapshotMessageSchema>;
export type CliVerifyResultMessage = z.infer<typeof cliVerifyResultMessageSchema>;
