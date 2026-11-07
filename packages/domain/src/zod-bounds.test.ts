import { describe, expect, it } from "vitest";
import { z } from "zod";

// Exercise the installed production entry point. Zod v3 traverses the rejected
// elements here; changing only the package version while importing /v3 cannot pass.
describe.each(["sync", "async"] as const)("bounded Zod collections (%s parsing)", (mode) => {
  it.each(["array.max", "array.length", "set.max", "set.size", "map.max", "map.size"] as const)(
    "%s rejects oversized input before validating any member",
    async (kind) => {
      let visited = 0;
      const inspect = (value: string) => { visited++; return value !== "invalid"; };
      const element = z.string().refine(mode === "async" ? async (value) => inspect(value) : inspect);
      let schema: z.ZodType;
      let make: (values: string[]) => unknown;
      let visitsPerMember = 1;
      switch (kind) {
        case "array.max": schema = z.array(element).max(1); make = (values) => values; break;
        case "array.length": schema = z.array(element).length(1); make = (values) => values; break;
        case "set.max": schema = z.set(element).max(1); make = (values) => new Set(values); break;
        case "set.size": schema = z.set(element).size(1); make = (values) => new Set(values); break;
        case "map.max": schema = z.map(element, element).max(1); make = (values) => new Map(values.map((value, index) => [String(index), value])); visitsPerMember = 2; break;
        case "map.size": schema = z.map(element, element).size(1); make = (values) => new Map(values.map((value, index) => [String(index), value])); visitsPerMember = 2; break;
      }
      const parse = (input: unknown) => mode === "async" ? schema.safeParseAsync(input) : schema.safeParse(input);

      const oversized = await parse(make(["invalid", "also-invalid"]));
      expect(oversized.success).toBe(false);
      if (oversized.success) throw new Error("Oversized collection was accepted");
      expect(oversized.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "too_big", maximum: 1 }),
      ]));
      expect(visited).toBe(0);

      expect((await parse(make(["valid"]))).success).toBe(true);
      expect(visited).toBe(visitsPerMember);
      visited = 0;
      expect((await parse(make(["invalid"]))).success).toBe(false);
      expect(visited).toBe(visitsPerMember);
    },
  );
});
