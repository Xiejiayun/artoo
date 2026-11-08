import { createHash } from "node:crypto";
import { z } from "zod";
import { decodeApplicationCompilerRequest } from "./application-compiler-protocol.js";
import { readApplicationCompilerResponse } from "./application-compiler-response.js";
import { APPLICATION_SDK_V1_SOURCE } from "./application-sdk-v1.js";
import { isWellFormedApplicationUtf8 } from "./application-build-primitives.js";
import type { ApplicationBuildDraft, ApplicationBuildFilePin, ApplicationBuildTextFile } from "./application-build-kernel.js";

/** Expected content selected locally. A version/library match does not prove
 * which compiler implementation, process, package or executable produced output. */
export interface ApplicationCompilerContentInputs {
  readonly compilerVersion: string;
  readonly libraries: readonly ApplicationBuildTextFile[];
}
declare const captureBrand: unique symbol;
export interface CapturedApplicationCompilerContent { readonly [captureBrand]: true }
export interface ApplicationCompilerContent {
  readonly version: 1;
  readonly scope: "compiler-response-content-only";
  readonly qualified_for_product: false;
  readonly request_id: string;
  readonly source: readonly ApplicationBuildTextFile[];
  readonly result: ApplicationBuildDraft;
}
export interface ApplicationCompilerCaptureOwner {
  /** Exactly one attempt for this original request, including failure/rejection. */
  capture(input: AsyncIterable<Uint8Array>): Promise<CapturedApplicationCompilerContent>;
  read(captured: CapturedApplicationCompilerContent): ApplicationCompilerContent;
  revoke(captured: CapturedApplicationCompilerContent): void;
}
type Failure = "invalid-input" | "response-mismatch" | "compiler-rejected" | "attempt-used" | "original-capture-required";
export class ApplicationCompilerCaptureError extends Error {
  constructor(readonly code: Failure) { super("Application compiler content capture rejected: " + code); }
}
const fail = (code: Failure): never => { throw new ApplicationCompilerCaptureError(code); };
const sha = (text: string): string => "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
const order = (a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const portable = (path: string) => path.length <= 512 && path.split("/").every(part =>
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(part) && !/[. ]$/u.test(part)
  && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function pins(files: readonly ApplicationBuildTextFile[]): ApplicationBuildFilePin[] {
  return [...files].sort(order).map(file => ({ path: file.path, bytes: Buffer.byteLength(file.text, "utf8"), sha256: sha(file.text) }));
}
const pinDigest = (files: readonly ApplicationBuildFilePin[]) => sha(JSON.stringify(files));
const samePins = (actual: readonly ApplicationBuildFilePin[], expected: readonly ApplicationBuildFilePin[]) =>
  actual.length === expected.length && actual.every((value, index) => {
    const wanted = expected[index]!;
    return value.path === wanted.path && value.bytes === wanted.bytes && value.sha256 === wanted.sha256;
  });
function boundedFiles(files: readonly ApplicationBuildTextFile[], role: "source" | "libraries" | "artifacts"): ApplicationBuildTextFile[] {
  const seen = new Set<string>(); let total = 0;
  const copies = files.map(file => {
    if (typeof file.path !== "string" || typeof file.text !== "string" || !portable(file.path)
      || seen.has(file.path.toLowerCase()) || !isWellFormedApplicationUtf8(file.text)) return fail("invalid-input");
    seen.add(file.path.toLowerCase());
    const length = Buffer.byteLength(file.text, "utf8"); total += length;
    if (role === "source" && (!/^product\/(?:client\/.+\.(?:html|css|ts)|server\/.+\.ts)$/u.test(file.path)
      || file.path.endsWith(".d.ts") || file.path.split("/").some(part => part.toLowerCase() === "node_modules")
      || length > 128 * 1024 || total > 8 * 1024 * 1024)
      || role === "libraries" && (!/^lib\.[a-z0-9.]+\.d\.ts$/u.test(file.path) || length > 4 * 1024 * 1024 || total > 16 * 1024 * 1024)
      || role === "artifacts" && (!/^(?:client\/.+\.(?:html|css|js)|server\/.+\.js)$/u.test(file.path) || total > 16 * 1024 * 1024))
      return fail("invalid-input");
    return { path: file.path, text: file.text };
  }).sort(order);
  if (role === "source" && (!copies.some(file => file.path === "product/client/index.html")
    || !copies.some(file => file.path === "product/server/handler.ts"))) return fail("invalid-input");
  return copies;
}
const inputsSchema = z.object({ compilerVersion: z.string().min(1).max(64).regex(/^[A-Za-z0-9.+_-]+$/u),
  libraries: z.array(z.object({ path: z.string().min(1).max(512), text: z.string().max(4 * 1024 * 1024) }).strict()).min(1).max(128) }).strict();

/** Immutable request and compiler-content expectations only. This owner grants
 * no native, staging, run-verification, independent-review or publication permit. */
export function createApplicationCompilerCaptureOwner(requestBytes: Uint8Array, compilerInputs: ApplicationCompilerContentInputs): ApplicationCompilerCaptureOwner {
  const request = decodeApplicationCompilerRequest(requestBytes), input = inputsSchema.safeParse(compilerInputs);
  if (!input.success) return fail("invalid-input");
  const source = freeze(boundedFiles(request.source, "source"));
  const libraries = boundedFiles(input.data.libraries, "libraries");
  const expectedSource = freeze(pins(source)), expectedLibraries = freeze(pins(libraries));
  const sourceDigest = pinDigest(expectedSource), libraryDigest = pinDigest(expectedLibraries), sdkDigest = sha(APPLICATION_SDK_V1_SOURCE);
  const outputs = new Map(source.map(file => [file.path.slice("product/".length).replace(/\.ts$/u, ".js"), file]));
  const compilerVersion = input.data.compilerVersion, requestId = request.request_id;
  const captures = new WeakMap<CapturedApplicationCompilerContent, ApplicationCompilerContent>();
  const original = (token: CapturedApplicationCompilerContent) => captures.get(token) ?? fail("original-capture-required");
  let attempted = false;
  return Object.freeze({
    async capture(stream: AsyncIterable<Uint8Array>): Promise<CapturedApplicationCompilerContent> {
      if (attempted) return fail("attempt-used"); attempted = true;
      const response = await readApplicationCompilerResponse(stream);
      if (response.request_id !== requestId) return fail("response-mismatch");
      if (response.result.status !== "compiled") return fail("compiler-rejected");
      const { manifest } = response.result, files = boundedFiles(response.result.files, "artifacts");
      const measured = pins(files);
      if (manifest.compiler_version !== compilerVersion || manifest.source_digest !== sourceDigest
        || manifest.compiler_lib_digest !== libraryDigest || manifest.sdk_digest !== sdkDigest
        || !samePins(manifest.source_files, expectedSource) || !samePins(manifest.compiler_lib_files, expectedLibraries)
        || files.length !== outputs.size || files.some(file => !outputs.has(file.path))
        || !samePins(manifest.artifact_files, measured) || manifest.artifact_digest !== pinDigest(measured))
        return fail("response-mismatch");
      for (const file of files) {
        const from = outputs.get(file.path)!;
        if (!from.path.endsWith(".ts") && file.text !== from.text) return fail("response-mismatch");
      }
      const token = Object.freeze({}) as CapturedApplicationCompilerContent;
      captures.set(token, freeze({ version: 1, scope: "compiler-response-content-only", qualified_for_product: false,
        request_id: requestId, source, result: { ...response.result, files } }));
      return token;
    },
    read(token: CapturedApplicationCompilerContent) { return original(token); },
    revoke(token: CapturedApplicationCompilerContent) { original(token); captures.delete(token); },
  });
}
