import { useState } from "react";

import type { Memory } from "@artoo/domain";

import { Badge, Button, Textarea } from "../ui/index.js";
import { MEMORY_STATUS_TONE } from "./MemoryPage.js";
import "../ui/work-insights.css";

interface MemoryDetailProps {
  memory: Memory;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onSupersede: (text: string) => Promise<void>;
}

/** Renders a memory's full record — content, provenance, supersession links, and
 *  timestamps — plus the curation actions valid for its status. Accept/Reject are
 *  only offered for `proposed`; Supersede only for `accepted` (it creates a new
 *  accepted replacement and retires this row). */
export function MemoryDetail({
  memory,
  busy,
  onAccept,
  onReject,
  onSupersede,
}: MemoryDetailProps): React.ReactNode {
  const [showSupersede, setShowSupersede] = useState(false);
  const [replacement, setReplacement] = useState("");

  const provenance: Array<[string, string | null | undefined]> = [
    ["Source task", memory.source_task_id],
    ["Source run", memory.source_run_id],
    ["Source message", memory.source_message_id],
    ["Source artifact", memory.source_artifact_id],
  ];
  const hasProvenance = provenance.some(([, value]) => value != null);

  return (
    <div className="memory-detail">
      <header className="memory-detail__head">
        <h2 className="t-h2">Knowledge detail</h2>
        <Badge tone={MEMORY_STATUS_TONE[memory.status] ?? "neutral"}>{memory.status}</Badge>
      </header>
      <p className="insights-help">{memory.status === "proposed" ? "Review this proposal before making it available to future runs." : memory.status === "accepted" ? "This knowledge is accepted. Replace it when guidance changes." : "This record is kept for reference and is unavailable to future runs."}</p>
      <dl className="inv-meta insights-memory-meta">
        <div className="inv-row">
          <dt>Scope</dt>
          <dd>{memory.scope}</dd>
        </div>
        <div className="inv-row">
          <dt>Confidence</dt>
          <dd>{Math.round(memory.confidence * 100)}%</dd>
        </div>
        <div className="inv-row"><dt>Created by</dt><dd>{memory.author_type === "agent" ? "Agent" : memory.author_type === "user" ? "Team member" : memory.author_type}</dd></div>
        {memory.project_id != null ? (
          <div className="inv-row">
            <dt>Project</dt>
            <dd className="t-mono">{memory.project_id}</dd>
          </div>
        ) : null}
        {memory.task_id != null ? (
          <div className="inv-row">
            <dt>Task</dt>
            <dd className="t-mono">{memory.task_id}</dd>
          </div>
        ) : null}
        {memory.tags.length > 0 ? (
          <div className="inv-row">
            <dt>Tags</dt>
            <dd>{memory.tags.join(", ")}</dd>
          </div>
        ) : null}
      </dl>

      <section className="memory-detail__section" aria-label="Content">
        <h3 className="inventory-subtitle">Content</h3>
        {memory.text != null ? (
          <p className="t-body">{memory.text}</p>
        ) : (
          <pre className="msg__code">{JSON.stringify(memory.payload ?? {}, null, 2)}</pre>
        )}
      </section>

      <details className="insights-disclosure"><summary>Provenance and record details</summary>
      <dl className="inv-meta"><div className="inv-row"><dt>Memory ID</dt><dd><code>{memory.id}</code></dd></div><div className="inv-row"><dt>Author reference</dt><dd>{memory.author_type}:{memory.author_id}</dd></div></dl>
      {hasProvenance ? (
        <section className="memory-detail__section" aria-label="Provenance">
          <h3 className="inventory-subtitle">Provenance</h3>
          <dl className="inv-meta">
            {provenance
              .filter(([, value]) => value != null)
              .map(([label, value]) => (
                <div key={label} className="inv-row">
                  <dt>{label}</dt>
                  <dd className="t-mono">{value}</dd>
                </div>
              ))}
          </dl>
        </section>
      ) : null}

      {memory.supersedes_id != null || memory.superseded_by_id != null ? (
        <section className="memory-detail__section" aria-label="Supersession">
          <h3 className="inventory-subtitle">Supersession</h3>
          {memory.supersedes_id != null ? <p className="t-small">Supersedes {memory.supersedes_id}</p> : null}
          {memory.superseded_by_id != null ? (
            <p className="t-small">Superseded by {memory.superseded_by_id}</p>
          ) : null}
        </section>
      ) : null}

      <section className="memory-detail__section" aria-label="Timestamps">
        <h3 className="inventory-subtitle">Timestamps</h3>
        <p className="t-small t-subtle">Created {memory.created_at}</p>
        {memory.updated_at != null ? <p className="t-small t-subtle">Updated {memory.updated_at}</p> : null}
      </section>
      </details>

      {memory.status === "proposed" ? (
        <div className="memory-actions">
          <Button variant="primary" size="sm" disabled={busy} onClick={onAccept}>
            Accept
          </Button>
          <Button variant="danger" size="sm" disabled={busy} onClick={onReject}>
            Reject
          </Button>
        </div>
      ) : null}

      {memory.status === "accepted" ? (
        <div className="memory-supersede">
          {showSupersede ? (
            <form
              className="u-stack"
              onSubmit={async (event) => {
                event.preventDefault();
                if (busy || !replacement.trim()) return;
                try {
                  await onSupersede(replacement);
                  setReplacement("");
                  setShowSupersede(false);
                } catch { /* Keep the draft; the parent displays the mutation error. */ }
              }}
            >
              <Textarea
                label="Replacement text"
                value={replacement}
                disabled={busy}
                onChange={(event) => setReplacement(event.target.value)}
                required
              />
              <p className="hint">Creates an accepted replacement with the same scope and retires this memory immediately.</p>
              <div className="memory-actions">
                <Button type="submit" variant="primary" size="sm" disabled={busy || replacement.trim() === ""}>
                  Save replacement
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setShowSupersede(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setShowSupersede(true)}>
              Supersede
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
