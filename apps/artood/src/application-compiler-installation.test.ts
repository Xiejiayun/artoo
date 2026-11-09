// Actual pinned-file reads with inert guest/vendor data. No child is executed.
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { APPLICATION_COMPILER_TYPESCRIPT_SHA256, APPLICATION_COMPILER_VENDOR_MEMBERS, loadApplicationCompilerConfiguration } from "./application-compiler-installation.js";
import { APPLICATION_COMPILER_PROCESS_PROTOCOL } from "./application-compiler-process-protocol.js";
const compiler = readFileSync(createRequire(import.meta.url).resolve("typescript"));
const sha = (bytes: Uint8Array) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) {
    if (dirname(folder) !== realpathSync.native(tmpdir()) || !basename(folder).startsWith("artoo-compiler-installation-")) throw Error("unsafe fixture cleanup path");
    rmSync(folder, { recursive: true, force: true });
  }
});
function installation(options: { libraries?: unknown; vendorMembers?: readonly string[]; compilerBytes?: Buffer; packageExtra?: Record<string, unknown>;
  configurationExtra?: Record<string, unknown>; snapshotBytes?: Buffer } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-compiler-installation-"))); folders.push(root);
  const pin = (member: string, value: string | Buffer) => {
    const path = join(root, member), bytes = Buffer.from(value); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
    return { path: realpathSync.native(path), bytes: bytes.length, sha256: sha(bytes) };
  };
  const typescript = pin("compiler/typescript.js", options.compilerBytes ?? compiler);
  const guest = pin("compiler/application-compiler-guest.js", "// Inert pinned guest bytes");
  const libraries = pin("compiler/application-compiler-libraries.json", options.snapshotBytes ?? JSON.stringify(options.libraries ?? [{ path: "lib.es2023.d.ts", text: "// Inert library fixture 😀" }]));
  const measured = ({ bytes, sha256 }: { bytes: number; sha256: string }) => ({ bytes, sha256 });
  const compilerManifest = pin("compiler/compiler-installation.json", JSON.stringify({ version: 1, format: "artoo.application-compiler-installation.v1",
    qualified_for_product: false, compiler_version: "5.9.3", typescript: measured(typescript), guest: measured(guest), libraries: measured(libraries), ...options.packageExtra }));
  const files = (options.vendorMembers ?? APPLICATION_COMPILER_VENDOR_MEMBERS).map(path => {
    const bytes = pin("vendor/" + path, "// Inert vendor member " + path);
    return { path, bytes: bytes.bytes, sha256: bytes.sha256.slice(7), url: "https://example.invalid/inert", integrity: "controlled" };
  });
  const vendorManifest = pin("vendor/manifest.json", JSON.stringify({ version: 1, format: "artoo.quickjs-runtime-vendor.v1", version_name: "0.32.0",
    variant: "wasmfile-release-sync", qualified_for_product: false, provenance: "inert installation test data", files }));
  const configuration = pin("application-compiler-process.json", JSON.stringify({ version: 1, protocol: APPLICATION_COMPILER_PROCESS_PROTOCOL,
    vendorManifest, compilerManifest, ...options.configurationExtra }));
  return { root, configuration, typescript, guest, libraries, compilerManifest, vendorManifest };
}
describe("fixed compiler installation data closure", () => {
  it("captures the exact fixed compiler, guest, protected library snapshot and all nine vendor members", () => {
    expect(sha(compiler)).toBe(APPLICATION_COMPILER_TYPESCRIPT_SHA256);
    const { configuration } = installation(), loaded = loadApplicationCompilerConfiguration(configuration);
    expect(loaded.files).toHaveLength(14); expect([...loaded.vendorPins.keys()]).toEqual(APPLICATION_COMPILER_VENDOR_MEMBERS);
    expect(loaded.compilerInputs).toEqual({ compilerVersion: "5.9.3", libraries: [{ path: "lib.es2023.d.ts", text: "// Inert library fixture 😀" }] });
    expect(Object.isFrozen(loaded.compilerInputs.libraries[0])).toBe(true);
  });
  it("rejects an added package member and changed guest bytes", () => {
    const value = installation(); writeFileSync(join(value.root, "compiler/unlisted.txt"), "not admitted");
    expect(() => loadApplicationCompilerConfiguration(value.configuration)).toThrow("inventory");
    const second = installation(); writeFileSync(second.guest.path, "// Changed pinned guest!");
    expect(() => loadApplicationCompilerConfiguration(second.configuration)).toThrow("pin");
  });
  it("rejects another compiler even when its manifest self-consistently pins it", () => {
    const value = installation({ compilerBytes: Buffer.from("// Not the fixed TypeScript implementation") });
    expect(() => loadApplicationCompilerConfiguration(value.configuration)).toThrow("fixed-toolchain");
  });
  it.each(["entry", "argv", "budget", "qualification"])("does not accept package-selected %s", key => {
    const value = installation({ packageExtra: { [key]: "untrusted" } });
    expect(() => loadApplicationCompilerConfiguration(value.configuration)).toThrow();
  });
  it("does not accept remote command configuration or another protocol", () => {
    const value = installation({ configurationExtra: { command: "untrusted" } });
    expect(() => loadApplicationCompilerConfiguration(value.configuration)).toThrow();
    const other = installation({ configurationExtra: { protocol: "artoo.application-runtime.v1" } });
    expect(() => loadApplicationCompilerConfiguration(other.configuration)).toThrow();
  });
  it.each(["missing", "duplicate", "unexpected"])("rejects %s vendor members", change => {
    const members = [...APPLICATION_COMPILER_VENDOR_MEMBERS];
    if (change === "missing") members.pop();
    else members[members.length - 1] = change === "duplicate" ? members[0]! : "core/dist/unlisted.mjs";
    const value = installation({ vendorMembers: members });
    expect(() => loadApplicationCompilerConfiguration(value.configuration)).toThrow();
  });
  it.each([
    [],
    [{ path: "lib.es2023.d.ts", text: "a" }, { path: "lib.es2023.d.ts", text: "b" }],
    [{ path: "../outside.d.ts", text: "a" }],
    [{ path: "lib.es2023.d.ts", text: "\ud800" }],
    [{ path: "lib.es2023.d.ts", text: "中".repeat(1_500_000) }],
  ].map(libraries => ({ libraries })))("rejects invalid or UTF-8-oversized library snapshot %#", ({ libraries }) => {
    const value = installation({ libraries });
    expect(() => loadApplicationCompilerConfiguration(value.configuration)).toThrow();
  });
  it("rejects malformed UTF-8 in the pinned snapshot", () => {
    const value = installation({ snapshotBytes: Buffer.from([0xff]) });
    expect(() => loadApplicationCompilerConfiguration(value.configuration)).toThrow();
  });
});
