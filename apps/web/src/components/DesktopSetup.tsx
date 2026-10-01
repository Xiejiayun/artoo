import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ExternalLink, Monitor, Play, RotateCcw, Square } from "lucide-react";
import { Badge, Button, Input, Select, Textarea } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import { clearRoomDrafts } from "../app/roomDrafts.js";
import "../ui/settings.css";

export function DesktopGate({ children }: { children: React.ReactNode }): React.ReactNode {
  const bridge = window.artooDesktop;
  const connection = useQuery({ queryKey: ["desktopConnection"], queryFn: () => bridge!.getConnection!(), enabled: !!bridge?.getConnection, retry: false });
  if (!bridge?.getConnection) return children;
  if (connection.isLoading) return <div className="auth-state" role="status">Loading device connection…</div>;
  if (connection.error) return <DesktopSetup initialError={connection.error} />;
  if (!connection.data?.paired) return <DesktopSetup />;
  return children;
}

export function DesktopSetup({ initialError }: { initialError?: unknown } = {}): React.ReactNode {
  const bridge = window.artooDesktop!;
  const [server, setServer] = useState(bridge.serverUrl);
  const platformName = bridge.platform === "darwin" ? "macOS" : "Windows";
  const [name, setName] = useState(bridge.platform === "darwin" ? "My Mac" : "My Windows computer");
  const [code, setCode] = useState("");
  const mutation = useMutation({ mutationFn: async () => {
    clearRoomDrafts();
    await bridge.configureServer!(server.trim());
    await bridge.pairDevice!({ code: code.trim(), displayName: name.trim() });
    window.location.reload();
  } });
  return <section className="auth-state desktop-onboarding"><form className="login-card desktop-onboarding__card u-stack" aria-label="Connect desktop" onSubmit={(event) => { event.preventDefault(); if (!mutation.isPending) mutation.mutate(); }}>
    <span className="login-brand"><span className="brand-mark" aria-hidden="true">a</span>artoo</span><div className="desktop-onboarding__intro"><span className="desktop-onboarding__platform"><Monitor size={15} aria-hidden="true" />Artoo for {platformName}</span><h1>Connect this computer</h1><p>Bring your team’s conversations and work to your desktop.</p></div>
    <div className="desktop-onboarding__instructions"><strong>Start with a pairing code</strong><p>Sign in to the Web app with your own account and open Settings → Connect a device to generate a {platformName} pairing code. This computer will use that account's permissions.</p><Button variant="ghost" size="sm" iconRight={ExternalLink} onClick={() => void bridge.openExternal?.(`${server.replace(/\/$/, "")}/settings`)}>Open Web settings</Button></div>
    <fieldset disabled={mutation.isPending} className="desktop-onboarding__fields">
    <Input label="Server address" type="url" required value={server} onChange={(event) => setServer(event.target.value)} placeholder="https://artoo.example.com" />
    <Input label="Device name" required value={name} onChange={(event) => setName(event.target.value)} />
    <Input label="Pairing code" required autoComplete="off" value={code} onChange={(event) => setCode(event.target.value)} />
    </fieldset>
    <ActionError error={mutation.error ?? initialError} /><Button variant="primary" type="submit" loading={mutation.isPending} disabled={!code.trim() || !name.trim()}>Pair this computer</Button>
  </form></section>;
}

