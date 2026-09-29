import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { Task } from "@artoo/domain";

import { newIdempotencyKey } from "../api/idempotency.js";
import { useApi, useCommands } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { Button, Select, Textarea } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

/**
 * Status-aware task lifecycle controls. Drives the happy path from the UI:
 * backlog → Mark ready → ready → Assign → running …; blocked → Retry. Each
 * mutation runs through the canonical @artoo/client command queue (#27 dogfood)
 * with a stable idempotency key, so a flaky/offline send is queued and replayed
 * once on reconnect rather than lost or double-applied. Then it refreshes the
 * task snapshot + project list.
 */
export function TaskActions({ task }: { task: Task }): React.ReactNode {
  const api = useApi();
  const commands = useCommands();
  const queryClient = useQueryClient();
  const [assignee, setAssignee] = useState("");
  const [approvalSummary, setApprovalSummary] = useState("");
  const [approvalRisk, setApprovalRisk] = useState<"low" | "medium" | "high">("medium");
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap(), enabled: task.status === "ready" });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.task(task.id) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.tasks(task.project_id) });
  };

  const ready = useMutation({
    mutationFn: () => {
      const key = newIdempotencyKey();
      return commands.submit(() => api.markReady(task.id, key), { key });
    },
    onSuccess: invalidate,
  });
  const assign = useMutation({
    mutationFn: () => {
      const key = newIdempotencyKey();
      return commands.submit(() => api.assignTask(task.id, assignee ? { mode: "manual", agent_instance_id: assignee } : { mode: "auto" }, key), { key });
    },
    onSuccess: invalidate,
  });
  const retry = useMutation({
    mutationFn: () => {
      const key = newIdempotencyKey();
      return commands.submit(() => api.retryTask(task.id, {}, key), { key });
    },
    onSuccess: invalidate,
  });

  const requestApproval = useMutation({
    mutationFn: () => api.requestExecutionApproval(task.id, { summary: approvalSummary.trim(), risk: approvalRisk }, newIdempotencyKey()),
    onSuccess: async () => { setApprovalSummary(""); await invalidate(); await queryClient.invalidateQueries({ queryKey: ["approvals"] }); },
  });

  const busy = ready.isPending || assign.isPending || retry.isPending || requestApproval.isPending;

  if (task.status !== "backlog" && task.status !== "ready" && task.status !== "blocked") {
    return null;
  }

  return (
    <div className="task-actions">
      <ActionError error={ready.error ?? assign.error ?? retry.error ?? requestApproval.error} />
      {task.status === "backlog" ? (
        <Button variant="primary" loading={ready.isPending} disabled={busy} onClick={() => ready.mutate()}>
          Mark ready
        </Button>
      ) : null}
      {task.status === "ready" ? (
        <><Select label="Assignment" value={assignee} onChange={(event) => setAssignee(event.target.value)} disabled={busy}><option value="">Automatic selection</option>{bootstrap.data?.agent_instances.filter((instance) => instance.status !== "disabled").map((instance) => <option key={instance.id} value={instance.id}>{bootstrap.data.agents.find((agent) => agent.id === instance.agent_id)?.display_name ?? instance.id} · {instance.runtime}</option>)}</Select>
        <Button variant="primary" loading={assign.isPending} disabled={busy} onClick={() => assign.mutate()}>
          Assign
        </Button>
        <details className="product-card"><summary>Require approval before execution</summary><form className="u-stack" aria-label="Request execution approval" onSubmit={(event) => { event.preventDefault(); requestApproval.mutate(); }}>
          <p>Assignment waits until the latest execution approval is approved.</p>
          <Textarea label="Execution approval summary" value={approvalSummary} required maxLength={2000} onChange={(event) => setApprovalSummary(event.target.value)} />
          <Select label="Execution approval risk" value={approvalRisk} onChange={(event) => setApprovalRisk(event.target.value as "low" | "medium" | "high")}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></Select>
          <Button type="submit" disabled={busy || !approvalSummary.trim()} loading={requestApproval.isPending}>Request execution approval</Button>
        </form></details></>
      ) : null}
      {task.status === "blocked" ? (
        <Button variant="primary" loading={retry.isPending} disabled={busy} onClick={() => retry.mutate()}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}
