// Exercise the real Windows installer against fixed-URL download stubs and controlled
// package entrypoints. This is bootstrap/integrity evidence, not live pairing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = dirname(fileURLToPath(import.meta.url));
const releaseUrl =
  "https://github.com/Xiejiayun/artoo/releases/download/artood-v0.1.0-test.1/jiayunxie-artood-0.1.0-test.1.tgz";
const installerTest = process.platform === "win32" && process.arch === "x64" ? test : test.skip;

function fixture(t, { validNode = false } = {}) {
  const parent = realpathSync(tmpdir()),
    root = mkdtempSync(join(parent, "artoo-bootstrap-"));
  t.after(() => {
    assert.ok(realpathSync(root).startsWith(`${parent}${sep}artoo-bootstrap-`));
    rmSync(root, { recursive: true, force: true });
  });
  const payload = join(root, "payload"),
    bin = join(payload, "package", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "verify.mjs"),
    "import{writeFileSync}from'node:fs';writeFileSync(process.env.FIXTURE_VERIFIED,'verified');",
  );
  writeFileSync(
    join(bin, "artood.mjs"),
    "import{writeFileSync}from'node:fs';writeFileSync(process.env.FIXTURE_OBSERVED,JSON.stringify(process.argv.slice(2)));console.log('Controlled installer target started.');",
  );
  const archive = join(root, "fixture.tgz");
  const tar = join(process.env.SystemRoot, "System32", "tar.exe");
  const packed = spawnSync(tar, ["-czf", archive, "-C", payload, "package"], { encoding: "utf8", windowsHide: true });
  assert.equal(packed.status, 0, packed.stderr);
  const bytes = readFileSync(archive);
  const nodeName = "node-v24.11.1-win-x64.zip";
  const checksum = join(root, "checksums.txt"),
    nodeArchive = join(root, "not-node");
  writeFileSync(checksum, `${"0".repeat(64)}  ${nodeName}\n`);
  writeFileSync(nodeArchive, "This is intentionally not a Node.js release.");
  if (validNode) {
    const nodeDirectory = nodeName.slice(0, -4),
      payload = join(root, "node-payload");
    const binary = join(payload, nodeDirectory, "node.exe");
    mkdirSync(dirname(binary), { recursive: true });
    copyFileSync(process.execPath, binary);
    const archive = join(root, nodeName);
    const packed = spawnSync(tar, ["-a", "-cf", archive, "-C", payload, nodeDirectory], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(packed.status, 0, packed.stderr);
    copyFileSync(archive, nodeArchive);
    writeFileSync(checksum, `${createHash("sha256").update(readFileSync(nodeArchive)).digest("hex")}  ${nodeName}\n`);
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(?:ARTOO_|NODE_OPTIONS$|NODE_PATH$|PSModulePath$)/i.test(key) &&
        !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key),
    ),
  );
  Object.assign(env, {
    ARTOO_HOME: join(root, "state"),
    FIXTURE_ARCHIVE: archive,
    FIXTURE_RELEASE_URL: releaseUrl,
    FIXTURE_NODE: process.execPath,
    FIXTURE_CHECKSUMS: checksum,
    FIXTURE_NODE_ARCHIVE: nodeArchive,
    FIXTURE_NODE_URL: `https://nodejs.org/dist/v24.11.1/${nodeName}`,
    FIXTURE_VERIFIED: join(root, "verified"),
    FIXTURE_OBSERVED: join(root, "observed.json"),
    FIXTURE_WORKSPACE: join(root, "work space 'quoted'"),
  });
  return { root, env, hash: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

function runInstaller(
  item,
  { corruptHash = false, corruptSize = false, noNode = false, powershell, server = "https://artoo.example.test" } = {},
) {
  const script = readFileSync(join(source, "install.ps1"), "utf8")
    .replaceAll("{{PACKAGE_VERSION}}", "0.1.0-test.1")
    .replaceAll("{{PACKAGE_SHA256}}", corruptHash ? "f".repeat(64) : item.hash)
    .replaceAll("{{PACKAGE_SIZE}}", String(item.size + (corruptSize ? 1 : 0)));
  const installer = join(item.root, "install.ps1");
  writeFileSync(installer, script);
  const env = {
    ...item.env,
    FIXTURE_INSTALLER: installer,
    FIXTURE_NO_NODE: noNode ? "1" : "0",
    FIXTURE_SERVER: server,
  };
  const command = powershell || join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
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
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    harness.replace("param($UseBasicParsing,", "param([switch]$UseBasicParsing,"),
  ];
  return spawnSync(command, args, { env, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 128 * 1024 });
}

