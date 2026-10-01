import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { FolderKanban, Laptop, Link2, Monitor, Smartphone } from "lucide-react";
import type { DevicePlatform } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useProject } from "../app/useProject.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { Badge, Button, EmptyState, Input, Modal, Select } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import { DesktopSettings } from "./DesktopSetup.js";
import "../ui/settings.css";

export function SettingsPage(): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const { bootstrap, project, setSelectedProjectId } = useProject();
  const [creating, setCreating] = useState(false);
  const [platform, setPlatform] = useState<DevicePlatform>("windows");
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [confirmEnroll, setConfirmEnroll] = useState<string | null>(null);
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api.listDevices(), refetchInterval: 15000 });
  const pairing = useMutation({ mutationFn: () => api.createPairing(platform, newIdempotencyKey()) });
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeDevice(id, newIdempotencyKey()), onSuccess: async () => { setConfirmRevoke(null); await query.invalidateQueries({ queryKey: ["devices"] }); } });
  const enroll = useMutation({ mutationFn: (id: string) => api.enrollDevice(id, newIdempotencyKey()), onSuccess: async () => {
    setConfirmEnroll(null);
    await Promise.all([query.invalidateQueries({ queryKey: ["devices"] }), query.invalidateQueries({ queryKey: queryKeys.bootstrap })]);
  } });
  const canManage = ["owner", "admin"].includes(bootstrap.data?.user.role ?? "");
  return <section className="product-page settings-page" aria-label="Settings">
    <header className="settings-page__heading"><div><h1 className="t-h1">Settings</h1><p>Manage your workspace and the devices you use with your team.</p></div></header>
    <ActionError error={bootstrap.error} />
    <nav className="settings-sections" aria-label="Settings sections"><button type="button" onClick={() => document.getElementById("project-settings")?.scrollIntoView()}><FolderKanban size={16} />Project</button>{window.artooDesktop?.getConnection && <button type="button" onClick={() => document.getElementById("desktop-settings")?.scrollIntoView()}><Monitor size={16} />This computer</button>}<button type="button" onClick={() => document.getElementById("pairing-settings")?.scrollIntoView()}><Link2 size={16} />Connect a device</button><button type="button" onClick={() => document.getElementById("device-settings")?.scrollIntoView()}><Laptop size={16} />Devices</button></nav>
    <section id="project-settings" className="settings-section" aria-label="Projects"><header className="settings-section__heading"><div><h2>Projects</h2><p>Name your shared workspace and choose where agents work by default.</p></div>{canManage && <Button onClick={() => setCreating(true)}>New project</Button>}</header>
      {creating && <ProjectForm onSaved={(id) => { setSelectedProjectId(id); setCreating(false); }} onClose={() => setCreating(false)} />}
      <div className="settings-section__body">{project && canManage ? <ProjectForm key={project.id} project={project} onSaved={() => undefined} /> : project && <p>{project.name} · {project.default_workspace || "Workspace not configured"}</p>}
      {bootstrap.isLoading && <p role="status">Loading project settings…</p>}</div>
    </section>
    {window.artooDesktop?.getConnection && <DesktopSettings />}
    <section id="pairing-settings" className="settings-section" aria-label="Device pairing"><header className="settings-section__heading"><div><h2>Connect a device</h2><p>Take your conversations and work with you.</p></div><Link2 size={20} aria-hidden="true" /></header>
      <div className="settings-section__body u-stack"><ol className="pairing-steps"><li><span>1</span><div><strong>Choose your device</strong><p>Generate a single-use code for your Mac, Windows or iOS app.</p></div></li><li><span>2</span><div><strong>Enter the code in the app</strong><p>The device signs in with your account. Keep the code private; teammates should generate their own.</p></div></li></ol>
      <div className="pairing-controls">
      <Select label="Device platform" value={platform} onChange={(event) => { setPlatform(event.target.value as DevicePlatform); pairing.reset(); }}><option value="windows">Windows</option><option value="ios">iOS</option><option value="macos">macOS</option></Select>
      <Button variant="primary" loading={pairing.isPending} onClick={() => pairing.mutate()}>Generate pairing code</Button></div><ActionError error={pairing.error} />
      {pairing.data && <div className="pairing-result"><p>Pairing code: <output aria-label="Pairing code" className="t-mono">{pairing.data.code}</output></p><p>Expires {new Date(pairing.data.pairing.expires_at).toLocaleString()}. Keep the code private.</p><Button size="sm" onClick={() => pairing.reset()}>Hide code</Button></div>}</div>
    </section>
    <section id="device-settings" className="settings-section" aria-label="Devices"><header className="settings-section__heading"><div><h2>Devices{devices.data ? <span className="settings-count">{devices.data.devices.length}</span> : null}</h2><p>Review access and manage the computers available for team tasks.</p></div></header><div className="settings-section__body u-stack"><ActionError error={devices.error ?? revoke.error} />{devices.isError && <Button size="sm" onClick={() => void devices.refetch()}>Reload devices</Button>}{devices.isLoading && <p role="status">Loading devices…</p>}{devices.data?.devices.length === 0 && <EmptyState icon={Laptop} title="No devices paired yet." description="Connect a device above to bring Artoo to your desktop or phone." />}
      {devices.data?.devices.map((device) => <article key={device.id} className="settings-device"><div className="settings-device__identity"><span className="settings-device__icon">{["ios", "android"].includes(device.platform) ? <Smartphone size={20} aria-hidden="true" /> : <Laptop size={20} aria-hidden="true" />}</span><div><h3>{device.display_name || device.id}</h3><p>Last seen: {device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : "Never"}</p></div><div className="settings-device__badges"><Badge>{device.platform === "macos" ? "macOS" : device.platform === "ios" ? "iOS" : device.platform === "windows" ? "Windows" : device.platform}</Badge><Badge tone={device.trust === "active" ? "success" : "danger"}>{device.trust}</Badge></div></div>{device.computer_id && <p className="t-subtle">Computer: {bootstrap.data?.computers.find((computer) => computer.id === device.computer_id)?.display_name ?? device.computer_id}</p>}
        <div className="settings-device__actions">
        {canManage && device.trust === "active" && ["macos", "windows"].includes(device.platform) && !device.computer_id && (confirmEnroll === device.id ? <div className="u-stack-sm">
          <p>Enroll {device.display_name || device.id} as an execution computer? Its owner can then start a worker and allow team tasks in their selected folders.</p>
          <ActionError error={enroll.error} /><div className="action-row"><Button variant="primary" loading={enroll.isPending} onClick={() => enroll.mutate(device.id)}>Confirm enrollment</Button><Button disabled={enroll.isPending} onClick={() => { setConfirmEnroll(null); enroll.reset(); }}>Cancel enrollment</Button></div>
        </div> : <Button size="sm" disabled={enroll.isPending || revoke.isPending} onClick={() => { setConfirmEnroll(device.id); setConfirmRevoke(null); enroll.reset(); }}>Enroll computer</Button>)}
        {!canManage && device.trust === "active" && ["macos", "windows"].includes(device.platform) && !device.computer_id && <p className="t-subtle">An owner or admin must enroll this computer before its local worker can start.</p>}
        {device.trust === "active" && (confirmRevoke === device.id ? <div className="u-stack-sm"><p>Revoke this device and disconnect its sessions immediately?</p><div className="action-row"><Button variant="danger" loading={revoke.isPending} disabled={enroll.isPending} onClick={() => revoke.mutate(device.id)}>Confirm revoke</Button><Button disabled={revoke.isPending} onClick={() => setConfirmRevoke(null)}>Keep device</Button></div></div> : <Button variant="danger" size="sm" disabled={enroll.isPending || revoke.isPending} onClick={() => { setConfirmRevoke(device.id); setConfirmEnroll(null); }}>Revoke device</Button>)}
        </div></article>)}</div>
    </section>
  </section>;
}

