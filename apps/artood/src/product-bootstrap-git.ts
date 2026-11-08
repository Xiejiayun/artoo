import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { resolveCliCommand } from "./cli-resolver.js";
import { prepareWindowsCodeInstallation, assertWindowsCodeInstallation, type PreparedWindowsCodeInstallation } from "./windows-code-installation.js";

const pinSchema = z.object({ version: z.literal(1), path: z.string().min(1), bytes: z.number().int().positive().max(256 * 1024 * 1024),
  sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict();
export type ProductBootstrapGitPin = z.infer<typeof pinSchema>;
declare const prepared: unique symbol;
/** Local executable selection only. This grants no process or workspace authority. */
export interface PreparedProductBootstrapGit { readonly [prepared]: true }
type State = { file: string; storage: PreparedWindowsCodeInstallation; pin: ProductBootstrapGitPin; identity: string;
  assertConfigurationUnchanged?: () => void };
const selections = new WeakMap<object, State>();
function inspect(file: string) {
  if (!isAbsolute(file) || !/\.exe$/i.test(file) || /[\u0000-\u001f\u007f]/.test(file) || realpathSync.native(file) !== file)
    throw Error("Product bootstrap Git must be an absolute physical executable");
  const before = lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size <= 0n || before.size > 256n * 1024n * 1024n)
    throw Error("Product bootstrap Git must be a bounded single-link executable");
  const bytes = readFileSync(file), after = lstatSync(file, { bigint: true });
  const identity = (stat: typeof before) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  if (identity(before) !== identity(after) || after.nlink !== 1n || !after.isFile() || after.isSymbolicLink()
    || BigInt(bytes.length) !== after.size || realpathSync.native(file) !== file) throw Error("Product bootstrap Git changed during inspection");
  return { pin: pinSchema.parse({ version: 1, path: file, bytes: bytes.length,
    sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex") }), identity: identity(after) };
}
/** Reuses protected configuration readers; never opens a source runtime or owner fence. */
export function prepareProductBootstrapGit(input: { file: string; allowedRoots: readonly string[]; expected?: unknown;
  assertConfigurationUnchanged?: () => void }): PreparedProductBootstrapGit {
  input.assertConfigurationUnchanged?.();
  const storage = prepareWindowsCodeInstallation({ directory: dirname(input.file), writableWorkspaceRoots: input.allowedRoots });
  const current = inspect(input.file);
  if (input.expected !== undefined) {
    const expected = pinSchema.parse(input.expected);
    if (expected.path !== current.pin.path || expected.bytes !== current.pin.bytes || expected.sha256 !== current.pin.sha256)
      throw Error("Product bootstrap Git differs from the supervisor's protected selection");
  }
  assertWindowsCodeInstallation(storage, dirname(input.file)); input.assertConfigurationUnchanged?.();
  const token = Object.freeze({}) as PreparedProductBootstrapGit;
  selections.set(token, { file: input.file, storage, ...current, assertConfigurationUnchanged: input.assertConfigurationUnchanged });
  return token;
}
export function readProductBootstrapGit(token: PreparedProductBootstrapGit): string {
  const state = selections.get(token);
  if (!state) throw Error("Product bootstrap Git requires a prepared local selection");
  state.assertConfigurationUnchanged?.(); assertWindowsCodeInstallation(state.storage, dirname(state.file));
  const current = inspect(state.file);
  if (current.identity !== state.identity || current.pin.sha256 !== state.pin.sha256 || current.pin.bytes !== state.pin.bytes)
    throw Error("Prepared product bootstrap Git changed");
  assertWindowsCodeInstallation(state.storage, dirname(state.file)); state.assertConfigurationUnchanged?.();
  return state.file;
}
export function describeProductBootstrapGit(token: PreparedProductBootstrapGit): Readonly<ProductBootstrapGitPin> {
  readProductBootstrapGit(token); return Object.freeze({ ...selections.get(token)!.pin });
}
/** Ordinary, non-supervised execution retains its existing installed-Git PATH resolution. */
export function resolveProductBootstrapGit(token?: PreparedProductBootstrapGit): string {
  if (token) return readProductBootstrapGit(token);
  const git = resolveCliCommand("git");
  if (!git || git.length !== 1) throw Error("Product bootstrap requires an installed native Git executable");
  return git[0]!;
}
