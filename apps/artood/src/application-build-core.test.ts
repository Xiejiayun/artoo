import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { assertApplicationBuildOutput, compileApplicationDraft, type ApplicationBuildDraft, type ApplicationBuildTextFile } from "./application-build-core.js";

const fault = vi.hoisted(() => ({ sysFallback: false }));
vi.mock("typescript", async importOriginal => {
  const actual = await importOriginal<{ default: typeof ts }>();
  const compiler = actual.default;
  // Every ordinary case uses the real compiler. This one fault makes an otherwise hidden
  // host fallback explicit, so the guard must stop it before the original sys read runs.
  return { ...actual, default: { ...compiler, createProgram: (options: ts.CreateProgramOptions) => {
    if (fault.sysFallback) compiler.sys.readFile("C:/host-private/canary.txt");
    return compiler.createProgram(options);
  } } };
});

const compilerDirectory = dirname(createRequire(import.meta.url).resolve("typescript"));
const libraries = readdirSync(compilerDirectory).filter(name => /^lib\.[a-z0-9.]+\.d\.ts$/u.test(name)).sort()
  .map(path => ({ path, text: readFileSync(join(compilerDirectory, path), "utf8") }));
const source: ApplicationBuildTextFile[] = [
  { path: "product/client/index.html", text: '<!doctype html><html lang="en"><title>Inventory</title><link rel="stylesheet" href="./style.css"><h1>Inventory</h1><script type="module" src="./main.js"></script></html>' },
  { path: "product/client/style.css", text: "body { font-family: sans-serif; }" },
  { path: "product/client/main.ts", text: 'const heading = document.querySelector("h1"); if (heading) heading.textContent = "Inventory"; export {};' },
  { path: "product/server/handler.ts", text: 'import type { ApplicationHandler } from "@artoo/application"; import { title } from "./title.js"; export const handle: ApplicationHandler = async () => ({ status: 200, body: { title } });' },
  { path: "product/server/title.ts", text: 'export const title: string = "Inventory";' },
];
const input = (files: readonly ApplicationBuildTextFile[] = source) => ({ version: 1, source: files, libraries });
const change = (path: string, text: string) => source.map(file => file.path === path ? { path, text } : file);
const environment = new Map<string, string | undefined>();
beforeEach(() => {
  for (const key of ["NODE_OPTIONS", "NODE_PATH"]) { environment.set(key, process.env[key]); delete process.env[key]; }
});
afterEach(() => {
  for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  environment.clear(); fault.sysFallback = false; vi.restoreAllMocks();
});
let baseline: ApplicationBuildDraft | undefined;
function compiled(): ApplicationBuildDraft {
  if (!baseline) {
    const result = compileApplicationDraft(input());
    expect(result.status).toBe("compiled");
    if (result.status !== "compiled") throw new Error(JSON.stringify(result.diagnostics));
    baseline = result;
  }
  return baseline;
}
function rejection(value: ReturnType<typeof compileApplicationDraft>, code?: string) {
  expect(value.status).toBe("rejected");
  if (value.status !== "rejected") throw new Error("Expected rejected compilation");
  if (code) expect(value.diagnostics).toContainEqual(expect.objectContaining({ code }));
  expect(value.execution).toContain("unavailable");
  expect(value).not.toHaveProperty("files");
  return value;
}

