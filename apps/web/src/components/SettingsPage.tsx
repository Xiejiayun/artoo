import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { DevicePlatform } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useProject } from "../app/useProject.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { Badge, Button, Input, Select } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import { DesktopSettings } from "./DesktopSetup.js";

export function SettingsPage(): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const { bootstrap, project, setSelectedProjectId } = useProject();
  const [creating, setCreating] = useState(false);
  const [platform, setPlatform] = useState<DevicePlatform>("windows");
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api.listDevices(), refetchInterval: 15000 });
  const pairing = useMutation({ mutationFn: () => api.createPairing(platform, newIdempotencyKey()) });
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeDevice(id, newIdempotencyKey()), onSuccess: async () => { setConfirmRevoke(null); await query.invalidateQueries({ queryKey: ["devices"] }); } });
  const canManage = ["owner", "admin"].includes(bootstrap.data?.user.role ?? "");
  return <section className="product-page" aria-label="Settings">
    <h1 className="t-h1">Settings</h1><ActionError error={bootstrap.error} />
    <section className="product-card u-stack" aria-label="Projects"><header className="action-row"><h2>Projects</h2>{canManage && <Button onClick={() => setCreating(true)}>New project</Button>}</header>
      {creating && <ProjectForm onSaved={(id) => { setSelectedProjectId(id); setCreating(false); }} onClose={() => setCreating(false)} />}
      {project && canManage ? <ProjectForm key={project.id} project={project} onSaved={() => undefined} /> : project && <p>{project.name} · {project.default_workspace || "Workspace not configured"}</p>}
    </section>
    {window.artooDesktop?.getConnection && <DesktopSettings />}
    <section className="product-card u-stack" aria-label="Device pairing"><h2>Connect a device</h2><p>Generate a single-use code, then enter it in the Windows or iOS app. The device receives access as your account.</p>
      <Select label="Device platform" value={platform} onChange={(event) => { setPlatform(event.target.value as DevicePlatform); pairing.reset(); }}><option value="windows">Windows</option><option value="ios">iOS</option><option value="macos">macOS</option></Select>
      <Button variant="primary" loading={pairing.isPending} onClick={() => pairing.mutate()}>Generate pairing code</Button><ActionError error={pairing.error} />
      {pairing.data && <div role="status" className="product-card"><p>Pairing code: <strong className="t-mono">{pairing.data.code}</strong></p><p>Expires {new Date(pairing.data.pairing.expires_at).toLocaleString()}. Keep the code private.</p><Button size="sm" onClick={() => pairing.reset()}>Hide code</Button></div>}
    </section>
    <section className="u-stack" aria-label="Devices"><h2>Devices</h2><ActionError error={devices.error ?? revoke.error} />{devices.isLoading && <p role="status">Loading devices…</p>}{devices.data?.devices.length === 0 && <p>No devices paired yet.</p>}
      {devices.data?.devices.map((device) => <article key={device.id} className="product-card u-stack-sm"><div className="action-row"><h3>{device.display_name || device.id}</h3><Badge>{device.platform}</Badge><Badge tone={device.trust === "active" ? "success" : "danger"}>{device.trust}</Badge></div><p>Last seen: {device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : "Never"}</p>{device.computer_id && <p>Computer: {device.computer_id}</p>}
        {device.trust === "active" && (confirmRevoke === device.id ? <div className="u-stack-sm"><p>Revoke this device and disconnect its sessions immediately?</p><div className="action-row"><Button variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate(device.id)}>Confirm revoke</Button><Button onClick={() => setConfirmRevoke(null)}>Keep device</Button></div></div> : <Button variant="danger" size="sm" onClick={() => setConfirmRevoke(device.id)}>Revoke device</Button>)}
      </article>)}
    </section>
  </section>;
}

function ProjectForm({ project, onSaved, onClose }: { project?: { id: string; name: string; default_workspace: string | null }; onSaved: (id: string) => void; onClose?: () => void }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const [name, setName] = useState(project?.name ?? "");
  const [workspace, setWorkspace] = useState(project?.default_workspace ?? "");
  const mutation = useMutation({ mutationFn: () => project ? api.updateProject(project.id, { name: name.trim(), default_workspace: workspace.trim() || null }, newIdempotencyKey()) : api.createProject({ name: name.trim(), default_workspace: workspace.trim() || null }, newIdempotencyKey()), onSuccess: async ({ project: saved }) => { await query.invalidateQueries({ queryKey: queryKeys.bootstrap }); onSaved(saved.id); } });
  return <form aria-label={project ? "Edit project" : "Create project"} className="u-stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><Input label="Project name" value={name} required maxLength={200} onChange={(event) => setName(event.target.value)} /><Input label="Default workspace" value={workspace} helperText="Absolute path on the execution computer" onChange={(event) => setWorkspace(event.target.value)} /><ActionError error={mutation.error} />{mutation.isSuccess && <p role="status">Project saved.</p>}<div className="action-row"><Button variant="primary" type="submit" loading={mutation.isPending} disabled={!name.trim()}>{project ? "Save project" : "Create project"}</Button>{onClose && <Button onClick={onClose}>Cancel</Button>}</div></form>;
}
