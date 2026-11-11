import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { connectComputer, parseConnectArguments, savedConnectionEnvironment } from "./onboarding.mjs";
import { assertPrivateProviderKeyFile, connectionEnvironment, loadConnection, prepareWorkspace, protectDirectory, saveConnection, serverOrigin, validateConnection } from "./local-config.mjs";
import { managedStatus, startManaged, stopManaged } from "./managed.mjs";
import { launchManagedRuntime, runCli } from "./cli.mjs";
import { managedConnectionEnvironment, teamConfigurationEnvironment, validateTeamConfiguration } from "./team-config.mjs";
import { readRelease } from "./verify.mjs";

const source = dirname(fileURLToPath(import.meta.url));
const connection = root => ({ version: 1, origin: "https://artoo.example.test", deviceId: "device_test", computerId: "computer_test",
  nodeToken: "fixture-node-token-123456789", controlToken: null, roots: [root], runtimes: ["codex"], codexBinary: null });
function temporary(t, beforeRemove = async () => {}) {
  // Hosted Windows TEMP can use an 8.3 name. Prepare genuine physical paths for
  // the same strict configuration admission that production uses.
  const parent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(parent, "artoo-onboarding-")));
  t.after(async () => { await beforeRemove(); assert.ok(realpathSync.native(root).startsWith(`${parent}${sep}artoo-onboarding-`)); rmSync(root, { recursive: true, force: true }); });
  return root;
}

