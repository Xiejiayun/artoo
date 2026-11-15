/** Versioned, read-only scheduler measurements; null means no durable sample. */
export interface SchedulerObservationsV1 {
  version: 1;
  project_id: string;
  observed_at: string;
  window: { from: string; to: string };
  hanging_after_ms: number;
  queue: { assignments: number; samples: number; mean_ms: number | null; max_ms: number | null };
  execution: { samples: number; mean_ms: number | null; max_ms: number | null };
  failure: { terminal_runs: number; failed_runs: number; rate: number | null };
  current: { hanging_tasks: number; unconfirmed_disconnect_runs: number };
}