export function DesktopSettings(): React.ReactNode {
  const bridge = window.artooDesktop!;
  const query = useQueryClient();
  const connection = useQuery({ queryKey: ["desktopConnection"], queryFn: () => bridge.getConnection!() });
  const daemon = useQuery({ queryKey: ["desktopDaemon"], queryFn: () => bridge.daemonStatus!(), enabled: !!bridge.daemonStatus, refetchInterval: 3000 });
  const action = useMutation({ mutationFn: (run: () => Promise<void>) => run(), onSuccess: async () => { await query.invalidateQueries({ queryKey: ["desktopDaemon"] }); } });
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  return <section id="desktop-settings" className="settings-section" aria-label="Desktop connection"><header className="settings-section__heading"><div><h2>This computer</h2><p>Control the local worker and choose the folders it can use.</p></div><Monitor size={20} aria-hidden="true" /></header><div className="settings-section__body u-stack">
    <div className="desktop-status"><div><span className="desktop-status__label">Connected server</span><strong>{connection.data?.serverUrl ?? "Loading…"}</strong></div><Badge tone={daemon.data?.state === "running" ? "success" : daemon.data?.state === "failed" ? "danger" : "neutral"}>Worker: {daemon.data?.state ?? "Loading…"}</Badge></div><ActionError error={connection.error ?? daemon.error ?? action.error ?? daemon.data?.lastError} />
    <div className="action-row"><Button variant="primary" iconLeft={Play} disabled={action.isPending} onClick={() => action.mutate(() => bridge.startDaemon!())}>Start worker</Button><Button iconLeft={Square} disabled={action.isPending} onClick={() => action.mutate(() => bridge.stopDaemon!())}>Stop worker</Button><Button iconLeft={RotateCcw} disabled={action.isPending} onClick={() => action.mutate(() => bridge.restartDaemon!())}>Restart worker</Button></div>
    <p className="t-subtle">After starting the worker, register its runtime and workspace on the Computers page so tasks can be assigned.</p>
    {daemon.data && <DaemonForm config={daemon.data.config} onSave={(config) => action.mutateAsync(() => bridge.configureDaemon!(config))} busy={action.isPending} />}
    <details className="settings-technical"><summary>Connection details</summary><p>Device: {connection.data?.deviceId ?? "Unpaired"}</p>{daemon.data?.pid ? <p>Worker process: {daemon.data.pid}</p> : null}</details>
    <div className="settings-disconnect">
    {confirmDisconnect ? <div className="u-stack-sm"><p>Disconnect this app from the server and clear its stored credentials?</p><div className="action-row"><Button variant="danger" loading={action.isPending} onClick={() => action.mutate(async () => { clearRoomDrafts(); await bridge.logout!(); window.location.reload(); })}>Confirm disconnect</Button><Button onClick={() => setConfirmDisconnect(false)}>Keep connection</Button></div></div> : <Button variant="danger" onClick={() => setConfirmDisconnect(true)}>Disconnect this app</Button>}
    </div></div></section>;
}

function normalizeApiAddress(value: string): string {
  try { return new URL(value.trim()).toString().replace(/\/$/, ""); } catch { return value.trim(); }
}

