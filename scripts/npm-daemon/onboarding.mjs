import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { connectionEnvironment, discoverRuntimes, loadConnection, prepareWorkspace, protectDirectory, saveConnection, serverOrigin, stateDirectory } from "./local-config.mjs";
import { managedStatus, retainInstallation, startManaged, stopManaged, writeManagementLauncher } from "./managed.mjs";

export function parseConnectArguments(args) {
  const keys = { "--server": "server", "--code": "code", "--workspace": "workspace", "--name": "name" };
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = keys[args[index]], value = args[index + 1];
    if (!key || Object.hasOwn(result, key) || !value || value.startsWith("--")) throw Error("Invalid connect options. Use --server, --code, and optionally --workspace or --name.");
    result[key] = value;
  }
  result.server = serverOrigin(result.server);
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(result.code || "")) throw Error("Copy the complete connection command from your Artoo website; its pairing code is single-use.");
  result.code = result.code.toUpperCase();
  if (result.name && (result.name.length > 200 || /[\u0000-\u001f]/u.test(result.name))) throw Error("The computer name is invalid.");
  return result;
}

async function requestJson(origin, path, { body, token, fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(new URL(path, origin), {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch { throw Error("Cannot reach your Artoo website. Check its address and your network, then retry; saved credentials are retained."); }
  if (!response.ok) {
    const error = Error(response.status === 401 ? "This saved device credential is no longer accepted. Revoke the old device in Web before connecting it again."
      : path.endsWith("/claim") ? "The pairing code is invalid, expired or already used. Generate a new connection command in Web."
      : `Artoo could not complete device enrollment (HTTP ${response.status}).`);
    error.status = response.status; throw error;
  }
  try { return await response.json(); } catch { throw Error("Artoo returned an invalid response. No credential values were printed."); }
}

export async function finishEnrollment(connection, directory, fetchImpl = fetch) {
  if (connection.computerId) return connection;
  if (!connection.controlToken) throw Error("This saved device has no enrollment credential. Revoke it in Web before reconnecting.");
  try {
    const enrollment = await requestJson(connection.origin, `/api/v1/devices/${encodeURIComponent(connection.deviceId)}/enroll`, {
      body: { hostname: hostname(), os: process.platform, arch: process.arch }, token: connection.controlToken, fetchImpl,
    });
    if (enrollment.device_id !== connection.deviceId || typeof enrollment.computer_id !== "string") throw Error("Artoo returned a different device enrollment.");
    connection = { ...connection, computerId: enrollment.computer_id, controlToken: null };
  } catch (error) {
    if (error.status !== 403) throw error;
    const result = await requestJson(connection.origin, "/api/v1/devices", { token: connection.controlToken, fetchImpl });
    const device = result.devices?.find(device => device.id === connection.deviceId);
    if (!device?.computer_id) throw Error("Your device is paired and saved. Ask an owner/admin to enroll it in Web, then run artood start. Do not generate another pairing code.");
    connection = { ...connection, computerId: device.computer_id, controlToken: null };
  }
  saveConnection(directory, connection);
  return connection;
}

export async function connectComputer({ args, env = process.env, packageDirectory, metadata, output = () => {}, fetchImpl = fetch, start = startManaged }) {
  const options = parseConnectArguments(args), directory = protectDirectory(stateDirectory(env));
  const existing = loadConnection(directory);
  if (existing && existing.origin !== options.server) throw Error("This computer is already configured for another Artoo website. Keep that connection or revoke it before replacing it.");
  const workspace = existing ? null : prepareWorkspace(options.workspace ?? join(homedir(), "ArtooWorkspaces"), directory, packageDirectory);
  // Retain a working restart command before consuming a one-time claim. A
  // member waiting for enrollment must not depend on npx's temporary cache.
  const installation = await retainInstallation(packageDirectory, directory);
  const launcher = writeManagementLauncher(directory, installation);
  const discovered = discoverRuntimes(env);
  output(`Check status: ${launcher} status\nReplace status with stop or start to stop or restart.\n`);
  if (existing) {
    output("Using this computer's saved device. The new pairing code was not consumed.\n");
    const enrolled = await finishEnrollment(existing, directory, fetchImpl);
    saveConnection(directory, { ...enrolled, ...discovered });
    return start({ directory, packageDirectory: installation, env, output });
  }
  output(`Connecting ${options.name || hostname()} to ${options.server}\nWorkspace: ${workspace}\n`);
  const claim = await requestJson(options.server, "/api/v1/devices/claim", {
    body: { code: options.code, platform: { win32: "windows", darwin: "macos", linux: "linux" }[process.platform],
      app_version: metadata.version, display_name: options.name || hostname() }, fetchImpl,
  });
  const connection = { version: 1, origin: options.server, deviceId: claim.device?.id, computerId: null,
    nodeToken: claim.node_token, controlToken: claim.control_token, roots: [workspace], ...discovered };
  // Claim is intentionally not replayable. Save its credentials before any later
  // network operation so an interrupted enrollment resumes the same identity.
  saveConnection(directory, connection);
  await finishEnrollment(connection, directory, fetchImpl);
  output(`Computer paired and enrolled. ${discovered.runtimes.length ? `Detected ${discovered.runtimes.join(", ")}.` : "No model CLI found yet. Install and sign in to Codex or Claude, then stop/start Artoo to detect it before running tasks."}\n`);
  return start({ directory, packageDirectory: installation, env, output });
}

export async function savedConnectionEnvironment(env = process.env, { fetchImpl = fetch } = {}) {
  const directory = stateDirectory(env);
  if (!existsSync(join(directory, "connection.dat"))) return null;
  protectDirectory(directory);
  let connection = loadConnection(directory);
  connection = await finishEnrollment(connection, directory, fetchImpl);
  const discovered = discoverRuntimes(env);
  const current = { ...connection, ...discovered };
  saveConnection(directory, current);
  return { directory, connection: current, env: connectionEnvironment(current, env) };
}

export async function showStatus(env, output) {
  const directory = stateDirectory(env);
  const status = await managedStatus(directory);
  output(`Artoo: ${status.status}${status.pid ? ` (PID ${status.pid})` : ""}\n`);
  if (status.origin) output(`Website: ${status.origin}/computers\n`);
  if (!existsSync(join(directory, "connection.dat"))) output("Connect this computer using the command in Web → Machines → Connect Local Node.\n");
  return status;
}

export const stopComputer = (env, output) => stopManaged(stateDirectory(env), output);
