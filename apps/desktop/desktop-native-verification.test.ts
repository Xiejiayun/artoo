// Real local persistence/path/manifest checks, controlled child process events.
// No native helper, model provider or product is executed by this suite.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createDesktopController } = require("./desktop-controller.cjs");
const { createConnectionStore } = require("./connection-store.cjs");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture(platform = "win32") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "artoo-desktop-native-")));
  const directory = join(root, "control"), workspace = join(root, "workspace"), daemon = join(root, "installation", "daemon");
  const native = join(daemon, "native", "windows-process"), profilesFile = join(root, "verification.json");
  for (const path of [directory, workspace, native]) await mkdir(path, { recursive: true });
  const nativeManifest = Buffer.from(JSON.stringify({ version: 1, protocol: "artoo.windows-job-process.v1", runtime: "win-x64", executable: "Artoo.WindowsProcessHost.exe", files: [] }));
  const manifestSha256 = `sha256:${createHash("sha256").update(nativeManifest).digest("hex")}`;
  const bundle = { format: "artoo.desktop-daemon.v1", node_target: "node24", windows_process: {
    directory: "native/windows-process", manifest_sha256: manifestSha256, executable: "Artoo.WindowsProcessHost.exe" } };
  await writeFile(join(daemon, "artood.mjs"), "// controlled placeholder, never executed");
  await writeFile(join(native, "manifest.json"), nativeManifest);
  await writeFile(join(daemon, "bundle-manifest.json"), JSON.stringify(bundle));
  await writeFile(profilesFile, JSON.stringify([{ id: "local-profile", project_id: "project", workspace_root: workspace, commands: [], required_files: [], subject_paths: ["product"] }]));
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`controlled:${value}`),
    decryptString: (value: Buffer) => value.toString().slice("controlled:".length) };
  const store = createConnectionStore(directory, safeStorage); await store.pair("device", "control-token", "node-token"); await store.setComputer("computer");
  const launches: { args: string[]; options: any }[] = [];
  const options = { directory, safeStorage, platform, executable: process.execPath, daemonEntry: join(daemon, "artood.mjs"),
    fetch: async () => new Response("{}"), spawn: (_executable: string, args: string[], spawnOptions: any) => {
      launches.push({ args, options: spawnOptions });
      const child: any = Object.assign(new EventEmitter(), { connected: true, pid: 4321,
        send: (_message: unknown, callback?: (error?: Error) => void) => queueMicrotask(() => { callback?.(); child.emit("exit", 0); child.emit("close", 0); }) });
      return child;
    } };
  const controller = createDesktopController(options); await controller.initialize();
  cleanups.push(async () => { await controller.stopDaemon(); await rm(root, { recursive: true, force: true }); });
  const base = { allowedRoots: [workspace], runtimes: ["codex"], trustedExecution: false };
  const config = { ...base, nativeVerification: { version: 1, profilesFile } };
  return { root, directory, workspace, daemon, native, profilesFile, manifestSha256, bundle, options, controller, launches, base, config };
}

