import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { Approval, ResolveApprovalRequest } from "@artoo/domain";

import { newIdempotencyKey } from "../api/idempotency.js";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { Badge, Button, toneFor } from "../ui/index.js";

export interface ApprovalInboxProps {
  taskId: string;
  approvals: Approval[];
}

/**
 * Pending-approval review cards for a task (#74). Resolving is a platform-gated
 * action: the server applies the decision out-of-band (codex guardrail). No UI
 * path implies resuming a Codex process in place. Each resolve carries a fresh
 * idempotency key. Risk is surfaced via a semantic badge.
 */
export function ApprovalInbox({ taskId, approvals }: ApprovalInboxProps): React.ReactNode {
  const api = useApi();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (input: { id: string; body: ResolveApprovalRequest }) =>
      api.resolveApproval(input.id, input.body, newIdempotencyKey()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.approvals("pending") });
    },
  });

  const pending = approvals.filter((approval) => approval.status === "pending");
  if (pending.length === 0) {
    return null;
  }

  const busy = mutation.isPending;

  return (
    <section aria-label="Approvals" className="approval-inbox task-detail__section">
      <h3 className="task-detail__section-title">Approvals</h3>
      <ul className="approval-list">
        {pending.map((approval) => (
          <li key={approval.id} className="approval-card" data-risk={approval.risk}>
            <div className="approval-card__head">
              <p className="approval-card__summary">{approval.summary}</p>
              <Badge tone={toneFor.risk(approval.risk)}>{approval.risk} risk</Badge>
            </div>
            <p className="approval-card__action t-mono">{approval.action}</p>
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
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => mutation.mutate({ id: approval.id, body: { decision: "needs_more_info" } })}
              >
                Need info
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
