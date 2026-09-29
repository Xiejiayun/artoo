import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BlockerTypeSchema, type BlockerType } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { Badge, Button, Input, Select, Textarea } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

export function CollaborationPanel({ roomId, taskId, goalId }: { roomId: string; taskId?: string; goalId?: string }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  const records = useQuery({ queryKey: ["collaboration", roomId], queryFn: async () => {
    const [decisions, handoffs, blockers] = await Promise.all([api.listDecisions(roomId), api.listHandoffs(roomId), api.listBlockers(roomId)]);
    return { ...decisions, ...handoffs, ...blockers };
  }, refetchInterval: 10000 });
  const [kind, setKind] = useState<"decision" | "handoff" | "blocker">("decision");
  const [summary, setSummary] = useState("");
  const [detail, setDetail] = useState("");
  const [recipient, setRecipient] = useState("");
  const [blockerType, setBlockerType] = useState<BlockerType>("human_input");
  const refresh = async (): Promise<void> => { await Promise.all([query.invalidateQueries({ queryKey: ["collaboration", roomId] }), query.invalidateQueries({ queryKey: queryKeys.messages(roomId) }), query.invalidateQueries({ queryKey: ["goals"] })]); };
  const create = useMutation({ mutationFn: async () => {
    const user = bootstrap.data?.user;
    if (!user) throw new Error("Wait for your account to load before creating a record.");
    const key = newIdempotencyKey();
    const links = { task_id: taskId, goal_id: goalId };
    if (kind === "decision") return api.createDecision(roomId, { ...links, actor_type: "user", actor_id: user.id, summary: summary.trim(), rationale: detail.trim(), alternatives: [], evidence_refs: [] }, key);
    if (kind === "blocker") return api.createBlocker(roomId, { ...links, owner_type: "user", owner_id: user.id, type: blockerType, source_kind: "manual", summary: summary.trim(), next_action: detail.trim() }, key);
    const [recipient_type, ...id] = recipient.split(":");
    if ((recipient_type !== "user" && recipient_type !== "agent") || !id.length) throw new Error("Choose a handoff recipient.");
    return api.createHandoff(roomId, { ...links, sender_type: "user", sender_id: user.id, recipient_type, recipient_id: id.join(":"), expected_action: summary.trim(), blocking_condition: detail.trim() }, key);
  }, onSuccess: async () => { setSummary(""); setDetail(""); await refresh(); } });
  const update = useMutation({ mutationFn: (run: () => Promise<unknown>) => run(), onSuccess: refresh });
  return <section className="collaboration-panel u-stack" aria-label="Team collaboration">
    <h3>Team collaboration</h3><ActionError error={records.error ?? create.error ?? update.error} />
    {records.isLoading && <p role="status">Loading collaboration…</p>}
    <details className="product-card"><summary>Add decision, handoff, or blocker</summary>
      <form className="u-stack" onSubmit={(event) => { event.preventDefault(); create.mutate(); }}>
        <Select label="Record type" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="decision">Decision</option><option value="handoff">Handoff</option><option value="blocker">Blocker</option></Select>
        <Input label={kind === "handoff" ? "Expected action" : "Summary"} required value={summary} onChange={(event) => setSummary(event.target.value)} />
        <Textarea label={kind === "decision" ? "Rationale" : kind === "handoff" ? "Blocking condition" : "Next action"} value={detail} onChange={(event) => setDetail(event.target.value)} />
        {kind === "handoff" && <Select label="Recipient" required value={recipient} onChange={(event) => setRecipient(event.target.value)}><option value="">Choose recipient</option>{bootstrap.data && <option value={`user:${bootstrap.data.user.id}`}>{bootstrap.data.user.display_name} (you)</option>}{bootstrap.data?.agents.map((agent) => <option key={agent.id} value={`agent:${agent.id}`}>{agent.display_name}</option>)}</Select>}
        {kind === "blocker" && <Select label="Blocker type" value={blockerType} onChange={(event) => setBlockerType(event.target.value as BlockerType)}>{BlockerTypeSchema.options.map((type) => <option key={type}>{type}</option>)}</Select>}
        <Button type="submit" variant="primary" loading={create.isPending} disabled={!summary.trim()}>Save record</Button>
      </form>
    </details>
    <h4>Decisions</h4>{records.data?.decisions.length === 0 && <p>No decisions recorded.</p>}{records.data?.decisions.map((decision) => <article key={decision.id} className="product-card"><div className="action-row"><strong>{decision.summary}</strong><Badge>{decision.status}</Badge></div><p>{decision.rationale}</p>{decision.status === "proposed" && <div className="action-row"><Button size="sm" disabled={update.isPending} onClick={() => update.mutate(() => api.updateDecision(decision.id, { status: "accepted" }, newIdempotencyKey()))}>Accept decision</Button><Button size="sm" disabled={update.isPending} onClick={() => update.mutate(() => api.updateDecision(decision.id, { status: "rejected" }, newIdempotencyKey()))}>Reject decision</Button></div>}</article>)}
    <h4>Handoffs</h4>{records.data?.handoffs.length === 0 && <p>No handoffs recorded.</p>}{records.data?.handoffs.map((handoff) => <article key={handoff.id} className="product-card"><div className="action-row"><strong>{handoff.expected_action}</strong><Badge>{handoff.status}</Badge></div><p>{handoff.sender_id} → {handoff.recipient_id}</p>{handoff.blocking_condition && <p>Waiting on: {handoff.blocking_condition}</p>}{["open", "accepted"].includes(handoff.status) && <div className="action-row"><Button size="sm" disabled={update.isPending} onClick={() => update.mutate(() => api.updateHandoff(handoff.id, { status: handoff.status === "open" ? "accepted" : "completed" }, newIdempotencyKey()))}>{handoff.status === "open" ? "Accept handoff" : "Complete handoff"}</Button><Button size="sm" disabled={update.isPending} onClick={() => update.mutate(() => api.updateHandoff(handoff.id, { status: "cancelled" }, newIdempotencyKey()))}>Cancel handoff</Button></div>}</article>)}
    <h4>Blockers</h4>{records.data?.blockers.length === 0 && <p>No blockers recorded.</p>}{records.data?.blockers.map((blocker) => <article key={blocker.id} className="product-card"><div className="action-row"><strong>{blocker.summary}</strong><Badge tone={blocker.status === "resolved" ? "success" : "warning"}>{blocker.status}</Badge></div><p>{blocker.type} · {blocker.owner_id}</p><p>{blocker.next_action}</p>{["open", "mitigated"].includes(blocker.status) && <Button size="sm" disabled={update.isPending} onClick={() => update.mutate(() => api.updateBlocker(blocker.id, { status: "resolved" }, newIdempotencyKey()))}>Resolve blocker</Button>}</article>)}
  </section>;
}
