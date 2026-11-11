import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPrivateProviderKeyFile, atomicPrivateFile, connectionEnvironment, containsPath, loadConnection, protectDirectory, readPrivateFile, stateDirectory } from "./local-config.mjs";
import { disableOptionalWebSocketAddons, packagedWindowsProcessEnvironment } from "./verify.mjs";

const filename = "team-config.json";
const fields = ["version", "research_receipts_directory", "verification_profiles_file", "initialize_repository", "codex"];
const normalize = path => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

function physicalPath(path, kind, roots) {
  if (typeof path !== "string" || !isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path))
    throw Error("Team configuration paths must be absolute local paths.");
  const resolved = resolve(path), stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
    || normalize(realpathSync.native(resolved)) !== normalize(resolved))
    throw Error("Team configuration requires existing physical files and directories without links.");
  for (const root of roots) {
    const physicalRoot = realpathSync.native(root);
    if (containsPath(physicalRoot, resolved) || (kind === "directory" && containsPath(resolved, physicalRoot)))
      throw Error("Team configuration, profiles and research receipts must be outside all agent workspace roots.");
  }
  return resolved;
}

function codexConfiguration(value, roots) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["model", "provider_url", "provider_key_file"].includes(key))
    || (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim() || value.model.length > 200 || /[\u0000-\u001f\u007f]/u.test(value.model))))
    throw Error("Invalid Codex configuration. Use only model, provider_url and provider_key_file.");
  if (value.provider_url !== undefined) {
    let url;
    try { url = new URL(value.provider_url); } catch { throw Error("Codex provider_url must be an HTTPS or loopback HTTP URL."); }
    if (typeof value.provider_url !== "string" || !value.model
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      || url.username || url.password || url.search || url.hash)
      throw Error("Codex provider_url requires a model and HTTPS or loopback HTTP without credentials, query or fragment.");
  }
  let keyFile;
  if (value.provider_key_file !== undefined) {
    if (!value.provider_url) throw Error("Codex provider_key_file requires an explicit provider_url.");
    keyFile = physicalPath(value.provider_key_file, "file", roots);
    assertPrivateProviderKeyFile(keyFile);
  }
  return { ...(value.model !== undefined ? { model: value.model.trim() } : {}),
    ...(value.provider_url !== undefined ? { provider_url: value.provider_url } : {}),
    ...(keyFile ? { provider_key_file: keyFile } : {}) };
}

/** Local selections only: never accept environment maps, commands or inline credentials. */
export function validateTeamConfiguration(value, roots) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1
    || Object.keys(value).some(key => !fields.includes(key))
    || (value.initialize_repository !== undefined && typeof value.initialize_repository !== "boolean"))
    throw Error("Invalid team configuration. Use version 1 and only the documented nonsecret fields.");
  return {
    version: 1,
    ...(value.research_receipts_directory !== undefined
      ? { research_receipts_directory: physicalPath(value.research_receipts_directory, "directory", roots) } : {}),
    ...(value.verification_profiles_file !== undefined
      ? { verification_profiles_file: physicalPath(value.verification_profiles_file, "file", roots) } : {}),
    ...(value.initialize_repository !== undefined ? { initialize_repository: value.initialize_repository } : {}),
    ...(value.codex !== undefined ? { codex: codexConfiguration(value.codex, roots) } : {}),
  };
}

function readConfiguration(path, roots) {
  physicalPath(path, "file", roots);
  const bytes = readPrivateFile(path);
  if (bytes.length > 16 * 1024) throw Error("Team configuration exceeds its size limit.");
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw Error("Team configuration must contain valid JSON."); }
  return validateTeamConfiguration(value, roots);
}

export function teamConfigurationEnvironment(configuration, release) {
  return {
    ...(configuration.research_receipts_directory ? { ARTOO_RESEARCH_ENABLED: "1",
      ARTOO_RESEARCH_RECEIPTS_DIR: configuration.research_receipts_directory } : {}),
    ...(configuration.verification_profiles_file ? { ARTOO_VERIFICATION_PROFILES_FILE: configuration.verification_profiles_file,
      ...(process.platform === "win32" ? packagedWindowsProcessEnvironment(release) : {}) } : {}),
    ...(configuration.initialize_repository === true ? { ARTOO_INITIALIZE_REPOSITORY: "1" } : {}),
    ...(configuration.codex?.model ? { ARTOO_CODEX_MODEL: configuration.codex.model } : {}),
    ...(configuration.codex?.provider_url ? { ARTOO_CODEX_PROVIDER_URL: configuration.codex.provider_url } : {}),
  };
}

function providerKey(configuration) {
  const path = configuration.codex?.provider_key_file;
  if (!path) return {};
  // Metadata/ACL checks also run when loading the saved selection. Recheck next
  // to the read, and never include file contents in any parser diagnostic.
  assertPrivateProviderKeyFile(path);
  let key;
  try { key = new TextDecoder("utf-8", { fatal: true }).decode(readPrivateFile(path)).trim(); }
  catch { throw Error("The configured provider key file could not be read as UTF-8 text."); }
  if (!key || /[^\u0021-\u007e]/u.test(key)) throw Error("The configured provider key file must contain one nonempty ASCII token.");
  return { ARTOO_CODEX_PROVIDER_KEY: key };
}

/** The token stays in this argument object, never in inherited process.env. */
export function managedConnectionEnvironment(connection, base, directory, release) {
  const path = join(directory, filename);
  let present = true;
  try { lstatSync(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; present = false; }
  const configuration = present ? readConfiguration(path, connection.roots) : { version: 1 };
  const cleanBase = Object.fromEntries(Object.entries(base).filter(([key]) => !/^(?:NODE_OPTIONS|NODE_PATH)$/i.test(key)));
  return { ...connectionEnvironment(connection, cleanBase), ...teamConfigurationEnvironment(configuration, release), ...providerKey(configuration) };
}

export async function configureTeam({ args, env, release, output = () => {} }) {
  if (args.length !== 2 || args[0] !== "--file" || !args[1] || !isAbsolute(args[1]))
    throw Error("Usage: artood configure --file <absolute local JSON path>");
  const directory = stateDirectory(env);
  const connection = loadConnection(directory);
  if (!connection?.computerId) throw Error("Connect and enroll this computer before configuring its team settings.");
  // Validate the input before changing protected state. The saved copy is the
  // authority on later starts; task-writable or linked input is never imported.
  const configuration = readConfiguration(args[1], connection.roots);
  physicalPath(directory, "directory", connection.roots);
  const configured = { ...connectionEnvironment(connection, env), ...teamConfigurationEnvironment(configuration, release),
    // The parser needs only credential presence. Configure never reads the key
    // or authenticates against a provider; the worker reads it on each start.
    ...(configuration.codex?.provider_key_file ? { ARTOO_CODEX_PROVIDER_KEY: "selected-local-credential" } : {}) };
  disableOptionalWebSocketAddons();
  const runtime = await import(pathToFileURL(join(release.runtime, "artood.mjs")).href);
  // This exported parser qualifies local helper/profile selections without
  // connecting or starting a model. Full node admission still runs on startup.
  runtime.loadConfigFromEnv(configured);
  protectDirectory(directory);
  atomicPrivateFile(join(directory, filename), `${JSON.stringify(configuration, null, 2)}\n`);
  output("Team settings saved. Stop and start Artoo to apply them; the saved computer identity is retained.\n");
  return { configured: true };
}
