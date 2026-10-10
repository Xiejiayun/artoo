export interface AiDataSharingState {
  user_id: string;
  configured: boolean;
  policy: null | {
    version: string;
    mode: "local" | "external";
    providers: Array<{ id: string; name: string; privacy_url: string }>;
    data_categories: string[];
    purpose: string;
  };
  consent: null | { id: string; policy_version: string; granted_at: string };
  unconfirmed_stops?: Array<{ kind: string; id: string }>;
}
