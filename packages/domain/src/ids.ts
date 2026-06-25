/**
 * Stable id generation for @artoo/domain.
 *
 * Domain *logic* never draws randomness or time directly — it receives an
 * {@link IdGen} by injection so tests can supply a deterministic generator
 * (see `@artoo/testkit`). {@link createUlidIdGen} is the single sanctioned
 * entropy seam in this package.
 */
import { ulid } from "ulid";

export const ID_PREFIXES = {
  event: "evt",
  task: "task",
  run: "run",
  room: "room",
  message: "msg",
  approval: "approval",
  artifact: "artifact",
  dependency: "dep",
  lease: "lease",
  contextPack: "ctx",
  schedulerDecision: "sched",
  agent: "agent",
  agentInstance: "ai",
  computer: "computer",
  project: "proj",
  organization: "org",
  user: "user",
  integrationJob: "integration",
  modelProfile: "model",
  effortProfile: "effort",
  memory: "mem",
  skillInstall: "skill",
  device: "device",
  deviceToken: "dtok",
  pairingCode: "pair",
  userIdentity: "uid",
  session: "sess",
  oauthFlow: "oauth",
  decision: "dec",
  handoff: "ho",
  blocker: "blk",
} as const;

export type IdPrefixName = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdPrefixName];

/** Pure helper: assemble an id from a prefix and a ULID body. No entropy here. */
export function formatId(prefix: string, body: string): string {
  return `${prefix}_${body}`;
}

export interface IdGen {
  /** Returns `${prefix}_${ULID}`. */
  generate(prefix: string): string;
}

/**
 * Sanctioned entropy seam — the ONLY place in @artoo/domain that draws
 * randomness/time for ids. Inject the result; never call from domain logic.
 */
export function createUlidIdGen(): IdGen {
  return {
    generate: (prefix: string): string => formatId(prefix, ulid()),
  };
}
