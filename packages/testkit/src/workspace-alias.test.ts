import { describe, expect, it } from "vitest";

import { ARTOO_DOMAIN_PACKAGE } from "@artoo/domain";
import { ARTOO_PROTOCOL_PACKAGE } from "@artoo/protocol";
import { ARTOO_STORAGE_PACKAGE } from "@artoo/storage";

describe("workspace test aliases", () => {
  it("allow Vitest to import workspace packages from live source", () => {
    expect(ARTOO_DOMAIN_PACKAGE).toBe("@artoo/domain");
    expect(ARTOO_PROTOCOL_PACKAGE).toBe("@artoo/protocol");
    expect(ARTOO_STORAGE_PACKAGE).toBe("@artoo/storage");
  });
});
