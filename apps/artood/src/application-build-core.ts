import { createHash } from "node:crypto";
import { posix } from "node:path";
import ts from "typescript";
import { z } from "zod";
import { APPLICATION_SDK_V1_MODULE, APPLICATION_SDK_V1_SOURCE } from "./application-sdk-v1.js";

const sourceRoot = "/__source/", libraryRoot = "/__toolchain/lib/", sdkPath = "/__toolchain/sdk/application.d.ts";
const maximumFiles = 256, maximumSourceBytes = 8 * 1024 * 1024, maximumOutputBytes = 16 * 1024 * 1024;
const maximumDiagnostics = 32;
const unavailable = "unavailable: native profile, isolated compiler process, protected staging and closure are not integrated" as const;
export const APPLICATION_BUILD_EXECUTION_STATUS = unavailable;
export interface ApplicationBuildTextFile { readonly path: string; readonly text: string }
export interface ApplicationBuildFilePin { readonly path: string; readonly bytes: number; readonly sha256: string }
export interface ApplicationBuildDiagnostic {
  readonly category: "input" | "policy" | "compiler" | "integrity";
  readonly code: string; readonly message: string; readonly file?: string; readonly line?: number; readonly column?: number;
}
export interface ApplicationBuildManifest {
  readonly version: 1; readonly format: "artoo.application-build-draft.v1";
  readonly compiler_version: string; readonly compiler_lib_digest: string; readonly sdk_digest: string;
  readonly source_digest: string; readonly artifact_digest: string;
  readonly source_files: readonly ApplicationBuildFilePin[];
  readonly compiler_lib_files: readonly ApplicationBuildFilePin[];
  readonly artifact_files: readonly ApplicationBuildFilePin[];
  readonly execution: typeof unavailable;
}
export interface ApplicationBuildDraft {
  readonly status: "compiled"; readonly manifest: ApplicationBuildManifest;
  readonly files: readonly ApplicationBuildTextFile[]; readonly diagnostics: readonly [];
}
export interface ApplicationBuildRejection {
  readonly status: "rejected"; readonly diagnostics: readonly ApplicationBuildDiagnostic[];
  readonly execution: typeof unavailable;
}
const localDrafts = new WeakMap<ApplicationBuildDraft, ApplicationBuildManifest>();
const fileSchema = z.object({ path: z.string().min(1).max(512), text: z.string() }).strict();
const inputSchema = z.object({ version: z.literal(1),
  source: z.array(fileSchema).min(2).max(maximumFiles),
  libraries: z.array(fileSchema).min(1).max(128),
}).strict();
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const sha = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
const order = (a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path === b.path ? 0 : 1;
function pins(files: readonly ApplicationBuildTextFile[]): ApplicationBuildFilePin[] {
  return [...files].sort(order).map(file => ({ path: file.path, bytes: Buffer.byteLength(file.text, "utf8"), sha256: sha(file.text) }));
}
const manifestDigest = (files: readonly ApplicationBuildFilePin[]) => sha(JSON.stringify(files));
class Rejected extends Error {
  constructor(readonly diagnostic: ApplicationBuildDiagnostic) { super(diagnostic.code); }
}
function reject(code: string, category: ApplicationBuildDiagnostic["category"] = "input", file?: string): never {
  throw new Rejected({ category, code, message: messages[code] ?? "The fixed application build contract was not satisfied.", ...(file ? { file } : {}) });
}
const messages: Record<string, string> = {
  "invalid-input": "Provide the complete bounded application source and compiler library snapshots.",
  "unsupported-source": "Only client HTML/CSS/TypeScript and server TypeScript modules are supported.",
  "unsafe-path": "A snapshot path is not a unique portable product path.",
  "missing-entry": "The client index.html and server handler.ts entries are required.",
  "unsupported-module": "Use relative .js module specifiers within the same client or server directory.",
  "sdk-runtime-import": "Import the application SDK only with an import type or export type declaration.",
  "compiler-directive": "Source references, compiler suppressions and ambient declarations are unsupported.",
  "missing-library": "A fixed compiler library or one of its library references is missing.",
  "ambient-runtime": "The compiler process must start without NODE_OPTIONS or NODE_PATH.",
  "host-fallback": "The compiler attempted an unavailable host-system operation.",
  "unexpected-output": "Compiler output did not exactly cover the supported source modules.",
  "source-changed": "The current source snapshot differs from the compiled snapshot.",
  "output-changed": "The complete artifact set differs from the compiler output.",
  "local-draft-required": "An original local compilation draft is required; serialized metadata grants no authority.",
};
function portable(path: string): boolean {
  return path.length <= 512 && path.split("/").every(part => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(part)
    && !/[. ]$/u.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}
function sourceFiles(input: unknown): ApplicationBuildTextFile[] {
  const parsed = z.array(fileSchema).min(2).max(maximumFiles).safeParse(input);
  if (!parsed.success) reject("invalid-input");
  const files = parsed.data.sort(order), seen = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (!portable(file.path) || seen.has(key)) reject("unsafe-path");
    seen.add(key);
    if (!/^product\/(?:client\/.+\.(?:html|css|ts)|server\/.+\.ts)$/u.test(file.path)
      || file.path.endsWith(".d.ts") || file.path.split("/").some(part => part.toLowerCase() === "node_modules")) reject("unsupported-source");
    const length = Buffer.byteLength(file.text, "utf8"); bytes += length;
    if (length > 128 * 1024 || bytes > maximumSourceBytes || Buffer.from(file.text, "utf8").toString("utf8") !== file.text) reject("invalid-input");
  }
  if (!seen.has("product/client/index.html") || !seen.has("product/server/handler.ts")
    || !files.some(file => file.path === "product/client/index.html") || !files.some(file => file.path === "product/server/handler.ts")) reject("missing-entry");
  return files;
}
function libraryFiles(files: ApplicationBuildTextFile[]): ApplicationBuildTextFile[] {
  const seen = new Set<string>(); let total = 0;
  for (const file of files) {
    const bytes = Buffer.byteLength(file.text, "utf8"); total += bytes;
    if (!/^lib\.[a-z0-9.]+\.d\.ts$/u.test(file.path) || seen.has(file.path) || bytes > 4 * 1024 * 1024 || total > 16 * 1024 * 1024
      || Buffer.from(file.text, "utf8").toString("utf8") !== file.text) reject("invalid-input");
    seen.add(file.path);
  }
  return files.sort(order);
}
function moduleTarget(specifier: string, containing: string, available: ReadonlyMap<string, string>): string | undefined {
  if (specifier === APPLICATION_SDK_V1_MODULE) return sdkPath;
  if (!/^(?:\.\/|\.\.\/)[A-Za-z0-9_./-]+\.js$/u.test(specifier)) return undefined;
  const role = containing.startsWith(`${sourceRoot}product/client/`) ? "client" : "server";
  const target = posix.resolve(posix.dirname(containing), specifier).replace(/\.js$/u, ".ts");
  return target.startsWith(`${sourceRoot}product/${role}/`) && available.has(target) ? target : undefined;
}
function inspectSource(file: ApplicationBuildTextFile, available: ReadonlyMap<string, string>): ts.SourceFile {
  const source = ts.createSourceFile(sourceRoot + file.path, file.text, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  if (source.referencedFiles.length || source.typeReferenceDirectives.length || source.libReferenceDirectives.length || source.hasNoDefaultLib)
    reject("compiler-directive", "policy", file.path);
  // A standalone scanner lacks the parser's template/regex rescans and can miss
  // a real comment. This deliberately narrow source format reserves the entire
  // prefix family, even in strings, and includes TypeScript's accepted suffixes.
  if (/@ts-(?:nocheck|ignore|expect-error)/u.test(file.text)) reject("compiler-directive", "policy", file.path);
  const module = (value: string, typeOnly: boolean) => {
    if (value === APPLICATION_SDK_V1_MODULE && !typeOnly) reject("sdk-runtime-import", "policy", file.path);
    if (!moduleTarget(value, source.fileName, available)) reject("unsupported-module", "policy", file.path);
  };
  const walk = (node: ts.Node): void => {
    // A declare value can satisfy the synthetic handler type but disappear from
    // emitted JavaScript, including when another source re-exports that value.
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword))
      reject("compiler-directive", "policy", file.path);
    if (ts.isImportDeclaration(node)) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) reject("unsupported-module", "policy", file.path);
      module(node.moduleSpecifier.text, node.importClause?.isTypeOnly === true);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) reject("unsupported-module", "policy", file.path);
      module(node.moduleSpecifier.text, node.isTypeOnly);
    } else if (ts.isImportTypeNode(node)) {
      if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal)) reject("unsupported-module", "policy", file.path);
      module(node.argument.literal.text, true);
    } else if (ts.isImportEqualsDeclaration(node) || (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")))) {
      reject("unsupported-module", "policy", file.path);
    } else if (ts.isModuleDeclaration(node)) reject("compiler-directive", "policy", file.path);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return source;
}