installerTest("GitHub bootstrap executes only the verified package and preserves literal arguments", (t) => {
  const item = fixture(t),
    result = runInstaller(item);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(item.env.FIXTURE_VERIFIED, "utf8"), "verified");
  assert.deepEqual(JSON.parse(readFileSync(item.env.FIXTURE_OBSERVED, "utf8")), [
    "connect",
    "--server",
    "https://artoo.example.test",
    "--code",
    "ABCD-1234",
    "--workspace",
    item.env.FIXTURE_WORKSPACE,
  ]);
  assert.doesNotMatch(result.stdout + result.stderr, /ABCD-1234/);
});

for (const mismatch of ["hash", "size"])
  installerTest(`GitHub bootstrap rejects a package ${mismatch} mismatch before extraction or execution`, (t) => {
    const item = fixture(t),
      result = runInstaller(item, { corruptHash: mismatch === "hash", corruptSize: mismatch === "size" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /(?:hash|size) mismatch/i);
    assert.equal(existsSync(item.env.FIXTURE_VERIFIED), false);
    assert.equal(existsSync(item.env.FIXTURE_OBSERVED), false);
  });

installerTest("private Node bootstrap rejects official archive checksum mismatch before execution", (t) => {
  const item = fixture(t),
    result = runInstaller(item, { noNode: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hash mismatch/i);
  assert.equal(existsSync(item.env.FIXTURE_VERIFIED), false);
  assert.equal(existsSync(item.env.FIXTURE_OBSERVED), false);
});

installerTest(
  "bootstrap provisions and uses a private Node executable when none is on PATH",
  { timeout: 60_000 },
  (t) => {
    // The official URL is stubbed with this runner's actual Node binary. This
    // qualifies extraction/startup, not the signature or version of a live CDN.
    const item = fixture(t, { validNode: true }),
      result = runInstaller(item, { noNode: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(item.env.FIXTURE_OBSERVED), true);
  },
);

if (existsSync("C:/Program Files/PowerShell/7/pwsh.exe"))
  installerTest("PowerShell 7 runs the same bootstrap with its native ACL API", (t) => {
    const item = fixture(t),
      result = runInstaller(item, { powershell: "C:/Program Files/PowerShell/7/pwsh.exe" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(item.env.FIXTURE_OBSERVED), true);
  });

for (const server of ["http://127.0.0.1:8080", "http://localhost:3000", "http://[::1]:8080"])
  installerTest(`installer permits the loopback development origin ${server}`, (t) => {
    const item = fixture(t),
      result = runInstaller(item, { server });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(item.env.FIXTURE_OBSERVED), true);
  });

for (const server of [
  "http://remote.test",
  "https://user:pass@remote.test",
  "https://remote.test/path",
  "https://remote.test/?token=private",
  "https://remote.test/#fragment",
])
  installerTest(
    "installer rejects unsafe website origins before executing the package: " + server.replace(/\?.*/, "?…"),
    (t) => {
      const item = fixture(t),
        result = runInstaller(item, { server });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /HTTPS website origin/);
      assert.equal(existsSync(item.env.FIXTURE_VERIFIED), false);
      assert.equal(existsSync(item.env.FIXTURE_OBSERVED), false);
    },
  );
