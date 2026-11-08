import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ts from "typescript";
import { assertApplicationBuildOutput, compileApplicationDraft } from "./application-build-core.js";
import { createApplicationBuildKernel, type ApplicationBuildPlatform, type ApplicationBuildTextFile } from "./application-build-kernel.js";
import { applicationSha256, applicationUtf8ByteLength, applicationVirtualDirname, isWellFormedApplicationUtf8,
  resolveApplicationVirtualPath } from "./application-build-primitives.js";
import { APPLICATION_SDK_V1_SOURCE } from "./application-sdk-v1.js";
import { APPLICATION_COMPILER_LIMITS, parseApplicationCompilerRequestText } from "./application-compiler-contract.js";
import { decodeApplicationCompilerRequest } from "./application-compiler-protocol.js";

const compilerDirectory = dirname(createRequire(import.meta.url).resolve("typescript"));
const libraries = readdirSync(compilerDirectory).filter(path => /^lib\.[a-z0-9.]+\.d\.ts$/u.test(path)).sort()
  .map(path => ({ path, text: readFileSync(join(compilerDirectory, path), "utf8") }));
const source: readonly ApplicationBuildTextFile[] = [
  { path: "product/client/index.html", text: "<!doctype html><title>库存 😀</title>" },
  { path: "product/client/main.ts", text: 'document.title = "库存 😀"; export {};' },
  { path: "product/client/style.css", text: 'body::before { content: "中文 👩‍💻"; }' },
  { path: "product/server/handler.ts", text: 'import type { ApplicationHandler } from "@artoo/application"; import { title } from "./nested/title.js"; export const handle: ApplicationHandler = async () => ({ status: 200, body: { title } });' },
  { path: "product/server/nested/title.ts", text: 'export const title: string = "库存 😀";' },
];
const nodeSha = (text: string) => "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
const pins = (files: readonly ApplicationBuildTextFile[]) => [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  .map(file => ({ path: file.path, bytes: Buffer.byteLength(file.text, "utf8"), sha256: nodeSha(file.text) }));

// Controlled Node unit harness: real TypeScript with all sys functions denied. This is not a QuickJS realm.
const guard: ApplicationBuildPlatform["guardCompilerSystemCalls"] = (operation, reject) => {
  const changed: [string, PropertyDescriptor][] = [];
  try {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(ts.sys))) {
      if (typeof descriptor.value !== "function") continue;
      Object.defineProperty(ts.sys, key, { ...descriptor, value: () => reject("host-fallback", "compiler") });
      changed.push([key, descriptor]);
    }
    return operation();
  } finally { for (const [key, descriptor] of changed.reverse()) Object.defineProperty(ts.sys, key, descriptor); }
};
const makeKernel = () => createApplicationBuildKernel(ts, Object.freeze({ utf8ByteLength: applicationUtf8ByteLength,
  isWellFormedUtf8: isWellFormedApplicationUtf8, sha256: applicationSha256, dirname: applicationVirtualDirname,
  resolvePath: resolveApplicationVirtualPath, guardCompilerSystemCalls: guard }));
const environment = new Map<string, string | undefined>();
beforeEach(() => { for (const key of ["NODE_OPTIONS", "NODE_PATH"]) { environment.set(key, process.env[key]); delete process.env[key]; } });
afterEach(() => { for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } environment.clear(); });

