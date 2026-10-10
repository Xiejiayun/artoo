import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { Message } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { Button, Modal, Textarea } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

export function ReportMessageModal({ message, onClose }: { message: Message; onClose: () => void }): React.ReactNode {
  const api = useApi();
  const [reason, setReason] = useState("");
  const report = useMutation({ mutationFn: () => api.reportMessage(message.id, reason.trim(), newIdempotencyKey()) });
  return <Modal open title="Report message" onClose={() => { if (!report.isPending) onClose(); }}>
    {report.isSuccess ? <div className="u-stack"><p role="status">Report received. Your team administrators can now review it.</p>
      <p>Track its status in Settings → My reports.</p><Button onClick={onClose}>Done</Button></div>
      : <form className="u-stack" onSubmit={(event) => { event.preventDefault(); if (reason.trim() && !report.isPending) report.mutate(); }}>
        <p>The selected message and your reason will be visible to your team's administrators.</p>
        <blockquote>{message.body.slice(0, 240)}{message.body.length > 240 ? "…" : ""}</blockquote>
        <Textarea label="Report reason" value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={1000} disabled={report.isPending} />
        <ActionError error={report.error} /><div className="action-row"><Button type="submit" variant="primary" loading={report.isPending} disabled={!reason.trim()}>Send report</Button><Button disabled={report.isPending} onClick={onClose}>Cancel</Button></div>
      </form>}
  </Modal>;
}

export function MyContentReports(): React.ReactNode {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [before, setBefore] = useState<string>();
  const query = useQuery({ queryKey: ["moderation", "my-reports", before], queryFn: () => api.myContentReports(before), enabled: open, refetchInterval: open ? 15000 : false });
  return <section className="settings-section" aria-label="My reports"><header className="settings-section__heading"><div><h2>My reports</h2><p>Follow the messages you reported to your team administrators.</p></div>
    <Button onClick={() => setOpen(!open)}>{open ? "Hide reports" : "View my reports"}</Button></header>
    {open && <div className="settings-section__body u-stack"><ActionError error={query.error} />
      {query.isPending && <p role="status">Loading reports…</p>}
      {query.data?.reports.length === 0 && <p>You have not reported any messages.</p>}
      {query.data?.reports.map((report) => <article key={report.id}><h3>{report.status === "open" ? "Awaiting review" : report.status === "resolved" ? "Message removed" : "Review complete — no removal"}</h3>
        <p>{report.reason}</p><p className="t-subtle">Reported {new Date(report.created_at).toLocaleString()}</p></article>)}
      {query.data?.next_before && <Button onClick={() => setBefore(query.data!.next_before!)}>Earlier reports</Button>}
      {before && <Button onClick={() => setBefore(undefined)}>Latest reports</Button>}
      <Button onClick={() => void query.refetch()} disabled={query.isFetching}>Refresh reports</Button>
    </div>}
  </section>;
}
