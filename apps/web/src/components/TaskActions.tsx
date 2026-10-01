import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ArrowRight, Bot, Monitor, RotateCcw, ShieldCheck, Sparkles } from "lucide-react";

import type { Approval, Task } from "@artoo/domain";

import { newIdempotencyKey } from "../api/idempotency.js";
import { useApi, useCommands } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { Button, PresenceBadge, Select, Textarea } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import "../ui/work-management.css";

function executionApprovalBlockReason(taskId: string, approvals: readonly Approval[]): string | undefined {
  // Match assertExecutionApprovalGranted: history without exactly one current
  // gate stays blocked, and only its approved, unconsumed request permits work.
  const gates = approvals.filter((approval) => approval.task_id === taskId && approval.action === "execution.start");
  if (gates.length === 0) return undefined;
  const current = gates.filter((approval) => approval.payload_ref !== "execution-gate/superseded");
  const gate = current[0];
  const unverified = "Execution approval could not be verified. Request a new execution review before assigning this task.";
  if (current.length !== 1 || gate?.payload_ref !== "execution-gate/current") return unverified;
  if (gate.run_id != null) return "The execution approval was used by a previous run. Request and approve a new execution review before assigning this task again.";
  if (gate.run_id !== null) return unverified;
  switch (gate.status) {
    case "approved": return undefined;
    case "pending": return "Execution approval is pending. Approve the current request before assigning this task.";
    case "needs_more_info": return "Execution approval needs more information. Update the request and obtain approval before assigning this task.";
    case "rejected": return "Execution approval was rejected. Request and approve a new execution review before assigning this task.";
    case "expired": return "Execution approval has expired. Request and approve a new execution review before assigning this task.";
    default: return unverified;
  }
}

/**
 * Status-aware task lifecycle controls. Drives the happy path from the UI:
 * backlog → Mark ready → ready → Assign → running …; blocked → Retry. Each
 * mutation runs through the canonical @artoo/client command queue (#27 dogfood)
 * with a stable idempotency key, so a flaky/offline send is queued and replayed
 * once on reconnect rather than lost or double-applied. Then it refreshes the
 * task snapshot + project list.
 * Disabled approval feedback follows docs/production-ui-gate.md §9.
 */
