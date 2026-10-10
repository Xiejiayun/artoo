import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AiDataSharingState } from "../api/aiDataSharing.js";
import { useApi } from "../app/ApiContext.js";
import { Button } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import "../ui/ai-sharing.css";

/** A browser top-layer dialog remains accessible above an open assignment modal. */
export function AIConsentProvider({ children, userId }: { children: ReactNode; userId?: string }): ReactNode {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<Array<(allowed: boolean) => void>>([]);
  function finish(allowed: boolean): void {
    dialog.current?.close();
    setOpen(false);
    const callbacks = pending.current;
    pending.current = [];
    callbacks.forEach((resolve) => resolve(allowed));
  }
  useEffect(() => api.setAIConsentHandler(() => new Promise<boolean>((resolve) => {
    pending.current.push(resolve); setOpen(true);
  }), () => finish(false), userId), [api, userId]);
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  return <>{children}<dialog ref={dialog} className="ai-sharing-dialog" aria-labelledby="ai-sharing-title"
    onKeyDown={(event) => event.stopPropagation()}
    onCancel={(event) => { event.preventDefault(); finish(false); }}>
    {open && <><h2 id="ai-sharing-title">AI data sharing</h2><AIDataSharingContent onFinish={finish} expectedUserId={userId} /></>}
  </dialog></>;
}

export function AIDataSharingSettings(): ReactNode {
  const [open, setOpen] = useState(false);
  return <section className="settings-section" aria-label="AI data sharing">
    <header className="settings-section__heading"><div><h2>AI data sharing</h2><p>Review your team's AI providers and manage your permission.</p></div>
      <Button onClick={() => setOpen(!open)}>{open ? "Hide disclosure" : "Review AI data sharing"}</Button></header>
    {open && <div className="settings-section__body"><AIDataSharingContent /></div>}
  </section>;
}

const categories: Record<string, string> = {
  prompts_and_messages: "Prompts and messages", task_and_goal_context: "Task and goal context",
  workspace_files: "Workspace files used by your agents", execution_results: "Execution results",
  account_and_workspace_identifiers: "Account and workspace identifiers",
};

export function AIDataSharingContent({ onFinish, expectedUserId }: { onFinish?: (allowed: boolean) => void; expectedUserId?: string }): ReactNode {
  const api = useApi();
  const [state, setState] = useState<AiDataSharingState>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const alive = useRef(true);
  async function load(): Promise<void> {
    setBusy(true); setError(undefined);
    try {
      const result = await api.aiDataSharing();
      if (expectedUserId && result.user_id !== expectedUserId) throw new Error("Your account changed. Reload this workspace before granting permission.");
      if (alive.current) setState(result);
    }
    catch (cause) { if (alive.current) setError(cause); }
    finally { if (alive.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [api]);
  async function allow(): Promise<void> {
    if (!state?.policy || busy) return;
    setBusy(true); setError(undefined);
    try {
      const result = await api.allowAIDataSharing(state.policy.version, state.user_id);
      if (!alive.current) return;
      setState(result);
      if (result.consent) onFinish?.(true);
    } catch (cause) { if (alive.current) setError(cause); }
    finally { if (alive.current) setBusy(false); }
  }
  async function withdraw(): Promise<void> {
    if (!state || busy) return;
    setBusy(true); setError(undefined);
    try {
      const result = await api.withdrawAIDataSharing(state.user_id);
      if (alive.current) { setState(result); setConfirm(false); }
    } catch (cause) { if (alive.current) setError(cause); }
    finally { if (alive.current) setBusy(false); }
  }
  const policy = state?.policy;
  return <div className="u-stack ai-sharing-content">
    {!state && !error && <p role="status">Loading AI disclosure…</p>}
    {state && (!state.configured || !policy ? <p>Your team has not configured its AI provider disclosure. Ask your team administrator to complete it before starting agent work. You can continue browsing your workspace.</p>
      : policy.mode === "local" ? <p>Your team administrator has declared local-only AI processing with no external AI providers. External AI sharing permission is not required for this configuration.</p>
      : <>
        <p>When you request agent work, your execution computer may send the following information to the providers listed below.</p>
        <h3>What is shared</h3><ul>{policy.data_categories.map((category) => <li key={category}>{categories[category] ?? category}</li>)}</ul>
        <p>{policy.purpose}</p>
        <h3>AI providers</h3><ul>{policy.providers.map((provider) => <li key={provider.id}><strong>{provider.name}</strong>{" · "}
          {provider.privacy_url.startsWith("https://") && <a href={provider.privacy_url} target="_blank" rel="noopener noreferrer">Privacy policy for {provider.name}</a>}</li>)}</ul>
        <p>Only continue if you have permission to share this information. You can withdraw in Settings → AI data sharing. Withdrawal stops new sharing and requests that your agent work stop; information already sent cannot be recalled.</p>
        {state.consent ? <>
          <p role="status">You have allowed this team's current disclosure.</p>
          {onFinish && <Button onClick={() => onFinish(true)}>Continue</Button>}
        </> : <Button variant="primary" disabled={busy} onClick={() => void allow()}>Allow AI data sharing</Button>}
      </>)}
    {state && !onFinish && (confirm ? <div className="u-stack-sm">
      <p>Withdraw permission and stop your queued and running agent work for this team, across your devices? Offline computers may need to be stopped manually.</p>
      <div className="action-row"><Button variant="danger" disabled={busy} onClick={() => void withdraw()}>Withdraw and stop my agent work</Button><Button disabled={busy} onClick={() => setConfirm(false)}>Keep permission</Button></div>
    </div> : <Button variant="danger" disabled={busy} onClick={() => setConfirm(true)}>Withdraw permission…</Button>)}
    {state?.unconfirmed_stops && <div role="status">
      <p>Permission withdrawn.</p>
      {state.unconfirmed_stops.length ? <><p>Stopping {state.unconfirmed_stops.length} work items could not be confirmed. Stop affected agents on their execution computers; already running processes may still share information.</p>
        <ul>{state.unconfirmed_stops.map((item) => <li key={`${item.kind}:${item.id}`}>{item.kind}: {item.id}</li>)}</ul></> : <p>No affected agent work has an unconfirmed stop.</p>}
    </div>}
    <ActionError error={error} />
    {!!error && <Button disabled={busy} onClick={() => void load()}>Reload disclosure</Button>}
    {onFinish && <Button disabled={busy} onClick={() => onFinish(false)}>Not now</Button>}
  </div>;
}
