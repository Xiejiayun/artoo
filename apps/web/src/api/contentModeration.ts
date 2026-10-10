export interface ContentReport {
  id: string;
  message_id: string;
  reason: string;
  status: "open" | "resolved" | "dismissed";
  created_at: string;
  resolved_at: string | null;
  actor_id?: string;
  actor_type?: string;
  actor_name?: string | null;
  actor_email?: string | null;
  room_id?: string;
  reporter_user_id?: string;
  body_snapshot?: string;
  reviewed_by_user_id?: string | null;
  resolution_note?: string | null;
}
export interface ContentRules {
  blocked_phrases: string[];
  version: string;
  updated_at: string | null;
}
export interface ModerationMember {
  id: string;
  name: string;
  email: string;
  role: string;
  suspended_at: string | null;
  reinstated_at: string | null;
}
