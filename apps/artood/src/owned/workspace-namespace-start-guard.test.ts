import { describe, expect, it } from "vitest";
import { provisionRunNamespace } from "./workspace-namespace.js";

const input = {
  basePath: "/unobserved",
  agentInstanceId: "fixture-agent",
  runId: "fixture-run",
  root: "/unobserved/target",
  sourceRepo: "/unobserved/repo",
  allowedRoots: ["/unobserved"],
};

describe("namespace private startup guard", () => {
  it("rejects an expired guard before any filesystem preflight, including on unsupported platforms", async () => {
    const expired = new Error("Original start window expired");
    await expect(
      provisionRunNamespace(input, {}, () => {
        throw expired;
      }),
    ).rejects.toBe(expired);
  });

  it("rejects asynchronous and value-returning callbacks before touching paths", async () => {
    for (const guard of [() => Promise.resolve(), () => true]) {
      await expect(provisionRunNamespace(input, {}, guard)).rejects.toThrow("synchronously without a value");
    }
  });
});
