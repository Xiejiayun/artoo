// Exercise the real installers against fixed-URL download stubs and controlled
// package entrypoints. This is bootstrap/integrity evidence, not live pairing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = dirname(fileURLToPath(import.meta.url));
const releaseUrl = "https://github.com/Xiejiayun/artoo/releases/download/artood-v0.1.0-test.1/jiayunxie-artood-0.1.0-test.1.tgz";
const win = process.platform === "win32";
const platforms = new Set(["win32-x64", "linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]);

function fixture(t, { validNode = false } = {}) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, "artoo-bootstrap-"));
  t.after(() => { assert.ok(realpathSync(root).startsWith(`${parent}${sep}artoo-bootstrap-`)); rmSync(root, { recursive: true, force: true }); });
  const payload = join(root, "payload"), bin = join(payload, "package", "bin"); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "verify.mjs"), "import{writeFileSync}from'node:fs';writeFileSync(process.env.FIXTURE_VERIFIED,'verified');");
  writeFileSync(join(bin, "artood.mjs"), "import{writeFileSync}from'node:fs';writeFileSync(process.env.FIXTURE_OBSERVED,JSON.stringify(process.argv.slice(2)));console.log('Controlled installer target started.');");
  const archive = join(root, "fixture.tgz");
  const tar = win ? join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
  const packed = spawnSync(tar, ["-czf", archive, "-C", payload, "package"], { encoding: "utf8", windowsHide: true });
  assert.equal(packed.status, 0, packed.stderr);
  const bytes = readFileSync(archive);
  const nodePlatform = { win32: "win", linux: "linux", darwin: "darwin" }[process.platform];
  const nodeName = `node-v24.11.1-${nodePlatform}-${process.arch}.${win ? "zip" : "tar.gz"}`;
  const checksum = join(root, "checksums.txt"), nodeArchive = join(root, "not-node");
  writeFileSync(checksum, `${"0".repeat(64)}  ${nodeName}\n`); writeFileSync(nodeArchive, "This is intentionally not a Node.js release.");
  if (validNode) {
    const nodeDirectory = nodeName.replace(/\.(?:zip|tar\.gz)$/, ""), payload = join(root, "node-payload");
    const binary = join(payload, nodeDirectory, ...(win ? ["node.exe"] : ["bin", "node"]));
    mkdirSync(dirname(binary), { recursive: true }); copyFileSync(process.execPath, binary); chmodSync(binary, 0o700);
    const archive = join(root, nodeName);
    const packed = spawnSync(tar, [...(win ? ["-a", "-cf"] : ["-czf"]), archive, "-C", payload, nodeDirectory], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.equal(packed.status, 0, packed.stderr);
    copyFileSync(archive, nodeArchive);
    writeFileSync(checksum, `${createHash("sha256").update(readFileSync(nodeArchive)).digest("hex")}  ${nodeName}\n`);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:ARTOO_|NODE_OPTIONS$|NODE_PATH$|PSModulePath$)/i.test(key) && !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)));
  Object.assign(env, { ARTOO_HOME: join(root, "state"), FIXTURE_ARCHIVE: archive, FIXTURE_RELEASE_URL: releaseUrl,
    FIXTURE_NODE: process.execPath, FIXTURE_CHECKSUMS: checksum, FIXTURE_NODE_ARCHIVE: nodeArchive,
    FIXTURE_NODE_URL: `https://nodejs.org/dist/v24.11.1/${nodeName}`, FIXTURE_VERIFIED: join(root, "verified"),
    FIXTURE_OBSERVED: join(root, "observed.json"), FIXTURE_WORKSPACE: join(root, "work space 'quoted'") });
  return { root, env, hash: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

function runInstaller(item, { corruptHash = false, corruptSize = false, noNode = false, powershell, server = "https://artoo.example.test" } = {}) {
  const script = readFileSync(join(source, win ? "install.ps1" : "install.sh"), "utf8")
    .replaceAll("{{PACKAGE_VERSION}}", "0.1.0-test.1")
    .replaceAll("{{PACKAGE_SHA256}}", corruptHash ? "f".repeat(64) : item.hash)
    .replaceAll("{{PACKAGE_SIZE}}", String(item.size + (corruptSize ? 1 : 0)));
  const installer = join(item.root, win ? "install.ps1" : "install.sh"); writeFileSync(installer, script);
  const env = { ...item.env, FIXTURE_INSTALLER: installer, FIXTURE_NO_NODE: noNode ? "1" : "0", FIXTURE_SERVER: server };
  let command, args;
  if (win) {
    command = powershell || join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const harness = `
$ErrorActionPreference='Stop'
function Get-Command { param($Name,$CommandType,$ErrorAction)
  if ($Name -ne 'node.exe') { throw 'Unexpected command discovery in fixture' }
  if ($env:FIXTURE_NO_NODE -ne '1') { [pscustomobject]@{Source=$env:FIXTURE_NODE} }
}
function Invoke-WebRequest { param($UseBasicParsing,$Uri,$OutFile,$MaximumRedirection)
  if ($Uri -eq $env:FIXTURE_RELEASE_URL) { $from=$env:FIXTURE_ARCHIVE }
  elseif ($Uri -eq 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt') { $from=$env:FIXTURE_CHECKSUMS }
  elseif ($Uri -eq $env:FIXTURE_NODE_URL) { $from=$env:FIXTURE_NODE_ARCHIVE }
  else { throw 'Unexpected download URL in fixture' }
  [IO.File]::Copy($from,$OutFile)
}
& ([scriptblock]::Create([IO.File]::ReadAllText($env:FIXTURE_INSTALLER))) -Server $env:FIXTURE_SERVER -Code 'ABCD-1234' -Workspace $env:FIXTURE_WORKSPACE
`;
    // Switch binding must match Invoke-WebRequest, so no download falls through.
    args = ["-NoProfile", "-NonInteractive", "-Command", harness.replace("param($UseBasicParsing,", "param([switch]$UseBasicParsing,")];
  } else {
    const bin = join(item.root, "commands"); mkdirSync(bin);
    const curl = `#!/bin/sh
set -eu
out='' url=''
while [ "$#" -gt 0 ]; do
  case "$1" in --output) out=$2; shift 2 ;; --proto|--proto-redir|--tlsv1.2) if [ "$1" = --tlsv1.2 ]; then shift; else shift 2; fi ;; --*) shift ;; *) url=$1; shift ;; esac
done
case "$url" in
  "$FIXTURE_RELEASE_URL") from=$FIXTURE_ARCHIVE ;;
  'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt') from=$FIXTURE_CHECKSUMS ;;
  "$FIXTURE_NODE_URL") from=$FIXTURE_NODE_ARCHIVE ;;
  *) printf '%s\\n' 'Unexpected fixture download' >&2; exit 1 ;;
esac
cp "$from" "$out"
`;
    writeFileSync(join(bin, "curl"), curl); chmodSync(join(bin, "curl"), 0o700);
    if (noNode) { writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, "node"), 0o700); }
    env.PATH = bin + delimiter + env.PATH;
    command = "/bin/sh"; args = [installer, "--server", server, "--code", "ABCD-1234", "--workspace", env.FIXTURE_WORKSPACE];
  }
  return spawnSync(command, args, { env, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024 });
}

