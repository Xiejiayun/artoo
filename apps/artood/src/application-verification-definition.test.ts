import { describe, expect, it } from "vitest";
import { readApplicationVerificationDefinition } from "./application-verification-definition.js";
const digest = "sha256:" + "a".repeat(64);
const program = { version: 3, contract_digest: digest, steps: [
  { action: "navigate", page: "main", path: "/" }, { action: "assert_text", page: "main", selector: "#items", text: "Saved" }] };
function fixture() {
  const definition = { version: 1, format: "artoo.application-definition.v1", schema: { version: 1,
    tables: [{ name: "items", columns: [{ name: "text", type: "text", nullable: false, max_bytes: 4096 }] }] },
    persistence: { write: { path: "/api/items", body: { idempotency_key: "save" }, expected_status: 201, expected_json: { saved: true } },
      read: { path: "/api/items", expected_status: 200, expected_json: { items: ["Saved"] } }, after_restart_browser_program: program } };
  const design = { version: 1, requirement_ids: ["save"], information_architecture: ["Items"],
    user_flows: [{ id: "save", name: "Save", requirement_ids: ["save"], steps: ["Save an item"] }],
    screens: [{ id: "main", name: "Items", purpose: "Read items", states: ["Saved"], accessibility: ["Labels"], responsive: ["Fits"] }],
    prototype: { entrypoint: "product/index.html", description: "Prototype" }, data_model: [], api_contracts: [],
    decisions: [{ decision: "Persist items", rationale: "User requirement" }],
    validation_cases: [{ id: "save", requirement_ids: ["save"], procedure: ["Save and read"], expected_result: "Saved", browser_program: program }] };
  return { definition, design, read: (value: unknown = definition, cases: unknown = design) =>
    readApplicationVerificationDefinition(JSON.stringify(value), JSON.stringify(cases), digest) };
}
describe("bounded declarative application verification inputs", () => {
  it("retains immutable design programs and a schema-bound read-only reopen assertion", () => {
    const f = fixture(), value = f.read();
    expect(value.cases[0]!.program).toEqual(program); expect(value.persistence).toEqual(f.definition.persistence);
    expect(Object.isFrozen(value.persistence.write.body)).toBe(true); expect(Object.isFrozen(value.cases[0]!.program.steps)).toBe(true);
    expect(value.schemaDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
  it.each(["https://example.com/api/items", "//example.com/api/items", "/api/../private", "/api/items#x", "/api\\items"])("rejects API path %s", path => {
    const f = fixture(); f.definition.persistence.write.path = path; expect(() => f.read()).toThrow();
  });
  it("rejects local paths, commands or grants in the model's definition", () => {
    const f = fixture();
    for (const extra of [{ argv: ["cmd"] }, { node: { path: "C:\\node.exe" } }, { access: "write" }]) expect(() => f.read({ ...f.definition, ...extra })).toThrow();
  });
  it("rejects nonfinite numbers before stringify can turn them into null", () => {
    const f = fixture(), text = JSON.stringify(f.definition).replace('"saved":true', '"saved":1e999');
    expect(() => readApplicationVerificationDefinition(text, JSON.stringify(f.design), digest)).toThrow("Nonfinite");
  });
  it("bounds nested and wide product JSON independently of transport bytes", () => {
    const f = fixture(); let nested: unknown = null; for (let n = 0; n < 34; n++) nested = [nested];
    expect(() => f.read({ ...f.definition, persistence: { ...f.definition.persistence, write: { ...f.definition.persistence.write, body: nested } } })).toThrow("shape");
    expect(() => f.read({ ...f.definition, persistence: { ...f.definition.persistence, write: { ...f.definition.persistence.write, body: Array(16_384).fill(0) } } })).toThrow("shape");
  });
  it("refuses writes, unrelated contracts and assertion-free reopen programs", () => {
    const f = fixture();
    for (const after of [{ ...program, contract_digest: "sha256:" + "b".repeat(64) },
      { ...program, steps: [...program.steps, { action: "click", page: "main", selector: "#save" }] },
      { ...program, steps: [program.steps[0], { action: "assert_visible", page: "main", selector: "#items" }] }]) {
      expect(() => f.read({ ...f.definition, persistence: { ...f.definition.persistence, after_restart_browser_program: after } })).toThrow();
    }
  });
  it("requires all design cases to retain v3 programs and declines fault-injection scope", () => {
    const f = fixture();
    for (const item of [{ ...f.design.validation_cases[0], browser_program: undefined },
      { ...f.design.validation_cases[0], browser_program: { ...program, version: 2 } },
      { ...f.design.validation_cases[0], storage_checks: {} }]) expect(() => f.read(f.definition, { ...f.design, validation_cases: [item] })).toThrow();
  });
});
