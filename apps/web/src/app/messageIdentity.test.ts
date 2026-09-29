import { describe, expect, it } from "vitest";
import { bootstrapFixture, messageFixture } from "../test/utils.js";
import { messageIdentity } from "./messageIdentity.js";

describe("runtime message attribution", () => {
  it("resolves real run answers and mentions through their agent instance", () => {
    const bootstrap = bootstrapFixture();
    const message = messageFixture({ id: "answer", kind: "text", actor_type: "agent", actor_id: "instance_mock_coder",
      payload: { mentions: [{ actor_type: "agent", actor_id: "instance_mock_coder" }] } });
    expect(messageIdentity(message, bootstrap)).toEqual({ actorName: "Mock Coder", mentionNames: ["Mock Coder"] });
    expect(messageIdentity({ ...message, actor_id: "agent_mock_coder" }, bootstrap).actorName).toBe("Mock Coder");
  });

  it("keeps user identities separate and does not guess a missing instance's linked agent", () => {
    const bootstrap = bootstrapFixture();
    const people = [{ id: "instance_mock_coder", display_name: "A teammate", role: "member" as const }];
    const message = messageFixture({ id: "answer", kind: "text", actor_type: "agent", actor_id: "instance_mock_coder" });
    expect(messageIdentity({ ...message, actor_type: "user" }, bootstrap, people).actorName).toBe("A teammate");
    bootstrap.agent_instances[0]!.agent_id = "deleted_agent";
    expect(messageIdentity(message, bootstrap, people).actorName).toBe("agent:instance_mock_coder");
  });
});
