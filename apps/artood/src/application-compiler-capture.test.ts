// Real TypeScript content compilation in the test worker. No native owner,
// generated JavaScript execution, protected staging, database or publication.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import ts from "typescript";
import { compileApplicationDraft, assertApplicationBuildOutput, type ApplicationBuildDraft } from "./application-build-core.js";
import { APPLICATION_BUILD_EXECUTION_STATUS, type ApplicationBuildTextFile } from "./application-build-kernel.js";
import { encodeApplicationCompilerResponse, type ApplicationCompilerResponse } from "./application-compiler-protocol.js";
import { createApplicationCompilerCaptureOwner, type CapturedApplicationCompilerContent } from "./application-compiler-capture.js";

const compilerDirectory = dirname(createRequire(import.meta.url).resolve("typescript"));
const libraries = readdirSync(compilerDirectory).filter(path => /^lib\.[a-z0-9.]+\.d\.ts$/u.test(path)).sort()
  .map(path => ({ path, text: readFileSync(join(compilerDirectory, path), "utf8") }));
const source: ApplicationBuildTextFile[] = [
  { path: "product/client/index.html", text: '<!doctype html><title>捕获 😀</title><script type="module" src="/main.js"></script>' },
  { path: "product/client/main.ts", text: 'document.title = "captured"; export {};' },
  { path: "product/client/style.css", text: "body { color: black; }" },
  { path: "product/server/handler.ts", text: 'import type { ApplicationHandler } from "@artoo/application"; export const handle: ApplicationHandler = async () => ({ status: 200, body: { ok: true } });' },
];
let draft: ApplicationBuildDraft;
const request = (files = source, request_id = "original-request-1") => ({ version: 1, kind: "compile", request_id, source: files });
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const inputs = () => ({ compilerVersion: ts.version, libraries: libraries.map(file => ({ ...file })) });
const owner = (files = source) => createApplicationCompilerCaptureOwner(bytes(request(files)), inputs());
const response = (): ApplicationCompilerResponse => ({ version: 1, kind: "compile-result", request_id: "original-request-1",
  qualified_for_product: false, result: structuredClone(draft) });
