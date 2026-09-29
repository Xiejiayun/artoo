import type { Member, Message } from "@artoo/domain";
import type { BootstrapResponse } from "../api/types.js";

/** Use the same identity snapshot for timeline, thread-root and mentioned cards. */
export function messageIdentity(message: Message, bootstrap?: BootstrapResponse, people: Member[] = []): { actorName: string; mentionNames: string[] } {
  const name = (actorType: string, actorId: string, annotateSelf = false): string => {
    if (actorType === "system") return "Artoo";
    const fallback = `${actorType}:${actorId}`;
    if (actorType === "user" && bootstrap?.user.id === actorId) {
      const ownName = bootstrap.user.display_name.trim() || bootstrap.user.email.trim() || fallback;
      return annotateSelf ? `${ownName} (you)` : ownName;
    }
    if (actorType === "user") return people.find((person) => person.id === actorId)?.display_name.trim() || fallback;
    if (actorType === "agent") {
      // Run answers are signed by the executing instance, while older messages
      // and mentions may identify the agent directly.
      const agentId = bootstrap?.agent_instances.find((instance) => instance.id === actorId)?.agent_id ?? actorId;
      return bootstrap?.agents.find((agent) => agent.id === agentId)?.display_name.trim() || fallback;
    }
    return fallback;
  };
  const refs = Array.isArray(message.payload.mentions) ? message.payload.mentions : [];
  const mentionNames = [...new Set(refs.flatMap((ref: unknown) => {
    if (!ref || typeof ref !== "object" || !("actor_type" in ref) || typeof ref.actor_type !== "string" || !("actor_id" in ref) || typeof ref.actor_id !== "string" || !ref.actor_id) return [];
    return [name(ref.actor_type, ref.actor_id)];
  }))];
  return { actorName: name(message.actor_type, message.actor_id, true), mentionNames };
}
