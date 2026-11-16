import { AgentKindSchema, CAPABILITIES, LogicalAgentConfigurationV1Schema, type LogicalAgentConfigurationRecordV1, type LogicalAgentConfigurationV1 } from "@artoo/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { Button, Input, Modal, Select, Textarea } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import { CAPABILITY_LABELS } from "./taskPresentation.js";

const empty: LogicalAgentConfigurationV1 = { version: 1, display_name: "", kind: "coding", capabilities: [], role: "", description: "", instructions: "" };
function ConfigurationForm({ initial, onSaved }: { initial?: LogicalAgentConfigurationRecordV1; onSaved: () => void }): React.ReactNode {
  const api = useApi(), query = useQueryClient();
  const [base] = useState(initial);
  const [draft, setDraft] = useState(initial?.configuration ?? empty);
  // Keep the request key across failed retries; changing the submitted payload gets a new key.
  const [submission, setSubmission] = useState<{ payload: string; key: string } | null>(null);
  const save = useMutation({ mutationFn: async () => {
    const configuration = LogicalAgentConfigurationV1Schema.parse(draft);
    if (base) return api.putAgentConfiguration(base.agent_id, base.revision, configuration);
    const payload = JSON.stringify(configuration);
    const key = submission?.payload === payload ? submission.key : newIdempotencyKey();
    setSubmission({ payload, key });
    return api.createLogicalAgent(configuration, key);
  }, onSuccess: async () => { await query.invalidateQueries({ queryKey: queryKeys.bootstrap }); if (initial) await query.invalidateQueries({ queryKey: queryKeys.agentConfiguration(initial.agent_id) }); onSaved(); } });
  const patch = (value: Partial<LogicalAgentConfigurationV1>): void => setDraft((current) => ({ ...current, ...value }));
  return <form className="cowork-resource-form u-stack" aria-label="Logical Agent configuration" onSubmit={(event) => { event.preventDefault(); if (!save.isPending) save.mutate(); }}><p>An Agent is a shared identity and role. Create execution instances on connected machines separately.</p><fieldset disabled={save.isPending} className="u-stack-sm"><Input label="Agent name" required maxLength={160} value={draft.display_name} onChange={(event) => patch({ display_name: event.target.value })} /><Select label="Agent kind" value={draft.kind} onChange={(event) => patch({ kind: event.target.value as LogicalAgentConfigurationV1["kind"] })}>{AgentKindSchema.options.map((kind) => <option key={kind} value={kind}>{kind.replaceAll("_", " ")}</option>)}</Select><Input label="Team role" maxLength={160} value={draft.role} onChange={(event) => patch({ role: event.target.value })} /><Textarea label="Agent description" maxLength={4000} value={draft.description} onChange={(event) => patch({ description: event.target.value })} /><Textarea label="Agent instructions" maxLength={32000} value={draft.instructions} onChange={(event) => patch({ instructions: event.target.value })} helperText="Guidance is saved for future Runs. Existing Runs keep their original context and permissions." /><fieldset className="cowork-capability-options"><legend>Declared capabilities</legend>{CAPABILITIES.map((capability) => <label key={capability}><input type="checkbox" checked={draft.capabilities.includes(capability)} onChange={(event) => patch({ capabilities: event.target.checked ? [...draft.capabilities, capability] : draft.capabilities.filter((value) => value !== capability) })} />{CAPABILITY_LABELS[capability] ?? capability}</label>)}</fieldset><p>Actual runtime support is reported by each machine. Declaring a capability does not install a tool or authorize execution.</p><Button variant="primary" type="submit" loading={save.isPending} disabled={!draft.display_name.trim()}>{initial ? "Save Agent configuration" : "Create Agent"}</Button></fieldset><ActionError error={save.error} />{save.isError && <p>Your draft is retained. If the configuration changed elsewhere, close and reopen to load its latest revision.</p>}</form>;
}
function ExistingConfiguration({ agentId, onSaved }: { agentId: string; onSaved: () => void }): React.ReactNode {
  const api = useApi();
  const configuration = useQuery({ queryKey: queryKeys.agentConfiguration(agentId), queryFn: () => api.getAgentConfiguration(agentId), refetchOnWindowFocus: false });
  if (!configuration.data) return <><ActionError error={configuration.error} /><Button loading={configuration.isFetching} onClick={() => void configuration.refetch()}>Load Agent configuration</Button></>;
  return <ConfigurationForm initial={configuration.data.configuration} onSaved={onSaved} />;
}
export function LogicalAgentEditor({ agentId, role }: { agentId?: string; role: string }): React.ReactNode {
  const [open, setOpen] = useState(false);
  if (!["owner", "admin"].includes(role)) return null;
  return <><Button size={agentId ? "sm" : "md"} variant={agentId ? "secondary" : "primary"} onClick={() => setOpen(true)}>{agentId ? "Edit Agent" : "Create Agent"}</Button><Modal open={open} onClose={() => setOpen(false)} title={agentId ? "Configure Agent identity & role" : "Create logical Agent"}>{open && (agentId ? <ExistingConfiguration agentId={agentId} onSaved={() => setOpen(false)} /> : <ConfigurationForm onSaved={() => setOpen(false)} />)}</Modal></>;
}
