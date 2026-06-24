import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { Memory, ProposeMemoryRequest } from "@artoo/domain";

import { newIdempotencyKey } from "../api/idempotency.js";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { Badge, EmptyState, ErrorState, Select, type Tone } from "../ui/index.js";
import { MemoryDetail } from "./MemoryDetail.js";

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

  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  const projectId = bootstrap.data?.projects[0]?.id;
  useSubscription(projectId === undefined ? [] : [`project:${projectId}`]);

  const memories = useQuery({
    queryKey: queryKeys.memories({ status, scope }),
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
        <ErrorState title="Failed to load memory" />
      </div>
    );
  }

  const items = memories.data?.memories ?? [];
  const selected = items.find((memory) => memory.id === selectedId) ?? null;
  const busy = accept.isPending || reject.isPending || supersede.isPending;

  return (
    <div className="memory">
      <header className="memory-header">
        <h1 className="t-h1">Memory</h1>
        <div className="memory-filters">
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
        </div>
      </header>

      <div className="memory-body">
        <section className="memory-list" aria-label="Memories">
          {memories.isLoading ? (
            <p className="memory-loading-label" role="status" aria-label="Loading memories">
              Loading memories
            </p>
          ) : null}
          {!memories.isLoading && items.length === 0 ? <p className="inv-empty">No memories match.</p> : null}
          <ul>
            {items.map((memory) => (
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
                  <span className="memory-summary u-truncate">{summarize(memory)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="memory-detail-panel" aria-label="Memory detail">
          {selected !== null ? (
            <MemoryDetail
              memory={selected}
              busy={busy}
              onAccept={() => accept.mutate(selected.id)}
              onReject={() => reject.mutate(selected.id)}
              onSupersede={(text) => supersede.mutate({ memory: selected, text })}
            />
          ) : (
            <EmptyState title="Select a memory to review" description="Choose a memory from the list to see its full record and curation actions." />
          )}
        </section>

        <section className="memory-context" aria-label="Injectable into ContextPack">
          <h2 className="inventory-subtitle">Injectable into ContextPack</h2>
          <p className="hint">
            Accepted memories that would inject for this project, with the audit ids recorded on a
            run&apos;s ContextPack. Proposed, rejected, and superseded memories never inject.
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
              <p className="source-ids">
                source_memory_ids:{" "}
                {context.data.source_memory_ids.length > 0
                  ? context.data.source_memory_ids.join(", ")
                  : "(none)"}
              </p>
            </>
          ) : (
            <p className="memory-loading-label" role="status" aria-label="Loading context">
              Loading context
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