test("connect options require a short-lived code and a safe server origin", () => {
  assert.deepEqual(parseConnectArguments(["--server", "https://artoo.example.test", "--code", "abcd-1234"]), { server: "https://artoo.example.test", code: "ABCD-1234" });
  for (const origin of ["http://remote.test", "https://user:pass@remote.test", "https://remote.test/path", "https://remote.test/?token=secret"])
    assert.throws(() => serverOrigin(origin), /HTTPS website origin/);
  assert.equal(serverOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.throws(() => parseConnectArguments(["--server", "https://a.test", "--code", "ABCD-1234", "--code", "WXYZ-5678"]), /Invalid connect/);
  assert.throws(() => parseConnectArguments(["--server", "https://a.test", "--token", "long-lived-secret"]), /Invalid connect/);
});

test("saved credentials round-trip without entering process.env and protect their file", t => {
  const root = temporary(t), state = join(root, "state"), workspace = join(root, "workspace"); mkdirSync(workspace);
  const original = process.env.ARTOO_NODE_URL;
  saveConnection(state, connection(workspace));
  assert.deepEqual(loadConnection(state), connection(workspace));
  assert.equal(process.env.ARTOO_NODE_URL, original);
  if (process.platform === "win32") assert.equal(readFileSync(join(state, "connection.dat")).includes(Buffer.from("fixture-node-token")), false);
  else assert.equal(statSync(join(state, "connection.dat")).mode & 0o077, 0);
  const env = connectionEnvironment(connection(workspace), { PATH: "/bin", ARTOO_OLD_SETTING: "must-not-survive" });
  assert.equal(env.ARTOO_NODE_ID, "computer_test"); assert.equal(env.ARTOO_OLD_SETTING, undefined);
  assert.match(env.ARTOO_NODE_URL, /^wss:\/\/artoo\.example\.test\/api\/v1\/node\?token=/);
  assert.equal(connectionEnvironment({ ...connection(workspace), runtimes: [] }, {}).ARTOO_RUNTIMES, "none", "Missing CLIs must never become advertised default runtimes.");
});

test("agent workspaces cannot include credentials or package files", t => {
  const root = temporary(t), state = protectDirectory(join(root, "state")), packageDirectory = join(root, "package"); mkdirSync(packageDirectory);
  assert.throws(() => prepareWorkspace(root, state, packageDirectory), /outside/);
  assert.throws(() => prepareWorkspace(join(state, "workspace"), state, packageDirectory), /outside/);
  assert.throws(() => prepareWorkspace(packageDirectory, state, packageDirectory), /outside/);
  for (const name of ["work,projects", "work;projects"]) {
    const unsafe = join(root, name);
    assert.throws(() => prepareWorkspace(unsafe, state, packageDirectory), /commas, semicolons/);
    assert.throws(() => validateConnection(connection(unsafe)), /connection is invalid/);
    assert.equal(existsSync(unsafe), false, "Ambiguous roots must be rejected before creating a directory.");
  }
  const physical = join(root, "actual,root"), linked = join(root, "alias"); mkdirSync(physical);
  symlinkSync(physical, linked, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => prepareWorkspace(linked, state, packageDirectory), /resolves to a path containing commas/);
  assert.equal(prepareWorkspace(join(root, "workspace"), state, packageDirectory), realpathSync(join(root, "workspace")));
});

test("one command claims, protects, enrolls and starts the same device without printing credentials", async t => {
  const root = temporary(t), state = join(root, "state"), workspace = join(root, "work"), packageDirectory = controlledPackage(root, join(root, "unused.json"));
  const calls = [], token = "fixture-node-token-123456789", control = "fixture-control-token-123456789";
  let output = "", started;
  const fetchImpl = async (url, options) => {
    calls.push(url.pathname);
    if (url.pathname.endsWith("/claim")) {
      assert.deepEqual(JSON.parse(options.body), { code: "ABCD-1234", platform: { win32: "windows", darwin: "macos", linux: "linux" }[process.platform], app_version: "0.1.0-test.1", display_name: "Fixture computer" });
      return Response.json({ device: { id: "device_test" }, node_token: token, control_token: control }, { status: 201 });
    }
    assert.equal(loadConnection(state).nodeToken, token, "Claim must be saved before enrollment.");
    assert.equal(options.headers.authorization, `Bearer ${control}`);
    return Response.json({ device_id: "device_test", computer_id: "computer_test" });
  };
  await connectComputer({ args: ["--server", "https://artoo.example.test", "--code", "ABCD-1234", "--workspace", workspace, "--name", "Fixture computer"],
    env: { ARTOO_HOME: state, PATH: "" }, packageDirectory, metadata: { version: "0.1.0-test.1" }, fetchImpl,
    output: text => { output += text; }, start: async value => { started = value; } });
  assert.deepEqual(calls, ["/api/v1/devices/claim", "/api/v1/devices/device_test/enroll"]);
  assert.equal(loadConnection(state).computerId, "computer_test"); assert.equal(loadConnection(state).controlToken, null);
  assert.equal(started.directory, state); assert.equal(output.includes(token) || output.includes(control) || output.includes("ABCD-1234"), false);
  await connectComputer({ args: ["--server", "https://artoo.example.test", "--code", "WXYZ-5678"],
    env: { ARTOO_HOME: state, PATH: "" }, packageDirectory, metadata: { version: "0.1.0-test.1" },
    fetchImpl: async () => { throw Error("A saved identity must not consume another pairing code."); }, start: async () => {} });
  assert.equal(loadConnection(state).deviceId, "device_test");
});

test("member enrollment waits for an administrator and resumes the saved identity", async t => {
  const root = temporary(t), state = join(root, "state"), workspace = join(root, "work"), packageDirectory = controlledPackage(root, join(root, "unused.json"));
  let claims = 0, enrolled = false;
  const fetchImpl = async url => {
    if (url.pathname.endsWith("/claim")) { claims++; return Response.json({ device: { id: "device_test" }, node_token: "fixture-node-token-123456789", control_token: "fixture-control-token-123456789" }); }
    if (url.pathname.endsWith("/enroll")) return new Response(null, { status: 403 });
    assert.equal(url.pathname, "/api/v1/devices");
    return Response.json({ devices: [{ id: "device_test", computer_id: enrolled ? "computer_test" : null }] });
  };
  await assert.rejects(connectComputer({ args: ["--server", "https://artoo.example.test", "--code", "ABCD-1234", "--workspace", workspace],
    env: { ARTOO_HOME: state, PATH: "" }, packageDirectory, metadata: { version: "0.1.0-test.1" }, fetchImpl }), /Ask an owner\/admin/);
  assert.equal(loadConnection(state).computerId, null);
  enrolled = true;
  const saved = await savedConnectionEnvironment({ ARTOO_HOME: state, PATH: "" }, { fetchImpl });
  assert.equal(claims, 1); assert.equal(saved.connection.computerId, "computer_test"); assert.equal(saved.connection.controlToken, null);
});

test("interrupted enrollment retains one identity and resumes without another claim", async t => {
  const root = temporary(t), state = join(root, "state"), workspace = join(root, "work"), packageDirectory = controlledPackage(root, join(root, "unused.json"));
  let claims = 0;
  const fetchImpl = async url => {
    if (url.pathname.endsWith("/claim")) { claims++; return Response.json({ device: { id: "device_test" }, node_token: "fixture-node-token-123456789", control_token: "fixture-control-token-123456789" }); }
    return new Response("server failure containing private data", { status: 503 });
  };
  await assert.rejects(connectComputer({ args: ["--server", "https://artoo.example.test", "--code", "ABCD-1234", "--workspace", workspace],
    env: { ARTOO_HOME: state, PATH: "" }, packageDirectory, metadata: { version: "0.1.0-test.1" }, fetchImpl }), /HTTP 503/);
  assert.equal(loadConnection(state).deviceId, "device_test");
  const saved = await savedConnectionEnvironment({ ARTOO_HOME: state, PATH: "" }, { fetchImpl: async url => {
    assert.match(url.pathname, /device_test\/enroll$/); return Response.json({ device_id: "device_test", computer_id: "computer_test" });
  } });
  assert.equal(claims, 1); assert.equal(saved.connection.computerId, "computer_test");
});

function controlledPackage(root, observation) {
  const packageDirectory = join(root, "npm-cache"), runtime = join(packageDirectory, "runtime"), bin = join(packageDirectory, "bin");
  mkdirSync(bin, { recursive: true }); mkdirSync(runtime);
  for (const file of ["cli.mjs", "verify.mjs", "platforms.mjs", "local-config.mjs", "managed.mjs", "onboarding.mjs", "team-config.mjs"])
    copyFileSync(join(source, file), join(bin, file === "cli.mjs" ? "artood.mjs" : file));
  const files = new Map([["artood.mjs", `import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
export function loadConfigFromEnv(env) {
  if(env.ARTOO_VERIFICATION_PROFILES_FILE && readFileSync(env.ARTOO_VERIFICATION_PROFILES_FILE,'utf8')==='reject')
    throw Error('Controlled profile qualification failed');
  return env;
}
export async function runDaemonEntrypoint(env) {
  loadConfigFromEnv(env);
  const child=spawnSync(process.execPath,['-e','process.stdout.write(JSON.stringify({home:process.env.CODEX_HOME,provider:!!process.env.ARTOO_CODEX_PROVIDER_KEY}))'],{encoding:'utf8',windowsHide:true});
  if(child.error||child.status!==0) throw Error('Controlled model environment probe failed');
  writeFileSync(${JSON.stringify(observation)}, JSON.stringify({node:env.ARTOO_NODE_ID,inherited:process.env.ARTOO_NODE_URL??null,entry:import.meta.url,
    research:env.ARTOO_RESEARCH_ENABLED,receipts:env.ARTOO_RESEARCH_RECEIPTS_DIR,profiles:env.ARTOO_VERIFICATION_PROFILES_FILE,
    initialize:env.ARTOO_INITIALIZE_REPOSITORY,native:env.ARTOO_WINDOWS_PROCESS_BUNDLE,pin:env.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256,
    model:env.ARTOO_CODEX_MODEL,provider:env.ARTOO_CODEX_PROVIDER_URL,providerSelected:!!env.ARTOO_CODEX_PROVIDER_KEY,
    providerInherited:!!env.ARTOO_CODEX_PROVIDER_KEY && process.env.ARTOO_CODEX_PROVIDER_KEY===env.ARTOO_CODEX_PROVIDER_KEY,
    providerInArgv:!!env.ARTOO_CODEX_PROVIDER_KEY && process.argv.some(arg=>arg.includes(env.ARTOO_CODEX_PROVIDER_KEY)),
    codexHome:env.CODEX_HOME,modelEnvironment:JSON.parse(child.stdout),
    inheritedSettings:Object.keys(process.env).filter(key=>/^ARTOO_|^(?:NODE_OPTIONS|NODE_PATH)$/i.test(key))}));
  const timer=setInterval(()=>{},1000);
  const node={stop:async()=>clearInterval(timer)};
  process.on('SIGTERM',async()=>{await node.stop();writeFileSync(${JSON.stringify(observation + ".stopped")},JSON.stringify({providerPresent:!!process.env.ARTOO_CODEX_PROVIDER_KEY}));process.exit(0)});
  return node;
}`]]);
  const directories = ["node_modules"];
  for (const name of ["playwright", "playwright-core"]) {
    directories.push(`node_modules/${name}`);
    files.set(`node_modules/${name}/package.json`, JSON.stringify({name,version:"0.0.0-test",main:"index.cjs"}));
    files.set(`node_modules/${name}/index.cjs`, "module.exports={chromium:{launch(){}}};");
  }
  for (const directory of directories) mkdirSync(join(runtime, directory), { recursive: true });
  for (const [file, contents] of files) writeFileSync(join(runtime, file), contents);
  const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const manifest = JSON.stringify({format:"artoo.desktop-daemon.v1",node_target:"node24",playwright_version:"0.0.0-test",
    windows_process:{directory:"native/windows-process",manifest_sha256:`sha256:${"b".repeat(64)}`},
    tree:{directories,files:[...files].map(([path,contents])=>({path,size:Buffer.byteLength(contents),sha256:digest(contents)}))}});
  writeFileSync(join(runtime,"bundle-manifest.json"),manifest);
  writeFileSync(join(packageDirectory,"package.json"),JSON.stringify({name:"controlled-artood",version:"0.1.0-test.1",type:"module",artoo:{format:"artoo.npm-daemon.v1",runtimeManifestSha256:digest(manifest)}}));
  return packageDirectory;
}

test("background start retains installation, authenticates control, restarts without cache and stops normally", { timeout: 60_000 }, async t => {
  let state;
  const root = temporary(t, async () => { if (state) await stopManaged(state); });
  state = protectDirectory(join(root,"state"));
  const workspace = join(root,"workspace"), observation = join(root,"observation.json"); mkdirSync(workspace);
  saveConnection(state, connection(workspace));
  const packageDirectory = controlledPackage(root,observation);
  const status = await startManaged({directory:state,packageDirectory,env:{...process.env,ARTOO_NODE_URL:"must-not-inherit"}});
  assert.equal(status.status,"running");
  const observed = JSON.parse(readFileSync(observation,"utf8"));
  assert.equal(observed.node,"computer_test"); assert.equal(observed.inherited,null);
  assert.ok(observed.entry.includes("releases/"));
  assert.equal((await managedStatus(state)).pid,status.pid);
  const record = JSON.parse(readFileSync(join(state,"running.json"),"utf8"));
  assert.equal((await fetch(`http://127.0.0.1:${record.port}/stop`, {method:"POST",headers:{authorization:"Bearer wrong"}})).status,403);
  assert.equal((await managedStatus(state)).status,"running");
  const again = await startManaged({directory:state,packageDirectory}); assert.equal(again.pid,status.pid);
  // The original npm cache may disappear; the running daemon uses its retained copy.
  assert.ok(realpathSync(packageDirectory).startsWith(realpathSync(root)+sep)); rmSync(packageDirectory,{recursive:true});
  assert.equal((await managedStatus(state)).status,"running");
  await stopManaged(state);
  assert.equal((await managedStatus(state)).status,"stopped");
  assert.ok(existsSync(join(state,"connection.dat")));
  const retained = dirname(dirname(fileURLToPath(observed.entry)));
  const restarted = await startManaged({directory:state,packageDirectory:retained});
  assert.equal(restarted.status,"running"); assert.notEqual(restarted.pid,status.pid);
  await stopManaged(state);
});

function teamFixture(t, { stop = false } = {}) {
  let state;
  const root = temporary(t, async () => { if (stop && state) await stopManaged(state); });
  state = join(root, "state");
  const workspace = join(root, "workspace"), control = join(root, "control");
  mkdirSync(workspace); mkdirSync(control);
  const receipts = join(control, "receipts"), profiles = join(control, "profiles.json"), file = join(control, "team.json");
  mkdirSync(receipts); writeFileSync(profiles, "[]", { mode: 0o600 });
  const configuration = { version: 1, research_receipts_directory: receipts, verification_profiles_file: profiles, initialize_repository: true };
  writeFileSync(file, JSON.stringify(configuration), { mode: 0o600 });
  const observation = join(root, "observation.json"), packageDirectory = controlledPackage(root, observation);
  saveConnection(state, connection(workspace));
  return { root, state, workspace, control, receipts, profiles, file, configuration, observation, packageDirectory };
}

test("protected configuration fixtures use the physical temporary directory even through a Windows short name", async t => {
  const outer = temporary(t), physical = join(outer, "long temporary directory"); mkdirSync(physical);
  let selected = physical;
  if (process.platform === "win32") {
    // Read an existing 8.3 alias; never change the volume's short-name settings.
    const script = 'Add-Type -TypeDefinition \'using System; using System.Text; using System.Runtime.InteropServices; public static class ArtooTempShortPath { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="GetShortPathNameW")] public static extern uint Get(string path, StringBuilder output, uint length); }\'; '
      + '$buffer=[Text.StringBuilder]::new(32768);$length=[ArtooTempShortPath]::Get($env:ARTOO_NPM_TEST_SHORT_PATH,$buffer,$buffer.Capacity);'
      + 'if($length -eq 0 -or $length -ge $buffer.Capacity){throw "GetShortPathNameW failed"};[Console]::Write($buffer.ToString())';
    const alias = spawnSync(join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { env: { ...process.env, ARTOO_NPM_TEST_SHORT_PATH: physical }, encoding: "utf8", timeout: 15_000, windowsHide: true });
    assert.ifError(alias.error); assert.equal(alias.status, 0, alias.stderr); assert.equal(alias.signal, null);
    selected = alias.stdout;
    assert.equal(realpathSync.native(selected), realpathSync.native(physical));
    t.diagnostic(selected.toLowerCase() !== realpathSync.native(physical).toLowerCase()
      ? "Actual Windows 8.3 temporary-directory alias exercised."
      : "This volume returned its long path; physical temporary-directory preparation is still exercised.");
  }
  await t.test("the selected temporary path supports protected configuration without relaxing admission", async child => {
    const variables = ["TMPDIR", "TEMP", "TMP"], original = new Map(variables.map(key => [key, process.env[key]]));
    let fixture;
    try {
      for (const key of variables) process.env[key] = selected;
      fixture = teamFixture(child);
    } finally {
      for (const [key, value] of original) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    await runCli({ args: ["configure", "--file", fixture.file], env: { ARTOO_HOME: fixture.state }, packageDirectory: fixture.packageDirectory, output: () => {} });
    assert.equal(fixture.root, realpathSync.native(fixture.root));
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.state, "team-config.json"), "utf8")), fixture.configuration);
  });
});

