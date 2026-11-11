import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { connectComputer, parseConnectArguments, savedConnectionEnvironment } from "./onboarding.mjs";
import { connectionEnvironment, loadConnection, prepareWorkspace, protectDirectory, saveConnection, serverOrigin, validateConnection } from "./local-config.mjs";
import { managedStatus, startManaged, stopManaged } from "./managed.mjs";

const source = dirname(fileURLToPath(import.meta.url));
const connection = root => ({ version: 1, origin: "https://artoo.example.test", deviceId: "device_test", computerId: "computer_test",
  nodeToken: "fixture-node-token-123456789", controlToken: null, roots: [root], runtimes: ["codex"], codexBinary: null });
function temporary(t, beforeRemove = async () => {}) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, "artoo-onboarding-"));
  t.after(async () => { await beforeRemove(); assert.ok(realpathSync(root).startsWith(`${parent}${sep}artoo-onboarding-`)); rmSync(root, { recursive: true, force: true }); });
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
  for (const file of ["cli.mjs", "verify.mjs", "platforms.mjs", "local-config.mjs", "managed.mjs", "onboarding.mjs"])
    copyFileSync(join(source, file), join(bin, file === "cli.mjs" ? "artood.mjs" : file));
  const files = new Map([["artood.mjs", `import {writeFileSync} from 'node:fs';
export function loadConfigFromEnv(env) { return env; }
export async function runDaemonEntrypoint(env) {
  writeFileSync(${JSON.stringify(observation)}, JSON.stringify({node:env.ARTOO_NODE_ID,inherited:process.env.ARTOO_NODE_URL??null,entry:import.meta.url}));
  const timer=setInterval(()=>{},1000);
  process.on('SIGTERM',()=>{clearInterval(timer);process.exit(0)});
  return {stop:async()=>clearInterval(timer)};
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
  const manifest = JSON.stringify({format:"artoo.desktop-daemon.v1",node_target:"node24",playwright_version:"0.0.0-test",tree:{directories,files:[...files].map(([path,contents])=>({path,size:Buffer.byteLength(contents),sha256:digest(contents)}))}});
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
