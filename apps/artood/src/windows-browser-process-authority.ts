import { realpathSync } from "node:fs";
import { win32 } from "node:path";
import { z } from "zod";
import { describeWindowsProcessInstallation, prepareWindowsProcessInstallation } from "./windows-process-installation.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";

const identifier = z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const absolute = z.string().min(1).max(4096).refine(value => win32.isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value));
const bindingSchema = z.object({
  request_id: identifier, command_id: identifier, profile_digest: digest, subject_digest: digest, workspace_root: absolute,
}).strict();
export type WindowsBrowserProcessBinding = z.infer<typeof bindingSchema>;
const descriptorSchema = bindingSchema.extend({ version: z.literal(1), installation: z.object({
  directory: absolute, manifestSha256: digest, writableWorkspaceRoots: z.array(absolute).min(1).max(128),
}).strict() }).strict();
export type WindowsBrowserProcessDescriptor = z.infer<typeof descriptorSchema>;

function requireWindows(): void {
  if (process.platform !== "win32") throw new Error("Windows browser Job execution requires Windows");
}
function assertWorkspaceScope(workspace: string, roots: readonly string[]): void {
  const physical = realpathSync.native(workspace);
  if (physical !== workspace) throw new Error("Windows browser workspace must be the bound physical directory");
  const covered = roots.some(root => {
    const physicalRoot = realpathSync.native(root);
    if (physicalRoot !== root) throw new Error("Windows browser installation write-root binding changed");
    const tail = win32.relative(physicalRoot, physical);
    return tail === "" || (!win32.isAbsolute(tail) && tail !== ".." && !tail.startsWith("..\\"));
  });
  if (!covered) throw new Error("Windows browser workspace is outside the installation's configured write roots");
}

/** A generic callback-prepared backend is insufficient for transport to a child. */
export function assertWindowsBrowserProcessInstallation(backend: PreparedWindowsProcessBackend, workspace: string): void {
  requireWindows();
  const installation = describeWindowsProcessInstallation(backend);
  assertWorkspaceScope(workspace, installation.writableWorkspaceRoots);
}

/** The node derives this optional private envelope field from its genuine local backend. */
export function createWindowsBrowserProcessDescriptor(backend: PreparedWindowsProcessBackend,
  expected: WindowsBrowserProcessBinding): WindowsBrowserProcessDescriptor {
  requireWindows();
  const binding = bindingSchema.parse(expected), installation = describeWindowsProcessInstallation(backend);
  assertWorkspaceScope(binding.workspace_root, installation.writableWorkspaceRoots);
  const descriptor = descriptorSchema.parse({ version: 1, ...binding, installation });
  Object.freeze(descriptor.installation.writableWorkspaceRoots);
  Object.freeze(descriptor.installation);
  return Object.freeze(descriptor);
}

/** Configuration crosses the private file; the child must obtain fresh local authority. */
export function prepareWindowsBrowserProcessFromDescriptor(input: unknown, expected: unknown,
  enabled: boolean): PreparedWindowsProcessBackend | undefined {
  if (!enabled) {
    if (input !== undefined) throw new Error("Unsolicited Windows browser process descriptor");
    return undefined;
  }
  requireWindows();
  const binding = bindingSchema.parse(expected), descriptor = descriptorSchema.parse(input);
  for (const field of Object.keys(binding) as (keyof WindowsBrowserProcessBinding)[]) {
    if (descriptor[field] !== binding[field]) throw new Error(`Windows browser process ${field} binding mismatch`);
  }
  assertWorkspaceScope(binding.workspace_root, descriptor.installation.writableWorkspaceRoots);
  return prepareWindowsProcessInstallation(descriptor.installation);
}