/** Fail closed if TypeScript falls back to its own sys object. The operation is synchronous;
 * no application callback, async continuation or compiler plugin runs while the guard is held. */
let compilerInUse = false;
function guardCompilerSystemCalls<T>(operation: () => T): T {
  if (compilerInUse) reject("host-fallback", "compiler");
  if (Object.hasOwn(process.env, "NODE_OPTIONS") || Object.hasOwn(process.env, "NODE_PATH")) reject("ambient-runtime", "compiler");
  compilerInUse = true;
  const changed: [string, PropertyDescriptor][] = [];
  try {
    if (Object.getPrototypeOf(ts.sys) !== Object.prototype && Object.getPrototypeOf(ts.sys) !== null) reject("host-fallback", "compiler");
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(ts.sys))) {
      if (descriptor.get || descriptor.set) reject("host-fallback", "compiler");
      if (typeof descriptor.value !== "function") continue;
      Object.defineProperty(ts.sys, key, { ...descriptor, value: () => reject("host-fallback", "compiler") });
      changed.push([key, descriptor]);
    }
    return operation();
  } finally {
    try { for (const [key, descriptor] of changed.reverse()) Object.defineProperty(ts.sys, key, descriptor); }
    finally { compilerInUse = false; }
  }
}
function libraryRoots(roots: string[], libraries: ReadonlyMap<string, string>): string[] {
  const found = new Set<string>();
  const visit = (name: string): void => {
    const key = `lib.${name}.d.ts`;
    if (found.has(key)) return;
    const text = libraries.get(key);
    if (text === undefined) reject("missing-library", "compiler");
    found.add(key);
    const references = ts.preProcessFile(text, true, false);
    if (references.referencedFiles.length || references.typeReferenceDirectives.length || references.importedFiles.length) reject("missing-library", "compiler");
    for (const reference of references.libReferenceDirectives) {
      if (!/^[a-z0-9.]+$/u.test(reference.fileName)) reject("missing-library", "compiler");
      visit(reference.fileName);
    }
  };
  roots.forEach(visit);
  return [...found].sort().map(name => libraryRoot + name);
}
function safeDiagnostic(diagnostic: ts.Diagnostic, source: ReadonlyMap<string, string>): ApplicationBuildDiagnostic {
  const file = diagnostic.file?.fileName;
  const relative = file?.startsWith(sourceRoot) ? file.slice(sourceRoot.length) : undefined;
  const known = relative !== undefined && source.has(sourceRoot + relative);
  const position = known && diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
  // Never return TypeScript's raw message text: it can include a source-supplied path/string.
  return { category: "compiler", code: `TS${diagnostic.code}`, message: "TypeScript rejected this source or the fixed handler contract.",
    ...(known ? { file: relative } : {}), ...(position ? { line: position.line + 1, column: position.character + 1 } : {}) };
}
function compileRole(role: "client" | "server", source: ReadonlyMap<string, string>, libraries: ReadonlyMap<string, string>): {
  files: ApplicationBuildTextFile[]; diagnostics: ApplicationBuildDiagnostic[];
} {
  const root = `${sourceRoot}product/${role}/`, output = `/__output/${role}/`;
  const virtual = new Map<string, string>([...source].filter(([name]) => name.startsWith(root)));
  for (const [name, text] of libraries) virtual.set(libraryRoot + name, text);
  virtual.set(sdkPath, APPLICATION_SDK_V1_SOURCE);
  const roots = [...virtual.keys()].filter(name => name.startsWith(root) && name.endsWith(".ts"));
  if (role === "server") {
    const guard = root + "__artoo_handler_contract__.d.ts";
    virtual.set(guard, `import type { ApplicationHandler } from "${APPLICATION_SDK_V1_MODULE}";\nimport type { handle } from "./handler.js";\ntype Accept<T extends ApplicationHandler> = T;\ntype Checked = Accept<typeof handle>;\n`);
    roots.push(guard);
  }
  roots.push(...libraryRoots(role === "client" ? ["es2023", "dom", "dom.iterable"] : ["es2023"], libraries));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler,
    rootDir: root, outDir: output, noLib: true, types: [], typeRoots: [], strict: true,
    noUncheckedIndexedAccess: true, noImplicitOverride: true, noEmitOnError: true,
    allowJs: false, declaration: false, sourceMap: false, inlineSourceMap: false, incremental: false,
    skipLibCheck: false, resolveJsonModule: false, verbatimModuleSyntax: true,
    moduleDetection: ts.ModuleDetectionKind.Force, newLine: ts.NewLineKind.LineFeed,
  };
  const files: ApplicationBuildTextFile[] = [], emitted = new Set<string>(); let outputBytes = 0;
  const directories = new Set<string>();
  for (const name of virtual.keys()) for (let parent = posix.dirname(name); parent !== "/"; parent = posix.dirname(parent)) directories.add(parent);
  const read = (name: string) => virtual.get(name);
  const host: ts.CompilerHost = {
    getSourceFile(name, languageVersion) {
      const text = read(name);
      return text === undefined ? undefined : ts.createSourceFile(name, text, languageVersion, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => libraryRoot + "lib.es2023.d.ts", getDefaultLibLocation: () => libraryRoot,
    getCurrentDirectory: () => "/", getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n", getEnvironmentVariable: () => undefined,
    fileExists: name => virtual.has(name), directoryExists: name => directories.has(name), getDirectories: () => [],
    readFile: read, readDirectory: () => [], realpath: name => name, createHash: sha,
    resolveModuleNameLiterals: (names, containing) => names.map(name => {
      const resolved = moduleTarget(name.text, containing, virtual);
      return { resolvedModule: resolved ? { resolvedFileName: resolved, extension: resolved.endsWith(".d.ts") ? ts.Extension.Dts : ts.Extension.Ts,
        isExternalLibraryImport: false } : undefined };
    }),
    resolveTypeReferenceDirectiveReferences: references => references.map(() => ({ resolvedTypeReferenceDirective: undefined })),
    writeFile(name, text, bom) {
      if (!name.startsWith(output) || !name.endsWith(".js") || bom) reject("unexpected-output", "integrity");
      const relative = name.slice(output.length), input = root + relative.replace(/\.js$/u, ".ts");
      const path = `${role}/${relative}`;
      if (!source.has(input) || !portable(path) || emitted.has(path)) reject("unexpected-output", "integrity");
      emitted.add(path); outputBytes += Buffer.byteLength(text, "utf8");
      if (outputBytes > maximumOutputBytes) reject("unexpected-output", "integrity");
      files.push({ path, text });
    },
  };
  const program = ts.createProgram({ rootNames: roots, options, host });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.some(item => item.category === ts.DiagnosticCategory.Error)) return { files: [], diagnostics: diagnostics.slice(0, maximumDiagnostics).map(item => safeDiagnostic(item, source)) };
  const result = program.emit();
  if (result.emitSkipped || result.diagnostics.length) return { files: [], diagnostics: result.diagnostics.slice(0, maximumDiagnostics).map(item => safeDiagnostic(item, source)) };
  if (files.length !== [...source.keys()].filter(name => name.startsWith(root) && name.endsWith(".ts")).length) reject("unexpected-output", "integrity");
  return { files, diagnostics: [] };
}

