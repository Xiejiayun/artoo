import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Check } from "lucide-react";
import { WorktreeBaseConfigurationSchema, type AgentInstance, type WorktreeBaseConfiguration } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { Button, Input } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

const settingKey = "worktree_workspace_base";
function matchesSetting(instance: AgentInstance | undefined, expected: WorktreeBaseConfiguration | null): boolean {
  if (!instance) return false;
  if (expected === null) return !Object.hasOwn(instance.config, settingKey);
  const current = WorktreeBaseConfigurationSchema.safeParse(instance.config[settingKey]);
  return current.success && current.data.basePath === expected.basePath;
}

export function AgentWorkspaceAllocation({ instance, role, computerOs }: { instance: AgentInstance; role: string; computerOs?: string }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const canManage = ["owner", "admin"].includes(role);
  const isMac = computerOs === "darwin" || computerOs === "macos";
  const parsed = WorktreeBaseConfigurationSchema.safeParse(instance.config[settingKey]);
  const saved = parsed.success ? parsed.data : undefined;
  const hasSaved = Object.hasOwn(instance.config, settingKey);
  const [draft, setDraft] = useState<{ enabled: boolean; basePath: string } | null>(null);
  const enabled = draft?.enabled ?? !!saved;
  const basePath = draft?.basePath ?? saved?.basePath ?? "";
  // This small input check improves feedback. The server remains responsible
  // for OS/path validity, current feature support, role and active-run guards.
  const absolute = basePath.startsWith("/") && !basePath.startsWith("//") && !basePath.includes("\\") && !basePath.includes("\0");
  const mutation = useMutation({ mutationFn: async (desired: WorktreeBaseConfiguration | null) => {
    if (!canManage) throw new Error("Only an owner or admin can change task workspace settings");
    if (desired) await api.setAgentWorktreeBase(instance.id, desired);
    else await api.clearAgentWorktreeBase(instance.id);
    let refreshed;
    try {
      // Do not let a bootstrap request begun before the write stand in for
      // observing the committed configuration. Keep cached cards/drafts mounted.
      await query.cancelQueries({ queryKey: queryKeys.bootstrap, exact: true });
      await query.invalidateQueries({ queryKey: queryKeys.bootstrap, exact: true, refetchType: "none" });
      refreshed = await query.fetchQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap(), staleTime: 0, retry: false });
    } catch (error) {
      throw new Error(`The server accepted the workspace setting, but refreshing agent settings failed. Your input is retained. ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!matchesSetting(refreshed.agent_instances.find((item) => item.id === instance.id), desired)) {
      throw new Error("The refreshed agent settings differ from this change. Your input is retained; check the current setting before saving again.");
    }
    return desired;
  }, onSuccess: () => { setDraft(null); } });
  if (!canManage) return null;
  const unchanged = enabled ? !!saved && saved.basePath === basePath : !hasSaved;
  const canSave = !mutation.isPending && !unchanged && (!enabled || (isMac && absolute));
  return <form className="resource-form" aria-label="Task workspace configuration" onSubmit={(event) => {
    event.preventDefault();
    if (canSave) mutation.mutate(enabled ? { version: 1, strategy: "per-run", basePath } : null);
  }}>
    <label><input type="checkbox" checked={enabled} disabled={mutation.isPending || (!isMac && !enabled)} onChange={(event) => {
      mutation.reset(); setDraft({ enabled: event.target.checked, basePath });
    }} />Separate workspace for each task</label>
    {enabled && <Input label="Task workspace base folder" value={basePath} required disabled={mutation.isPending || !isMac}
      placeholder="/Users/you/Artoo workspaces" errorText={basePath && !absolute ? "Enter an absolute folder path on the Mac, starting with /." : undefined}
      helperText="Use a folder allowed by this Mac's worker configuration. The exact path is preserved."
      onChange={(event) => { mutation.reset(); setDraft({ enabled, basePath: event.target.value }); }} />}
    <p className="t-subtle">Applies to branch-backed task assignments. Prepare separate workspaces and allow new allocations in the Mac desktop settings first. This setting does not grant access to folders.</p>
    {!isMac && <p className="resource-form__notice">New separate-workspace settings require a Mac execution computer. An existing setting can still be turned off.</p>}
    <p>Current setting: {saved ? <>Separate task workspaces under <code>{saved.basePath}</code></> : hasSaved ? "Saved setting is invalid; turn this option off and save to clear it." : "Use the agent’s registered workspace."}</p>
    <ActionError error={mutation.error} />
    <div><Button size="sm" type="submit" variant="primary" disabled={!canSave} loading={mutation.isPending}>Save task workspace setting</Button></div>
    {mutation.isSuccess && matchesSetting(instance, mutation.data) && <p className="resource-success" role="status"><Check size={15} aria-hidden="true" />Task workspace setting saved.</p>}
  </form>;
}
