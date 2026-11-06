import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProductSourceRoutingV1Schema, ProductSourceTransferRequestV2Schema } from "./product-source-semantics.js";

const request = ProductSourceTransferRequestV2Schema.parse(JSON.parse(readFileSync(new URL("../test-fixtures/product-source-operation.json", import.meta.url), "utf8")).admission.request);
const mapping = { source_release: request.source_export.measurement_v2!.source_release,
  destination_release: request.measurement_v2!.destination_release, command_pairs: request.command_pairs };

describe("prepared route metadata (not execution authority)", () => {
  it("keeps source exports separate from complete destination mappings", () => {
    expect(ProductSourceRoutingV1Schema.parse({ version: 1, source_exports: [mapping.source_release], destination_mappings: [] }).destination_mappings).toEqual([]);
    expect(ProductSourceRoutingV1Schema.parse({ version: 1, source_exports: [], destination_mappings: [mapping] }).source_exports).toEqual([]);
  });
  it("rejects duplicate routes, ambiguous command mappings, project substitution and command injection", () => {
    const route = { version: 1, source_exports: [], destination_mappings: [mapping] };
    const invalid = [
      { ...route, source_exports: [mapping.source_release, mapping.source_release] },
      { ...route, destination_mappings: [mapping, mapping] },
      { ...route, destination_mappings: [{ ...mapping, command_pairs: [mapping.command_pairs[0], mapping.command_pairs[0]] }] },
      { ...route, destination_mappings: [{ ...mapping, destination_release: { ...mapping.destination_release,
        binding: { ...mapping.destination_release.binding, project_id: "different-project" } } }] },
      { ...route, destination_mappings: [{ ...mapping, argv: ["task-supplied-command"] }] },
      { ...route, version: 2 },
    ];
    for (const value of invalid) expect(ProductSourceRoutingV1Schema.safeParse(value).success).toBe(false);
  });
});