test("configure saves only explicit local team settings after controlled preflight without changing identity", async t => {
  const fixture = teamFixture(t), before = readFileSync(join(fixture.state, "connection.dat"));
  let output = "";
  const configured = await runCli({ args: ["configure", "--file", fixture.file], env: { ARTOO_HOME: fixture.state },
    packageDirectory: fixture.packageDirectory, output: value => { output += value; } });
  assert.deepEqual(configured, { configured: true });
  assert.deepEqual(JSON.parse(readFileSync(join(fixture.state, "team-config.json"), "utf8")), fixture.configuration);
  assert.deepEqual(readFileSync(join(fixture.state, "connection.dat")), before);
  assert.equal(existsSync(fixture.observation), false, "Preflight must not start a node or model.");
  assert.match(output, /Stop and start/); assert.doesNotMatch(output, /fixture-node-token/);
  const release = readRelease(fixture.packageDirectory);
  const env = managedConnectionEnvironment(connection(fixture.workspace), { PATH: "/bin", ARTOO_HOME: fixture.state,
    ARTOO_RESEARCH_RECEIPTS_DIR: "untrusted", ARTOO_RELEASE_PROFILES_FILE: "untrusted", ARTOO_MANAGED_EXECUTION: "1",
    ARTOO_TRUSTED_EXECUTION: "1", NODE_OPTIONS: "untrusted", NODE_PATH: "untrusted" }, fixture.state, release);
  assert.equal(env.ARTOO_RESEARCH_RECEIPTS_DIR, fixture.receipts); assert.equal(env.ARTOO_VERIFICATION_PROFILES_FILE, fixture.profiles);
  assert.equal(env.ARTOO_RESEARCH_ENABLED, "1"); assert.equal(env.ARTOO_INITIALIZE_REPOSITORY, "1");
  for (const key of ["ARTOO_HOME", "ARTOO_RELEASE_PROFILES_FILE", "ARTOO_MANAGED_EXECUTION", "ARTOO_TRUSTED_EXECUTION", "NODE_OPTIONS", "NODE_PATH"])
    assert.equal(env[key], undefined, key);
  assert.equal(env.ARTOO_WINDOWS_PROCESS_BUNDLE, process.platform === "win32" ? join(release.runtime, "native/windows-process") : undefined);
  assert.equal(env.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256, process.platform === "win32" ? release.manifest.windows_process.manifest_sha256 : undefined);
});

