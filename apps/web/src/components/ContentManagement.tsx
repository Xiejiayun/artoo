import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ContentReport, ContentRules, ModerationMember } from "../api/contentModeration.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { useApi } from "../app/ApiContext.js";
import { useProject } from "../app/useProject.js";
import { Button, Modal, Textarea } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

export function ContentManagementSettings(): React.ReactNode {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"reports" | "rules" | "members">("reports");
  return <section className="settings-section" aria-label="Content management"><header className="settings-section__heading"><div><h2>Content management</h2><p>Review reported messages, set posting rules and manage abusive members' access.</p></div>
    <Button onClick={() => setOpen(!open)}>{open ? "Close content management" : "Open content management"}</Button></header>
    {open && <div className="settings-section__body u-stack"><nav className="action-row" aria-label="Content management sections">
      <Button aria-pressed={tab === "reports"} onClick={() => setTab("reports")}>Reports</Button>
      <Button aria-pressed={tab === "rules"} onClick={() => setTab("rules")}>Posting rules</Button>
      <Button aria-pressed={tab === "members"} onClick={() => setTab("members")}>Member access</Button>
    </nav>{tab === "reports" ? <ReportQueue /> : tab === "rules" ? <PostingRules /> : <MemberAccess />}</div>}
  </section>;
}
function ReportQueue(): React.ReactNode {
  const api = useApi();
  const [before, setBefore] = useState<string>();
  const [review, setReview] = useState<{ report: ContentReport; action: "remove" | "dismiss" }>();
  const reports = useQuery({ queryKey: ["moderation", "reports", before], queryFn: () => api.contentReports(before), refetchInterval: 15000 });
  return <div className="u-stack"><p>Reports and their original content are private to team administrators. Review incoming reports regularly and respond through your team's support channel.</p>
    <ActionError error={reports.error} />{reports.isPending && <p role="status">Loading reports…</p>}
    {reports.data?.reports.length === 0 && <p>No reports on this page.</p>}
    {reports.data?.reports.map((report) => <article key={report.id} className="u-stack-sm" aria-label={`Report ${report.id}`}>
      <h3>{report.status === "open" ? "Awaiting review" : report.status === "resolved" ? "Message removed" : "Dismissed"}</h3>
      <p>From {report.actor_name ?? report.actor_id} {report.actor_email ? `(${report.actor_email})` : `· ${report.actor_type}`}</p><p>{report.reason}</p><details><summary>View reported content</summary><blockquote style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{report.body_snapshot}</blockquote></details>
      <p className="t-subtle">Reported {new Date(report.created_at).toLocaleString()}</p>
      {report.status === "open" ? <div className="action-row"><Button variant="danger" onClick={() => setReview({ report, action: "remove" })}>Remove message</Button><Button onClick={() => setReview({ report, action: "dismiss" })}>Dismiss report</Button></div> : <p>{report.resolution_note}</p>}
    </article>)}
    <div className="action-row"><Button onClick={() => { setBefore(undefined); void reports.refetch(); }}>Latest reports</Button>{reports.data?.next_before && <Button onClick={() => setBefore(reports.data!.next_before!)}>Earlier reports</Button>}</div>
    {review && <ReviewReport key={`${review.report.id}:${review.action}`} {...review} onClose={() => setReview(undefined)} />}
  </div>;
}
function ReviewReport({ report, action, onClose }: { report: ContentReport; action: "remove" | "dismiss"; onClose: () => void }): React.ReactNode {
  const api = useApi(), query = useQueryClient();
  const [note, setNote] = useState("");
  const save = useMutation({ mutationFn: () => api.resolveContentReport(report.id, action, note.trim(), newIdempotencyKey()),
    onSuccess: async () => { await query.invalidateQueries(); onClose(); } });
  return <Modal open title={action === "remove" ? "Remove this message?" : "Dismiss this report?"} onClose={() => { if (!save.isPending) onClose(); }}>
    <form className="u-stack" onSubmit={(event) => { event.preventDefault(); if (note.trim() && !save.isPending) save.mutate(); }}>
      <p>{action === "remove" ? "Replace the message and its mention preview with a removal notice. Staff report evidence, historical execution records and previously exported copies may still contain the original content." : "Keep the message and mark this report as reviewed."}</p>
      <Textarea label="Private staff note" value={note} onChange={(event) => setNote(event.target.value)} required maxLength={1000} disabled={save.isPending} />
      <ActionError error={save.error} /><div className="action-row"><Button type="submit" variant={action === "remove" ? "danger" : "primary"} disabled={!note.trim()} loading={save.isPending}>Confirm {action === "remove" ? "removal" : "dismissal"}</Button><Button disabled={save.isPending} onClick={onClose}>Cancel</Button></div>
    </form>
  </Modal>;
}
function PostingRules(): React.ReactNode {
  const api = useApi();
  const query = useQuery({ queryKey: ["moderation", "rules"], queryFn: () => api.contentRules() });
  return <div className="u-stack"><ActionError error={query.error} />{query.isPending && <p role="status">Loading posting rules…</p>}
    {query.data && <RulesEditor key={query.data.version} rules={query.data} />}
    <Button disabled={query.isFetching} onClick={() => void query.refetch()}>Reload saved rules</Button>
  </div>;
}
function RulesEditor({ rules }: { rules: ContentRules }): React.ReactNode {
  const api = useApi(), query = useQueryClient();
  const [text, setText] = useState(rules.blocked_phrases.join("\n"));
  const [confirmDisable, setConfirmDisable] = useState(false);
  const phrases = text.split("\n").map((value) => value.trim()).filter(Boolean);
  const save = useMutation({ mutationFn: () => api.saveContentRules(phrases, rules.version, newIdempotencyKey()),
    onSuccess: (result) => { query.setQueryData(["moderation", "rules"], result); setConfirmDisable(false); } });
  function submit(): void { if (rules.blocked_phrases.length > 0 && phrases.length === 0) setConfirmDisable(true); else save.mutate(); }
  return <form className="u-stack" onSubmit={(event) => { event.preventDefault(); if (!save.isPending) submit(); }}>
    <p>These phrases block new team messages and agent requests. Matching ignores case, normalizes whitespace and also matches within words. This is a literal phrase filter, not a complete automated content classifier.</p>
    {rules.blocked_phrases.length === 0 && <p role="status">No phrases are configured. Phrase filtering is currently off.</p>}
    <Textarea label="Blocked phrases, one per line" value={text} onChange={(event) => setText(event.target.value)} disabled={save.isPending} rows={7} />
    <p>Up to 128 phrases, each 3–200 characters. Changes apply to new posts; review existing reports separately.</p>
    <ActionError error={save.error} /><Button type="submit" variant="primary" loading={save.isPending}>Save posting rules</Button>
    {confirmDisable && <Modal open title="Turn off phrase filtering?" onClose={() => { if (!save.isPending) setConfirmDisable(false); }}>
      <p>New posts will no longer be checked against blocked phrases.</p><div className="action-row"><Button variant="danger" loading={save.isPending} onClick={() => save.mutate()}>Turn off filtering</Button><Button disabled={save.isPending} onClick={() => setConfirmDisable(false)}>Keep filtering</Button></div>
    </Modal>}
  </form>;
}
function MemberAccess(): React.ReactNode {
  const api = useApi();
  const { bootstrap } = useProject();
  const [selected, setSelected] = useState<ModerationMember>();
  const members = useQuery({ queryKey: ["moderation", "members"], queryFn: () => api.moderationMembers(), refetchInterval: 15000 });
  return <div className="u-stack"><ActionError error={members.error} />{members.isPending && <p role="status">Loading members…</p>}
    {members.data?.members.map((member) => {
      const suspended = !!member.suspended_at && !member.reinstated_at;
      const permitted = member.id !== bootstrap.data?.user.id && (member.role === "member" || bootstrap.data?.user.role === "owner");
      return <article key={member.id} className="u-stack-sm"><h3>{member.name}</h3><p>{member.email} · {member.role} · {suspended ? "Suspended" : "Active"}</p>
        {permitted && <Button variant={suspended ? "secondary" : "danger"} onClick={() => setSelected(member)}>{suspended ? "Reinstate member" : "Suspend member"}</Button>}
      </article>;
    })}{selected && <ChangeMemberAccess member={selected} onClose={() => setSelected(undefined)} />}
  </div>;
}
function ChangeMemberAccess({ member, onClose }: { member: ModerationMember; onClose: () => void }): React.ReactNode {
  const api = useApi(), query = useQueryClient();
  const [reason, setReason] = useState("");
  const suspended = !!member.suspended_at && !member.reinstated_at;
  const save = useMutation({ mutationFn: () => api.suspendMember(member.id, !suspended, reason.trim(), newIdempotencyKey()),
    onSuccess: async () => { await query.invalidateQueries(); onClose(); } });
  return <Modal open title={`${suspended ? "Reinstate" : "Suspend"} ${member.name}?`} onClose={() => { if (!save.isPending) onClose(); }}>
    <form className="u-stack" onSubmit={(event) => { event.preventDefault(); if (reason.trim() && !save.isPending) save.mutate(); }}>
      <p>{suspended ? "The member can sign in and pair new devices. Previously revoked credentials stay revoked." : "Block sign-in, expire pairing codes and revoke this member's device sessions. Existing agent processes may still run; check Runs and stop any that must be stopped."}</p>
      <Textarea label="Access change reason" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={1000} disabled={save.isPending} />
      <ActionError error={save.error} /><div className="action-row"><Button type="submit" variant={suspended ? "primary" : "danger"} disabled={!reason.trim()} loading={save.isPending}>Confirm {suspended ? "reinstatement" : "suspension"}</Button><Button disabled={save.isPending} onClick={onClose}>Cancel</Button></div>
    </form>
  </Modal>;
}
