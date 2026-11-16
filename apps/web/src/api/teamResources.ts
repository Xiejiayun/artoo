import type { SchedulerAgentPolicyV1, SchedulerComputerPolicyV1, SchedulerProjectPolicyV1 } from "@artoo/domain";

export interface SchedulingPolicyByKind {
  project: SchedulerProjectPolicyV1;
  agent: SchedulerAgentPolicyV1;
  computer: SchedulerComputerPolicyV1;
}
export type SchedulingPolicyKind = keyof SchedulingPolicyByKind;
/** The service wraps its stored record; active is independent from capacity admission. */
export interface SchedulingPolicyResponse<K extends SchedulingPolicyKind = SchedulingPolicyKind> {
  policy: { revision: number; policy: SchedulingPolicyByKind[K] } | null;
  active: boolean;
  capacity_admission: { version: 1; shared_quotas_enabled: boolean; project_quota_enabled: boolean | null };
}
