import { useProject } from "../app/useProject.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BookOpen } from "lucide-react";

import type { Memory, ProposeMemoryRequest } from "@artoo/domain";

import { newIdempotencyKey } from "../api/idempotency.js";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { Badge, Button, EmptyState, ErrorState, Input, Select, type Tone } from "../ui/index.js";
import { MemoryDetail } from "./MemoryDetail.js";
import { ActionError } from "./ActionError.js";
import "../ui/work-insights.css";

const STATUS_FILTERS = ["all", "proposed", "accepted", "rejected", "superseded"] as const;
const SCOPE_FILTERS = ["all", "task", "project", "organization", "code"] as const;

export const MEMORY_STATUS_TONE: Record<string, Tone> = {
  proposed: "info",
  accepted: "success",
  rejected: "danger",
  superseded: "neutral",
};

function summarize(memory: Memory): string {
  return memory.text ?? JSON.stringify(memory.payload ?? {});
}

/**
 * Memory product surface (#22): review agent-proposed memories (accept / reject /
 * supersede) and inspect the ContextPack injection evidence. The injectable panel
 * is sourced ONLY from `GET /memories/context` (accepted-only), never inferred
 * from the list query, so proposed/rejected/superseded rows are never presented
 * as injected. Refreshes in realtime via the `project:` subscription.
 */