test("team settings reject unknown fields, invalid paths and task-writable or linked configuration", async t => {
  const fixture = teamFixture(t), roots = [fixture.workspace];
  for (const value of [null, [], {}, { version: 2 }, { version: 1, initialize_repository: "1" },
    { version: 1, env: {} }, { version: 1, argv: [] }, { version: 1, nodeToken: "fixture-secret" }])
    assert.throws(() => validateTeamConfiguration(value, roots), /Invalid team configuration/);
  for (const value of ["relative", "", 42, `${fixture.profiles}\n`])
    assert.throws(() => validateTeamConfiguration({ version: 1, verification_profiles_file: value }, roots), /absolute local paths/);
  assert.throws(() => validateTeamConfiguration({ version: 1, research_receipts_directory: fixture.root }, roots), /outside all agent/);
  const taskFile = join(fixture.workspace, "team.json"); writeFileSync(taskFile, JSON.stringify(fixture.configuration), { mode: 0o600 });
  await assert.rejects(runCli({ args: ["configure", "--file", taskFile], env: { ARTOO_HOME: fixture.state }, packageDirectory: fixture.packageDirectory }), /outside all agent/);
  const alias = join(fixture.root, "alias"); symlinkSync(fixture.control, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(runCli({ args: ["configure", "--file", join(alias, "team.json")], env: { ARTOO_HOME: fixture.state }, packageDirectory: fixture.packageDirectory }), /physical files/);
  assert.throws(() => validateTeamConfiguration({ version: 1, research_receipts_directory: alias }, roots), /physical files/);
  assert.equal(existsSync(join(fixture.state, "team-config.json")), false);
  for (const args of [["configure"], ["configure", "--env", fixture.file], ["configure", "--file", "relative"], ["configure", "--file", fixture.file, "extra"]])
    await assert.rejects(runCli({ args, env: { ARTOO_HOME: fixture.state }, packageDirectory: fixture.packageDirectory }), /Usage: artood configure/);
});

test("failed profile qualification preserves saved settings, and explicit empty settings disable optional capabilities", async t => {
  const fixture = teamFixture(t), options = { args: ["configure", "--file", fixture.file], env: { ARTOO_HOME: fixture.state }, packageDirectory: fixture.packageDirectory, output: () => {} };
  await runCli(options);
  const path = join(fixture.state, "team-config.json"), before = readFileSync(path);
  writeFileSync(fixture.profiles, "reject");
  await assert.rejects(runCli(options), /Controlled profile qualification failed/);
  assert.deepEqual(readFileSync(path), before);
  writeFileSync(fixture.file, JSON.stringify({ version: 1 }));
  await runCli(options);
  const env = managedConnectionEnvironment(connection(fixture.workspace), { ARTOO_RESEARCH_ENABLED: "1" }, fixture.state, readRelease(fixture.packageDirectory));
  for (const key of ["ARTOO_RESEARCH_ENABLED", "ARTOO_VERIFICATION_PROFILES_FILE", "ARTOO_INITIALIZE_REPOSITORY", "ARTOO_WINDOWS_PROCESS_BUNDLE"])
    assert.equal(env[key], undefined);
});

test("native team selection uses the current release pin and rejects missing or unsafe helper metadata", t => {
  const fixture = teamFixture(t), release = readRelease(fixture.packageDirectory);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    for (const native of [undefined, { directory: "../escape", manifest_sha256: `sha256:${"b".repeat(64)}` },
      { directory: "native/windows-process", manifest_sha256: "wrong" }])
      assert.throws(() => teamConfigurationEnvironment(fixture.configuration, { ...release, manifest: { windows_process: native } }), /valid Windows native/);
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    const env = teamConfigurationEnvironment(fixture.configuration, { ...release, manifest: {} });
    assert.equal(env.ARTOO_VERIFICATION_PROFILES_FILE, fixture.profiles); assert.equal(env.ARTOO_WINDOWS_PROCESS_BUNDLE, undefined);
  } finally { Object.defineProperty(process, "platform", platform); }
});