export function TaskActions({ task, approvals }: { task: Task; approvals: readonly Approval[] }): React.ReactNode {
  const api = useApi();
  const commands = useCommands();
  const queryClient = useQueryClient();
  const [assignee, setAssignee] = useState("");
  const [branchBacked, setBranchBacked] = useState(false);
  const [assigneeLabel, setAssigneeLabel] = useState("");
  const [approvalSummary, setApprovalSummary] = useState("");
  const [approvalRisk, setApprovalRisk] = useState<"low" | "medium" | "high">("medium");
  const approvalReasonId = useId();
  const worktreeHelpId = useId();
  const availabilityReasonId = useId();
  const approvalBlockReason = executionApprovalBlockReason(task.id, approvals);
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap(), enabled: task.status === "ready" });
  const instances = bootstrap.data?.agent_instances.filter((instance) => instance.status !== "disabled" && instance.config.enabled !== false) ?? [];
  const assigneeUnavailable = !!assignee && !!bootstrap.data && !instances.some((instance) => instance.id === assignee);
  const assignmentLabel = (instance: (typeof instances)[number]): string => {
    const computer = bootstrap.data?.computers.find((item) => item.id === instance.computer_id);
    const agent = bootstrap.data?.agents.find((item) => item.id === instance.agent_id);
    return `${agent?.display_name ?? instance.id} · ${computer?.display_name ?? instance.computer_id} · ${instance.runtime}${computer ? ` · ${computer.status}` : ""}`;
  };

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
      if (assigneeUnavailable) throw new Error("Choose an available agent or Automatic selection before assigning work.");
      const key = newIdempotencyKey();
      const body = { ...(assignee ? { mode: "manual" as const, agent_instance_id: assignee } : { mode: "auto" as const }), ...(branchBacked ? { branch_backed: true } : {}) };
      return commands.submit(() => api.assignTask(task.id, body, key), { key });
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
  const selectedInstance = bootstrap.data?.agent_instances.find((instance) => instance.id === assignee);
  const selectedAgent = bootstrap.data?.agents.find((agent) => agent.id === selectedInstance?.agent_id);
  const selectedComputer = bootstrap.data?.computers.find((computer) => computer.id === selectedInstance?.computer_id);

  if (task.status !== "backlog" && task.status !== "ready" && task.status !== "blocked") {
    return null;
  }

  return (
    <div className="work-task-actions">
      <ActionError error={ready.error ?? assign.error ?? retry.error ?? requestApproval.error} />
      {task.status === "backlog" ? (
        <div className="work-next-step">
          <div><span className="work-eyebrow">Next step</span><p>Ready to hand off?</p><span>Check the brief and acceptance criteria, then choose an agent.</span></div>
          <Button variant="primary" iconRight={ArrowRight} loading={ready.isPending} disabled={busy} onClick={() => ready.mutate()}>Mark ready</Button>
        </div>
      ) : null}
      {task.status === "ready" ? (
        <>
          <div className="work-assignment">
            <div className="work-assignment__heading"><Bot size={17} aria-hidden="true" /><h3>Assign work</h3></div>
            <Select label="Assignment" value={assignee} onChange={(event) => {
              const selected = instances.find((instance) => instance.id === event.target.value);
              setAssignee(event.target.value);
              setAssigneeLabel(selected ? assignmentLabel(selected) : "");
            }} disabled={busy}>
              <option value="">Automatic selection</option>
              {assigneeUnavailable ? <option value={assignee} disabled>{assigneeLabel || "Selected agent"} · no longer available</option> : null}
              {instances.map((instance) => <option key={instance.id} value={instance.id}>{assignmentLabel(instance)}</option>)}
            </Select>
            <div className="work-assignment__summary">
              {assignee ? <>
                <Monitor size={17} aria-hidden="true" />
                <div><strong>{selectedAgent?.display_name ?? (assigneeUnavailable ? "Selected agent unavailable" : assignee)}</strong><span>{selectedComputer?.display_name ?? selectedInstance?.computer_id ?? (assigneeUnavailable ? assigneeLabel : "Computer details unavailable")}{selectedInstance ? ` · ${selectedInstance.runtime}` : ""}</span></div>
                {selectedComputer ? <PresenceBadge presence={selectedComputer.status} /> : null}
              </> : <><Sparkles size={17} aria-hidden="true" /><div><strong>Let Artoo choose</strong><span>Match the task to an eligible agent and computer.</span></div></>}
            </div>
            {bootstrap.isLoading ? <p className="work-help">Loading agents and computers…</p> : null}
            {bootstrap.isError ? <div className="work-assignment__feedback"><p className="work-help">Agent choices could not be loaded. Automatic assignment is still available.</p><Button size="sm" variant="ghost" onClick={() => void bootstrap.refetch()}>Reload agents</Button></div> : null}
            {bootstrap.isSuccess && instances.length === 0 ? <p className="work-help">No enabled agents are registered. Add an agent in Agents before assigning work.</p> : null}
            {assignee && selectedComputer && selectedComputer.status !== "online" ? <p className="work-help">This computer is {selectedComputer.status}. Check its connection before assigning work.</p> : null}
            {assigneeUnavailable ? <p className="work-assignment__approval" id={availabilityReasonId} role="status">This agent is no longer available for assignment. Choose another agent or Automatic selection.</p> : null}
            {approvalBlockReason && <p className="work-assignment__approval" id={approvalReasonId} role="status">{approvalBlockReason}</p>}
            <div className="assignment-worktree u-stack-sm">
              <label><input type="checkbox" checked={branchBacked} onChange={(event) => setBranchBacked(event.target.checked)} disabled={busy} aria-describedby={worktreeHelpId} /> Use an isolated Git worktree</label>
              <p className="work-help" id={worktreeHelpId}>Requires a Git repository configured on the execution computer and an unused workspace path. Use a different workspace when previous failed or cancelled work is retained.</p>
            </div>
            <Button variant="primary" className="work-assignment__submit" iconRight={ArrowRight} loading={assign.isPending} disabled={busy || !!approvalBlockReason || assigneeUnavailable} aria-describedby={[approvalBlockReason ? approvalReasonId : "", assigneeUnavailable ? availabilityReasonId : ""].filter(Boolean).join(" ") || undefined} onClick={() => assign.mutate()}>Assign</Button>
          </div>
          <details className="work-execution-review">
            <summary><ShieldCheck size={16} aria-hidden="true" /><span>Require approval before execution</span></summary>
            <form className="u-stack" aria-label="Request execution approval" onSubmit={(event) => { event.preventDefault(); if (!busy && approvalSummary.trim()) requestApproval.mutate(); }}>
              <p className="work-help">Assignment waits until the latest execution approval is approved.</p>
              <Textarea label="Execution approval summary" placeholder="What should be reviewed before this work starts?" value={approvalSummary} required maxLength={2000} disabled={busy} onChange={(event) => setApprovalSummary(event.target.value)} />
              <Select label="Execution approval risk" value={approvalRisk} disabled={busy} onChange={(event) => setApprovalRisk(event.target.value as "low" | "medium" | "high")}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></Select>
              <Button type="submit" disabled={busy || !approvalSummary.trim()} loading={requestApproval.isPending}>Request execution approval</Button>
            </form>
          </details>
        </>
      ) : null}
      {task.status === "blocked" ? (
        <div className="work-next-step"><div><span className="work-eyebrow">Needs attention</span><p>Work is blocked</p><span>Review the run details, resolve the blocker, and try again.</span></div><Button variant="primary" iconLeft={RotateCcw} loading={retry.isPending} disabled={busy} onClick={() => retry.mutate()}>Retry</Button></div>
      ) : null}
    </div>
  );
}