export function MemoryPage(): React.ReactNode {
  const api = useApi();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [scope, setScope] = useState<(typeof SCOPE_FILTERS)[number]>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const { bootstrap, projectId } = useProject();
  useSubscription(projectId === undefined ? [] : [`project:${projectId}`]);

  const memories = useQuery({
    queryKey: queryKeys.memories({ status, scope, projectId }),
    queryFn: () =>
      api.listMemories({
        status: status === "all" ? undefined : status,
        scope: scope === "all" ? undefined : scope,
      }),
    enabled: projectId !== undefined,
  });

  const context = useQuery({
    queryKey:
      projectId === undefined ? ["memoryContext", "pending"] : queryKeys.memoryContext(projectId),
    queryFn: () => api.getMemoryContext(projectId as string),
    enabled: projectId !== undefined,
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["memories"] });
    await queryClient.invalidateQueries({ queryKey: ["memoryContext"] });
  };
  const accept = useMutation({
    mutationFn: (id: string) => api.acceptMemory(id, newIdempotencyKey()),
    onSuccess: invalidate,
  });
  const reject = useMutation({
    mutationFn: (id: string) => api.rejectMemory(id, newIdempotencyKey()),
    onSuccess: invalidate,
  });
  const supersede = useMutation({
    mutationFn: ({ memory, text }: { memory: Memory; text: string }) => {
      // Inherit the old memory's scope refs; send only contract-accepted fields.
      const body: ProposeMemoryRequest = {
        scope: memory.scope,
        project_id: memory.project_id ?? null,
        task_id: memory.task_id ?? null,
        text,
        tags: memory.tags,
        confidence: memory.confidence,
      };
      return api.supersedeMemory(memory.id, body, newIdempotencyKey());
    },
    onSuccess: invalidate,
  });

  if (bootstrap.isLoading) {
    return (
      <div className="memory">
        <p className="memory-loading-label" role="status" aria-label="Loading memory">
          Loading memory
        </p>
      </div>
    );
  }
  if (bootstrap.isError || projectId === undefined) {
    return (
      <div className="memory">
        <ErrorState title="Failed to load memory" action={<Button onClick={() => void bootstrap.refetch()}>Retry</Button>} />
      </div>
    );
  }

  const items = memories.data?.memories ?? [];
  const matching = items.filter((memory) => `${summarize(memory)} ${memory.tags.join(" ")}`.toLowerCase().includes(search.trim().toLowerCase()));
  const selected = items.find((memory) => memory.id === selectedId) ?? null;
  const busy = accept.isPending || reject.isPending || supersede.isPending;

  return (
    <div className="memory insights-page">
      <header className="insights-page__header">
        <div><span className="insights-eyebrow"><BookOpen size={15} aria-hidden="true" /> Shared knowledge</span><h1 className="t-h1">Memory</h1><p>Review what your agents learn and keep useful knowledge current.</p></div>
      </header>
        <div className="insights-toolbar memory-filters">
          <Input label="Search memories" placeholder="Search knowledge or tags…" value={search} onChange={(event) => setSearch(event.target.value)} />
          <Select
            label="Status"
            value={status}
            onChange={(event) => setStatus(event.target.value as (typeof STATUS_FILTERS)[number])}
          >
            {STATUS_FILTERS.map((value) => (
              <option key={value} value={value}>
                {value === "all" ? "All" : value}
              </option>
            ))}
          </Select>
          <Select
            label="Scope"
            value={scope}
            onChange={(event) => setScope(event.target.value as (typeof SCOPE_FILTERS)[number])}
          >
            {SCOPE_FILTERS.map((value) => (
              <option key={value} value={value}>
                {value === "all" ? "All" : value}
              </option>
            ))}
          </Select>
          {(search || status !== "all" || scope !== "all") && <Button size="sm" variant="ghost" onClick={() => { setSearch(""); setStatus("all"); setScope("all"); }}>Clear filters</Button>}
        </div>
      <ActionError error={memories.error ?? context.error ?? accept.error ?? reject.error ?? supersede.error} />

      <div className="memory-body">
        <section className="memory-list" aria-label="Memories">
          <div className="insights-section-heading"><h2>Knowledge</h2><Badge>{matching.length}</Badge></div>
          {memories.isLoading ? (
            <p className="memory-loading-label" role="status" aria-label="Loading memories">
              Loading memories
            </p>
          ) : null}
          {!memories.isLoading && matching.length === 0 ? <EmptyState title="No memories match." description={search || status !== "all" || scope !== "all" ? "Try another search or clear your filters." : "Agent proposals will appear here for you to review."} /> : null}
          {memories.isError && <Button size="sm" onClick={() => void memories.refetch()}>Retry memories</Button>}
          <ul>
            {matching.map((memory) => (
              <li key={memory.id}>
                <button
                  type="button"
                  className="memory-row"
                  aria-pressed={memory.id === selectedId}
                  data-scope={memory.scope}
                  data-status={memory.status}
                  onClick={() => setSelectedId(memory.id)}
                >
                  <span className="memory-row__badges">
                    <Badge tone="neutral">{memory.scope}</Badge>
                    <Badge tone={MEMORY_STATUS_TONE[memory.status] ?? "neutral"}>{memory.status}</Badge>
                  </span>
                  <span className="memory-summary">{summarize(memory)}</span>
                  <span className="insights-row-meta">{memory.tags.length ? memory.tags.slice(0, 3).join(" · ") : "No tags"}<time dateTime={memory.updated_at ?? memory.created_at}>{new Date(memory.updated_at ?? memory.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time></span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="memory-detail-panel" aria-label="Memory detail">
          {selected !== null ? (
            <MemoryDetail
              key={selected.id}
              memory={selected}
              busy={busy}
              onAccept={() => accept.mutate(selected.id)}
              onReject={() => reject.mutate(selected.id)}
              onSupersede={async (text) => { await supersede.mutateAsync({ memory: selected, text }); }}
            />
          ) : (
            <EmptyState title="Select a memory to review" description="Choose a memory from the list to see its full record and curation actions." />
          )}
        </section>

        <section className="memory-context" aria-label="Injectable into ContextPack">
          <div className="insights-section-heading"><h2>Available to future runs</h2><Badge tone="success">{context.data?.memories.length ?? 0} accepted</Badge></div>
          <p className="hint">
            Accepted knowledge eligible for this project. A run’s evidence records what it actually used. Proposed, rejected, and superseded memories are excluded.
          </p>
          {context.data !== undefined ? (
            <>
              <ul className="memory-context__list">
                {context.data.memories.map((memory) => (
                  <li key={memory.id}>
                    <Badge tone="neutral">{memory.scope}</Badge>{" "}
                    <span className="memory-summary">{summarize(memory)}</span>
                  </li>
                ))}
              </ul>
              {context.data.memories.length === 0 && <p>No accepted knowledge is available for this project yet.</p>}
              <details className="insights-disclosure"><summary>Source references</summary><p className="source-ids">
                source_memory_ids:{" "}
                {context.data.source_memory_ids.length > 0
                  ? context.data.source_memory_ids.join(", ")
                  : "(none)"}
              </p></details>
            </>
          ) : context.isError ? <Button size="sm" onClick={() => void context.refetch()}>Retry available knowledge</Button> : (
            <p className="memory-loading-label" role="status" aria-label="Loading context">
              Loading context
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