describe("fixed application compilation core (no native runner or attestation)", () => {
  it("uses real TypeScript to emit separate client/server modules and copies plain assets", () => {
    const result = compiled();
    expect(result.files.map(file => file.path)).toEqual(["client/index.html", "client/main.js", "client/style.css", "server/handler.js", "server/title.js"]);
    expect(result.files.find(file => file.path === "server/handler.js")?.text).toContain('from "./title.js"');
    expect(result.files.find(file => file.path === "server/handler.js")?.text).not.toContain("@artoo/application");
    expect(result.manifest.compiler_version).toBe(ts.version);
    expect(result.manifest).not.toHaveProperty("toolchain_digest");
    expect(result.manifest).not.toHaveProperty("verification");
    expect(result.manifest.execution).toContain("unavailable");
    assertApplicationBuildOutput(result, source, result.files);
  });

  it("blocks real sys fallback before a host read and restores the original sys methods", () => {
    const read = vi.spyOn(ts.sys, "readFile").mockImplementation(() => { throw new Error("Host read must not run"); });
    const descriptor = Object.getOwnPropertyDescriptor(ts.sys, "readFile");
    fault.sysFallback = true;
    rejection(compileApplicationDraft(input()), "host-fallback");
    expect(read).not.toHaveBeenCalled();
    expect(Object.getOwnPropertyDescriptor(ts.sys, "readFile")).toEqual(descriptor);
    fault.sysFallback = false;
    const next = compileApplicationDraft(input());
    expect(next.status).toBe("compiled");
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["NODE_OPTIONS", "NODE_PATH"])("rejects ambient %s before invoking the compiler", key => {
    process.env[key] = key === "NODE_OPTIONS" ? "--import C:/host-private/loader.mjs" : "C:/host-private/packages";
    rejection(compileApplicationDraft(input()), "ambient-runtime");
  });

  it.each(["product/client/tsconfig.json", "product/client/package.json", "product/client/.npmrc"])("does not load project configuration %s", path => {
    const result = rejection(compileApplicationDraft(input([...source, { path, text: JSON.stringify({ extends: "C:/host-private/config", compilerOptions: { plugins: [{ name: "custom-plugin" }] }, scripts: { build: "execute-me" } }) }])));
    expect(JSON.stringify(result)).not.toContain("host-private");
    expect(JSON.stringify(result)).not.toContain("custom-plugin");
  });

  it("rejects caller-supplied compiler options and plugins", () => {
    rejection(compileApplicationDraft({ ...input(), compilerOptions: { plugins: [{ name: "custom-plugin" }], noEmitOnError: false } }), "invalid-input");
  });

  it.each([
    '/// <reference path="C:/host-private/types.d.ts" />\nexport const x = 1;',
    '/// <reference types="node" />\nexport const x = 1;',
    '/// <reference lib="dom" />\nexport const x = 1;',
    '// @ts-nocheck\nconst x: number = "wrong"; export {};',
    '// @ts-ignoreSuffix\nexport const title: number = "Inventory";',
    '/* @ts-ignoreSuffix */\nexport const title: number = "Inventory";',
    '// @ts-expect-errorSuffix\nexport const title: number = "Inventory";',
    '/* @ts-expect-errorSuffix */\nexport const title: number = "Inventory";',
    'const label = `${1}`;\n// @ts-ignore\nexport const title: number = "Inventory";',
    'const label = `${1}`;\n// @ts-expect-error\nexport const title: number = "Inventory";',
    'const label = `${1}`;\n/* @ts-ignoreSuffix */\nexport const title: number = "Inventory";',
    'const label = `${1}`;\n/* @ts-expect-errorSuffix */\nexport const title: number = "Inventory";',
    'export const title = "@ts-ignore";',
    'export const title = "@ts-expect-error";',
    'export const title = "@ts-nocheck";',
    'declare module "another-package" { export const value: number; }',
  ])("rejects source-controlled references and compiler directives", text => {
    rejection(compileApplicationDraft(input(change("product/server/title.ts", text))), "compiler-directive");
  });

  it.each([
    'import type { ApplicationHandler } from "@artoo/application"; export declare const handle: ApplicationHandler;',
    'import type { ApplicationRequest, ApplicationContext, ApplicationResponse } from "@artoo/application"; export declare function handle(request: ApplicationRequest, context: ApplicationContext): Promise<ApplicationResponse>;',
  ])("rejects ambient handlers that would vanish from the emitted entry", text => {
    rejection(compileApplicationDraft(input(change("product/server/handler.ts", text))), "compiler-directive");
  });

  it("rejects a re-export of an erased ambient handler from a relative source", () => {
    const files = change("product/server/handler.ts", 'export { handle } from "./title.js";')
      .map(file => file.path === "product/server/title.ts" ? { ...file,
        text: 'import type { ApplicationHandler } from "@artoo/application"; export declare const handle: ApplicationHandler;' } : file);
    rejection(compileApplicationDraft(input(files)), "compiler-directive");
  });

  it.each([
    'import { readFile } from "node:fs"; export const title = readFile;',
    'import { title } from "../client/main.js"; export { title };',
    'import { title } from "../../../../host-private.js"; export { title };',
    'export const title = import("./title.js");',
    'export const title = require("./title.js");',
    'import type { Json } from "@types/node"; export const title: Json = "wrong";',
  ])("rejects unsupported module resolution without disclosing specifiers", text => {
    const result = rejection(compileApplicationDraft(input(change("product/server/title.ts", text))), "unsupported-module");
    expect(JSON.stringify(result)).not.toContain("host-private");
  });

  it("rejects runtime imports of the type-only SDK", () => {
    rejection(compileApplicationDraft(input(change("product/server/title.ts", 'import { ApplicationHandler } from "@artoo/application"; export const title = ApplicationHandler;'))), "sdk-runtime-import");
  });

  it("requires a typed handler and excludes DOM globals from the server program", () => {
    rejection(compileApplicationDraft(input(change("product/server/handler.ts", 'export async function handle() { return { status: "bad", body: null }; }'))));
    rejection(compileApplicationDraft(input(change("product/server/title.ts", 'export const title = document.title;'))));
  });

  it("returns bounded compiler locations and codes without raw diagnostic strings", () => {
    const result = rejection(compileApplicationDraft(input(change("product/client/main.ts", 'const number: number = "C:/host-private/secret"; export {};'))));
    expect(result.diagnostics.length).toBeGreaterThan(0); expect(result.diagnostics.length).toBeLessThanOrEqual(32);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ file: "product/client/main.ts", line: 1 }));
    expect(JSON.stringify(result)).not.toContain("host-private");
    expect(JSON.stringify(result)).not.toContain("__toolchain");
  });

  it("rejects missing fixed libraries instead of using a host default library", () => {
    rejection(compileApplicationDraft({ ...input(), libraries: libraries.filter(file => file.path !== "lib.es2023.d.ts") }), "missing-library");
  });

  it("rejects portable path escapes, aliases and case collisions", () => {
    for (const path of ["product/client/../escape.ts", "C:/host-private/code.ts", "product/client/con.ts", "product/client\\escape.ts", "product/client/Main.ts"]) {
      rejection(compileApplicationDraft(input([...source, { path, text: "export {};" }])));
    }
  });

  it("rejects source changes, partial or extra outputs and fabricated local drafts", () => {
    const draft = compiled();
    expect(() => assertApplicationBuildOutput(draft, change("product/server/title.ts", 'export const title = "changed";'), draft.files)).toThrow("source-changed");
    expect(() => assertApplicationBuildOutput(draft, source, draft.files.slice(1))).toThrow("output-changed");
    expect(() => assertApplicationBuildOutput(draft, source, [...draft.files, { path: "server/extra.js", text: "export {};" }])).toThrow("output-changed");
    expect(() => assertApplicationBuildOutput(draft, source, draft.files.map(file => file.path === "server/title.js" ? { ...file, text: "changed" } : file))).toThrow("output-changed");
    expect(() => assertApplicationBuildOutput(JSON.parse(JSON.stringify(draft)), source, draft.files)).toThrow("local-draft-required");
  });

  it("compiles product top-level code as text without executing it", () => {
    const result = compileApplicationDraft(input(change("product/client/main.ts", 'throw new Error("This product code must not execute while compiling"); export {};')));
    expect(result.status).toBe("compiled");
  });
});
