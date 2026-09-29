import { z } from "zod";

export const ChannelSchema = z.object({ id: z.string(), project_id: z.string(), name: z.string(), description: z.string(), created_at: z.string() });
export type Channel = z.infer<typeof ChannelSchema>;
export const CreateChannelRequestSchema = z.object({ project_id: z.string().min(1), name: z.string().trim().min(1).max(80), description: z.string().trim().max(2000).default("") });
export type CreateChannelRequest = z.infer<typeof CreateChannelRequestSchema>;
export const MemberSchema = z.object({ id: z.string(), display_name: z.string() });
export type Member = z.infer<typeof MemberSchema>;
export const NotificationSchema = z.object({
  id: z.string(), room_id: z.string(), message_id: z.string(), thread_root_id: z.string().nullable(),
  actor_id: z.string(), body_preview: z.string(), read_at: z.string().nullable(), created_at: z.string(),
  project_id: z.string().nullable(), room_type: z.string(), room_name: z.string(),
  channel_id: z.string().nullable(), task_id: z.string().nullable(), goal_id: z.string().nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;
export const NotificationPageSchema = z.object({
  notifications: z.array(NotificationSchema), next_before: z.string().nullable(),
  has_more: z.boolean(), unread_count: z.number().int().nonnegative(),
});
export type NotificationPage = z.infer<typeof NotificationPageSchema>;
