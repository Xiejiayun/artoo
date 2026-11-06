// Actual native filesystem regression. Only installation authority and ACL facts
// are controlled; no native helper, PowerShell, browser or provider is launched.
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import type { WindowsAclTarget } from "./windows-local-acl.js";

const state = vi.hoisted(() => ({ backend: Object.freeze({ controlled: "private-file parent" }), roots: [] as string[] }));
vi.mock("./windows-process-installation.js", () => ({ describeWindowsProcessInstallation: (backend: unknown) => {
  if (backend !== state.backend) throw new Error("Not the controlled installation backend");
  return { directory: "C:\\controlled-host", manifestSha256: `sha256:${"d".repeat(64)}`, writableWorkspaceRoots: state.roots };
} }));
vi.mock("./windows-local-acl.js", async load => ({ ...await load<typeof import("./windows-local-acl.js")>(),
  collectWindowsAclFacts: (targets: readonly WindowsAclTarget[]) => ({ version: 1, currentSid: "S-1-5-21-100-200-300-1001",
    nodes: targets.map(target => ({ ...target, ownerSid: "S-1-5-21-100-200-300-1001", aces: [] })) }),
}));
import { readWindowsBrowserPrivateContext, writeWindowsBrowserPrivateContext } from "./windows-browser-private-context.js";

const roots: { path: string; parent: string }[] = [];
const digest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function fixture() {
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, "artoo-private-native-")));
  roots.push({ path: root, parent });
  const directory = join(root, "private"), workspace = join(root, "workspace");
  mkdirSync(directory); mkdirSync(workspace); state.roots = [workspace];
  return { directory, file: join(directory, "context.json") };
}
beforeEach(() => { state.roots = []; });
afterEach(() => {
  for (const root of roots.splice(0)) {
    // This suite never starts a process; delete only its verified physical temp directory.
    if (realpathSync.native(root.path) !== root.path || dirname(root.path) !== root.parent
      || !basename(root.path).startsWith("artoo-private-native-")) throw new Error("Fixture cleanup path changed");
    rmSync(root.path, { recursive: true, force: true });
  }
});

describe.runIf(process.platform === "win32" && process.arch === "x64")("native Windows private context IO (controlled ACL facts)", () => {
  it("writes and re-reads fresh mode0400 private files without warming their metadata", () => {
    const f = fixture(), backend = state.backend as unknown as PreparedWindowsProcessBackend;
    for (let index = 0; index < 3; index++) {
      const envelope = { version: 1, request_id: `fresh-${index}`, context: { description: "native filesystem regression" } };
      const bytes = Buffer.from(JSON.stringify(envelope)), file = join(f.directory, `fresh-${index}.json`);
      const hash = writeWindowsBrowserPrivateContext(backend, file, envelope, performance.now() + 60000);
      expect(hash).toBe(digest(bytes));
      expect(readWindowsBrowserPrivateContext(file, hash)).toEqual(bytes);
    }
  });
  it("rejects actual changed bytes using the independent parent binding", () => {
    const f = fixture(), original = Buffer.from('{"fixture":"original"}'), changed = Buffer.from('{"fixture":"modified"}');
    expect(original.length).toBe(changed.length);
    writeFileSync(f.file, original, { flag: "wx", mode: 0o400 });
    // Deliberate fixture mutation; no preparatory read may warm the new metadata.
    chmodSync(f.file, 0o600); writeFileSync(f.file, changed); chmodSync(f.file, 0o400);
    expect(() => readWindowsBrowserPrivateContext(f.file, digest(original))).toThrow(/parent binding/);
  });
  it("rejects a real hardlink before returning private bytes", () => {
    const f = fixture(), bytes = Buffer.from('{"fixture":"hardlink"}');
    writeFileSync(f.file, bytes, { flag: "wx", mode: 0o400 });
    linkSync(f.file, join(f.directory, "linked.json"));
    expect(() => readWindowsBrowserPrivateContext(f.file, digest(bytes))).toThrow(/linked|aliased/);
  });
});