test("managed background and foreground starts retain team settings without inheriting credentials or arbitrary settings", { timeout: 60_000 }, async t => {
  const fixture = teamFixture(t, { stop: true });
  await runCli({ args: ["configure", "--file", fixture.file], env: { ARTOO_HOME: fixture.state }, packageDirectory: fixture.packageDirectory, output: () => {} });
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ARTOO_|^(?:NODE_OPTIONS|NODE_PATH)$/i.test(key)));
  const env = { ...base, ARTOO_HOME: fixture.state, ARTOO_RESEARCH_ENABLED: "0", ARTOO_TRUSTED_EXECUTION: "1", ARTOO_RELEASE_PROFILES_FILE: "untrusted" };
  const check = () => {
    const observed = JSON.parse(readFileSync(fixture.observation, "utf8"));
    assert.equal(observed.node, "computer_test"); assert.equal(observed.inherited, null); assert.deepEqual(observed.inheritedSettings, []);
    assert.equal(observed.research, "1"); assert.equal(observed.receipts, fixture.receipts); assert.equal(observed.profiles, fixture.profiles);
    assert.equal(observed.initialize, "1");
    assert.doesNotMatch(readFileSync(fixture.observation, "utf8"), /fixture-node-token|untrusted/);
    return observed;
  };
  const first = await startManaged({ directory: fixture.state, packageDirectory: fixture.packageDirectory,
    env: { ...env, NODE_OPTIONS: "--require must-not-load", NODE_PATH: "must-not-load" } });
  const observed = check(); await stopManaged(fixture.state);
  const retained = dirname(dirname(fileURLToPath(observed.entry)));
  const second = await startManaged({ directory: fixture.state, packageDirectory: retained, env });
  assert.notEqual(second.pid, first.pid); check(); await stopManaged(fixture.state);
  const child = spawn(process.execPath, [join(retained, "bin", "artood.mjs"), "start", "--foreground"],
    { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if ((await managedStatus(fixture.state)).status === "running") { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, output); check(); await stopManaged(fixture.state);
  assert.deepEqual(await closed, { code: 0, signal: null }); assert.doesNotMatch(output, /fixture-node-token/);
  // Replacing saved settings with invalid data must fail startup, not fall back.
  writeFileSync(join(fixture.state, "team-config.json"), JSON.stringify({ version: 1, env: {} }));
  assert.throws(() => managedConnectionEnvironment(connection(fixture.workspace), env, fixture.state, readRelease(retained)), /Invalid team configuration/);
  rmSync(fixture.observation);
  const rejected = spawnSync(process.execPath, [join(retained, "bin", "artood.mjs"), "start", "--foreground"],
    { env, windowsHide: true, encoding: "utf8", timeout: 15_000 });
  assert.ifError(rejected.error); assert.equal(rejected.status, 1); assert.equal(rejected.signal, null);
  assert.match(rejected.stderr, /Invalid team configuration/); assert.doesNotMatch(rejected.stdout + rejected.stderr, /fixture-node-token/);
  assert.equal(existsSync(fixture.observation), false, "Invalid saved configuration must prevent runtime startup.");
  assert.equal((await managedStatus(fixture.state)).status, "stopped");
});

function providerFixture(t, options) {
  const fixture = teamFixture(t, options);
  // Windows Temp/AppData may grant other local identities replacement rights.
  // Exercise private credentials in a fresh owned home directory, not by
  // weakening the production ancestor check to admit that test location.
  const parent = realpathSync.native(homedir()), directory = protectDirectory(mkdtempSync(join(parent, ".artoo-provider-key-test-"))), keyFile = join(directory, "key");
  t.after(() => {
    assert.ok(realpathSync.native(directory).startsWith(`${parent}${sep}.artoo-provider-key-test-`));
    rmSync(directory, { recursive: true });
  });
  writeFileSync(keyFile, "fixture-provider-credential", { mode: 0o600 });
  fixture.configuration.codex = { model: "fixture-model", provider_url: "http://127.0.0.1:18181/v1", provider_key_file: keyFile };
  writeFileSync(fixture.file, JSON.stringify(fixture.configuration));
  return { ...fixture, keyFile };
}

function codexHomeFixture(t, options) {
  const fixture = providerFixture(t, options), home = join(dirname(fixture.keyFile), "codex-home");
  mkdirSync(home, { mode: 0o700 });
  fixture.configuration.codex.home_directory = home;
  writeFileSync(fixture.file, JSON.stringify(fixture.configuration));
  return { ...fixture, home };
}

test("Codex home selection requires an empty protected physical directory outside all agent roots", async t => {
  const fixture = codexHomeFixture(t), roots = [fixture.workspace];
  const value = home_directory => ({ version: 1, codex: { home_directory } });
  for (const path of ["relative", "", 42, `${fixture.home}\n`, fixture.keyFile])
    assert.throws(() => validateTeamConfiguration(value(path), roots));
  if (process.platform === "win32") assert.throws(() => validateTeamConfiguration(value("\\\\server\\share\\home"), roots), /local disk/);
  assert.throws(() => validateTeamConfiguration(value(fixture.workspace), roots), /outside all agent/);
  const nestedRoot = join(fixture.home, "workspace"); mkdirSync(nestedRoot, { mode: 0o700 });
  assert.throws(() => validateTeamConfiguration(value(fixture.home), [nestedRoot]), /outside all agent/);
  rmdirSync(nestedRoot);
  const alias = join(fixture.control, "home-alias"); symlinkSync(fixture.home, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => validateTeamConfiguration(value(alias), roots), /physical files/);
  const config = join(fixture.home, "config.toml"); writeFileSync(config, "# operator fixture, must not be imported", { mode: 0o600 });
  const options = { args: ["configure", "--file", fixture.file], env: { ARTOO_HOME: fixture.state }, packageDirectory: fixture.packageDirectory, output: () => {} };
  await assert.rejects(runCli(options), /newly selected.*empty/);
  assert.equal(existsSync(join(fixture.state, "team-config.json")), false);
  assert.equal(readFileSync(config, "utf8"), "# operator fixture, must not be imported");
  rmSync(config); await runCli(options);
  assert.deepEqual(readdirSync(fixture.home), [], "Configure does not write or copy home contents.");
  writeFileSync(join(fixture.home, "runtime-state.json"), "{}", { mode: 0o600 });
  await runCli(options); // An already saved home can retain the CLI's state.
  assert.equal(JSON.parse(readFileSync(join(fixture.state, "team-config.json"), "utf8")).codex.home_directory, fixture.home);
});