async function* stream(value: Uint8Array) { yield value; }
const capture = (factory = owner(), value = response()) => factory.capture(stream(encodeApplicationCompilerResponse(value)));
const sha = (text: string) => "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
function rehash(value: ApplicationBuildDraft): void {
  const artifact_files = [...value.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(file => ({ path: file.path, bytes: Buffer.byteLength(file.text), sha256: sha(file.text) }));
  Object.assign(value.manifest, { artifact_files, artifact_digest: sha(JSON.stringify(artifact_files)) });
}
beforeAll(() => {
  const saved = new Map(["NODE_OPTIONS", "NODE_PATH"].map(key => [key, process.env[key]]));
  try {
    for (const key of saved.keys()) delete process.env[key];
    const result = compileApplicationDraft({ version: 1, source, libraries });
    expect(result.status).toBe("compiled"); if (result.status !== "compiled") throw Error("Real fixture compiler rejected");
    draft = result;
  } finally { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}, 30_000);

describe("original-request compiler content captures", () => {
  it("captures real compiler content while preserving all unqualified boundaries", async () => {
    const factory = owner(), token = await capture(factory), value = factory.read(token);
    expect(value).toMatchObject({ version: 1, scope: "compiler-response-content-only", qualified_for_product: false, request_id: request().request_id });
    expect(value.result).toEqual(draft); expect(value.source).toEqual([...source].sort((a, b) => a.path.localeCompare(b.path)));
    expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.result.files[0])).toBe(true);
    expect(() => assertApplicationBuildOutput(value.result, source, value.result.files)).toThrow("local-draft-required");
    expect(value).not.toHaveProperty("verification"); expect(value).not.toHaveProperty("process");
  });
  it("keeps the original source/library/version selection after caller mutations", async () => {
    const original = bytes(request()), selected = inputs(), factory = createApplicationCompilerCaptureOwner(original, selected);
    original.fill(0); selected.compilerVersion = "other"; selected.libraries[0]!.text = "changed";
    expect(factory.read(await capture(factory)).result.manifest.compiler_version).toBe(ts.version);
  });
  it.each(["request", "sourceDigest", "sourcePin", "libraryDigest", "libraryPin", "sdk", "compilerVersion"] as const)(
    "rejects a response mismatching the original %s", async change => {
      const value = response(); if (value.result.status !== "compiled") throw Error("compiled");
      if (change === "request") Object.assign(value, { request_id: "another-request" });
      if (change === "sourceDigest") Object.assign(value.result.manifest, { source_digest: "sha256:" + "a".repeat(64) });
      if (change === "sourcePin") Object.assign(value.result.manifest.source_files[0]!, { bytes: 0 });
      if (change === "libraryDigest") Object.assign(value.result.manifest, { compiler_lib_digest: "sha256:" + "b".repeat(64) });
      if (change === "libraryPin") Object.assign(value.result.manifest.compiler_lib_files[0]!, { sha256: "sha256:" + "c".repeat(64) });
      if (change === "sdk") Object.assign(value.result.manifest, { sdk_digest: "sha256:" + "d".repeat(64) });
      if (change === "compilerVersion") Object.assign(value.result.manifest, { compiler_version: "other" });
      await expect(capture(owner(), value)).rejects.toThrow("response-mismatch");
    });
  it.each(["missing", "extra", "rename", "alias", "duplicate", "escape", "bytes", "digest", "plainAsset", "surrogate"] as const)(
    "rejects incomplete or changed artifact content: %s", async change => {
      const value = response(); if (value.result.status !== "compiled") throw Error("compiled");
      const files = value.result.files as ApplicationBuildTextFile[], artifact = value.result;
      if (change === "missing") files.pop();
      if (change === "extra") files.push({ path: "server/extra.js", text: "export {};" });
      if (change === "rename") files[0] = { ...files[0]!, path: "client/renamed.html" };
      if (change === "alias") files[0] = { ...files[0]!, path: "Client/index.html" };
      if (change === "duplicate") files.push({ ...files[0]! });
      if (change === "escape") files[0] = { ...files[0]!, path: "client/../server/handler.js" };
      if (change === "plainAsset") files[0] = { ...files[0]!, text: "<title>different copied HTML</title>" };
      if (change === "surrogate") files[0] = { ...files[0]!, text: "\ud800" };
      if (!["bytes", "digest", "surrogate"].includes(change)) rehash(artifact);
      if (change === "bytes") Object.assign(artifact.manifest.artifact_files[0]!, { bytes: 0 });
      if (change === "digest") Object.assign(artifact.manifest, { artifact_digest: "sha256:" + "e".repeat(64) });
      await expect(capture(owner(), value)).rejects.toThrow();
    });
  it("rejects changed source and library selections even when a prior response was internally consistent", async () => {
    const changed = source.map(file => file.path.endsWith("main.ts") ? { ...file, text: file.text + "\n// changed" } : file);
    await expect(capture(owner(changed))).rejects.toThrow("response-mismatch");
    const selected = inputs(); selected.libraries[0]!.text += "\n// changed";
    await expect(capture(createApplicationCompilerCaptureOwner(bytes(request()), selected))).rejects.toThrow("response-mismatch");
  });
  it("permits only one attempt and rejects forged, foreign, revoked and replayed tokens", async () => {
    const factory = owner(), token = await capture(factory), other = owner();
    expect(() => factory.read({} as CapturedApplicationCompilerContent)).toThrow("original-capture-required");
    expect(() => other.read(token)).toThrow("original-capture-required");
    await expect(capture(factory)).rejects.toThrow("attempt-used");
    factory.revoke(token); expect(() => factory.read(token)).toThrow("original-capture-required");
    await expect(capture(factory)).rejects.toThrow("attempt-used");
    const failed = owner();
    await expect(failed.capture(stream(Buffer.from("{")))).rejects.toThrow("protocol_failed");
    await expect(capture(failed)).rejects.toThrow("attempt-used");
  });
  it("consumes rejected results without granting an artifact token and prevents concurrent replay", async () => {
    const factory = owner(), rejected: ApplicationCompilerResponse = { ...response(),
      result: { status: "rejected", execution: APPLICATION_BUILD_EXECUTION_STATUS,
        diagnostics: [{ category: "compiler", code: "fixture-rejected", message: "Controlled rejection" }] } };
    await expect(capture(factory, rejected)).rejects.toThrow("compiler-rejected");
    await expect(capture(factory)).rejects.toThrow("attempt-used");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), current = owner();
    async function* pending() { await gate; yield encodeApplicationCompilerResponse(response()); }
    const first = current.capture(pending());
    await expect(capture(current)).rejects.toThrow("attempt-used"); release();
    expect(current.read(await first).qualified_for_product).toBe(false);
  });
  it("labels self-consistent producer claims as content only, never compiler provenance", async () => {
    const value = response(); if (value.result.status !== "compiled") throw Error("compiled");
    const files = value.result.files as ApplicationBuildTextFile[];
    const at = files.findIndex(file => file.path === "server/handler.js");
    files[at] = { path: "server/handler.js", text: "// fabricated but internally consistent producer text" }; rehash(value.result);
    const factory = owner(), captured = factory.read(await capture(factory, value));
    expect(captured.qualified_for_product).toBe(false); expect(captured.scope).toBe("compiler-response-content-only");
    expect(captured.result.manifest.execution).toBe(APPLICATION_BUILD_EXECUTION_STATUS);
    expect(() => assertApplicationBuildOutput(captured.result, source, captured.result.files)).toThrow("local-draft-required");
  });
  it.each([
    { files: [{ path: "product/client/index.html", text: "x" }, { path: "product/server/handler.ts", text: "\ud800" }] },
    { files: [...source, { path: "product/client/INDEX.html", text: "case collision" }] },
    { files: [...source, { path: "product/client/node_modules/x.ts", text: "export {}" }] },
    { files: source.map(file => file.path === "product/client/index.html" ? { ...file, path: "product/client/INDEX.html" } : file) },
  ])("rejects unsupported original source snapshots", ({ files }) => expect(() => owner(files)).toThrow("invalid-input"));
});
