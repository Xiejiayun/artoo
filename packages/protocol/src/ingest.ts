/**
 * run.event ingest idempotency (design.md §4.6 / §10.7, security S6).
 *
 * Run events are deduped on the transport envelope tuple (node_id, run_id,
 * sequence) — all protocol-level fields, no domain payload involved — so a node
 * reconnect/replay never produces duplicate task-room messages or timeline
 * entries. The server persists this set; this in-memory deduper is the contract
 * reference used by the mock loop and node integration tests.
 */
export interface RunEventKey {
  node_id: string;
  run_id: string;
  sequence: number;
}

export function runEventKey(key: RunEventKey): string {
  // JSON.stringify of a fixed-arity tuple is collision-proof: it cannot confuse
  // e.g. (node_id='a:b', run_id='c') with (node_id='a', run_id='b:c'), which a
  // naive `${node_id}:${run_id}:${sequence}` join would.
  return JSON.stringify([key.node_id, key.run_id, key.sequence]);
}

export class RunEventDeduper {
  private readonly seen = new Set<string>();

  isDuplicate(key: RunEventKey): boolean {
    return this.seen.has(runEventKey(key));
  }

  /** Records the key. Returns true if newly recorded, false if already present. */
  record(key: RunEventKey): boolean {
    const composite = runEventKey(key);
    if (this.seen.has(composite)) {
      return false;
    }
    this.seen.add(composite);
    return true;
  }
}
