import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApplicationArtifactOwner, readApplicationClientArtifact, revokeApplicationClientReader, assertApplicationClientReader,
  type ApplicationClientReader, type ApplicationArtifactByteFile, type ApplicationArtifactCaptureInput,
  type ApplicationArtifactExpectation, type CapturedApplicationArtifact } from "./application-artifact-admission.js";

const sha = (bytes: Uint8Array | string) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const file = (path: string, text: string): ApplicationArtifactByteFile => ({ path, bytes: Buffer.from(text, "utf8") });
function expectation(input: ApplicationArtifactCaptureInput): ApplicationArtifactExpectation {
  const set = (files: readonly ApplicationArtifactByteFile[]) => {
    const pins = files.map(item => ({ path: item.path, bytes: item.bytes.byteLength, sha256: sha(item.bytes) }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { files: pins, digest: sha(JSON.stringify(pins)) };
  };
  return { version: 1, source: set(input.source), artifacts: set(input.artifacts), toolchain: set(input.toolchain) };
}
function fixture() {
  // Controlled source/output and binary bytes. No compiler, guest, native owner,
  // filesystem admission or generated product is executed by these content tests.
  const source = [file("product/client/index.html", "<h1>笔记 📚</h1>"), file("product/client/app.ts", "export const title: string = 'notes';"),
    file("product/server/handler.ts", "export async function handle() { return {status: 200, body: null}; }"),
    file("product/server/value.ts", "export const value = 'captured';"),
    file("product/server/nested/a.ts", "export {value} from '../value.js';")];
  const artifacts = [file("client/index.html", "<h1>笔记 📚</h1>"), file("client/app.js", "export const title = 'notes';"),
    file("server/handler.js", "export async function handle() { return {status: 200, body: null}; }"),
    file("server/value.js", "export const value = 'captured';"), file("server/nested/a.js", "export {value} from '../value.js';")];
  const toolchain = [{ path: "compiler/entry.js", bytes: new Uint8Array([0, 0xff, 0x80, 1]) }, file("libraries/lib.es2023.d.ts", "// controlled library bytes")];
  const input = { source, artifacts, toolchain }; return { input, expected: expectation(input) };
}

describe("owner-local immutable content capture and virtual server modules", () => {
  it("captures complete independently pinned sets and loads only copied server text", () => {
    const { input, expected } = fixture(), owner = createApplicationArtifactOwner(expected), token = owner.capture(input);
    expect(Object.isFrozen(token)).toBe(true); expect(Object.keys(token)).toEqual([]);
    expect(owner.entry(token)).toBe("server/handler.js");
    expect(owner.load(token, "server/value.js")).toBe("export const value = 'captured';");
    for (const files of [input.source, input.artifacts, input.toolchain]) for (const item of files) item.bytes.fill(0);
    input.artifacts.splice(0); input.source.splice(0); input.toolchain.splice(0);
    expect(owner.load(token, "server/value.js")).toBe("export const value = 'captured';");
    expect(owner.resolve(token, "server/handler.js", "./value.js")).toBe("server/value.js");
    expect(Object.values(token).some(value => value instanceof Uint8Array)).toBe(false);
  });

  it("captures the owner's expectations independently of later caller mutation", () => {
    const { input, expected } = fixture(), owner = createApplicationArtifactOwner(expected);
    Object.assign(expected.source, { digest: sha("changed") });
    Object.assign(expected.artifacts.files[0]!, { path: "client/changed.html", sha256: sha("changed") });
    expect(owner.entry(owner.capture(input))).toBe("server/handler.js");
  });

  it("requires original tokens from this owner and revokes content access explicitly", () => {
    const { input, expected } = fixture(), first = createApplicationArtifactOwner(expected), second = createApplicationArtifactOwner(expected);
    const token = first.capture(input);
    for (const foreign of [JSON.parse(JSON.stringify(token)), { ...token }, second.capture(input)])
      expect(() => first.load(foreign as CapturedApplicationArtifact, "server/handler.js")).toThrow("capture-required");
    first.revoke(token);
    expect(() => first.entry(token)).toThrow("capture-required");
    expect(() => first.resolve(token, "server/handler.js", "./value.js")).toThrow("capture-required");
    expect(() => first.revoke(token)).toThrow("capture-required");
  });

  it.each(["source", "artifacts", "toolchain"] as const)("remeasures every %s file rather than accepting metadata", role => {
    const { input, expected } = fixture(), owner = createApplicationArtifactOwner(expected);
    const bytes = input[role][input[role].length - 1]!.bytes; bytes[0] = bytes[0]! ^ 1;
    expect(() => owner.capture(input)).toThrow("pin-mismatch");
  });

  it.each(["missing", "extra", "duplicate", "case-change", "length"])("rejects a %s complete artifact set", mutation => {
    const { input, expected } = fixture(), owner = createApplicationArtifactOwner(expected);
    if (mutation === "missing") input.artifacts.pop();
    if (mutation === "extra") input.artifacts.push(file("server/extra.js", "export {};"));
    if (mutation === "duplicate") input.artifacts[1] = input.artifacts[0]!;
    if (mutation === "case-change") input.artifacts[2] = { ...input.artifacts[2]!, path: "server/Handler.js" };
    if (mutation === "length") input.artifacts[2] = file("server/handler.js", "short");
    expect(() => owner.capture(input)).toThrow("Application artifact capture rejected");
  });

  it.each(["server/./handler.js", "server//handler.js", "server/../handler.js", "SERVER/handler.js", "server/handler.js\n",
    "C:/handler.js", "/server/handler.js", "\\\\host\\server\\handler.js", "server/con.js", "server/handler.js."])(
    "rejects noncanonical or inconsistent capture path %j", path => {
      const { input } = fixture(); input.artifacts[2] = { ...input.artifacts[2]!, path };
      expect(() => createApplicationArtifactOwner(expectation(input))).toThrow("Application artifact capture rejected");
    });

  it("rejects case collisions and source/output footprint or copied-asset disagreement", () => {
    const collision = fixture(); collision.input.artifacts.push(file("server/Value.js", "case alias"));
    expect(() => createApplicationArtifactOwner(expectation(collision.input))).toThrow("Application artifact capture rejected");
    const footprint = fixture(); footprint.input.artifacts[3] = file("server/other.js", "export const value = 1;");
    expect(() => createApplicationArtifactOwner(expectation(footprint.input))).toThrow("pin-mismatch");
    const asset = fixture(); asset.input.artifacts[0] = file("client/index.html", "changed copied asset");
    expect(() => createApplicationArtifactOwner(expectation(asset.input))).toThrow("pin-mismatch");
  });

  it("rejects a compiler manifest or self-inconsistent declared digest as an expectation", () => {
    const { expected } = fixture();
    expect(() => createApplicationArtifactOwner({ version: 1, format: "artoo.application-build-draft.v1", artifact_digest: expected.artifacts.digest } as unknown as ApplicationArtifactExpectation))
      .toThrow("invalid-input");
    Object.assign(expected.toolchain, { digest: sha("not-the-listed-pins") });
    expect(() => createApplicationArtifactOwner(expected)).toThrow("pin-mismatch");
  });

  it("uses real TypedArray slots rather than caller byteLength/buffer/offset properties", () => {
    const { input, expected } = fixture(), getter = vi.fn(() => { throw Error("untrusted getter"); });
    for (const name of ["buffer", "byteLength", "byteOffset"]) Object.defineProperty(input.artifacts[2]!.bytes, name, { get: getter });
    const owner = createApplicationArtifactOwner(expected), token = owner.capture(input);
    expect(owner.load(token, "server/handler.js")).toContain("handle"); expect(getter).not.toHaveBeenCalled();
  });

  it.each(["shared", "resizable", "detached", "proxy"])("rejects %s backing before copying", kind => {
    const { input, expected } = fixture();
    let bytes: Uint8Array;
    if (kind === "shared") {
      bytes = new Uint8Array(new SharedArrayBuffer(1));
      Object.defineProperty(bytes, "buffer", { value: new ArrayBuffer(1) });
    } else if (kind === "resizable") bytes = new Uint8Array(Reflect.construct(ArrayBuffer, [1, { maxByteLength: 2 }]) as ArrayBuffer);
    else if (kind === "detached") { const buffer = new ArrayBuffer(1); bytes = new Uint8Array(buffer); structuredClone(buffer, { transfer: [buffer] }); }
    else bytes = new Proxy(new Uint8Array(1), {});
    input.toolchain[0] = { path: input.toolchain[0]!.path, bytes };
    expect(() => createApplicationArtifactOwner(expected).capture(input)).toThrow("invalid-input");
  });

  it("preflights declared aggregate bounds without allocating the claimed payload", () => {
    const { expected } = fixture();
    Object.assign(expected.toolchain.files[0]!, { bytes: 256 * 1024 * 1024 + 1 });
    expect(() => createApplicationArtifactOwner(expected)).toThrow("limit");
  });

  it("rejects accessor metadata without invoking it", () => {
    const { input, expected } = fixture(), getter = vi.fn(() => input.artifacts[2]!.bytes);
    input.artifacts[2] = Object.defineProperty({ path: "server/handler.js" }, "bytes", { enumerable: true, get: getter }) as ApplicationArtifactByteFile;
    expect(() => createApplicationArtifactOwner(expected).capture(input)).toThrow("invalid-input"); expect(getter).not.toHaveBeenCalled();
  });

  it("keeps Unicode and the exact UTF-8 BOM in module text and accepts binary toolchain bytes", () => {
    const { input } = fixture(); input.artifacts[2] = file("server/handler.js", "\ufeffexport const title = '中文 📚';");
    const owner = createApplicationArtifactOwner(expectation(input)), token = owner.capture(input), text = owner.load(token, "server/handler.js");
    expect(text.charCodeAt(0)).toBe(0xfeff); expect(Buffer.from(text)).toEqual(input.artifacts[2]!.bytes);
  });

  it.each(["source", "artifacts"] as const)("rejects pinned but malformed UTF-8 %s bytes", role => {
    const { input } = fixture(); input[role][2] = { path: input[role][2]!.path, bytes: new Uint8Array([0xed, 0xa0, 0x80]) };
    expect(() => createApplicationArtifactOwner(expectation(input)).capture(input)).toThrow("invalid-utf8");
  });

  it.each([
    ["server/handler.js", "./value.js", "server/value.js"],
    ["server/handler.js", "././value.js", "server/value.js"],
    ["server/handler.js", "./nested//a.js", "server/nested/a.js"],
    ["server/nested/a.js", "../value.js", "server/value.js"],
    ["server/nested/a.js", "../../server/value.js", "server/value.js"],
    ["server/nested/a.js", "../../../product/server/value.js", "server/value.js"],
    ["server/nested/a.js", "../../../../__source/product/server/value.js", "server/value.js"],
    ["server/handler.js", "./".repeat(300) + "value.js", "server/value.js"],
  ])("matches compiler virtual-root resolution from %s for %s", (base, specifier, canonical) => {
    const { input, expected } = fixture(), owner = createApplicationArtifactOwner(expected), token = owner.capture(input);
    expect(owner.resolve(token, base!, specifier!)).toBe(canonical);
    expect(owner.load(token, owner.resolve(token, base!, specifier!))).toContain("export");
  });

  it.each(["node:fs", "fs", "@artoo/application", "https://example.test/x.js", "file:///x.js", "/server/value.js",
    "//host/share/value.js", "C:/server/value.js", "C:value.js", "\\\\host\\share\\value.js", ".\\value.js",
    "./%76alue.js", "./value.js?raw", "./value.js#x", "./Value.js", "./missing.js", "../client/app.js",
    "../../server/value.js", "./value", "./value.ts", "./".repeat(65_536) + "value.js"])(
    "rejects unsupported, escaping or missing module specifier (%#)", specifier => {
      const { input, expected } = fixture(), owner = createApplicationArtifactOwner(expected), token = owner.capture(input);
      expect(() => owner.resolve(token, "server/handler.js", specifier)).toThrow("module-rejected");
    });

  it("requires captured canonical importer and loader names, including case", () => {
    const { input, expected } = fixture(), owner = createApplicationArtifactOwner(expected), token = owner.capture(input);
    for (const path of ["server/./handler.js", "server/Handler.js", "server/missing.js", "client/app.js", "/__source/product/server/handler.js"]) {
      expect(() => owner.resolve(token, path, "./value.js")).toThrow("module-rejected");
      expect(() => owner.load(token, path)).toThrow("module-rejected");
    }
  });

  it("gives the fixed host loader only defensive copies of exact captured toolchain members", () => {
    const { input, expected } = fixture(), owner = createApplicationArtifactOwner(expected), token = owner.capture(input);
    const bytes = owner.readToolchain(token, "compiler/entry.js"); expect(bytes).toEqual(new Uint8Array([0, 0xff, 0x80, 1]));
    bytes.fill(0); input.toolchain[0]!.bytes.fill(0);
    const again = owner.readToolchain(token, "compiler/entry.js");
    expect(again).toEqual(new Uint8Array([0, 0xff, 0x80, 1])); expect(again.buffer).not.toBe(bytes.buffer);
    for (const logicalId of ["compiler/./entry.js", "Compiler/entry.js", "compiler/missing.js", "server/handler.js", "../compiler/entry.js"])
      expect(() => owner.readToolchain(token, logicalId)).toThrow("toolchain-rejected");
    expect(() => createApplicationArtifactOwner(expected).readToolchain(token, "compiler/entry.js")).toThrow("capture-required");
    owner.revoke(token); expect(() => owner.readToolchain(token, "compiler/entry.js")).toThrow("capture-required");
  });
});

describe("independent original client artifact readers", () => {
  it("returns only copied public bytes and retains the original capture after input/output mutation", () => {
    const { input, expected } = fixture(), owner = createApplicationArtifactOwner(expected), captured = owner.capture(input);
    const reader = owner.clientReader(captured), first = readApplicationClientArtifact(reader, "client/index.html")!;
    expect(Buffer.from(first).toString()).toBe("<h1>笔记 📚</h1>");
    first.fill(0); input.artifacts[0]!.bytes.fill(0);
    expect(Buffer.from(readApplicationClientArtifact(reader, "client/index.html")!).toString()).toBe("<h1>笔记 📚</h1>");
    for (const name of ["server/handler.js", "product/client/index.html", "compiler/entry.js", "client/../server/handler.js",
      "client/%2e%2e/server/handler.js", "client/index.html:stream", "client/.env", "Client/index.html", "client/missing.js"])
      expect(readApplicationClientArtifact(reader, name)).toBeUndefined();
    expect(Object.keys(reader)).toEqual([]); expect(Object.isFrozen(reader)).toBe(true);
  });
  it("rejects forged/foreign captures and revokes readers independently, including original capture revocation", () => {
    const { input, expected } = fixture(), owner = createApplicationArtifactOwner(expected), other = createApplicationArtifactOwner(expected);
    const captured = owner.capture(input), reader = owner.clientReader(captured), sibling = owner.clientReader(captured);
    expect(() => owner.clientReader(other.capture(input))).toThrow("capture-required");
    expect(() => assertApplicationClientReader({} as ApplicationClientReader)).toThrow("client-reader-required");
    expect(() => readApplicationClientArtifact({ ...reader }, "client/index.html")).toThrow("client-reader-required");
    revokeApplicationClientReader(reader); revokeApplicationClientReader(reader);
    expect(() => readApplicationClientArtifact(reader, "client/index.html")).toThrow("client-reader-required");
    expect(readApplicationClientArtifact(sibling, "client/index.html")).toBeDefined();
    expect(owner.load(captured, "server/handler.js")).toContain("handle");
    owner.revoke(captured);
    expect(() => assertApplicationClientReader(sibling)).toThrow("capture-required");
    expect(() => readApplicationClientArtifact(sibling, "client/index.html")).toThrow("capture-required");
  });
});
