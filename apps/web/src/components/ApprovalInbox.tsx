import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ShieldCheck } from "lucide-react";

import type { Approval, ResolveApprovalRequest } from "@artoo/domain";

import { newIdempotencyKey } from "../api/idempotency.js";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { Badge, Button, Textarea, toneFor } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import "../ui/work-insights.css";

export interface ApprovalInboxProps {
  taskId: string;
  taskStatus?: string;
  approvals: Approval[];
}

/**
 * Pending-approval review cards for a task (#74). Resolving is a platform-gated
 * action: the server applies the decision out-of-band (codex guardrail). No UI
 * path implies resuming a Codex process in place. Each resolve carries a fresh
 * idempotency key. Risk is surfaced via a semantic badge.
 */
export function ApprovalInbox({ taskId, taskStatus, approvals }: ApprovalInboxProps): React.ReactNode {
  const api = useApi();
  const queryClient = useQueryClient();
  const [comments, setComments] = useState<Record<string, string>>({});
  const mutation = useMutation({
    mutationFn: (input: { id: string; body: ResolveApprovalRequest }) =>
      api.resolveApproval(input.id, { ...input.body, ...(comments[input.id]?.trim() ? { comment: comments[input.id]!.trim() } : {}) }, newIdempotencyKey()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
      await queryClient.invalidateQueries({ queryKey: ["approvals"] });
    },
    onError: async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) }); },
  });

  const pending = approvals.filter((approval) => approval.payload_ref !== "execution-gate/superseded" && (approval.status === "pending" || approval.status === "needs_more_info"));
  const consumed = taskStatus === "ready" && approvals.some((approval) => approval.action === "execution.start" && approval.payload_ref !== "execution-gate/superseded" && approval.status === "approved" && approval.run_id != null);
  if (pending.length === 0 && !consumed) {
    return null;
  }

  const busy = mutation.isPending;

  return (
    <section aria-label="Approvals" className="approval-inbox task-detail__section insights-approvals">
      <div className="insights-section-heading"><ShieldCheck size={16} aria-hidden="true" /><h3 className="task-detail__section-title">Approvals</h3><Badge tone="warning">{pending.length} waiting</Badge></div>
      <p className="insights-help">Review the requested action and risk before deciding.</p>
      <details className="insights-disclosure"><summary>How approvals work</summary><p className="insights-help">Execution approvals gate task assignment. Other decisions are recorded for the team; runtime permissions remain controlled on the execution computer.</p></details>
      {consumed && <p role="status">The execution approval was used by a previous run. Request and approve a new execution approval before assigning this task again.</p>}
      <ActionError error={mutation.error} />
      <ul className="approval-list">
        {pending.map((approval) => (
          <li key={approval.id} className="approval-card" data-risk={approval.risk}>
            <div className="approval-card__head">
              <p className="approval-card__summary">{approval.summary}</p>
              <Badge tone={toneFor.risk(approval.risk)}>{approval.risk} risk</Badge>
            </div>
            <p className="approval-card__action">{approval.action === "execution.start" ? "Start task execution" : approval.action}</p>
            {approval.status === "needs_more_info" && <Badge tone="warning">Waiting for more information</Badge>}
            <Textarea label={`Approval comment for ${approval.summary}`} placeholder="Add a comment (optional)…" rows={2} value={comments[approval.id] ?? ""} onChange={(event) => setComments({ ...comments, [approval.id]: event.target.value })} disabled={busy} />
            <div className="approval-card__actions">
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                onClick={() => mutation.mutate({ id: approval.id, body: { decision: "approved" } })}
              >
                Approve
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={() => mutation.mutate({ id: approval.id, body: { decision: "rejected" } })}
              >
                Reject
              </Button>
              {approval.status === "pending" && <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => mutation.mutate({ id: approval.id, body: { decision: "needs_more_info" } })}
              >
                Need info
              </Button>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
