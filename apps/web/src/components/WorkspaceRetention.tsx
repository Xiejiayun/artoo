import { useState } from "react";
import { WorkspaceRetentionProjectionSchema, type Run, type WorkspaceRetentionProjection } from "@artoo/domain";
import { Button } from "../ui/index.js";

export interface RetentionComputer {
  id: string;
  display_name?: string | null;
  hostname?: string | null;
}

const outcomes: Record<WorkspaceRetentionProjection["outcome"], string> = {
  completed: "Execution completed", failed: "Execution failed", cancelled: "Execution cancelled",
  incomplete_delivery: "Delivery incomplete", unconfirmed: "Outcome unconfirmed",
};

/** Historical worker evidence; output text and run status cannot establish retention. */
export function WorkspaceRetention({ run, computers = [] }: { run: Run; computers?: readonly RetentionComputer[] }): React.ReactNode {
  const [copyStatus, setCopyStatus] = useState("");
  const parsed = WorkspaceRetentionProjectionSchema.safeParse(run.workspace_retention);
  const report = parsed.success && parsed.data.workspace_root === run.workspace_root &&
    parsed.data.workspace_branch === run.workspace_branch && parsed.data.reporter_computer_id === run.computer_id
    ? parsed.data : null;
  const root = report?.workspace_root ?? run.workspace_root;
  const branch = report?.workspace_branch ?? run.workspace_branch;
  const matches = computers.filter((computer) => computer.id === report?.reporter_computer_id);
  const computer = matches.length === 1 ? matches[0] : undefined;
  const name = computer?.display_name?.trim() || computer?.hostname?.trim();
  const copy = async (value: string, kind: "Workspace path" | "Branch"): Promise<void> => {
    try {
      if (window.artooDesktop?.writeClipboardText) await window.artooDesktop.writeClipboardText(value);
      else {
        if (!navigator.clipboard) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(value);
      }
      setCopyStatus(`${kind} copied`);
    } catch {
      setCopyStatus(`Copy unavailable. Select the ${kind.toLowerCase()} to copy it.`);
    }
  };

  return <section className="run-workspace" aria-label={`Workspace for ${run.id}`}>
    <strong>{report ? "Work retention reported" : "Retention not reported"}</strong>
    <p className="t-subtle">Run <code>{run.id}</code></p>
    {report ? <>
      <p className="t-subtle">Reported by {name ? <><span>{name}</span> · </> : null}<code>{report.reporter_computer_id}</code>{" at "}
        <time dateTime={report.reported_at} title={report.reported_at}>{new Date(report.reported_at).toLocaleString()}</time></p>
      <dl><div><dt>Reported outcome</dt><dd>{outcomes[report.outcome]}</dd></div></dl>
      <p className="t-subtle">This is the worker's report at that time. Current file availability has not been checked.</p>
    </> : <p className="t-subtle">No supported retention report is available for this run.</p>}
    {root != null && root !== "" ? <dl>
      <div><dt>{report ? "Reported workspace" : "Planned workspace"}</dt><dd><code>{root}</code></dd></div>
      {branch ? <div><dt>Branch</dt><dd><code>{branch}</code></dd></div> : null}
    </dl> : <p className="t-subtle">No workspace location was supplied.</p>}
    <div className="run-workspace-actions">
      {root != null && root !== "" ? <Button size="sm" onClick={() => void copy(root, "Workspace path")}>Copy workspace path</Button> : null}
      {branch ? <Button size="sm" onClick={() => void copy(branch, "Branch")}>Copy branch</Button> : null}
    </div>
    {copyStatus ? <p role="status" className="t-subtle">{copyStatus}</p> : null}
  </section>;
}
