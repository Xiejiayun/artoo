import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Check, CheckCircle2, Copy, Monitor, Terminal } from "lucide-react";
import type { DevicePlatform } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useDaemons } from "../app/useDaemons.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { Button, Modal, Select, useToast } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import "./node-onboarding.css";

export const DAEMON_CONNECT_VERSION = "0.1.0-rc.6";

export function daemonConnectCommand(origin: string, code: string, platform: DevicePlatform | "npm" = "npm"): string {
  const url = new URL(origin);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      || url.origin !== origin || !/^(?:[a-z0-9.-]+|\[[0-9a-f:]+\])$/i.test(url.hostname) || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    throw new Error("This connection command needs a trusted server address and a valid pairing code.");
  }
  if (!["windows", "linux", "macos", "npm"].includes(platform)) throw new Error("Choose Windows, Linux or macOS for a local node.");
  return `npx -y @jiayunxie/artood@${DAEMON_CONNECT_VERSION} connect --server ${origin} --code ${code}`;
}

/** Codes stay in this dialog's memory. Progress belongs to this exact pairing. */
export function ConnectNodeDialog({ open, onClose, onCreateInstance, onViewMachines }: {
  open: boolean; onClose: () => void; onCreateInstance?: (computerId: string) => void; onViewMachines?: () => void;
}): React.ReactNode {
  const api = useApi();
  const toast = useToast();
  const query = useQueryClient();
  const [platform, setPlatform] = useState<DevicePlatform>("windows");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<Error | null>(null);
  const [now, setNow] = useState(Date.now());
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap(), enabled: open });
  const pairing = useMutation({ mutationFn: () => api.createPairing(platform, newIdempotencyKey()) });
  const pairingId = pairing.data?.pairing.id;
  const progress = useQuery({
    queryKey: queryKeys.pairing(pairingId), queryFn: () => api.getPairingStatus(pairingId!), enabled: open && !!pairingId,
    refetchInterval: (state) => ["expired", "cancelled"].includes(state.state.data?.pairing.status ?? "") ? false : 2000,
    retry: false,
  });
  const computerId = progress.data?.device?.computer_id;
  const presence = useDaemons({ enabled: open && !!computerId, intervalMs: 2000 });
  const machine = presence.data?.daemons.find((daemon) => daemon.computer_id === computerId);
  const connected = machine?.status === "online" && machine.connected;
  const claimed = progress.data?.pairing.status === "claimed";
  const cancelled = progress.data?.pairing.status === "cancelled";
  const expiresAt = Date.parse(pairing.data?.pairing.expires_at ?? "");
  const expired = !claimed && (progress.data?.pairing.status === "expired" || Number.isFinite(expiresAt) && now >= expiresAt);
  const canEnroll = ["owner", "admin"].includes(bootstrap.data?.user.role ?? "");
  let command = "", commandError: Error | null = null;
  if (pairing.data && !claimed && !expired && !cancelled) {
    try { command = daemonConnectCommand(window.location.origin, pairing.data.code, platform); }
    catch (error) { commandError = error instanceof Error ? error : new Error("Unable to prepare the connection command."); }
  }
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);
  useEffect(() => {
    if (computerId) void query.invalidateQueries({ queryKey: queryKeys.bootstrap });
  }, [computerId, query]);
  const close = (): void => {
    if (pairing.isPending) return;
    pairing.reset(); setCopied(false); setCopyError(null); onClose();
  };
  const generate = (): void => { setCopied(false); setCopyError(null); pairing.mutate(); };
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(command); setCopied(true); setCopyError(null); toast.push({ tone: "success", message: "Connection command copied." }); }
    catch { setCopyError(new Error("Clipboard access is unavailable. Select and copy the command below.")); }
  };
  return <Modal open={open} onClose={close} title="Connect Local Node">
    <div className="connect-node">
      <div className="connect-node__intro"><span><Monitor size={24} /></span><div><h3>Your machine. Your agents.</h3><p>Run one command on the computer where your agents will work.</p></div></div>
      <ol className="connect-node__steps" aria-label="Connection progress">
        <li aria-current={!pairing.data ? "step" : undefined}><span>1</span>Get command</li>
        <li aria-current={pairing.data && !connected ? "step" : undefined}><span>2</span>Run locally</li>
        <li aria-current={connected ? "step" : undefined}><span>3</span>Create instance</li>
      </ol>
      {!pairing.data && <>
        <Select label="Target operating system" value={platform} disabled={pairing.isPending} onChange={(event) => setPlatform(event.target.value as DevicePlatform)}><option value="windows">Windows</option><option value="linux">Linux</option><option value="macos">macOS</option></Select>
        <p className="connect-node__hint">Requires Node.js 24+ and npm 11+. The command installs the official npm package, discovers your Codex and Claude CLIs, and starts ARTOO in the background.</p>
        <p className="connect-node__access">This connects the machine to your account. Tasks can use its selected workspace; the default is <code>ArtooWorkspaces</code> in your home folder.</p>
        {!canEnroll && bootstrap.data && <p className="connect-node__hint">An administrator will need to approve this machine after you run the command.</p>}
        <Button variant="primary" loading={pairing.isPending} onClick={generate}>Generate connection command</Button>
      </>}
      {command && <>
        <div className="connect-node__command"><header><span><Terminal size={15} />{platform === "windows" ? "PowerShell" : "Terminal"}</span><Button size="sm" iconLeft={copied ? Check : Copy} onClick={() => void copy()}>{copied ? "Copied" : "Copy command"}</Button></header><pre tabIndex={0} aria-label="Connection command">{command}</pre></div>
        <p className="connect-node__hint">Paste into a terminal on the target machine. This single-use command expires at {new Date(expiresAt).toLocaleTimeString()}. Keep it private.</p>
        <p className="connect-node__waiting" role="status">Waiting for your machine…</p>
        <details className="resource-details"><summary>Reconnecting an existing machine?</summary><p>The command reuses its saved connection and leaves this new code unused. Open Machines to find it and create an instance.</p><Button size="sm" onClick={() => { close(); onViewMachines?.(); }}>View machines</Button></details>
      </>}
      {(expired || cancelled) && <div role="status" className="connect-node__hint"><p>This connection command {cancelled ? "was cancelled" : "expired"}. Generate a new one to try again.</p><Button variant="primary" loading={pairing.isPending} onClick={generate}>Generate new command</Button></div>}
      {claimed && !connected && <p className="connect-node__waiting" role="status">{computerId ? "Machine registered. Waiting for the daemon to come online…" : "Machine paired. An administrator can approve it in Settings → Devices."}</p>}
      {connected && <div className="connect-node__success" role="status"><CheckCircle2 size={30} /><h3>{machine.display_name} is connected</h3>{canEnroll ? <><p>Choose an existing Agent and give it a workspace on this machine.</p><Button variant="primary" onClick={() => { const id = computerId!; close(); onCreateInstance?.(id); }}>Create an instance</Button></> : <><p>An owner or admin can now create an Agent instance on this machine.</p><Button variant="primary" onClick={() => { close(); onViewMachines?.(); }}>View machines</Button></>}</div>}
      {pairing.data && !pairingId && <p role="alert">This server needs an update to track connection progress. Open Machines after running the command.</p>}
      <ActionError error={pairing.error ?? progress.error ?? presence.error ?? copyError ?? commandError ?? bootstrap.error} />
    </div>
  </Modal>;
}
