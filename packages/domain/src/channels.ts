import { z } from "zod";

export const ChannelSchema = z.object({ id: z.string(), project_id: z.string(), name: z.string(), description: z.string(), created_at: z.string() });
export type Channel = z.infer<typeof ChannelSchema>;
export const CreateChannelRequestSchema = z.object({ project_id: z.string().min(1), name: z.string().trim().min(1).max(80), description: z.string().trim().max(2000).default("") });
export type CreateChannelRequest = z.infer<typeof CreateChannelRequestSchema>;
export const MemberSchema = z.object({ id: z.string(), display_name: z.string() });
export type Member = z.infer<typeof MemberSchema>;
export const NotificationSchema = z.object({ id: z.string(), room_id: z.string(), message_id: z.string(), thread_root_id: z.string().nullable(), actor_id: z.string(), body_preview: z.string(), read_at: z.string().nullable(), created_at: z.string() });
export type Notification = z.infer<typeof NotificationSchema>;
