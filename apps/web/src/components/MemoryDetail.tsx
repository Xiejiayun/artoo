import { useState } from "react";

import type { Memory } from "@artoo/domain";

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
      <h2>{memory.id}</h2>
      <dl className="memory-fields">
        <dt>Status</dt>
        <dd data-status={memory.status}>{memory.status}</dd>
        <dt>Scope</dt>
        <dd>{memory.scope}</dd>
        <dt>Confidence</dt>
        <dd>{memory.confidence}</dd>
        <dt>Author</dt>
        <dd>
          {memory.author_type}:{memory.author_id}
        </dd>
        {memory.project_id != null ? (
          <>
            <dt>Project</dt>
            <dd>{memory.project_id}</dd>
          </>
        ) : null}
        {memory.task_id != null ? (
          <>
            <dt>Task</dt>
            <dd>{memory.task_id}</dd>
          </>
        ) : null}
        {memory.tags.length > 0 ? (
          <>
            <dt>Tags</dt>
            <dd>{memory.tags.join(", ")}</dd>
          </>
        ) : null}
      </dl>

      <section aria-label="Content">
        <h3>Content</h3>
        {memory.text != null ? (
          <p>{memory.text}</p>
        ) : (
          <pre>{JSON.stringify(memory.payload ?? {}, null, 2)}</pre>
        )}
      </section>

      {hasProvenance ? (
        <section aria-label="Provenance">
          <h3>Provenance</h3>
          <dl>
            {provenance
              .filter(([, value]) => value != null)
              .map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
          </dl>
        </section>
      ) : null}

      {memory.supersedes_id != null || memory.superseded_by_id != null ? (
        <section aria-label="Supersession">
          <h3>Supersession</h3>
          {memory.supersedes_id != null ? <p>Supersedes {memory.supersedes_id}</p> : null}
          {memory.superseded_by_id != null ? (
            <p>Superseded by {memory.superseded_by_id}</p>
          ) : null}
        </section>
      ) : null}

      <section aria-label="Timestamps">
        <h3>Timestamps</h3>
        <p>Created {memory.created_at}</p>
        {memory.updated_at != null ? <p>Updated {memory.updated_at}</p> : null}
      </section>

      {memory.status === "proposed" ? (
        <div className="memory-actions">
          <button type="button" disabled={busy} onClick={onAccept}>
            Accept
          </button>
          <button type="button" disabled={busy} onClick={onReject}>
            Reject
          </button>
        </div>
      ) : null}

      {memory.status === "accepted" ? (
        <div className="memory-supersede">
          {showSupersede ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                onSupersede(replacement);
                setReplacement("");
                setShowSupersede(false);
              }}
            >
              <label>
                Replacement text
                <textarea
                  value={replacement}
                  onChange={(event) => setReplacement(event.target.value)}
                  required
                />
              </label>
              <p className="hint">
                Creates a new accepted memory (same scope/refs) and retires this one.
              </p>
              <button type="submit" disabled={busy || replacement.trim() === ""}>
                Save replacement
              </button>
              <button type="button" onClick={() => setShowSupersede(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <button type="button" disabled={busy} onClick={() => setShowSupersede(true)}>
              Supersede
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