function ProjectForm({ project, onSaved, onClose }: { project?: { id: string; name: string; default_workspace: string | null }; onSaved: (id: string) => void; onClose?: () => void }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const [name, setName] = useState(project?.name ?? "");
  const [workspace, setWorkspace] = useState(project?.default_workspace ?? "");
  const mutation = useMutation({ mutationFn: () => project ? api.updateProject(project.id, { name: name.trim(), default_workspace: workspace.trim() || null }, newIdempotencyKey()) : api.createProject({ name: name.trim(), default_workspace: workspace.trim() || null }, newIdempotencyKey()), onSuccess: async ({ project: saved }) => { await query.invalidateQueries({ queryKey: queryKeys.bootstrap }); onSaved(saved.id); } });
  const form = <form aria-label={project ? "Edit project" : "Create project"} className="u-stack settings-project-form" onSubmit={(event) => { event.preventDefault(); if (!mutation.isPending && name.trim()) mutation.mutate(); }}><Input label="Project name" value={name} required maxLength={200} disabled={mutation.isPending} onChange={(event) => setName(event.target.value)} /><Input label="Default workspace" value={workspace} disabled={mutation.isPending} helperText="Absolute path on the execution computer" onChange={(event) => setWorkspace(event.target.value)} /><ActionError error={mutation.error} />{mutation.isSuccess && <p role="status">Project saved.</p>}<div className="action-row"><Button variant="primary" type="submit" loading={mutation.isPending} disabled={!name.trim()}>{project ? "Save project" : "Create project"}</Button>{onClose && <Button disabled={mutation.isPending} onClick={onClose}>Cancel</Button>}</div></form>;
  return onClose ? <Modal open title="New project" onClose={() => { if (!mutation.isPending) onClose(); }}>{form}</Modal> : form;
}
