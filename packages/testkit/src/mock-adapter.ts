import type { ArtifactPayload } from "@artoo/domain";
import type {
  AgentInstanceConfig,
  AgentInstanceHandle,
  ArtifactDescriptor,
  RunEvent,
  RuntimeAdapter
} from "@artoo/protocol";

/**
 * In-process {@link RuntimeAdapter} for the mock loop. It scripts the §12.13
 * happy-path run-event sequence from real @artoo/domain payloads:
 *
 *   run.lifecycle(started) -> run.output* -> artifact.created -> run.lifecycle(final)
 *
 * RunEvents are built from domain payload shapes (not redefined here), so the
 * server's mock-run-loop test exercises the same contract a real adapter would.
 */
export interface MockAdapterOptions {
  outputLines?: string[];
  artifact?: ArtifactPayload;
  finalPhase?: "completed" | "failed" | "cancelled";
}

const DEFAULT_ARTIFACT: ArtifactPayload = {
  type: "patch",
  uri: "file:///mock/run.patch",
  metadata: {},
  checksum: null
};

export function createMockAdapter(options: MockAdapterOptions = {}): RuntimeAdapter {
  const outputLines = options.outputLines ?? ["mock: starting", "mock: tests passed"];
  const artifact = options.artifact ?? DEFAULT_ARTIFACT;
  const finalPhase = options.finalPhase ?? "completed";
  const stopped = new Set<string>();

  return {
    runtimeId: "mock-coder",

    async start(config: AgentInstanceConfig): Promise<AgentInstanceHandle> {
      stopped.delete(config.runId);
      return { runId: config.runId };
    },

    async *streamEvents(handle: AgentInstanceHandle): AsyncIterable<RunEvent> {
      yield { type: "run.lifecycle", payload: { phase: "started" } };
      for (const text of outputLines) {
        if (stopped.has(handle.runId)) {
          yield { type: "run.lifecycle", payload: { phase: "cancelled" } };
          return;
        }
        yield { type: "run.output", payload: { stream: "stdout", text } };
      }
      if (stopped.has(handle.runId)) {
        yield { type: "run.lifecycle", payload: { phase: "cancelled" } };
        return;
      }
      yield { type: "artifact.created", payload: artifact };
      yield { type: "run.lifecycle", payload: { phase: finalPhase } };
    },

    async stop(handle: AgentInstanceHandle): Promise<void> {
      stopped.add(handle.runId);
    },

    async collectArtifacts(): Promise<ArtifactDescriptor[]> {
      return [{ payload: artifact }];
    }
  };
}