describe("desktop native verification explicit configuration", () => {
  it("persists only the profile path and derives launch binding from the packaged manifest", async () => {
    const f = await fixture(); await f.controller.configureDaemon(f.config);
    const disk = JSON.parse(await readFile(join(f.directory, "connection.json"), "utf8"));
    expect(disk.daemon.nativeVerification).toEqual({ version: 1, profilesFile: f.profilesFile });
    expect(JSON.stringify(disk.daemon)).not.toContain(f.manifestSha256);
    const status = await f.controller.daemonStatus(); status.config.nativeVerification.profilesFile = "caller mutation";
    expect((await f.controller.daemonStatus()).config.nativeVerification.profilesFile).toBe(f.profilesFile);
    const reopened = createDesktopController(f.options); await reopened.initialize();
    await reopened.startDaemon(); await reopened.stopDaemon();
    expect(f.launches[0]!.options.env).toMatchObject({ ARTOO_VERIFICATION_PROFILES_FILE: f.profilesFile,
      ARTOO_WINDOWS_PROCESS_BUNDLE: f.native, ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256: f.manifestSha256 });
    expect(f.launches[0]!.args).not.toContain("--prepared-journal");
  });

  it("strips inherited automation settings and removes saved native settings when disabled", async () => {
    const f = await fixture();
    for (const key of ["ARTOO_VERIFICATION_PROFILES_FILE", "ARTOO_WINDOWS_PROCESS_BUNDLE", "ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256",
      "artoo_windows_process_unrecognized", "ARTOO_RELEASE_PROFILES_FILE", "ARTOO_OWNED_RESULT_PROFILES_FILE"]) vi.stubEnv(key, "inherited-untrusted-setting");
    await f.controller.configureDaemon(f.config); await f.controller.startDaemon(); await f.controller.stopDaemon();
    expect(f.launches[0]!.options.env.ARTOO_RELEASE_PROFILES_FILE).toBeUndefined();
    expect(f.launches[0]!.options.env.artoo_windows_process_unrecognized).toBeUndefined();
    await f.controller.configureDaemon(f.base); await f.controller.startDaemon(); await f.controller.stopDaemon();
    for (const [key, value] of Object.entries(f.launches[1]!.options.env)) {
      if (/^ARTOO_(WINDOWS_PROCESS_|VERIFICATION_PROFILES_FILE|RELEASE_PROFILES_FILE|OWNED_RESULT_PROFILES_FILE)/i.test(key)) expect(value).toBeUndefined();
    }
    expect((await f.controller.daemonStatus()).config.nativeVerification).toBeUndefined();
  });

  it("rejects profile files within any writable root and preserves the previous saved settings", async () => {
    const f = await fixture(); await f.controller.configureDaemon(f.base);
    const before = await readFile(join(f.directory, "connection.json"), "utf8");
    await expect(f.controller.configureDaemon({ ...f.config, allowedRoots: [f.workspace, f.root] })).rejects.toThrow(/outside every allowed/);
    expect(await readFile(join(f.directory, "connection.json"), "utf8")).toBe(before);
  });

  it.each(["missing", "malformed", "empty", "directory", "relative"])("rejects a %s profile file", async (kind) => {
    const f = await fixture();
    if (kind === "missing") await rm(f.profilesFile);
    if (kind === "malformed") await writeFile(f.profilesFile, "{");
    if (kind === "empty") await writeFile(f.profilesFile, "[]");
    const profilesFile = kind === "directory" ? f.directory : kind === "relative" ? "profiles.json" : f.profilesFile;
    await expect(f.controller.configureDaemon({ ...f.config, nativeVerification: { version: 1, profilesFile } })).rejects.toThrow();
    expect(f.launches).toHaveLength(0);
  });

  it.each(["darwin", "linux"])("preserves ordinary configuration on %s and rejects native activation", async platform => {
    const f = await fixture(platform); await f.controller.configureDaemon(f.base);
    await expect(f.controller.configureDaemon(f.config)).rejects.toThrow(/only on Windows/);
  });

  it.each(["darwin", "linux"])("preserves explicit operator verification/release/result environment on %s", async platform => {
    const f = await fixture(platform), inherited = {
      ARTOO_VERIFICATION_PROFILES_FILE: "operator-verification.json",
      ARTOO_RELEASE_PROFILES_FILE: "operator-release.json",
      ARTOO_OWNED_RESULT_PROFILES_FILE: "operator-owned-results.json",
    };
    for (const [key, value] of Object.entries(inherited)) vi.stubEnv(key, value);
    // This Windows-hosted routing fixture simulates only the missing POSIX uid
    // accessor. It does not prepare a managed profile or establish Mac support.
    const descriptor = Object.getOwnPropertyDescriptor(process, "getuid"), uid = (await stat(f.directory)).uid;
    if (!descriptor) Object.defineProperty(process, "getuid", { configurable: true, value: () => uid });
    try {
      await f.controller.configureDaemon(f.base); await f.controller.startDaemon(); await f.controller.stopDaemon();
      expect(f.launches[0]!.options.env).toMatchObject(inherited);
    } finally { if (!descriptor) Reflect.deleteProperty(process, "getuid"); }
  });

  it("rejects managed allocation and renderer-supplied native helper authority", async () => {
    const f = await fixture();
    await expect(f.controller.configureDaemon({ ...f.config, allowNewAllocations: true })).rejects.toThrow(/ordinary workspaces/);
    await expect(f.controller.configureDaemon({ ...f.config, nativeVerification: { ...f.config.nativeVerification, manifestSha256: f.manifestSha256 } })).rejects.toThrow(/Invalid native/);
  });

  it.each(["absent", "wrong-path", "changed-hash"])("fails closed on %s packaged native binding", async kind => {
    const f = await fixture();
    if (kind === "absent") await writeFile(join(f.daemon, "bundle-manifest.json"), JSON.stringify({ format: "artoo.desktop-daemon.v1", node_target: "node24" }));
    if (kind === "wrong-path") await writeFile(join(f.daemon, "bundle-manifest.json"), JSON.stringify({ ...f.bundle, windows_process: { ...f.bundle.windows_process, directory: "../other" } }));
    if (kind === "changed-hash") await writeFile(join(f.native, "manifest.json"), "changed");
    await expect(f.controller.configureDaemon(f.config)).rejects.toThrow(/native Windows verification binding|manifest has changed/);
    expect(f.launches).toHaveLength(0);
  });

  it("revalidates configuration at start and keeps settings locked while the worker is active", async () => {
    const f = await fixture(); await f.controller.configureDaemon(f.config);
    await writeFile(f.profilesFile, "[]"); await expect(f.controller.startDaemon()).rejects.toThrow(/one to 64/);
    expect(f.launches).toHaveLength(0);
    await writeFile(f.profilesFile, "[{}]"); await f.controller.startDaemon();
    await expect(f.controller.configureDaemon(f.base)).rejects.toThrow(/Stop the worker/);
    await f.controller.stopDaemon();
    await writeFile(join(f.native, "manifest.json"), "changed after saving");
    await expect(f.controller.startDaemon()).rejects.toThrow(/manifest has changed/);
    expect(f.launches).toHaveLength(1);
  });
});

