import { z } from "zod";
import { SourceSupervisorLaunchV1Schema, type SourceSupervisorLaunchV1 } from "@artoo/domain";

const bound = z.object({ version: z.literal(1), kind: z.literal("source-lifecycle-bound"), nonce: z.string().uuid(),
  observer_id: z.string().uuid(), launch_identity_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
interface Control {
  nonce: string; observerId: string; ended: boolean; launch?: SourceSupervisorLaunchV1; accepted: boolean;
  pending?: { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
}
let original: Control | undefined;
/** Private pipe routing only. This never creates execution or checkpoint
 * authority; native qualification and the independent paired Server ACK remain
 * mandatory in the caller. The ordinary daemon installs no such route. */
export function installCleanDaemonControl(nonce: string, observerId: string) {
  if (original) throw Error("Original clean daemon pipe is already installed");
  const saved: Control = { nonce: z.string().uuid().parse(nonce), observerId: z.string().uuid().parse(observerId), ended: false, accepted: false };
  original = saved;
  return Object.freeze({
    accept(input: unknown): void {
      const value = bound.parse(input);
      if (saved.ended || original !== saved || !saved.launch || value.nonce !== saved.nonce || value.observer_id !== saved.observerId
        || value.launch_identity_digest !== saved.launch.launch_identity_digest)
        throw Error("Clean daemon private acknowledgement changed its original launch");
      if (saved.accepted) return;
      if (!saved.pending) throw Error("Clean daemon private acknowledgement has no original request");
      clearTimeout(saved.pending.timer); saved.accepted = true; saved.pending.resolve(); saved.pending = undefined;
    },
    invalidate(error: Error): void {
      saved.ended = true;
      if (saved.pending) { clearTimeout(saved.pending.timer); saved.pending.reject(error); saved.pending = undefined; }
    },
  });
}
export async function bindCleanDaemonParent(input: SourceSupervisorLaunchV1): Promise<void> {
  const saved = original, launch = SourceSupervisorLaunchV1Schema.parse(input);
  if (!saved || saved.ended || saved.launch || launch.observer_id !== saved.observerId)
    throw Error("Clean daemon requires its original private parent binding route");
  saved.launch = launch;
  const encoded = "ARTOO_SOURCE_LIFECYCLE_V1 " + JSON.stringify({ version: 1, kind: "source-lifecycle", nonce: saved.nonce,
    pid: process.pid, launch }) + "\n";
  if (Buffer.byteLength(encoded) > 65536) throw Error("Clean daemon private launch exceeds its pipe bound");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { saved.ended = true; saved.pending = undefined; reject(Error("Original clean parent acknowledgement timed out")); }, 30000);
    saved.pending = { resolve, reject, timer };
    process.stdout.write(encoded, error => {
      if (error && saved.pending) { clearTimeout(timer); saved.ended = true; saved.pending = undefined; reject(Error("Clean daemon private descriptor write failed")); }
    });
  });
  if (original !== saved || saved.ended || !saved.accepted) throw Error("Clean daemon private binding ended before acknowledgement");
}
