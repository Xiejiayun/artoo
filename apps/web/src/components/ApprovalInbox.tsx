import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { Approval, ResolveApprovalRequest } from "@artoo/domain";

import { newIdempotencyKey } from "../api/idempotency.js";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";

export interface ApprovalInboxProps {
  taskId: string;
  approvals: Approval[];
}

/**
 * Pending-approval list for a task. Resolving is a platform-gated action: the
 * server applies the decision out-of-band (codex guardrail). No UI path implies
 * resuming a Codex process in place. Each resolve carries a fresh idempotency key.
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

  return (
    <section aria-label="Approvals" className="approval-inbox">
      <h3>Approvals</h3>
      <ul>
        {pending.map((approval) => (
          <li key={approval.id} className="approval" data-risk={approval.risk}>
            <p className="approval-summary">{approval.summary}</p>
            <p className="approval-action">
              <span className="action">{approval.action}</span>
              <span className="risk">{approval.risk}</span>
            </p>
            <div className="approval-actions">
              <button
                type="button"
                disabled={mutation.isPending}
                onClick={() => mutation.mutate({ id: approval.id, body: { decision: "approved" } })}
              >
                Approve
              </button>
              <button
                type="button"
                disabled={mutation.isPending}
                onClick={() => mutation.mutate({ id: approval.id, body: { decision: "rejected" } })}
              >
                Reject
              </button>
              <button
                type="button"
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate({ id: approval.id, body: { decision: "needs_more_info" } })
                }
              >
                Need info
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
