import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FORMAT = "artoo.desktop-daemon.v1", MANIFEST = "bundle-manifest.json";
const ENTRIES = [
  ["main.ts", "artood.mjs", "esm"], ["managed/journal-worker.ts", "journal-worker.js", "cjs"],
  ["workspace-tools-mcp.ts", "workspace-tools-mcp.js", "cjs"], ["research-mcp.ts", "research-mcp.js", "cjs"],
  ["web-acceptance-cli.ts", "web-acceptance-cli.js", "cjs"],
];
const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function fail(message) { throw new Error(`Daemon bundle: ${message}`); }
function physicalDirectory(path) {
  const absolute = resolve(path), stat = lstatSync(absolute), physical = realpathSync.native(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform === "win32"
    ? physical.toLowerCase() !== absolute.toLowerCase() : physical !== absolute)) fail(`directory must be physical: ${absolute}`);
  return physical;
}
function relativeMember(value) {
  if (typeof value !== "string" || !value || isAbsolute(value) || /[\\:\u0000-\u001f]/.test(value)
    || value.split("/").some(part => !part || part === "." || part === "..")) fail("invalid bundle member path");
  return value;
}
function fileFact(path) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 512 * 1024 * 1024) fail(`invalid regular file: ${path}`);
  const windows = process.platform === "win32", fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const identity = ctime => {
      for (const stat of [fstatSync(fd), lstatSync(path)]) {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino
          || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || (!windows && stat.ctimeMs !== before.ctimeMs)
          || (ctime !== undefined && stat.ctimeMs !== ctime)) fail(`file changed while reading: ${path}`);
      }
    };
    identity();
    const buffer = Buffer.alloc(Math.min(64 * 1024, before.size + 1));
    const hash = ctime => {
      const digest = createHash("sha256"); let length = 0;
      while (length <= before.size) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, before.size + 1 - length), length);
        if (!count) break;
        digest.update(buffer.subarray(0, count)); length += count;
      }
      if (length !== before.size) fail(`file length changed: ${path}`);
      identity(ctime); return `sha256:${digest.digest("hex")}`;
    };
    const checksum = hash();
    if (windows) {
      // Absorb only NTFS's first-read access metadata update, then pin ctime.
      const ctime = fstatSync(fd).ctimeMs; identity(ctime);
      if (hash(ctime) !== checksum) fail(`file content changed: ${path}`);
    }
    return { size: before.size, sha256: checksum };
  } finally { closeSync(fd); }
}
function snapshot(root, omitted = []) {
  physicalDirectory(root);
  const files = [], directories = [], keys = new Set(); let bytes = 0;
  const visit = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), member = relative(root, path).split(sep).join("/");
      relativeMember(member);
      if (omitted.includes(member)) continue;
      const key = member.toLowerCase(); if (keys.has(key)) fail("case-colliding bundle members"); keys.add(key);
      if (keys.size > 30_000) fail("bundle member limit exceeded");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) fail(`linked bundle member: ${member}`);
      if (stat.isDirectory()) { directories.push(member); visit(path); }
      else {
        const fact = fileFact(path); bytes += fact.size;
        if (bytes > 2 * 1024 * 1024 * 1024) fail("bundle byte limit exceeded");
        files.push({ path: member, ...fact });
      }
    }
  };
  visit(root); return { directories: directories.sort(), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}