function DaemonForm({ config, onSave, busy }: { config: DesktopDaemonConfig; onSave: (config: DesktopDaemonInput) => Promise<void>; busy: boolean }): React.ReactNode {
  const [roots, setRoots] = useState(config.allowedRoots.join("\n"));
  const [runtimes, setRuntimes] = useState(config.runtimes);
  const [repo, setRepo] = useState(config.worktreeBaseRepo ?? "");
  const [trusted, setTrusted] = useState(config.trustedExecution);
  const [mode, setMode] = useState(config.codex?.mode ?? "default");
  const [binary, setBinary] = useState(config.codex?.binaryPath ?? "");
  const [model, setModel] = useState(config.codex?.model ?? "");
  const [baseUrl, setBaseUrl] = useState(config.codex?.baseUrl ?? "http://127.0.0.1:18181/v1");
  const [authMode, setAuthMode] = useState(config.codex?.authMode === "none" && config.codex.mode === "responses" ? "none" : "api-key");
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const savedKey = config.codex?.hasKey && config.codex.mode === "responses" && normalizeApiAddress(config.codex.baseUrl ?? "") === normalizeApiAddress(baseUrl);
  const choose = useMutation({ mutationFn: async () => { const path = await window.artooDesktop!.chooseDirectory!(); if (path) setRoots((current) => [...current.split("\n").filter(Boolean), path].join("\n")); } });
  const chooseBinary = useMutation({ mutationFn: async () => { const path = await window.artooDesktop!.chooseExecutable!(); if (path) { setBinary(path); setSaved(false); } } });
  return <form className="u-stack worker-configuration" aria-label="Worker configuration" onChange={() => setSaved(false)} onSubmit={async (event) => {
    event.preventDefault();
    try {
      await onSave({ allowedRoots: roots.split("\n").map((root) => root.trim()).filter(Boolean), runtimes, trustedExecution: trusted,
        ...(repo.trim() ? { worktreeBaseRepo: repo.trim() } : {}), codex: { mode, authMode: mode === "responses" ? authMode as "none" | "api-key" : "none",
          ...(binary.trim() ? { binaryPath: binary.trim() } : {}), ...(model.trim() ? { model: model.trim() } : {}),
          ...(mode === "responses" ? { baseUrl: baseUrl.trim(), ...(authMode === "api-key" && apiKey ? { apiKey } : {}) } : {}) } });
      setApiKey(""); if (mode === "responses") setBaseUrl(normalizeApiAddress(baseUrl)); setSaved(true);
    } catch { /* The parent displays the mutation error; preserve fields for retry. */ }
  }}>
    <fieldset disabled={busy} className="worker-fieldset u-stack"><legend>Workspace access</legend><p className="t-subtle">Choose the folders available to agents on this computer.</p><Textarea label="Allowed workspace folders" value={roots} required helperText="One absolute folder per line" onChange={(event) => setRoots(event.target.value)} /><div><Button size="sm" onClick={() => choose.mutate()} loading={choose.isPending}>Choose folder</Button></div><ActionError error={choose.error} />
    <Input label="Git repository for isolated worktrees (optional)" value={repo} onChange={(event) => setRepo(event.target.value)} /></fieldset>
    <fieldset disabled={busy} className="worker-fieldset worker-runtimes"><legend>Installed runtimes</legend><p className="t-subtle">Select the tools already installed on this computer.</p>{["codex", "claude-code"].map((runtime) => <label key={runtime}><input type="checkbox" checked={runtimes.includes(runtime)} onChange={(event) => setRuntimes(event.target.checked ? [...runtimes, runtime] : runtimes.filter((value) => value !== runtime))} />{runtime}</label>)}</fieldset>
    <fieldset disabled={busy} className="worker-fieldset u-stack"><legend>Codex connection</legend>
      <Input label="Codex program (optional)" value={binary} onChange={(event) => setBinary(event.target.value)} helperText="Leave blank to find codex on this computer's PATH, or select the installed program." />
      {window.artooDesktop?.chooseExecutable && <Button size="sm" onClick={() => chooseBinary.mutate()} loading={chooseBinary.isPending}>Choose Codex program</Button>}<ActionError error={chooseBinary.error} />
      <Select label="Model connection" value={mode} onChange={(event) => { setMode(event.target.value as "default" | "responses"); setApiKey(""); }}><option value="default">Use existing Codex settings</option><option value="responses">Aerial or another Responses API</option></Select>
      <Input label={mode === "responses" ? "Model name" : "Model name (optional)"} value={model} required={mode === "responses"} onChange={(event) => setModel(event.target.value)} helperText={mode === "responses" ? "Use the exact model name offered by your API." : "Leave blank to use your existing Codex model."} />
      {mode === "responses" && <>
        <Input label="Model API address" type="url" required value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setApiKey(""); }} helperText="For Aerial, start its local API and choose GitHub Copilot in Aerial first." />
        <Select label="API authentication" value={authMode} onChange={(event) => { setAuthMode(event.target.value); setApiKey(""); }}><option value="api-key">API key</option><option value="none">No API key</option></Select>
        {authMode === "api-key" ? <Input label="Model API key" type="password" autoComplete="new-password" value={apiKey} required={!savedKey} onChange={(event) => setApiKey(event.target.value)} helperText={savedKey ? "A key is saved for this address. Leave blank to keep it, or enter a replacement." : "Stored encrypted on this computer. Never sent to the Artoo server."} /> : <p className="t-subtle">No API key will be supplied. Saving removes any previously saved key; choose this only if your API allows requests without one.</p>}
        <p className="t-subtle">Saving checks these settings locally. It does not contact the model API or verify a model response.</p>
      </>}
      <p className="t-subtle">These settings apply to Codex tasks and discussions on this computer. Stop the worker before saving. Your global Codex settings are unchanged.</p>
    </fieldset>
    <div className="worker-trust"><label><input type="checkbox" disabled={busy} checked={trusted} onChange={(event) => setTrusted(event.target.checked)} />Allow execution of trusted team tasks on this computer</label>
    <p className="t-subtle">Agent commands can modify files and run programs using your account. Select only folders and tasks your team trusts.</p>
    </div><div><Button variant="primary" type="submit" disabled={!roots.trim() || runtimes.length === 0} loading={busy}>Save worker configuration</Button></div>
    {saved && <p role="status">Worker configuration saved.</p>}
  </form>;
}
