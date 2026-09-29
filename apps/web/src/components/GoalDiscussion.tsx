import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { canProposePlan, type Goal, type StartDiscussionRequest } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { Badge, Button, Input, Select } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import { RoomConversation } from "./RoomConversation.js";

/** Discussion produces a proposal; the existing plan accept action creates work. */
export function GoalDiscussion({ goal }: { goal: Goal }): React.ReactNode {
  const api = useApi(), query = useQueryClient();
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [rounds, setRounds] = useState(2), [minutes, setMinutes] = useState(15);
  const [roomId, setRoomId] = useState("");
  const [openThread, setOpenThread] = useState<string | null>(null);
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  const channels = useQuery({ queryKey: ["channels", goal.project_id], queryFn: () => api.listChannels(goal.project_id) });
  const sessions = useQuery({ queryKey: ["discussions", goal.id], queryFn: () => api.listDiscussions(goal.id), refetchInterval: 5000 });
  useSubscription(goal.room_id ? [`room:${goal.room_id}`] : []);
  const refresh = async () => { await Promise.all([
    query.invalidateQueries({ queryKey: ["discussions", goal.id] }), query.invalidateQueries({ queryKey: ["plans", goal.id] }),
  ]); };
  const start = useMutation({ mutationFn: (body: StartDiscussionRequest) => api.startDiscussion(goal.id, body, newIdempotencyKey()),
    onSuccess: async ({ discussion }) => { setOpenThread(discussion.id); await refresh(); }, onError: refresh });
  const action = useMutation({ mutationFn: ({ id, name }: { id: string; name: "cancel" | "propose" }) => name === "cancel"
    ? api.cancelDiscussion(id, newIdempotencyKey()) : api.proposeDiscussionPlan(id, newIdempotencyKey()), onSuccess: refresh, onError: refresh });
  const active = sessions.data?.discussions.some((discussion) => ["running", "stopping"].includes(discussion.status));
  const members = Object.entries(selected).map(([agent_instance_id, role]) => ({ agent_instance_id, role: role.trim() }));
  return <section className="product-card u-stack" aria-label="Agent planning">
    <h3>Agent planning</h3>
    <p>Agents discuss the objective, review one another’s proposals, and produce tasks with dependencies and acceptance criteria. Review and accept the resulting plan to create the tasks.</p>
    <ActionError error={bootstrap.error ?? sessions.error ?? channels.error ?? start.error ?? action.error} />
    {canProposePlan(goal.status, !!goal.current_plan_id) && <form className="u-stack-sm" onSubmit={(event) => {
      event.preventDefault(); start.mutate({ participants: members, rounds, max_minutes: minutes, ...(roomId ? { room_id: roomId } : {}) });
    }}>
      <fieldset disabled={active || start.isPending}><legend>Choose 2–6 agents and their roles</legend>
        {bootstrap.data?.agent_instances.map((instance) => {
          const checked = Object.hasOwn(selected, instance.id);
          const name = bootstrap.data.agents.find((agent) => agent.id === instance.agent_id)?.display_name ?? instance.runtime;
          const computer = bootstrap.data.computers.find((node) => node.id === instance.computer_id)?.display_name ?? instance.computer_id;
          return <div key={instance.id} className="u-stack-sm"><label><input type="checkbox" checked={checked} disabled={!checked && members.length >= 6} onChange={(event) => setSelected((current) => {
            const next = { ...current }; if (event.target.checked) next[instance.id] = Object.keys(current).length === 0 ? "Design and synthesis" : "Review and verification"; else delete next[instance.id]; return next;
          })} /> {name} · {computer} · {instance.status}</label>
            {checked && <Input label={`${name} discussion role`} value={selected[instance.id]} required maxLength={200} onChange={(event) => setSelected({ ...selected, [instance.id]: event.target.value })} />}
          </div>;
        })}
        {(bootstrap.data?.agent_instances.length ?? 0) < 2 && <p>Connect at least two agent instances to start a discussion.</p>}
        <div className="action-row"><Input label="Discussion rounds" type="number" min={1} max={3} value={rounds} required onChange={(event) => setRounds(Number(event.target.value))} />
          <Input label="Discussion time limit (minutes)" type="number" min={2} max={60} value={minutes} required onChange={(event) => setMinutes(Number(event.target.value))} /></div>
        <Select label="Discussion location" value={roomId} onChange={(event) => setRoomId(event.target.value)}><option value="">This goal’s conversation</option>{channels.data?.channels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</Select>
      </fieldset>
      <p className="t-subtle">Each round asks every selected agent, then the first agent writes a synthesis. Planning uses read-only runtime tools and may incur model usage. Waiting for an offline agent counts toward the time limit.</p>
      <Button type="submit" variant="primary" loading={start.isPending} disabled={active || sessions.isLoading || !!sessions.error || members.length < 2 || members.some((member) => !member.role)}>Start planning discussion</Button>
    </form>}
    {sessions.isLoading && <p role="status">Loading discussions…</p>}
    {sessions.data?.discussions.map((discussion) => <article className="product-card u-stack-sm" key={discussion.id}>
      <div className="action-row"><strong>Discussion · {new Date(discussion.created_at).toLocaleString()}</strong><Badge tone={discussion.status === "ready" ? "success" : discussion.status === "failed" ? "warning" : "neutral"}>{discussion.status}</Badge></div>
      <p role="status">{discussion.current_step} of {discussion.total_steps} contributions completed · {discussion.rounds} rounds · {discussion.max_minutes} minute limit</p>
      {discussion.error && <p>{discussion.error}</p>}
      {discussion.status === "stopping" && <p>Stopping the active agent. Waiting for its daemon to confirm the process has exited.</p>}
      <div className="action-row"><Button size="sm" onClick={() => setOpenThread(openThread === discussion.id ? null : discussion.id)}>{openThread === discussion.id ? "Close discussion" : "Open discussion thread"}</Button>
        {["running", "stopping"].includes(discussion.status) && <Button size="sm" variant="danger" disabled={action.isPending} onClick={() => action.mutate({ id: discussion.id, name: "cancel" })}>Stop discussion</Button>}
        {discussion.status === "ready" && !discussion.plan_id && <Button size="sm" variant="primary" disabled={action.isPending} onClick={() => action.mutate({ id: discussion.id, name: "propose" })}>Create plan proposal</Button>}
        {discussion.plan_id && <span>A plan proposal is available in Plans below.</span>}
      </div>
      {openThread === discussion.id && <RoomConversation key={discussion.thread_root_id} roomId={discussion.room_id} threadRootId={discussion.thread_root_id} allowAssistant={false} />}
    </article>)}
  </section>;
}