function copySnapshot(source, destination, expected) {
  mkdirSync(destination);
  for (const directory of [...expected.directories].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) mkdirSync(join(destination, directory));
  for (const file of expected.files) {
    const from = join(source, file.path), to = join(destination, file.path);
    copyFileSync(from, to, constants.COPYFILE_EXCL);
    chmodSync(to, lstatSync(from).mode & 0o777);
  }
  if (!equal(snapshot(source), expected) || !equal(snapshot(destination), expected)) fail("copied runtime tree differs from its fixed input");
}
function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function playwrightInputs(repoRoot) {
  const require = createRequire(join(repoRoot, "apps/artood/package.json"));
  const expected = readJson(join(repoRoot, "apps/artood/package.json")).dependencies?.playwright;
  if (!/^\d+\.\d+\.\d+$/.test(expected ?? "")) fail("artood must pin an exact Playwright version");
  const lock = readJson(join(repoRoot, "package-lock.json"));
  const packages = ["playwright", "playwright-core"].map(name => {
    const path = require.resolve(`${name}/package.json`), directory = physicalDirectory(dirname(path)), metadata = readJson(path);
    const lockKey = relative(repoRoot, directory).split(sep).join("/");
    if (metadata.name !== name || metadata.version !== expected || lock.packages?.[lockKey]?.version !== expected
      || (name === "playwright" && metadata.dependencies?.["playwright-core"] !== expected)) fail(`Playwright package/lock version mismatch: ${name}`);
    return { name, directory, tree: snapshot(directory) };
  });
  return { version: expected, packages };
}
function nativeInput(input) {
  if (!input) return undefined;
  if (process.platform !== "win32" || process.arch !== "x64") fail("native helper packaging requires an actual Windows x64 host");
  if (!/^sha256:[a-f0-9]{64}$/.test(input.manifestSha256 ?? "")) fail("native helper requires its pinned manifest sha256");
  const directory = physicalDirectory(input.directory), manifestPath = join(directory, "manifest.json"), manifestFact = fileFact(manifestPath);
  if (manifestFact.sha256 !== input.manifestSha256 || manifestFact.size > 1024 * 1024) fail("native helper manifest hash or size mismatch");
  // Parse the exact pinned bytes, never a separate unchecked JSON read after
  // hashing. The extra byte detects growth while keeping allocation bounded.
  const fd = openSync(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const buffer = Buffer.alloc(manifestFact.size + 1); let length = 0;
  try {
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break; length += count;
    }
  } finally { closeSync(fd); }
  const bytes = buffer.subarray(0, length);
  if (length !== manifestFact.size || sha(bytes) !== input.manifestSha256) fail("native helper manifest changed before parsing");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.version !== 1 || manifest.protocol !== "artoo.windows-job-process.v1" || manifest.runtime !== "win-x64"
    || !Array.isArray(manifest.files) || !manifest.files.length) fail("unsupported native helper manifest");
  const files = manifest.files.map(file => {
    relativeMember(file.path);
    if (file.path.toLowerCase() === "manifest.json" || !Number.isSafeInteger(file.size) || file.size < 0
      || !/^sha256:[a-f0-9]{64}$/.test(file.sha256 ?? "")) fail("invalid native helper manifest member");
    return { path: file.path, size: file.size, sha256: file.sha256 };
  }).sort((a, b) => a.path.localeCompare(b.path));
  relativeMember(manifest.executable);
  if (!manifest.executable.toLowerCase().endsWith(".exe") || !files.some(file => file.path === manifest.executable)
    || new Set(files.map(file => file.path.toLowerCase())).size !== files.length) fail("invalid native helper entrypoint or duplicate member");
  const tree = snapshot(directory), expectedDirectories = new Set();
  for (const file of files) { const parts = file.path.split("/"); for (let count = 1; count < parts.length; count++) expectedDirectories.add(parts.slice(0, count).join("/")); }
  const expected = { directories: [...expectedDirectories].sort(), files: [...files, { path: "manifest.json", ...manifestFact }].sort((a, b) => a.path.localeCompare(b.path)) };
  if (!equal(tree, expected) || fileFact(manifestPath).sha256 !== input.manifestSha256) fail("native helper member set or contents differ from manifest");
  return { directory, tree, manifestSha256: input.manifestSha256, executable: manifest.executable };
}

