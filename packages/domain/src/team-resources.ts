import { z } from "zod";
import { CapabilitySchema } from "./capabilities.js";
import { AgentKindSchema } from "./schemas.js";

const id = z.string().min(1).max(128);
export const ResourceRevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const LogicalAgentConfigurationV1Schema = z.object({
  version: z.literal(1), display_name: z.string().trim().min(1).max(160), kind: AgentKindSchema,
  capabilities: z.array(CapabilitySchema).max(64).refine((v) => new Set(v).size === v.length),
  role: z.string().trim().max(160), description: z.string().max(4000), instructions: z.string().max(32_000),
}).strict();
export type LogicalAgentConfigurationV1 = z.infer<typeof LogicalAgentConfigurationV1Schema>;
export const CreateLogicalAgentV1Schema = z.object({ version: z.literal(1), request_key: id, configuration: LogicalAgentConfigurationV1Schema }).strict();
export const PutLogicalAgentConfigurationV1Schema = z.object({ version: z.literal(1), expected_revision: ResourceRevisionSchema, configuration: LogicalAgentConfigurationV1Schema }).strict();
export const LogicalAgentConfigurationRecordV1Schema = z.object({ version: z.literal(1), agent_id: id, revision: ResourceRevisionSchema, configuration: LogicalAgentConfigurationV1Schema }).strict();
export type LogicalAgentConfigurationRecordV1 = z.infer<typeof LogicalAgentConfigurationRecordV1Schema>;
const memberIds = z.array(id).max(128).refine((v) => new Set(v).size === v.length, "Squad Agent ids must be unique");
export const PutProjectSquadV1Schema = z.object({ version: z.literal(1), expected_revision: ResourceRevisionSchema, agent_ids: memberIds }).strict();
export const ProjectSquadV1Schema = z.object({ version: z.literal(1), project_id: id, revision: ResourceRevisionSchema, agent_ids: memberIds, source: z.enum(["configured", "legacy_instances"]) }).strict();
export type ProjectSquadV1 = z.infer<typeof ProjectSquadV1Schema>;
export const ComputerAdmissionStateV1Schema = z.enum(["accepting", "draining"]);
export const PutComputerAdmissionV1Schema = z.object({ version: z.literal(1), expected_revision: ResourceRevisionSchema, state: ComputerAdmissionStateV1Schema }).strict();
export const ComputerAdmissionV1Schema = z.object({ version: z.literal(1), computer_id: id, revision: ResourceRevisionSchema, state: ComputerAdmissionStateV1Schema }).strict();
export type ComputerAdmissionV1 = z.infer<typeof ComputerAdmissionV1Schema>;
