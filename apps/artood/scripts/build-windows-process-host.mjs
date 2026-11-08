import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const nativeDist = path.join(packageRoot, 'native-dist');
const project = path.join(packageRoot, 'native', 'windows-process-host', 'Artoo.WindowsProcessHost.csproj');
const executable = 'Artoo.WindowsProcessHost.exe';
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function parseArguments() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return null;
  if (args.length === 0) return path.join(nativeDist, 'windows-process-host');
  if (args.length === 2 && args[0] === '--out-dir' && args[1]) return path.resolve(args[1]);
  throw new Error('Usage: build-windows-process-host.mjs [--out-dir <new directory>]');
}

async function runDotnet(args, capture = false) {
  const child = spawn('dotnet', args, { cwd: path.dirname(project), shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
  let spawnObserved = false, exitObserved = false, exitCode, exitSignal, ioError;
  const output = [];
  let captured = 0;
  child.once('spawn', () => { spawnObserved = true; });
  child.once('error', error => { ioError = error; });
  child.once('exit', (code, signal) => { exitObserved = true; exitCode = code; exitSignal = signal; });
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.on('error', error => { ioError = error; });
    stream.on('data', bytes => {
      if (!capture) destination.write(bytes);
      else if (captured < 65536) {
        const take = bytes.subarray(0, 65536 - captured); output.push(Buffer.from(take)); captured += take.length;
      }
    });
  }
  const closed = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  if (!spawnObserved || !exitObserved || exitCode !== 0 || exitSignal !== null || closed.code !== 0 || closed.signal !== null || ioError) {
    throw new Error(ioError?.code === 'ENOENT'
      ? 'Install the .NET 10 SDK to build the Windows process host.'
      : `dotnet ${args[0]} failed${exitCode === undefined ? '' : ` (exit ${exitCode})`}. No usable manifest was created.`);
  }
  return Buffer.concat(output).toString('utf8');
}

async function inventory(directory, prefix = '') {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    if (name.includes('\\') || name.includes(':')) throw new Error('Invalid published bundle member.');
    const absolute = path.join(directory, name), member = prefix + name;
    const before = await lstat(absolute);
    if (before.isSymbolicLink()) throw new Error('Published bundle must not contain links.');
    if (before.isDirectory()) files.push(...await inventory(absolute, `${member}/`));
    else {
      if (!before.isFile() || before.nlink !== 1) throw new Error('Published bundle member is not an unlinked regular file.');
      const bytes = await readFile(absolute), after = await lstat(absolute);
      if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || before.ino !== after.ino
        || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
        throw new Error('Published bundle changed while its hashes were being recorded.');
      }
      files.push({ path: member, size: bytes.length, sha256: digest(bytes) });
    }
  }
  return files;
}

async function build(outputArgument) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build the win-x64 process host on 64-bit Windows.');
  try { await lstat(outputArgument); throw new Error(`Output already exists: ${outputArgument}. Choose a new --out-dir to preserve existing bundles.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sdkVersion = (await runDotnet(['--version'], true)).trim();
  if (!/^10\.0\.\d+$/.test(sdkVersion)) throw new Error('A stable .NET 10 SDK is required to build the Windows process host.');

  await mkdir(path.dirname(outputArgument), { recursive: true });
  const output = path.join(await realpath(path.dirname(outputArgument)), path.basename(outputArgument));
  await mkdir(output); // Exclusive fresh directory; never replace a locally installed or previous bundle.
  const intermediateRoot = path.join(nativeDist, '.build');
  await mkdir(intermediateRoot, { recursive: true });
  const intermediate = await mkdtemp(path.join(intermediateRoot, 'windows-process-host-'));
  const manifestPath = path.join(output, 'manifest.json');
  const temporaryManifest = path.join(output, `.manifest-${randomUUID()}.tmp`);
  try {
    await runDotnet(['publish', project, '--configuration', 'Release', '--runtime', 'win-x64',
      '--self-contained', 'true', '--output', output, '--artifacts-path', intermediate, '--disable-build-servers',
      '-p:UseAppHost=true', '-p:PublishSingleFile=true', '-p:IncludeNativeLibrariesForSelfExtract=false',
      '-p:PublishTrimmed=false', '-p:ContinuousIntegrationBuild=true', '-p:Deterministic=true']);
    const files = await inventory(output);
    if (!files.some(file => file.path === executable)
      || files.some(file => file.path.toLowerCase() === 'manifest.json')
      || new Set(files.map(file => file.path.toLowerCase())).size !== files.length) {
      throw new Error('Unexpected published Windows process host layout.');
    }
    // These are fixed modes in this source build, not verification or recovery verdicts.
    // Old bundles without the modes remain usable for ordinary process execution only.
    const manifest = { version: 1, protocol: 'artoo.windows-job-process.v1', runtime: 'win-x64', executable, files,
      capabilities: ['artoo.windows-runtime-guardian.v1', 'artoo.windows-daemon-supervisor.v1', 'artoo.windows-job-member-observation.v1', 'artoo.windows-daemon-supervisor-lifetime.v1', 'artoo.windows-target-input.v1'] };
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    // Publish the only admission manifest last, after actual SDK exit/close and complete inventory.
    // A failed/interrupted build before this atomic rename has no usable manifest.json.
    const file = await open(temporaryManifest, 'wx');
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporaryManifest, manifestPath);
    process.stdout.write(`${JSON.stringify({ output, sdkVersion, runtime: 'win-x64', selfContained: true,
      manifestSha256: digest(bytes), files: files.length, bundleBytes: files.reduce((total, file) => total + file.size, 0) })}\n`);
  } catch (error) {
    // Both names belong to this freshly created output. Remove even an unexpected manifest that
    // MSBuild copied before failing, so partial output cannot inherit a usable admission record.
    for (const candidate of [temporaryManifest, manifestPath]) {
      try { await unlink(candidate); }
      catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') throw new Error(`Build failed and its manifest could not be removed: ${candidate}`, { cause: error });
      }
    }
    throw error;
  }
}

try {
  const output = parseArguments();
  if (output === null) {
    process.stdout.write('Build a self-contained win-x64 process host with the .NET 10 SDK.\n'
      + 'Usage: node scripts/build-windows-process-host.mjs [--out-dir <new directory>]\n'
      + `Default output: ${path.join(nativeDist, 'windows-process-host')}\n`
      + 'Existing output directories are never replaced. SDK intermediate files remain under native-dist/.build.\n');
  } else await build(output);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Windows process host build failed.'}\n`);
  process.exitCode = 1;
}
