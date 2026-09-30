import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { Message } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { useSelection } from "../app/SelectionContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { Badge, Button } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import { planningInstructionTitle } from "./planningInstruction.js";

export function AssistantTurns({ roomId, threadRootId, messages, allowActions = true }: { roomId: string; threadRootId?: string; messages: Message[]; allowActions?: boolean }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const navigate = useNavigate();
  const { setSelectedTaskId } = useSelection();
  const keys = useRef(new Map<string, string>());
  const turns = useQuery({ queryKey: queryKeys.assistantTurns(roomId, threadRootId), queryFn: () => api.listAssistantTurns(roomId, threadRootId), refetchInterval: 8000 });
  const action = useMutation({
    mutationFn: ({ id, name }: { id: string; name: "cancel" | "retry" }) => {
      const logicalAction = `${id}:${name}`;
      const key = keys.current.get(logicalAction) ?? newIdempotencyKey();
      keys.current.set(logicalAction, key);
      return api.assistantTurnAction(id, name, key);
    },
    onSuccess: async (_, { id, name }) => {
      keys.current.delete(`${id}:${name}`);
      await Promise.all([query.invalidateQueries({ queryKey: queryKeys.assistantTurns(roomId) }), query.invalidateQueries({ queryKey: queryKeys.messages(roomId) }), query.invalidateQueries({ queryKey: ["tasks"] })]);
    },
  });
  const visible = turns.data?.turns.filter((turn) => (turn.thread_root_id ?? undefined) === threadRootId);
  if (!visible?.length && !turns.error) return null;
  return <section className="u-stack-sm" aria-label="Agent requests"><h3>Agent requests</h3><ActionError error={turns.error ?? action.error} />{turns.error && <Button size="sm" onClick={() => void turns.refetch()}>Retry agent sync</Button>}
    {visible?.map((turn) => {
      const message = messages.find((message) => message.id === turn.user_message_id);
      const request = planningInstructionTitle(message) ?? message?.body;
      return <article className="product-card u-stack-sm" key={turn.id} aria-label={`Agent request ${request ?? turn.id}`}><div className="action-row"><strong>{request ?? "Agent request"}</strong><Badge tone={turn.status === "completed" ? "success" : turn.status === "failed" || turn.status === "waiting" ? "warning" : "neutral"}>{turn.status}</Badge></div>
        {turn.error && <p>{turn.error}</p>}
        {turn.status === "queued" && <p className="t-subtle">Waiting for an available execution slot.</p>}
        <div className="action-row"><Button size="sm" onClick={() => { setSelectedTaskId(turn.task_id); navigate("/"); }}>Open execution task</Button>
          {allowActions && ["waiting", "failed"].includes(turn.status) && <Button size="sm" disabled={action.isPending} loading={action.isPending && action.variables?.id === turn.id} onClick={() => action.mutate({ id: turn.id, name: "retry" })}>Retry agent request</Button>}
          {allowActions && ["queued", "running", "waiting"].includes(turn.status) && <Button size="sm" variant="danger" disabled={action.isPending} onClick={() => action.mutate({ id: turn.id, name: "cancel" })}>Cancel agent request</Button>}
        </div>
      </article>;
    })}
  </section>;
}