describe("one application compiler kernel with local Node/guest primitive adapters", () => {
  it("returns the entire same draft and independently verifies every manifest field and digest", () => {
    const input = { version: 1, source, libraries }, originalInput = JSON.stringify(input);
    const kernel = makeKernel(), portable = kernel.compileApplicationDraft(input), node = compileApplicationDraft(input);
    expect(portable).toEqual(node); expect(portable.status).toBe("compiled");
    if (portable.status !== "compiled" || node.status !== "compiled") throw Error("Expected complete drafts");
    const sourcePins = pins(source), libraryPins = pins(libraries), artifactPins = pins(portable.files);
    expect(portable.manifest).toEqual({ version: 1, format: "artoo.application-build-draft.v1", compiler_version: ts.version,
      compiler_lib_digest: nodeSha(JSON.stringify(libraryPins)), sdk_digest: nodeSha(APPLICATION_SDK_V1_SOURCE),
      source_digest: nodeSha(JSON.stringify(sourcePins)), artifact_digest: nodeSha(JSON.stringify(artifactPins)),
      source_files: sourcePins, compiler_lib_files: libraryPins, artifact_files: artifactPins,
      execution: "unavailable: native profile, isolated compiler process, protected staging and closure are not integrated" });
    expect(JSON.stringify(input)).toBe(originalInput);
    expect(Object.isFrozen(portable)).toBe(true); expect(Object.isFrozen(portable.manifest.source_files[0])).toBe(true);
    kernel.assertApplicationBuildOutput(portable, source, portable.files); assertApplicationBuildOutput(node, source, node.files);
    expect(() => kernel.assertApplicationBuildOutput(node, source, node.files)).toThrow("local-draft-required");
    expect(() => assertApplicationBuildOutput(portable, source, portable.files)).toThrow("local-draft-required");
    expect(() => makeKernel().assertApplicationBuildOutput(portable, source, portable.files)).toThrow("local-draft-required");
    expect(() => kernel.assertApplicationBuildOutput(JSON.parse(JSON.stringify(portable)), source, portable.files)).toThrow("local-draft-required");
    expect(() => kernel.assertApplicationBuildOutput(portable, source.slice(1), portable.files)).toThrow();
    expect(() => kernel.assertApplicationBuildOutput(portable, source, portable.files.slice(1))).toThrow("output-changed");
  });

  it("hashes changed plain assets and every library snapshot, including unused library text", () => {
    const kernel = makeKernel(), before = kernel.compileApplicationDraft({ version: 1, source, libraries });
    const changedSource = source.map(file => file.path.endsWith(".css") ? { ...file, text: file.text + "\n/* 变化 */" } : file);
    const changedLibraries = libraries.map(file => file.path === "lib.webworker.d.ts" ? { ...file, text: file.text + "\n// snapshot change\n" } : file);
    expect(changedLibraries).not.toEqual(libraries);
    const after = kernel.compileApplicationDraft({ version: 1, source: changedSource, libraries: changedLibraries });
    expect(after).toEqual(compileApplicationDraft({ version: 1, source: changedSource, libraries: changedLibraries }));
    if (before.status !== "compiled" || after.status !== "compiled") throw Error("Expected complete drafts");
    expect(after.manifest.source_digest).not.toBe(before.manifest.source_digest);
    expect(after.manifest.artifact_digest).not.toBe(before.manifest.artifact_digest);
    expect(after.manifest.compiler_lib_digest).not.toBe(before.manifest.compiler_lib_digest);
    expect(after.manifest.sdk_digest).toBe(nodeSha(APPLICATION_SDK_V1_SOURCE));
    expect(() => kernel.assertApplicationBuildOutput(before, changedSource, before.files)).toThrow("source-changed");
  });

  it.each([
    ["type", "product/server/nested/title.ts", 'export const title: number = "wrong";'],
    ["handler", "product/server/handler.ts", 'export const handle = async () => ({ status: "bad", body: null });'],
    ["missing-relative", "product/server/nested/title.ts", 'export { title } from "./missing.js";'],
    ["traversal", "product/server/nested/title.ts", 'export { title } from "../../../../escape.js";'],
    ["cross-role", "product/server/nested/title.ts", 'export { title } from "../../client/main.js";'],
    ["directive", "product/server/nested/title.ts", '// @ts-ignore\nexport const title: number = "wrong";'],
    ["surrogate", "product/client/index.html", "\ud800"],
  ])("preserves complete %s failure semantics and fixed diagnostic text", (_name, path, text) => {
    const input = { version: 1, source: source.map(file => file.path === path ? { path, text } : file), libraries };
    const portable = makeKernel().compileApplicationDraft(input);
    expect(portable).toEqual(compileApplicationDraft(input)); expect(portable.status).toBe("rejected");
    expect(portable).not.toHaveProperty("files");
  });

  it("retains strict input and library rejection semantics", () => {
    const inputs = [
      { version: 1, source, libraries, platform: { sha256: "caller-selected" } },
      { version: 1, source, libraries, compilerOptions: { noEmitOnError: false } },
      { version: 1, source: [...source, { path: "product/client/con.ts", text: "export {};" }], libraries },
      { version: 1, source, libraries: [{ path: "lib.es2023.d.ts", text: "\udfff" }] },
      { version: 1, source, libraries: libraries.filter(file => file.path !== "lib.es2023.d.ts") },
    ];
    for (const input of inputs) { const result = makeKernel().compileApplicationDraft(input); expect(result).toEqual(compileApplicationDraft(input)); expect(result.status).toBe("rejected"); }
  });

  it("shares strict request shape and unchanged byte-limit constants without qualifying I/O", () => {
    expect(APPLICATION_COMPILER_LIMITS).toEqual({ inputBytes: 52 * 1024 * 1024, outputBytes: 100 * 1024 * 1024 });
    const request = { version: 1, kind: "compile", request_id: "unicode", source }, text = JSON.stringify(request);
    expect(parseApplicationCompilerRequestText(text)).toEqual(decodeApplicationCompilerRequest(Buffer.from(text)));
    for (const extra of [{ libraries }, { platform: "guest" }, { compiler: "caller-selected" }])
      expect(() => parseApplicationCompilerRequestText(JSON.stringify({ ...request, ...extra }))).toThrow("application_compiler_protocol_failed");
  });

  it("never evaluates emitted top-level product code", () => {
    const files = source.map(file => file.path === "product/client/main.ts" ? { ...file, text: 'throw new Error("must not execute"); export {};' } : file);
    expect(makeKernel().compileApplicationDraft({ version: 1, source: files, libraries }).status).toBe("compiled");
  });
});