describe("desktop native publication explicit configuration", () => {
  async function publication(platform = "win32") {
    const f = await fixture(platform), profilesFile = join(f.root, "publication.json");
    await writeFile(profilesFile, JSON.stringify([{ id: "local-release", verification_profile_id: "local-profile" }]));
    return { ...f, publicationFile: profilesFile,
      publicationConfig: { ...f.config, nativePublication: { version: 1, profilesFile } } };
  }
  it("persists a separate local opt-in, protects returned settings and supplies only its saved profile path", async () => {
    const f = await publication(); vi.stubEnv("ARTOO_RELEASE_PROFILES_FILE", "inherited-publication.json");
    await f.controller.configureDaemon(f.publicationConfig);
    const status = await f.controller.daemonStatus(); status.config.nativePublication.profilesFile = "caller mutation";
    expect((await f.controller.daemonStatus()).config.nativePublication).toEqual({ version: 1, profilesFile: f.publicationFile });
    const reopened = createDesktopController(f.options); await reopened.initialize();
    await reopened.startDaemon(); await reopened.stopDaemon();
    expect(f.launches[0]!.options.env).toMatchObject({ ARTOO_RELEASE_PROFILES_FILE: f.publicationFile,
      ARTOO_VERIFICATION_PROFILES_FILE: f.profilesFile, ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256: f.manifestSha256 });
    await f.controller.configureDaemon(f.config); await f.controller.startDaemon(); await f.controller.stopDaemon();
    expect(f.launches[1]!.options.env.ARTOO_RELEASE_PROFILES_FILE).toBeUndefined();
    expect((await f.controller.daemonStatus()).config.nativePublication).toBeUndefined();
  });
  it("requires verification and rejects publication authority supplied by the renderer", async () => {
    const f = await publication(); await f.controller.configureDaemon(f.base);
    const before = await readFile(join(f.directory, "connection.json"), "utf8");
    await expect(f.controller.configureDaemon({ ...f.base, nativePublication: f.publicationConfig.nativePublication })).rejects.toThrow(/requires automatic task verification/);
    await expect(f.controller.configureDaemon({ ...f.publicationConfig, nativePublication: { ...f.publicationConfig.nativePublication, qualified: true } })).rejects.toThrow(/Invalid native publication/);
    expect(await readFile(join(f.directory, "connection.json"), "utf8")).toBe(before);
    expect(f.launches).toHaveLength(0);
  });
  it("rejects a publication file in any allowed workspace and preserves the prior configuration", async () => {
    const f = await publication(); await f.controller.configureDaemon(f.config);
    const before = await readFile(join(f.directory, "connection.json"), "utf8");
    const writable = join(f.workspace, "publication.json"); await writeFile(writable, "[{}]");
    await expect(f.controller.configureDaemon({ ...f.publicationConfig, nativePublication: { version: 1, profilesFile: writable } })).rejects.toThrow(/outside every allowed/);
    expect(await readFile(join(f.directory, "connection.json"), "utf8")).toBe(before);
  });
  it.each(["missing", "malformed", "empty", "directory", "relative"])("rejects a %s publication file", async kind => {
    const f = await publication();
    if (kind === "missing") await rm(f.publicationFile);
    if (kind === "malformed") await writeFile(f.publicationFile, "{");
    if (kind === "empty") await writeFile(f.publicationFile, "[]");
    const profilesFile = kind === "directory" ? f.directory : kind === "relative" ? "release.json" : f.publicationFile;
    await expect(f.controller.configureDaemon({ ...f.publicationConfig, nativePublication: { version: 1, profilesFile } })).rejects.toThrow();
    expect(f.launches).toHaveLength(0);
  });
  it("revalidates publication configuration on restart and keeps it locked during execution", async () => {
    const f = await publication(); await f.controller.configureDaemon(f.publicationConfig);
    await writeFile(f.publicationFile, "[]"); await expect(f.controller.startDaemon()).rejects.toThrow(/Publication profiles file must contain one to 64/);
    expect(f.launches).toHaveLength(0);
    await writeFile(f.publicationFile, "[{}]"); await f.controller.startDaemon();
    await expect(f.controller.configureDaemon(f.config)).rejects.toThrow(/Stop the worker/); await f.controller.stopDaemon();
  });
  it.each(["darwin", "linux"])("does not enable the Windows publication setting on %s", async platform => {
    const f = await publication(platform);
    await expect(f.controller.configureDaemon({ ...f.base, nativePublication: f.publicationConfig.nativePublication })).rejects.toThrow(/only on Windows/);
    expect(f.launches).toHaveLength(0);
  });
});