test("GitHub bootstrap executes only the verified package and preserves literal arguments", { skip: !platforms.has(`${process.platform}-${process.arch}`) }, t => {
  const item = fixture(t), result = runInstaller(item);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(item.env.FIXTURE_VERIFIED, "utf8"), "verified");
  assert.deepEqual(JSON.parse(readFileSync(item.env.FIXTURE_OBSERVED, "utf8")),
    ["connect", "--server", "https://artoo.example.test", "--code", "ABCD-1234", "--workspace", item.env.FIXTURE_WORKSPACE]);
  assert.doesNotMatch(result.stdout + result.stderr, /ABCD-1234/);
});

for (const mismatch of ["hash", "size"]) test(`GitHub bootstrap rejects a package ${mismatch} mismatch before extraction or execution`, t => {
  const item = fixture(t), result = runInstaller(item, { corruptHash: mismatch === "hash", corruptSize: mismatch === "size" });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /(?:hash|size) mismatch/i);
  assert.equal(existsSync(item.env.FIXTURE_VERIFIED), false); assert.equal(existsSync(item.env.FIXTURE_OBSERVED), false);
});

test("private Node bootstrap rejects official archive checksum mismatch before execution", t => {
  const item = fixture(t), result = runInstaller(item, { noNode: true });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /hash mismatch/i);
  assert.equal(existsSync(item.env.FIXTURE_VERIFIED), false); assert.equal(existsSync(item.env.FIXTURE_OBSERVED), false);
});

test("bootstrap provisions and uses a private Node executable when none is on PATH", { timeout: 60_000 }, t => {
  // The official URL is stubbed with this runner's actual Node binary. This
  // qualifies extraction/startup, not the signature or version of a live CDN.
  const item = fixture(t, { validNode: true }), result = runInstaller(item, { noNode: true });
  assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(item.env.FIXTURE_OBSERVED), true);
});

if (win && existsSync("C:/Program Files/PowerShell/7/pwsh.exe")) test("PowerShell 7 runs the same bootstrap with its native ACL API", t => {
  const item = fixture(t), result = runInstaller(item, { powershell: "C:/Program Files/PowerShell/7/pwsh.exe" });
  assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(item.env.FIXTURE_OBSERVED), true);
});

for (const server of ["http://127.0.0.1:8080", "http://localhost:3000", "http://[::1]:8080"])
  test(`installer permits the loopback development origin ${server}`, t => {
    const item = fixture(t), result = runInstaller(item, { server });
    assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(item.env.FIXTURE_OBSERVED), true);
  });

for (const server of ["http://remote.test", "https://user:pass@remote.test", "https://remote.test/path", "https://remote.test/?token=private", "https://remote.test/#fragment"])
  test("installer rejects unsafe website origins before executing the package: " + server.replace(/\?.*/, "?…"), t => {
    const item = fixture(t), result = runInstaller(item, { server });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /HTTPS website origin/);
    assert.equal(existsSync(item.env.FIXTURE_VERIFIED), false); assert.equal(existsSync(item.env.FIXTURE_OBSERVED), false);
  });
