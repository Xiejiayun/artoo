import { describe, expect, it } from "vitest";

import {
  ARTOO_DOMAIN_PACKAGE,
  CapabilitySchema,
  ContextPackSchema,
  EventEnvelopeSchema,
  RunStartPayloadSchema,
  TaskSchema,
  apiError,
  canTransitionTask,
} from "./index.js";

describe("domain barrel", () => {
  it("re-exports the public surface", () => {
    expect(ARTOO_DOMAIN_PACKAGE).toBe("@artoo/domain");
    expect(typeof canTransitionTask).toBe("function");
    expect(typeof apiError).toBe("function");
    for (const schema of [
      CapabilitySchema,
      ContextPackSchema,
      EventEnvelopeSchema,
      RunStartPayloadSchema,
      TaskSchema,
    ]) {
      expect(schema).toBeDefined();
    }
  });
});
