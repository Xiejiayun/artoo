import { describe, expect, it } from "vitest";
import { commandSchema, nodeHelloSchema } from "./node-messages.js";

const hello = {
  kind: "node.hello",
  node_id: "node",
  protocol_version: "v1",
  artood_version: "test",
  machine: { hostname: "local", os: "windows", arch: "x64" },
};
const command = {
  kind: "command",
  id: "inputs",
  idempotency_key: "inputs",
  type: "node.dependency-inputs.session.v1",
  payload: { version: 1, node_id: "node", session_id: "8f713102-1d3d-4c70-95f5-a9a8b8116003" },
};

describe("optional dependency input session discovery", () => {
  it("preserves old hello payloads and requires an explicit supported read contract", () => {
    expect(nodeHelloSchema.parse(hello)).not.toHaveProperty("dependency_inputs");
    expect(nodeHelloSchema.parse({ ...hello, dependency_inputs: { version: 1 } }).dependency_inputs).toEqual({
      version: 1,
    });
    for (const dependency_inputs of [{ version: 2 }, { version: 1, execution_authorized: true }])
      expect(nodeHelloSchema.safeParse({ ...hello, dependency_inputs }).success).toBe(false);
  });
  it("announces only node and original session identity without remote paths or extra authority", () => {
    expect(commandSchema.parse(command)).toEqual(command);
    for (const extra of [{ argv: ["untrusted"] }, { content_path: "file:///secret" }, { execution_authorized: true }])
      expect(commandSchema.safeParse({ ...command, payload: { ...command.payload, ...extra } }).success).toBe(false);
    expect(
      commandSchema.safeParse({ ...command, payload: { ...command.payload, session_id: "not-a-session" } }).success,
    ).toBe(false);
  });
});