/** Pure text compilation only. Actual compiler executable bytes and process isolation are
 * not measured here; compiler_version and library digests are descriptive input records. */
export function compileApplicationDraft(input: unknown): ApplicationBuildDraft | ApplicationBuildRejection {
  try {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) reject("invalid-input");
    const source = sourceFiles(parsed.data.source), libraries = libraryFiles(parsed.data.libraries);
    const sourceMap = new Map(source.map(file => [sourceRoot + file.path, file.text]));
    const libraryMap = new Map(libraries.map(file => [file.path, file.text]));
    return guardCompilerSystemCalls(() => {
      source.filter(file => file.path.endsWith(".ts")).forEach(file => inspectSource(file, sourceMap));
      const client = compileRole("client", sourceMap, libraryMap), server = compileRole("server", sourceMap, libraryMap);
      const diagnostics = [...client.diagnostics, ...server.diagnostics].slice(0, maximumDiagnostics);
      if (diagnostics.length) return freeze({ status: "rejected" as const, diagnostics, execution: unavailable });
      const files = [...client.files, ...server.files, ...source.filter(file => !file.path.endsWith(".ts"))
        .map(file => ({ path: file.path.slice("product/".length), text: file.text }))].sort(order);
      if (files.length !== source.length || files.reduce((total, file) => total + Buffer.byteLength(file.text, "utf8"), 0) > maximumOutputBytes) reject("unexpected-output", "integrity");
      const sourcePins = pins(source), libraryPins = pins(libraries), artifactPins = pins(files);
      const manifest: ApplicationBuildManifest = { version: 1, format: "artoo.application-build-draft.v1", compiler_version: ts.version,
        compiler_lib_digest: manifestDigest(libraryPins), sdk_digest: sha(APPLICATION_SDK_V1_SOURCE),
        source_digest: manifestDigest(sourcePins), artifact_digest: manifestDigest(artifactPins),
        source_files: sourcePins, compiler_lib_files: libraryPins, artifact_files: artifactPins, execution: unavailable };
      const result = freeze({ status: "compiled" as const, manifest, files, diagnostics: [] as const });
      localDrafts.set(result, manifest);
      return result;
    });
  } catch (error) {
    const diagnostic = error instanceof Rejected ? error.diagnostic
      : { category: "compiler" as const, code: "compiler-failed", message: "The fixed compiler failed without producing an accepted artifact." };
    return freeze({ status: "rejected" as const, diagnostics: [diagnostic], execution: unavailable });
  }
}

/** Content equality only; does not qualify a physical directory, process, or publication. */
export function assertApplicationBuildOutput(draft: ApplicationBuildDraft, currentSource: unknown, currentOutputs: unknown): void {
  const original = localDrafts.get(draft);
  if (!original) reject("local-draft-required", "integrity");
  if (manifestDigest(pins(sourceFiles(currentSource))) !== original.source_digest) reject("source-changed", "integrity");
  const outputs = z.array(fileSchema).min(2).max(maximumFiles).safeParse(currentOutputs);
  if (!outputs.success || outputs.data.some(file => !portable(file.path))
    || new Set(outputs.data.map(file => file.path.toLowerCase())).size !== outputs.data.length
    || outputs.data.reduce((total, file) => total + Buffer.byteLength(file.text, "utf8"), 0) > maximumOutputBytes
    || manifestDigest(pins(outputs.data)) !== original.artifact_digest) reject("output-changed", "integrity");
}
