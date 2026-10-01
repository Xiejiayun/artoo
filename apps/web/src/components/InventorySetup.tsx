import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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

export function AgentRegistration({ computerId, computerName, runtimes }: { computerId: string; computerName?: string; runtimes: AgentRuntime[] }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const [open, setOpen] = useState(false);
  const [runtime, setRuntime] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [name, setName] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  const mutation = useMutation({ mutationFn: () => api.registerAgent(computerId, { runtime, workspace_root: workspace.trim(), display_name: name.trim() || undefined, ...(capabilities.trim() ? { capabilities: capabilities.split(",").map((item) => item.trim()).filter(Boolean) } : {}) }, newIdempotencyKey()), onSuccess: async () => { await query.invalidateQueries({ queryKey: queryKeys.bootstrap }); setOpen(false); setWorkspace(""); setName(""); setCapabilities(""); } });
  if (!["owner", "admin"].includes(bootstrap.data?.user.role ?? "")) return null;
  const validRuntime = runtimes.some((item) => item.runtime === runtime);
  return <><Button iconLeft={Plus} size="sm" onClick={() => { mutation.reset(); setOpen(true); }}>Register an agent workspace</Button>{mutation.isSuccess && <p className="resource-success" role="status"><Check size={15} aria-hidden="true" />Agent workspace registered. It is available on the Agents page.</p>}
    <Modal open={open} onClose={() => { if (!mutation.isPending) setOpen(false); }} title="Register agent workspace"><form aria-label="Register agent" className="resource-form" onSubmit={(event) => { event.preventDefault(); if (!mutation.isPending && validRuntime && workspace.trim()) mutation.mutate(); }}>
      <div className="resource-form__intro"><Bot size={22} aria-hidden="true" /><div><strong>{computerName ?? "New agent workspace"}</strong><p>Give the agent a name and choose the folder where it will work.</p></div></div>
      {runtimes.length === 0 && <p className="resource-form__notice" role="status">No runtimes reported yet. Start the worker on this computer, then return here to choose its installed runtime.</p>}
      <Input label="Agent display name" placeholder="e.g. Frontend engineer" disabled={mutation.isPending} value={name} onChange={(event) => setName(event.target.value)} helperText="Optional. A clear name makes this agent easier to assign." />
      <Select label="Agent runtime" required disabled={mutation.isPending} value={runtime} onChange={(event) => setRuntime(event.target.value)}><option value="">Choose runtime</option>{runtimes.map((item) => <option key={item.id} value={item.runtime}>{item.runtime} ({item.status})</option>)}</Select>
      <Input label="Agent workspace path" required disabled={mutation.isPending} value={workspace} onChange={(event) => setWorkspace(event.target.value)} helperText="Use an absolute folder path allowed by this computer's worker configuration." />
      <details className="resource-details"><summary>Advanced configuration</summary><Input label="Agent capabilities (optional)" disabled={mutation.isPending} helperText="Comma-separated; leave empty to use the runtime's capabilities" value={capabilities} onChange={(event) => setCapabilities(event.target.value)} /></details>
      <ActionError error={mutation.error} /><div className="resource-form__actions"><Button disabled={mutation.isPending} onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" variant="primary" loading={mutation.isPending} disabled={!validRuntime || !workspace.trim()}>Register agent</Button></div>
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