test("saved Codex home rejects linked, overly deep or unprotected contents before restart", async t => {
  const fixture = codexHomeFixture(t);
  await runCli({ args: ["configure", "--file", fixture.file], env: { ARTOO_HOME: fixture.state }, packageDirectory: fixture.packageDirectory, output: () => {} });
  const load = () => managedConnectionEnvironment(connection(fixture.workspace), {}, fixture.state, readRelease(fixture.packageDirectory));
  const linked = join(fixture.home, "outside"); symlinkSync(fixture.control, linked, process.platform === "win32" ? "junction" : "dir");
  assert.throws(load, /without links/); rmSync(linked);
  const source = join(dirname(fixture.home), "synthetic-private"), hard = join(fixture.home, "hard-link");
  writeFileSync(source, "synthetic, never read", { mode: 0o600 }); linkSync(source, hard);
  assert.throws(load, /single-link/); rmSync(hard);
  let deep = fixture.home;
  for (let i = 0; i < 33; i++) { deep = join(deep, "d"); mkdirSync(deep, { mode: 0o700 }); }
  assert.throws(load, /bounded state inspection/);
  assert.ok(join(fixture.home, "d").startsWith(fixture.home + sep)); rmSync(join(fixture.home, "d"), { recursive: true });
  const state = join(fixture.home, "state.json"); writeFileSync(state, "{}", { mode: 0o600 });
  if (process.platform !== "win32") {
    chmodSync(state, 0o644); assert.throws(load, /private to the current user/); assert.equal(statSync(state).mode & 0o777, 0o644);
  } else {
    const result = spawnSync(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop';" +
        "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));$acl=Get-Acl -LiteralPath $p;" +
        "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Write','Allow'));" +
        "[IO.File]::SetAccessControl($p,$acl)"], { input: Buffer.from(state).toString("base64"), encoding: "utf8", windowsHide: true,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath")) });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    assert.throws(load, /private, trusted Windows permissions; no ACL was changed/);
    for (const descriptor of ["null", "generic"]) {
      const acl = spawnSync(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop';" +
          "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User;" +
          "$acl=[Security.AccessControl.FileSecurity]::new();" + (descriptor === "null"
            ? "$flags=[Security.AccessControl.ControlFlags]::DiscretionaryAclPresent -bor [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected;" +
              "$raw=[Security.AccessControl.RawSecurityDescriptor]::new($flags,$owner,$null,$null,$null);$bytes=[byte[]]::new($raw.BinaryLength);$raw.GetBinaryForm($bytes,0);" +
              "$acl.SetSecurityDescriptorBinaryForm($bytes,[Security.AccessControl.AccessControlSections]::Access);"
            : "$acl.SetSecurityDescriptorSddlForm('D:P(A;;FA;;;'+$owner.Value+')(A;;GA;;;WD)',[Security.AccessControl.AccessControlSections]::Access);") +
          "[IO.File]::SetAccessControl($p,$acl)"], { input: Buffer.from(state).toString("base64"), encoding: "utf8", windowsHide: true,
          env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath")) });
      assert.ifError(acl.error); assert.equal(acl.status, 0, acl.stderr);
      assert.throws(load, /private, trusted Windows permissions; no ACL was changed/, descriptor);
    }
  }
  assert.equal(readFileSync(state, "utf8"), "{}");
});

test("saved Codex home reaches actual controlled model children after background restart and foreground start", { timeout: 90_000 }, async t => {
  const fixture = codexHomeFixture(t, { stop: true });
  const operatorHome = join(dirname(fixture.home), "operator-home"); mkdirSync(operatorHome, { mode: 0o700 });
  const operatorConfig = join(operatorHome, "config.toml"), operatorAuth = join(operatorHome, "auth.json");
  writeFileSync(operatorConfig, "# unchanged operator configuration", { mode: 0o600 });
  writeFileSync(operatorAuth, "synthetic-operator-credential", { mode: 0o600 });
  const priorHome = process.env.CODEX_HOME;
  await runCli({ args: ["configure", "--file", fixture.file], env: { ARTOO_HOME: fixture.state }, packageDirectory: fixture.packageDirectory, output: () => {} });
  assert.equal(process.env.CODEX_HOME, priorHome);
  const env = { ...process.env, ARTOO_HOME: fixture.state, CODEX_HOME: operatorHome };
  const selected = managedConnectionEnvironment(connection(fixture.workspace), { ...env, codex_home: "must-not-survive" }, fixture.state, readRelease(fixture.packageDirectory));
  assert.equal(selected.CODEX_HOME, fixture.home); assert.equal(selected.codex_home, undefined);
  const check = () => {
    const observed = JSON.parse(readFileSync(fixture.observation, "utf8"));
    assert.equal(observed.codexHome, fixture.home); assert.equal(observed.modelEnvironment.home, fixture.home);
    assert.equal(observed.modelEnvironment.provider, true); assert.equal(observed.providerInArgv, false);
    assert.doesNotMatch(readFileSync(fixture.observation, "utf8"), /fixture-provider-credential|synthetic-operator-credential/);
    return observed;
  };
  const first = await startManaged({ directory: fixture.state, packageDirectory: fixture.packageDirectory, env });
  const retained = dirname(dirname(fileURLToPath(check().entry))); await stopManaged(fixture.state);
  writeFileSync(join(fixture.home, "runtime-state.json"), "{}", { mode: 0o600 });
  const second = await startManaged({ directory: fixture.state, packageDirectory: retained, env });
  assert.notEqual(first.pid, second.pid); check(); await stopManaged(fixture.state);
  const child = spawn(process.execPath, [join(retained, "bin", "artood.mjs"), "start", "--foreground"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if ((await managedStatus(fixture.state)).status === "running") { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, output); check(); await stopManaged(fixture.state); assert.deepEqual(await closed, { code: 0, signal: null });
  assert.equal(process.env.CODEX_HOME, priorHome); assert.equal(env.CODEX_HOME, operatorHome);
  assert.deepEqual(readdirSync(fixture.home), ["runtime-state.json"]);
  assert.equal(readFileSync(operatorConfig, "utf8"), "# unchanged operator configuration");
  assert.equal(readFileSync(operatorAuth, "utf8"), "synthetic-operator-credential");
  writeFileSync(fixture.file, JSON.stringify({ version: 1 }));
  await runCli({ args: ["configure", "--file", fixture.file], env: { ARTOO_HOME: fixture.state }, packageDirectory: retained, output: () => {} });
  assert.equal(managedConnectionEnvironment(connection(fixture.workspace), env, fixture.state, readRelease(retained)).CODEX_HOME, operatorHome);
});

test("daemon Codex home is restored after startup failure, normal stop and failed stop", async t => {
  const previous = process.env.CODEX_HOME;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });
  for (const original of [undefined, "controlled-original-home"]) {
    if (original === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = original;
    await assert.rejects(launchManagedRuntime({ CODEX_HOME: "controlled-selected-home" }, async () => {
      assert.equal(process.env.CODEX_HOME, "controlled-selected-home"); throw Error("controlled startup failure");
    }), /controlled startup failure/);
    assert.equal(process.env.CODEX_HOME, original);
    for (const fail of [false, true]) {
      const node = await launchManagedRuntime({ CODEX_HOME: "controlled-selected-home" }, async () => ({ stop: async () => {
        assert.equal(process.env.CODEX_HOME, "controlled-selected-home"); if (fail) throw Error("controlled stop failure");
      } }));
      if (fail) await assert.rejects(node.stop(), /controlled stop failure/); else await node.stop();
      assert.equal(process.env.CODEX_HOME, original);
    }
  }
});

test("Codex settings accept only an explicit safe provider and private credential reference", async t => {
  const fixture = providerFixture(t), roots = [fixture.workspace];
  for (const codex of [null, [], { env: {} }, { api_key: "fixture-secret" }, { model: "" }, { model: "bad\nmodel" },
    { provider_url: "https://provider.test/v1" }, { model: "m", provider_url: "http://remote.test/v1" },
    { model: "m", provider_url: "https://user:pass@provider.test/v1" }, { model: "m", provider_url: "https://provider.test/v1?key=hidden" },
    { model: "m", provider_url: "https://provider.test/v1#hidden" }, { provider_key_file: fixture.keyFile },
    { model: "m", provider_url: "https://provider.test/v1", CODEX_HOME: fixture.workspace }])
    assert.throws(() => validateTeamConfiguration({ version: 1, codex }, roots), /Codex/);
  assert.throws(() => validateTeamConfiguration({ version: 1, codex: { ...fixture.configuration.codex, provider_key_file: fixture.file.replace(fixture.control, fixture.workspace) } }, roots));
  assert.deepEqual(validateTeamConfiguration({ version: 1, codex: { model: "existing-model" } }, roots).codex, { model: "existing-model" });
  // Configure checks metadata/permissions without reading even invalid key bytes.
  writeFileSync(fixture.keyFile, Buffer.from([255]));
  await runCli({ args: ["configure", "--file", fixture.file], env: { ARTOO_HOME: fixture.state }, packageDirectory: fixture.packageDirectory, output: () => {} });
  const saved = readFileSync(join(fixture.state, "team-config.json"), "utf8");
  assert.equal(JSON.parse(saved).codex.provider_key_file, fixture.keyFile); assert.doesNotMatch(saved, /fixture-provider-credential|selected-local-credential/);
  assert.throws(() => managedConnectionEnvironment(connection(fixture.workspace), {}, fixture.state, readRelease(fixture.packageDirectory)), /UTF-8 text/);
  writeFileSync(fixture.keyFile, "fixture-provider-credential\n");
  const env = managedConnectionEnvironment(connection(fixture.workspace), { ARTOO_CODEX_PROVIDER_KEY: "untrusted" }, fixture.state, readRelease(fixture.packageDirectory));
  assert.equal(env.ARTOO_CODEX_PROVIDER_KEY, "fixture-provider-credential"); assert.equal(env.ARTOO_CODEX_MODEL, "fixture-model");
  assert.equal(env.ARTOO_CODEX_PROVIDER_URL, fixture.configuration.codex.provider_url);
  rmSync(fixture.keyFile);
  assert.throws(() => managedConnectionEnvironment(connection(fixture.workspace), {}, fixture.state, readRelease(fixture.packageDirectory)));
});

test("provider key permissions are inspected without changing the source ACL", t => {
  const fixture = providerFixture(t);
  assertPrivateProviderKeyFile(fixture.keyFile);
  if (process.platform !== "win32") {
    chmodSync(fixture.keyFile, 0o644);
    assert.throws(() => assertPrivateProviderKeyFile(fixture.keyFile), /private to the current user/);
    assert.equal(statSync(fixture.keyFile).mode & 0o777, 0o644);
  } else {
    const shell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop';" +
      "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));$acl=Get-Acl -LiteralPath $p;" +
      "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'));" +
      "[IO.File]::SetAccessControl($p,$acl)"], { input: Buffer.from(fixture.keyFile).toString("base64"), encoding: "utf8", windowsHide: true,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath")) });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    assert.throws(() => assertPrivateProviderKeyFile(fixture.keyFile), /private, trusted Windows permissions/);
    assert.throws(() => assertPrivateProviderKeyFile(fixture.keyFile), /no ACL was changed/);
    const nullDaclFile = join(dirname(fixture.keyFile), "null-dacl-fixture");
    writeFileSync(nullDaclFile, "synthetic-nonsecret");
    const nullDacl = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop';" +
      "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));" +
      "$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User;" +
      "$flags=[Security.AccessControl.ControlFlags]::DiscretionaryAclPresent -bor [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected;" +
      "$raw=[Security.AccessControl.RawSecurityDescriptor]::new($flags,$owner,$null,$null,$null);$bytes=[byte[]]::new($raw.BinaryLength);$raw.GetBinaryForm($bytes,0);" +
      "$acl=[Security.AccessControl.FileSecurity]::new();$acl.SetSecurityDescriptorBinaryForm($bytes,[Security.AccessControl.AccessControlSections]::Access);" +
      "[IO.File]::SetAccessControl($p,$acl);" +
      "$observed=Get-Acl -LiteralPath $p;$actual=[Security.AccessControl.RawSecurityDescriptor]::new($observed.GetSecurityDescriptorBinaryForm(),0);" +
      "if($null -ne $actual.DiscretionaryAcl){throw 'Fixture did not create an actual NULL DACL'}"],
    { input: Buffer.from(nullDaclFile).toString("base64"), encoding: "utf8", windowsHide: true,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath")) });
    assert.ifError(nullDacl.error); assert.equal(nullDacl.status, 0, nullDacl.stderr);
    assert.throws(() => assertPrivateProviderKeyFile(nullDaclFile), /private, trusted Windows permissions/);
    const genericFile = join(dirname(fixture.keyFile), "generic-allow-fixture");
    writeFileSync(genericFile, "synthetic-nonsecret");
    const generic = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop';" +
      "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;" +
      "$acl=[Security.AccessControl.FileSecurity]::new();$acl.SetSecurityDescriptorSddlForm('D:P(A;;FA;;;'+$owner+')(A;;GA;;;WD)',[Security.AccessControl.AccessControlSections]::Access);" +
      "[IO.File]::SetAccessControl($p,$acl);" +
      "$observed=Get-Acl -LiteralPath $p;$actual=[Security.AccessControl.RawSecurityDescriptor]::new($observed.GetSecurityDescriptorBinaryForm(),0);" +
      "$everyone=@($actual.DiscretionaryAcl | Where-Object {$_.AceType -eq 'AccessAllowed' -and $_.SecurityIdentifier.Value -eq 'S-1-1-0'});" +
      "if($everyone.Count -ne 1){throw 'Fixture did not persist its Everyone allow ACE'};" +
      "[pscustomobject]@{genericBitsRetained=(([long]$everyone[0].AccessMask -band 4026531840) -ne 0);accessMask=$everyone[0].AccessMask} | ConvertTo-Json -Compress"],
    { input: Buffer.from(genericFile).toString("base64"), encoding: "utf8", windowsHide: true,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath")) });
    assert.ifError(generic.error); assert.equal(generic.status, 0, generic.stderr);
    const persisted = JSON.parse(generic.stdout);
    assert.equal(typeof persisted.genericBitsRetained, "boolean"); assert.equal(Number.isInteger(persisted.accessMask), true);
    t.diagnostic(`Synthetic persisted Everyone GENERIC_ALL: raw generic bits ${persisted.genericBitsRetained ? "retained" : "mapped by Windows"}, mask ${persisted.accessMask}.`);
    assert.throws(() => assertPrivateProviderKeyFile(genericFile), /private, trusted Windows permissions/);
  }
});

test("selected model credential is cleared and redacted after in-process startup and stop failures", async t => {
  const original = process.env.ARTOO_CODEX_PROVIDER_KEY;
  t.after(() => { if (original === undefined) delete process.env.ARTOO_CODEX_PROVIDER_KEY; else process.env.ARTOO_CODEX_PROVIDER_KEY = original; });
  const key = 'fixture-"private"-\\key';
  const formats = [value => value, value => JSON.stringify(JSON.stringify({ value })), value => encodeURIComponent(value),
    value => JSON.stringify({ value }).replaceAll("private", "\\u0070rivate")];
  for (const format of formats) {
    const env = { ARTOO_NODE_URL: "ws://fixture/?token=fixture-node-credential", ARTOO_CODEX_PROVIDER_KEY: key };
    await assert.rejects(launchManagedRuntime(env, async () => {
      assert.equal(process.env.ARTOO_CODEX_PROVIDER_KEY, key);
      throw Error(`Controlled startup failure: ${format(key)}`);
    }), error => { assert.doesNotMatch(error.message, /fixture-|private|u0070rivate/); return true; });
    assert.equal(process.env.ARTOO_CODEX_PROVIDER_KEY, undefined); assert.equal(env.ARTOO_CODEX_PROVIDER_KEY, undefined);
  }
  for (const fail of [false, true]) {
    const env = { ARTOO_CODEX_PROVIDER_KEY: key };
    const node = await launchManagedRuntime(env, async () => ({ stop: async () => {
      assert.equal(process.env.ARTOO_CODEX_PROVIDER_KEY, key);
      if (fail) throw Error(`Controlled stop failure: ${JSON.stringify(key)}`);
    } }));
    if (fail) {
      await assert.rejects(node.stop(), /Controlled stop failure: "\[redacted\]"/);
      await assert.rejects(node.stop(), /Controlled stop failure: "\[redacted\]"/);
    }
    else await node.stop();
    assert.equal(process.env.ARTOO_CODEX_PROVIDER_KEY, undefined); assert.equal(env.ARTOO_CODEX_PROVIDER_KEY, undefined);
  }
});

test("managed provider selection survives background and foreground startup without copying the key into arguments or logs", { timeout: 60_000 }, async t => {
  const fixture = providerFixture(t, { stop: true });
  await runCli({ args: ["configure", "--file", fixture.file], env: { ARTOO_HOME: fixture.state }, packageDirectory: fixture.packageDirectory, output: () => {} });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ARTOO_|^(?:NODE_OPTIONS|NODE_PATH)$/i.test(key))), ARTOO_HOME: fixture.state };
  const check = () => {
    const observed = JSON.parse(readFileSync(fixture.observation, "utf8"));
    assert.equal(observed.inherited, null); assert.equal(observed.providerSelected, true); assert.equal(observed.providerInherited, true);
    assert.equal(observed.providerInArgv, false); assert.deepEqual(observed.inheritedSettings, ["ARTOO_CODEX_PROVIDER_KEY"]);
    assert.equal(observed.model, "fixture-model"); assert.equal(observed.provider, fixture.configuration.codex.provider_url);
    return observed;
  };
  await startManaged({ directory: fixture.state, packageDirectory: fixture.packageDirectory, env });
  const observed = check(); await stopManaged(fixture.state);
  assert.deepEqual(JSON.parse(readFileSync(fixture.observation + ".stopped", "utf8")), { providerPresent: false });
  const retained = dirname(dirname(fileURLToPath(observed.entry)));
  const child = spawn(process.execPath, [join(retained, "bin", "artood.mjs"), "start", "--foreground"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if ((await managedStatus(fixture.state)).status === "running") { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, output); check(); await stopManaged(fixture.state);
  assert.deepEqual(await closed, { code: 0, signal: null });
  assert.deepEqual(JSON.parse(readFileSync(fixture.observation + ".stopped", "utf8")), { providerPresent: false });
  assert.doesNotMatch(output + readFileSync(join(fixture.state, "daemon.log"), "utf8") + readFileSync(fixture.observation, "utf8"), /fixture-provider-credential|fixture-node-token/);
});
