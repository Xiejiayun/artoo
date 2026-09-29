import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { SkillManifestSchema, summarizeSkillPermissions, type AgentInstance, type AgentRuntime } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { useProject } from "../app/useProject.js";
import { Badge, Button, Input, Select, Textarea } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

export function AgentRegistration({ computerId, runtimes }: { computerId: string; runtimes: AgentRuntime[] }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const [runtime, setRuntime] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [name, setName] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  const mutation = useMutation({ mutationFn: () => api.registerAgent(computerId, { runtime, workspace_root: workspace.trim(), display_name: name.trim() || undefined, ...(capabilities.trim() ? { capabilities: capabilities.split(",").map((item) => item.trim()).filter(Boolean) } : {}) }, newIdempotencyKey()), onSuccess: async () => { await query.invalidateQueries({ queryKey: queryKeys.bootstrap }); } });
  if (!["owner", "admin"].includes(bootstrap.data?.user.role ?? "")) return null;
  return <details className="product-card"><summary>Register an agent workspace</summary><form aria-label="Register agent" className="u-stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
    <p>Start the worker on this computer, select its installed runtime, and choose a folder allowed by its worker configuration.</p>
    <Select label="Agent runtime" required value={runtime} onChange={(event) => setRuntime(event.target.value)}><option value="">Choose runtime</option>{runtimes.map((item) => <option key={item.id} value={item.runtime}>{item.runtime} ({item.status})</option>)}</Select>
    <Input label="Agent display name" value={name} onChange={(event) => setName(event.target.value)} /><Input label="Agent workspace path" required value={workspace} onChange={(event) => setWorkspace(event.target.value)} />
    <Input label="Agent capabilities (optional)" helperText="Comma-separated; leave empty to use the runtime's capabilities" value={capabilities} onChange={(event) => setCapabilities(event.target.value)} />
    <ActionError error={mutation.error} />{mutation.isSuccess && <p role="status">Agent workspace registered. It is available on the Agents page.</p>}<Button type="submit" variant="primary" loading={mutation.isPending} disabled={!runtime || !workspace.trim()}>Register agent</Button>
  </form></details>;
}

export function AgentEnabledControl({ instance }: { instance: AgentInstance }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  const disabled = instance.config.enabled === false || instance.status === "disabled";
  const mutation = useMutation({ mutationFn: () => api.setAgentEnabled(instance.id, disabled, newIdempotencyKey()), onSuccess: async () => { await query.invalidateQueries({ queryKey: queryKeys.bootstrap }); } });
  if (!["owner", "admin"].includes(bootstrap.data?.user.role ?? "")) return null;
  return <><ActionError error={mutation.error} /><Button size="sm" loading={mutation.isPending} onClick={() => mutation.mutate()}>{disabled ? "Enable agent" : "Disable agent"}</Button></>;
}

export function SkillInstallForm(): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const { bootstrap, projectId } = useProject();
  const [scope, setScope] = useState("project");
  const [manifest, setManifest] = useState("");
  const [preview, setPreview] = useState<ReturnType<typeof SkillManifestSchema.parse> | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const mutation = useMutation({ mutationFn: () => api.installSkill({ project_id: scope === "project" ? projectId : null, manifest: preview!, enabled: true }, newIdempotencyKey()), onSuccess: async () => { setManifest(""); setPreview(null); await query.invalidateQueries({ queryKey: queryKeys.skillInstalls }); } });
  const review = (): void => { setError(null); try { const parsed = SkillManifestSchema.safeParse(JSON.parse(manifest)); if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")); setPreview(parsed.data); } catch (cause) { setPreview(null); setError(cause instanceof Error ? cause : new Error(String(cause))); } };
  if (!["owner", "admin"].includes(bootstrap.data?.user.role ?? "")) return null;
  const permissions = preview ? summarizeSkillPermissions(preview) : null;
  return <details className="product-card"><summary>Install a skill manifest</summary><div className="u-stack"><p>Register a trusted skill and review its requested permissions before enabling it for scheduling.</p>
    <Select label="Install scope" value={scope} onChange={(event) => setScope(event.target.value)}><option value="project">Current project</option><option value="organization">Organization</option></Select>
    <Textarea label="Skill manifest (JSON)" rows={8} value={manifest} onChange={(event) => { setManifest(event.target.value); setPreview(null); }} placeholder={'{"api_version":"v1alpha1","id":"my-skill","name":"My skill","version":"1.0.0","capabilities":["test.run"],"compatible_runtimes":["codex"]}'} />
    <ActionError error={error ?? mutation.error} /><Button disabled={!manifest.trim()} onClick={review}>Review manifest</Button>
    {preview && <div className="product-card u-stack-sm"><h3>{preview.name} {preview.version}</h3><p>{preview.description}</p><p>Capabilities: {preview.capabilities.join(", ") || "None"}</p><p>Runtimes: {preview.compatible_runtimes.join(", ")}</p><Badge tone={permissions?.risk === "high" ? "danger" : "warning"}>{permissions?.risk} risk</Badge><p>Permissions: {permissions?.categories.join(", ") || "None declared"}</p>{permissions && <pre className="manifest-preview">{JSON.stringify(permissions, null, 2)}</pre>}<Button variant="primary" loading={mutation.isPending} disabled={scope === "project" && !projectId} onClick={() => mutation.mutate()}>Install reviewed skill</Button></div>}
    {mutation.isSuccess && <p role="status">Skill installed.</p>}
  </div></details>;
}
