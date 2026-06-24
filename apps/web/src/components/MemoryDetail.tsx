import { useState } from "react";

import type { Memory } from "@artoo/domain";

import { Badge, Button, Textarea } from "../ui/index.js";
import { MEMORY_STATUS_TONE } from "./MemoryPage.js";

interface MemoryDetailProps {
  memory: Memory;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onSupersede: (text: string) => void;
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
        <h2 className="t-h3 t-mono">{memory.id}</h2>
        <Badge tone={MEMORY_STATUS_TONE[memory.status] ?? "neutral"}>{memory.status}</Badge>
      </header>
      <dl className="inv-meta">
        <div className="inv-row">
          <dt>Scope</dt>
          <dd>{memory.scope}</dd>
        </div>
        <div className="inv-row">
          <dt>Confidence</dt>
          <dd>{memory.confidence}</dd>
        </div>
        <div className="inv-row">
          <dt>Author</dt>
          <dd>
            {memory.author_type}:{memory.author_id}
          </dd>
        </div>
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
              onSubmit={(event) => {
                event.preventDefault();
                onSupersede(replacement);
                setReplacement("");
                setShowSupersede(false);
              }}
            >
              <Textarea
                label="Replacement text"
                value={replacement}
                onChange={(event) => setReplacement(event.target.value)}
                required
              />
              <p className="hint">Creates a new accepted memory (same scope/refs) and retires this one.</p>
              <div className="memory-actions">
                <Button type="submit" variant="primary" size="sm" disabled={busy || replacement.trim() === ""}>
                  Save replacement
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowSupersede(false)}>
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
