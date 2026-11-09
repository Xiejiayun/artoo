import { z } from "zod";
import { ApplicationPublicationIdentifierV1Schema, ApplicationPublicationRequestV1Schema,
  ApplicationPublicationReceiptV1Schema, ApplicationPublicationObservationV1Schema } from "@artoo/domain";

const id = ApplicationPublicationIdentifierV1Schema;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const command = { kind: z.literal("command"), id, idempotency_key: id, deadline_at: z.string().datetime().optional() };
/** Ordinary device-authenticated socket lineage, separate from managed run receipt sessions. */
export const applicationPublicationSessionCommandSchema = z.object({ ...command,
  type: z.literal("application.publication.session.v1"), payload: z.object({ version: z.literal(1), node_id: id, session_id: z.string().guid() }).strict() }).strict();
// Every action retains the entire immutable request; a new paired session cannot adopt it.
export const applicationPublicationStartCommandSchema = z.object({ ...command,
  type: z.literal("application.publication.start"), payload: ApplicationPublicationRequestV1Schema }).strict();
export const applicationPublicationStopCommandSchema = z.object({ ...command,
  type: z.literal("application.publication.stop"), payload: z.object({ version: z.literal(1),
    request: ApplicationPublicationRequestV1Schema, reason: z.enum(["user-stop", "goal-cancelled", "authorization-invalid", "profile-invalid", "server-shutdown"]) }).strict() }).strict();
export const applicationPublicationStatusCommandSchema = z.object({ ...command,
  type: z.literal("application.publication.status"), payload: ApplicationPublicationRequestV1Schema }).strict();
export const applicationPublicationReceiptMessageSchema = z.object({
  kind: z.literal("application.publication.receipt"), node_id: id, payload: ApplicationPublicationReceiptV1Schema }).strict();
export const applicationPublicationObservationMessageSchema = z.object({
  kind: z.literal("application.publication.observation"), node_id: id, payload: ApplicationPublicationObservationV1Schema }).strict();

const acknowledged = { version: z.literal(1), publication_id: id, publisher_session_id: id, request_digest: digest,
  status: z.enum(["accepted", "rejected"]), message: z.string().max(2000).optional() };
/** An ACK confirms committed history, never grants or reconstructs an owner/permit. */
export const applicationPublicationReceiptAckCommandSchema = z.object({ ...command,
  type: z.literal("application.publication.receipt.ack"), payload: z.object({ ...acknowledged, receipt_digest: digest }).strict() }).strict();
export const applicationPublicationObservationAckCommandSchema = z.object({ ...command,
  type: z.literal("application.publication.observation.ack"), payload: z.object({ ...acknowledged,
    event_id: id, sequence: z.number().int().min(1).max(2_147_483_647), observation_digest: digest }).strict() }).strict();

export type ApplicationPublicationStartCommand = z.infer<typeof applicationPublicationStartCommandSchema>;
export type ApplicationPublicationSessionCommand = z.infer<typeof applicationPublicationSessionCommandSchema>;
export type ApplicationPublicationStopCommand = z.infer<typeof applicationPublicationStopCommandSchema>;
export type ApplicationPublicationStatusCommand = z.infer<typeof applicationPublicationStatusCommandSchema>;
export type ApplicationPublicationReceiptMessage = z.infer<typeof applicationPublicationReceiptMessageSchema>;
export type ApplicationPublicationObservationMessage = z.infer<typeof applicationPublicationObservationMessageSchema>;
export type ApplicationPublicationReceiptAckCommand = z.infer<typeof applicationPublicationReceiptAckCommandSchema>;
export type ApplicationPublicationObservationAckCommand = z.infer<typeof applicationPublicationObservationAckCommandSchema>;
