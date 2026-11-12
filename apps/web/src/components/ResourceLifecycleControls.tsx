import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { ResourceLifecycle } from "@artoo/domain";
import { newIdempotencyKey } from "../api/idempotency.js";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { Badge, Button, Modal } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

export function ResourceLifetime({ lifecycle }: { lifecycle?: ResourceLifecycle }): React.ReactNode {
  if (!lifecycle) return null;
  const expired = lifecycle.state === "expired";
  return <div className="resource-lifetime">
    <div className="action-row"><Badge tone={expired ? "warning" : "neutral"}>{expired ? "Expired" : "Auto expiry"}</Badge><span>After {lifecycle.inactivity_timeout_ms / 86400000} days offline</span></div>
    <dl className="inv-meta"><div className="inv-row"><dt>Last active</dt><dd>{lifecycle.last_seen_at ? <time dateTime={lifecycle.last_seen_at}>{new Date(lifecycle.last_seen_at).toLocaleString()}</time> : "Not reported"}</dd></div>
      <div className="inv-row"><dt>{expired ? "Expired at" : "Expires if inactive until"}</dt><dd><time dateTime={lifecycle.expires_at}>{new Date(lifecycle.expires_at).toLocaleString()}</time></dd></div></dl>
    {expired && <p className="resource-muted">Reconnect the computer and its runtime to restore availability.</p>}
  </div>;
}

export function DeleteResource({ kind, id, name, role }: { kind: "computer" | "agent" | "instance"; id: string; name: string; role: string }): React.ReactNode {
  const api = useApi(), query = useQueryClient();
  const [open, setOpen] = useState(false);
  const label = kind === "instance" ? "instance" : kind;
  const mutation = useMutation({ mutationFn: () => {
    const key = newIdempotencyKey();
    return kind === "computer" ? api.deleteComputer(id, key) : kind === "agent" ? api.deleteAgent(id, key) : api.deleteAgentInstance(id, key);
  }, onSuccess: async () => {
    setOpen(false);
    await Promise.all([query.invalidateQueries({ queryKey: queryKeys.bootstrap }), query.invalidateQueries({ queryKey: queryKeys.daemons })]);
  } });
  if (!["owner", "admin"].includes(role)) return null;
  return <><Button size="sm" variant="danger" iconLeft={Trash2} onClick={() => { mutation.reset(); setOpen(true); }}>Delete {label}</Button>
    <Modal open={open} title={`Delete ${label}`} onClose={() => { if (!mutation.isPending) setOpen(false); }}>
      <div className="u-stack"><p>Delete <strong>{name}</strong>?</p>
        <p>{kind === "computer" ? "Disconnects this computer, revokes its device credentials and removes all its agent instances." : kind === "agent" ? "Removes this Agent and all its instances from your resources." : "Removes this workspace instance. The reusable Agent stays in your library."} Historical tasks and audit records are retained. Workspace files stay on the computer.</p>
        <p>Active work must be stopped before deletion.</p><ActionError error={mutation.error} />
        <div className="action-row"><Button disabled={mutation.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" loading={mutation.isPending} onClick={() => mutation.mutate()}>Confirm deletion</Button></div>
      </div>
    </Modal>
  </>;
}
