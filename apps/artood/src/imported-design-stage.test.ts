import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importedDesignRequestFixture } from "./test-fixtures/imported-design-request.js";
const controlled = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./product-source-runtime.js", () => ({ readImportedDesignResearch: controlled.read }));
import { validateProductStage } from "./product-stage.js";

const roots: string[] = [], parent = resolve(tmpdir());
beforeEach(() => { controlled.read.mockReset().mockImplementation(() => { throw Error("Controlled missing original design owner"); }); });
afterEach(() => {
  for (const root of roots.splice(0)) {
    const tail = relative(parent, resolve(root));
    if (!tail || tail.startsWith("..") || isAbsolute(tail)) throw Error("Unexpected stage test cleanup root");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const { request, bytes } = importedDesignRequestFixture();
  const root = mkdtempSync(join(parent, "artoo-imported-design-stage-")); roots.push(root);
  mkdirSync(join(root, ".artoo", "product"), { recursive: true });
  writeFileSync(join(root, ".artoo", "product", "research.json"), bytes);
  const context = structuredClone(request.run_start.context_pack.payload);
  context.workspace.root = root;
  return { root, context, bytes };
}
describe("imported product-stage gateway (controlled owner rejection, real research files)", () => {
  it("requires the original owner even when serialized accepted research and descriptor are intact", () => {
    const { root, context, bytes } = fixture();
    expect(() => validateProductStage(root, context)).toThrow("missing original design owner");
    expect(controlled.read).toHaveBeenCalledExactlyOnceWith(root, context, Buffer.from(bytes));
  });
  it("checks accepted research pins before consulting the owner", () => {
    const { root, context, bytes } = fixture(); bytes[0] = bytes[0]! ^ 1;
    writeFileSync(join(root, ".artoo", "product", "research.json"), bytes);
    expect(() => validateProductStage(root, context)).toThrow("changed"); expect(controlled.read).not.toHaveBeenCalled();
  });
  it.each(["implementation", "discussion"])("does not reinterpret a transferred design descriptor as %s authority", mode => {
    const { root, context } = fixture();
    if (mode === "discussion") context.policy.execution_mode = "discussion";
    else context.product_development!.stage = "implementation";
    expect(() => validateProductStage(root, context)).toThrow("dedicated admitted design execution");
    expect(controlled.read).not.toHaveBeenCalled();
  });
});
