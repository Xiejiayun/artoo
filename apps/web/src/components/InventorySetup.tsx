import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Bot, Check, FileCheck2, Plus, ShieldCheck } from "lucide-react";
import { SkillManifestSchema, summarizeSkillPermissions, type AgentInstance, type AgentRuntime, type PermissionSummary } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { useProject } from "../app/useProject.js";
import { Badge, Button, Input, Modal, Select, Textarea } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import { CAPABILITY_LABELS } from "./taskPresentation.js";
import "../ui/resource-management.css";

export function AgentRegistration({ computerId, computerName, runtimes, allowedRoots = [], preferredAgentId, openRequest = false, onOpened }: {
  computerId: string; computerName?: string; runtimes: AgentRuntime[]; allowedRoots?: string[];
  preferredAgentId?: string; openRequest?: boolean; onOpened?: () => void;
}): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const [open, setOpen] = useState(false);
  const [runtime, setRuntime] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [name, setName] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [agentId, setAgentId] = useState("");
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  const agents = bootstrap.data?.agents ?? [];
  const selectedAgent = agents.find((agent) => agent.id === agentId);
  const creatingAgent = agentId === "__new__";
  const compatible = (item: AgentRuntime): boolean => item.status === "available" && (!selectedAgent || selectedAgent.capabilities.every((capability) => item.capabilities.includes(capability)));
  const mutation = useMutation({ mutationFn: () => api.registerAgent(computerId, {
    runtime, workspace_root: workspace.trim(),
    ...(creatingAgent ? { display_name: name.trim() || undefined, ...(capabilities.trim() ? { capabilities: capabilities.split(",").map((item) => item.trim()).filter(Boolean) } : {}) } : { agent_id: agentId }),
  }, newIdempotencyKey()), onSuccess: async () => { await query.invalidateQueries({ queryKey: queryKeys.bootstrap }); setOpen(false); setName(""); setCapabilities(""); } });
  const openForm = (): void => {
    mutation.reset();
    const agent = agents.find((item) => item.id === preferredAgentId) ?? agents[0];
    setAgentId(agent?.id ?? "__new__");
    setRuntime(runtimes.find((item) => item.status === "available" && (!agent || agent.capabilities.every((capability) => item.capabilities.includes(capability))))?.runtime ?? "");
    setWorkspace(allowedRoots[0] ?? "");
    setOpen(true);
  };
  useEffect(() => {
    if (openRequest && bootstrap.data) { openForm(); onOpened?.(); }
    // A request is consumed once; ordinary heartbeat refreshes must not reset a form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest, !!bootstrap.data]);
  if (!["owner", "admin"].includes(bootstrap.data?.user.role ?? "")) return null;
  const validRuntime = runtimes.some((item) => item.runtime === runtime && compatible(item));
  const validAgent = creatingAgent || !!selectedAgent;
  return <><Button iconLeft={Plus} size="sm" onClick={openForm}>Create instance</Button>{mutation.isSuccess && <p className="resource-success" role="status"><Check size={15} aria-hidden="true" />Instance created. Find it in your Agent Squad.</p>}
    <Modal open={open} onClose={() => { if (!mutation.isPending) setOpen(false); }} title="Create agent instance"><form aria-label="Create agent instance" className="resource-form" onSubmit={(event) => { event.preventDefault(); if (!mutation.isPending && validAgent && validRuntime && workspace.trim()) mutation.mutate(); }}>
      <div className="resource-form__intro"><Bot size={22} aria-hidden="true" /><div><strong>{computerName ?? "This machine"}</strong><p>An instance gives an Agent a runtime and workspace on this machine.</p></div></div>
      <Select label="Agent" required disabled={mutation.isPending} value={agentId} onChange={(event) => {
        const id = event.target.value, agent = agents.find((item) => item.id === id);
        setAgentId(id);
        setRuntime(runtimes.find((item) => item.status === "available" && (!agent || agent.capabilities.every((capability) => item.capabilities.includes(capability))))?.runtime ?? "");
      }}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.display_name}</option>)}<option value="__new__">+ Create a new Agent</option></Select>
      {selectedAgent && <p className="resource-form__notice">Uses <strong>{selectedAgent.display_name}</strong> from your Agent library. Its identity and capabilities stay the same across instances.</p>}
      {creatingAgent && <Input label="Agent display name" placeholder="e.g. Frontend engineer" disabled={mutation.isPending} value={name} onChange={(event) => setName(event.target.value)} helperText="A reusable identity for this Agent across machines." />}
      {runtimes.length === 0 && <p className="resource-form__notice" role="status">No runtimes reported yet. Connect this machine and install a supported CLI to continue.</p>}
      <Select label="Agent runtime" required disabled={mutation.isPending} value={runtime} onChange={(event) => setRuntime(event.target.value)}><option value="">Choose runtime</option>{runtimes.map((item) => <option key={item.id} value={item.runtime} disabled={!compatible(item)}>{item.runtime} · {compatible(item) ? "available" : item.status !== "available" ? item.status : "incompatible capabilities"}</option>)}</Select>
      {selectedAgent && runtimes.length > 0 && !runtimes.some(compatible) && <p className="resource-form__notice" role="status">No available runtime on this machine supports all of {selectedAgent.display_name}'s capabilities. Choose another Agent or connect a compatible runtime.</p>}
      <Input label="Agent workspace path" required disabled={mutation.isPending} value={workspace} onChange={(event) => setWorkspace(event.target.value)} helperText={allowedRoots.length ? `Allowed folders: ${allowedRoots.join(", ")}` : "An absolute folder path allowed by this machine. Reconnect with the latest daemon to choose its reported folders."} />
      {allowedRoots.length > 1 && <div className="action-row" aria-label="Allowed workspace folders">{allowedRoots.map((root) => <Button key={root} size="sm" disabled={mutation.isPending} onClick={() => setWorkspace(root)}>{root}</Button>)}</div>}
      {creatingAgent && <details className="resource-details"><summary>Advanced configuration</summary><Input label="Agent capabilities (optional)" disabled={mutation.isPending} helperText="Comma-separated; leave empty to use the runtime's capabilities" value={capabilities} onChange={(event) => setCapabilities(event.target.value)} /></details>}
      <ActionError error={mutation.error} /><div className="resource-form__actions"><Button disabled={mutation.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" variant="primary" loading={mutation.isPending} disabled={!validAgent || !validRuntime || !workspace.trim()}>Create instance</Button></div>
    </form></Modal>
  </>;
}

export function AgentEnabledControl({ instance }: { instance: AgentInstance }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  const disabled = instance.config.enabled === false || instance.status === "disabled";
  const mutation = useMutation({ mutationFn: () => api.setAgentEnabled(instance.id, disabled, newIdempotencyKey()), onSuccess: async () => { await query.invalidateQueries({ queryKey: queryKeys.bootstrap }); } });
  if (!["owner", "admin"].includes(bootstrap.data?.user.role ?? "")) return null;
  return <div className="resource-enabled-control"><span>{disabled ? "Enable to accept new assignments" : "Enabled for future assignments"}</span><Button size="sm" loading={mutation.isPending} onClick={() => mutation.mutate()}>{disabled ? "Enable agent" : "Disable agent"}</Button><ActionError error={mutation.error} /></div>;
}

export function SkillPermissionSummary({ permissions }: { permissions: PermissionSummary }): React.ReactNode {
  const groups: [string, string[]][] = [["Files to read", permissions.filesystem.read], ["Files to write", permissions.filesystem.write], ["Network destinations", permissions.network.outbound], ["Secret references", permissions.secrets], ["External services", permissions.external_services]];
  return <div className="resource-permissions">
    {permissions.categories.length === 0 && permissions.approval_risks.length === 0 && <p>No additional permissions declared.</p>}
    {groups.filter(([, entries]) => entries.length > 0).map(([label, entries]) => <section key={label}><h4>{label}</h4><ul>{entries.map((entry, index) => <li key={`${entry}-${index}`}><code>{entry}</code></li>)}</ul></section>)}
    {permissions.high_risk_actions.length > 0 && <section><h4>High-risk actions</h4><ul>{permissions.high_risk_actions.map((item, index) => <li key={`${item.action}-${index}`}><span>{item.action}</span><Badge tone={item.risk === "high" ? "danger" : item.risk === "medium" ? "warning" : "success"}>{item.risk} risk</Badge></li>)}</ul></section>}
    {permissions.approval_risks.length > 0 && <section><h4>Approval requirements</h4><ul>{permissions.approval_risks.map((item, index) => <li key={`${item.action}-${index}`}><div><strong>{item.action}</strong>{item.reason && <p>{item.reason}</p>}</div><Badge tone={item.risk === "high" ? "danger" : item.risk === "medium" ? "warning" : "success"}>{item.risk} risk</Badge></li>)}</ul></section>}
  </div>;
}

export function SkillInstallForm(): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const { bootstrap, projectId, project } = useProject();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState("project");
  const [manifest, setManifest] = useState("");
  const [preview, setPreview] = useState<ReturnType<typeof SkillManifestSchema.parse> | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const mutation = useMutation({ mutationFn: () => api.installSkill({ project_id: scope === "project" ? projectId : null, manifest: preview!, enabled: true }, newIdempotencyKey()), onSuccess: async () => { await query.invalidateQueries({ queryKey: queryKeys.skillInstalls }); setManifest(""); setPreview(null); setOpen(false); } });
  const review = (): void => { setError(null); mutation.reset(); try { const parsed = SkillManifestSchema.safeParse(JSON.parse(manifest)); if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")); setPreview(parsed.data); } catch (cause) { setPreview(null); setError(cause instanceof Error ? cause : new Error(String(cause))); } };
  if (!["owner", "admin"].includes(bootstrap.data?.user.role ?? "")) return null;
  const permissions = preview ? summarizeSkillPermissions(preview) : null;
  return <><Button variant="primary" iconLeft={Plus} onClick={() => { mutation.reset(); setOpen(true); }}>Install a skill manifest</Button>{mutation.isSuccess && <span className="resource-success" role="status">Skill installed.</span>}
    <Modal open={open} onClose={() => { if (!mutation.isPending) setOpen(false); }} title="Install a skill"><div className="resource-form">
      <ol className="resource-steps" aria-label="Install steps"><li aria-current={preview ? undefined : "step"}><span>1</span>Add manifest</li><li aria-current={preview ? "step" : undefined}><span>2</span>Review access</li></ol>
      {!preview ? <><div className="resource-form__intro"><FileCheck2 size={22} aria-hidden="true" /><p>Paste a skill manifest to review its capabilities and requested access.</p></div><Select label="Install scope" value={scope} onChange={(event) => setScope(event.target.value)}><option value="project">Current project{project ? ` · ${project.name}` : ""}</option><option value="organization">Organization</option></Select><Textarea label="Skill manifest (JSON)" rows={8} value={manifest} spellCheck={false} onChange={(event) => { setManifest(event.target.value); setPreview(null); setError(null); }} placeholder={'{"api_version":"v1alpha1","id":"my-skill","name":"My skill","version":"1.0.0","capabilities":["test.run"],"compatible_runtimes":["codex"]}'} /><ActionError error={error} /><div className="resource-form__actions"><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!manifest.trim()} onClick={review}>Review manifest</Button></div></> : <>
        <div className="resource-form__intro"><ShieldCheck size={24} aria-hidden="true" /><div><h3>{preview.name}</h3><p>Version {preview.version} · {scope === "project" ? project?.name ?? "Current project" : "Organization"}</p></div><Badge tone={permissions?.risk === "high" ? "danger" : permissions?.risk === "medium" ? "warning" : "success"}>{permissions?.risk} risk</Badge></div>
        {preview.description && <p className="resource-description">{preview.description}</p>}<div className="resource-review-facts"><div><h4>Capabilities</h4><p>{preview.capabilities.map((capability) => CAPABILITY_LABELS[capability] ?? capability).join(", ") || "None declared"}</p></div><div><h4>Compatible runtimes</h4><p>{preview.compatible_runtimes.join(", ")}</p></div></div>
        {permissions && <SkillPermissionSummary permissions={permissions} />}<details className="resource-details"><summary>Manifest source</summary><pre className="resource-source">{JSON.stringify(preview, null, 2)}</pre></details>
        <p className="resource-form__notice">Installing enables this skill for compatible agents in {scope === "project" ? project?.name ?? "the current project" : "your organization"}.</p><ActionError error={mutation.error} /><div className="resource-form__actions"><Button disabled={mutation.isPending} onClick={() => setPreview(null)}>Back to manifest</Button><Button variant="primary" loading={mutation.isPending} disabled={scope === "project" && !projectId} onClick={() => { if (!mutation.isPending) mutation.mutate(); }}>Install reviewed skill</Button></div>
      </>}
    </div></Modal>
  </>;
}