/** Load the packaged libraries themselves and reject resolution through a parent checkout. */
export function verifyBundledModules(directory, version) {
  const probe = String.raw`
    const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs');
    const {createRequire} = require('node:module'), {pathToFileURL} = require('node:url');
    const root = process.argv[1], version = process.argv[2], local = createRequire(path.join(root, 'artood.mjs'));
    for (const name of ['playwright', 'playwright-core']) {
      const packagePath = local.resolve(name + '/package.json');
      assert.equal(fs.realpathSync(packagePath), fs.realpathSync(path.join(root, 'node_modules', name, 'package.json')));
      assert.equal(local(name + '/package.json').version, version);
      assert.equal(typeof local(name).chromium.launch, 'function');
    }
    const playwrightRequire = createRequire(local.resolve('playwright'));
    assert.equal(playwrightRequire.resolve('playwright-core'), local.resolve('playwright-core'));
    assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'node_modules/playwright-core/browsers.json'), 'utf8')).browsers.length);
    import(pathToFileURL(path.join(root, 'artood.mjs')).href).then(module => {
      assert.equal(typeof module.loadConfigFromEnv, 'function'); process.stdout.write('packaged-runtime-ok\n');
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith("ARTOO_")) delete env[key];
  // Every probe input resolves from the absolute bundle path. Its parent avoids
  // Windows' process current-directory length limit for long staging names.
  const result = spawnSync(process.execPath, ["--input-type=commonjs", "-e", probe, directory, version],
    { cwd: process.platform === "win32" ? dirname(directory) : directory,
      env, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
  if (result.error || result.signal || result.status !== 0 || result.stdout.trim() !== "packaged-runtime-ok") {
    throw new Error(`Daemon bundle runtime resolution failed: ${(result.error?.message ?? result.stderr).slice(0, 2000)}`);
  }
}

function priorDefaultOutput(directory, defaultDirectory) {
  if (!existsSync(directory)) return undefined;
  if (directory !== defaultDirectory) fail("custom output directory must not already exist");
  const tree = snapshot(directory), manifestPath = join(directory, MANIFEST);
  if (existsSync(manifestPath)) {
    const manifest = readJson(manifestPath);
    if (manifest.format !== FORMAT || !equal(snapshot(directory, [MANIFEST]), manifest.tree)) fail("existing daemon output is changed or not a recognized build");
  } else if (tree.directories.length || !tree.files.some(file => file.path === "artood.mjs")
    || tree.files.some(file => !["artood.mjs", "journal-worker.js"].includes(file.path))) {
    fail("existing daemon directory contains unknown files; preserve it and choose a new output directory");
  }
  return tree;
}

// Windows can briefly deny a directory commit while another process has a
// member open without delete sharing. Only the commit's EPERM is retryable.
// This same boundary is exported for the real Windows filesystem regression.
export async function publishStagingDirectory(staging, output, expectedTree) {
  if (process.platform !== "win32") { renameSync(staging, output); return; }
  const original = lstatSync(staging, { bigint: true });
  const identity = () => {
    const current = lstatSync(staging, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== original.dev || current.ino !== original.ino) {
      fail("staging directory identity changed before publish");
    }
    physicalDirectory(staging);
  };
  const missingOutput = () => {
    try { lstatSync(output); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    fail("output appeared before publish retry");
  };
  identity();
  let attempts = 1; const failures = [];
  try { renameSync(staging, output); return; }
  catch (error) { if (error.code !== "EPERM") throw error; failures.push(error); }
  // One monotonic deadline for the entire retry period, never renewed per attempt.
  const deadline = performance.now() + 2000;
  const rejected = () => new AggregateError(failures,
    `Windows bundle publish rename failed after ${attempts} attempt(s); initial ${failures[0].code}: ${failures[0].message}; last: ${failures.at(-1).message}`, { cause: failures[0] });
  for (const delay of [50, 100, 200, 400]) {
    try {
      if (performance.now() + delay >= deadline) fail("Windows publish retry deadline expired");
      await new Promise(resolve => setTimeout(resolve, delay));
      if (performance.now() >= deadline) fail("Windows publish retry deadline expired");
      identity(); missingOutput();
      if (!equal(snapshot(staging), expectedTree)) fail("staging contents changed before publish retry");
      identity(); missingOutput();
      if (performance.now() >= deadline) fail("Windows publish retry deadline expired");
    } catch (error) { failures.push(error); throw rejected(); }
    attempts += 1;
    try { renameSync(staging, output); return; }
    catch (error) {
      failures.push(error);
      if (error.code !== "EPERM") throw rejected();
    }
  }
  throw rejected();
}

/** Construct a fresh, complete bundle before replacing the recognized default build output. */
export async function buildDaemon({ repoRoot = fileURLToPath(new URL("../../..", import.meta.url)), outputDirectory, windowsProcessBundle } = {}) {
  repoRoot = physicalDirectory(repoRoot);
  const defaultDirectory = join(repoRoot, "apps/desktop/daemon");
  outputDirectory = resolve(outputDirectory ?? defaultDirectory);
  const parent = physicalDirectory(dirname(outputDirectory)), name = basename(outputDirectory);
  if (join(parent, name) !== outputDirectory) fail("output parent must use its physical path");
  const lockPath = join(parent, `.${name}.bundle.lock`), lock = openSync(lockPath, "wx", 0o600);
  let stagingDirectory, backupDirectory;
  try {
    const prior = priorDefaultOutput(outputDirectory, defaultDirectory);
    const native = nativeInput(windowsProcessBundle), playwright = playwrightInputs(repoRoot);
    const require = createRequire(join(repoRoot, "apps/desktop/package.json")), { build } = require("esbuild");
    stagingDirectory = join(parent, `.${name}.build-${randomUUID()}`); mkdirSync(stagingDirectory);
    // Explicit CommonJS keeps journal-worker.js and the three CLI .js files
    // executable even when a custom output lives below a type:module package.
    writeFileSync(join(stagingDirectory, "package.json"), JSON.stringify({ private: true, type: "commonjs" }) + "\n", { flag: "wx" });
    const source = join(repoRoot, "apps/artood/src"), verifierSource = join(source, "verification.ts");
    const relocation = { name: "packaged-verifier-path", setup(builder) {
      builder.onLoad({ filter: /[\\/]verification\.ts$/ }, args => {
        if (resolve(args.path) !== verifierSource) return;
        const contents = readFileSync(args.path, "utf8"), expression = 'new URL("../dist/web-acceptance-cli.js", import.meta.url)';
        if (contents.split(expression).length !== 2) fail("verification CLI relocation no longer matches exactly once");
        return { contents: contents.replace(expression, 'new URL("./web-acceptance-cli.js", import.meta.url)'), loader: "ts" };
      });
    } };
    for (const [input, output, format] of ENTRIES) {
      const commonjs = format === "cjs";
      await build({ absWorkingDir: repoRoot, entryPoints: [join(source, input)], outfile: join(stagingDirectory, output),
        bundle: true, platform: "node", format, target: "node24", plugins: [relocation],
        external: ["bufferutil", "utf-8-validate", "playwright", "playwright/*", "playwright-core", "playwright-core/*"],
        ...(commonjs ? { define: { "import.meta.url": "__artooImportMetaUrl" },
          banner: { js: 'const __artooImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' } }
          : { banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } }) });
    }
    mkdirSync(join(stagingDirectory, "node_modules"));
    for (const input of playwright.packages) copySnapshot(input.directory, join(stagingDirectory, "node_modules", input.name), input.tree);
    if (native) {
      mkdirSync(join(stagingDirectory, "native"));
      copySnapshot(native.directory, join(stagingDirectory, "native/windows-process"), native.tree);
    }
    verifyBundledModules(stagingDirectory, playwright.version);
    const manifest = { format: FORMAT, node_target: "node24", playwright_version: playwright.version,
      entries: ENTRIES.map(([, path, format]) => ({ path, format })),
      ...(native ? { windows_process: { directory: "native/windows-process", manifest_sha256: native.manifestSha256, executable: native.executable } } : {}),
      tree: snapshot(stagingDirectory) };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(join(stagingDirectory, MANIFEST), manifestBytes, { flag: "wx" });
    if (prior ? !existsSync(outputDirectory) || !equal(snapshot(outputDirectory), prior) : existsSync(outputDirectory)) fail("output changed during build");
    if (prior) { backupDirectory = join(parent, `.${name}.previous-${randomUUID()}`); renameSync(outputDirectory, backupDirectory); }
    try {
      await publishStagingDirectory(stagingDirectory, outputDirectory, {
        directories: manifest.tree.directories,
        files: [...manifest.tree.files, { path: MANIFEST, size: manifestBytes.length, sha256: sha(manifestBytes) }]
          .sort((a, b) => a.path.localeCompare(b.path)),
      });
    }
    catch (error) {
      if (backupDirectory && !existsSync(outputDirectory)) {
        try { renameSync(backupDirectory, outputDirectory); }
        catch (rollbackError) {
          throw new AggregateError([error, rollbackError],
            `Daemon bundle publish and rollback failed: ${error.message}; rollback: ${rollbackError.message}`, { cause: error });
        }
      }
      throw error;
    }
    return { outputDirectory, ...(backupDirectory ? { backupDirectory } : {}), manifestSha256: sha(manifestBytes), playwrightVersion: playwright.version };
  } catch (error) {
    throw new Error(`Daemon bundle failed; existing output was preserved or retained in its backup. Staging: ${stagingDirectory ?? "not created"}; backup: ${backupDirectory ?? "not created"}. ${error.message}`, { cause: error });
  } finally {
    try {
      const held = fstatSync(lock), named = lstatSync(lockPath);
      if (held.dev !== named.dev || held.ino !== named.ino || !named.isFile() || named.isSymbolicLink()) fail("build lock identity changed; not removing it");
      unlinkSync(lockPath);
    } finally { closeSync(lock); }
  }
}

function argumentsFor(argv) {
  const options = {}, seen = new Set();
  const names = { "--repo-root": "repoRoot", "--output-directory": "outputDirectory", "--windows-process-bundle": "directory",
    "--windows-process-manifest-sha256": "manifestSha256" };
  for (let index = 0; index < argv.length; index += 2) {
    const name = names[argv[index]], value = argv[index + 1];
    if (!name || seen.has(name) || !value || value.startsWith("--")) fail("invalid or duplicate build argument");
    seen.add(name); options[name] = value;
  }
  if (seen.has("directory") !== seen.has("manifestSha256")) fail("native helper directory and manifest digest must be supplied together");
  return { ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}), ...(options.outputDirectory ? { outputDirectory: options.outputDirectory } : {}),
    ...(options.directory ? { windowsProcessBundle: { directory: options.directory, manifestSha256: options.manifestSha256 } } : {}) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildDaemon(argumentsFor(process.argv.slice(2))).then(result => console.log(JSON.stringify(result)), error => { console.error(error.message); process.exitCode = 1; });
}
