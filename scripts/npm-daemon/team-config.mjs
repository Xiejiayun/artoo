import { spawnSync } from "node:child_process";
import { lstatSync, opendirSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPrivateProviderKeyFile, atomicPrivateFile, connectionEnvironment, containsPath, loadConnection, protectDirectory, readPrivateFile, stateDirectory } from "./local-config.mjs";
import { disableOptionalWebSocketAddons, packagedWindowsProcessEnvironment } from "./verify.mjs";

const filename = "team-config.json";
const fields = ["version", "research_receipts_directory", "verification_profiles_file", "temporary_directory", "initialize_repository", "codex"];
const normalize = path => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
const temporaryAuditCodes = new Set([
  "collector_error", "input_decode_failed", "identity_read_failed", "volume_inspection_failed", "path_attributes_failed",
  "acl_read_failed", "descriptor_read_failed", "local_ntfs_required", "path_kind_changed", "untrusted_owner",
  "noncanonical_dacl", "missing_dacl", "acl_entry_limit", "unsupported_ace", "ancestor_replacement_grant",
  "private_effective_grant", "private_future_child_grant",
]);

/** Fixed collector protocol only: never expose process errors, stderr or arbitrary stdout. */
export function classifyTemporaryDirectoryAudit(result) {
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") return "collector_timeout";
    if (result.error.code === "ENOBUFS") return "collector_output_limit";
    return "collector_spawn_failed";
  }
  if (result.signal !== null) return "collector_signaled";
  const code = typeof result.stdout === "string" && /^[a-z_]+\r?\n$/.test(result.stdout)
    ? result.stdout.replace(/\r?\n$/, "") : undefined;
  if (result.status === 0) return code === "ok" ? null : "collector_protocol_failed";
  if (result.status === 1 && temporaryAuditCodes.has(code)) return code;
  return "collector_exit_failed";
}

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

/** Inspect selected state without copying credentials, changing ACLs or reading its contents. */
function codexHome(path, roots) {
  if (process.platform === "win32" && (typeof path !== "string" || !/^[a-z]:[\\/]/i.test(path)))
    throw Error("Codex home_directory must be an absolute local disk directory.");
  const home = physicalPath(path, "directory", roots), entries = [];
  let pathBytes = 0;
  const visit = (path, depth) => {
    if (depth > 32 || entries.length >= 2048 || (pathBytes += Buffer.byteLength(path)) > 1024 * 1024)
      throw Error("Codex home_directory exceeds the bounded state inspection limit.");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
      || normalize(realpathSync.native(path)) !== normalize(path))
      throw Error("Codex home_directory contents must be physical directories and single-link files without links.");
    entries.push({ path, stat });
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name), depth + 1);
  };
  visit(home, 0);
  const ancestors = [];
  for (let cursor = dirname(home); ; cursor = dirname(cursor)) {
    ancestors.push(cursor);
    if (dirname(cursor) === cursor) break;
  }
  if (process.platform !== "win32") {
    for (const { stat } of entries) if (stat.uid !== process.getuid() || (stat.mode & 0o077))
      throw Error("Codex home_directory and its contents must be private to the current user (directories 0700, files 0600).");
    for (const path of ancestors) {
      const stat = lstatSync(path);
      if (![0, process.getuid()].includes(stat.uid) || (stat.mode & 0o022))
        throw Error("Codex home_directory ancestors must have trusted ownership and no group or other write permission.");
    }
  } else {
    // Same trusted Windows principals and raw-ACE checks as private provider keys.
    // Inspect the bounded tree once per configuration/start, never per model task.
    const script = "$ErrorActionPreference='Stop';" +
      "$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))|ConvertFrom-Json;" +
      "if(([IO.DriveInfo]::new([IO.Path]::GetPathRoot($v.home))).DriveType -ne 'Fixed'){throw 'Local fixed disk required'};" +
      "$trusted=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');" +
      "$parentMask=[Security.AccessControl.FileSystemRights]'DeleteSubdirectoriesAndFiles,Delete,ChangePermissions,TakeOwnership,WriteAttributes,WriteExtendedAttributes';" +
      "foreach($item in $v.paths){$acl=Get-Acl -LiteralPath $item.path;$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;" +
      "if($trusted -notcontains $owner){throw 'Untrusted home owner'};" +
      "$raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0);" +
      "if(-not ($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -or $null -eq $raw.DiscretionaryAcl){throw 'Missing home DACL'};" +
      "foreach($ace in $raw.DiscretionaryAcl){" +
      "if($ace.AceType -notin @([Security.AccessControl.AceType]::AccessAllowed,[Security.AccessControl.AceType]::AccessDenied)){throw 'Unsupported home ACE'};" +
      "if($ace.AceType -eq [Security.AccessControl.AceType]::AccessAllowed -and -not ([int]$ace.AceFlags -band [int][Security.AccessControl.AceFlags]::InheritOnly) " +
      "-and $trusted -notcontains $ace.SecurityIdentifier.Value -and ([long]$ace.AccessMask -band [long]4026531840)){throw 'Untrusted generic home rights'}};" +
      "$mask=if($item.ancestor){$parentMask}else{[Security.AccessControl.FileSystemRights]::FullControl};" +
      "foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){" +
      "if($rule.AccessControlType -eq 'Allow' -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) " +
      "-and $trusted -notcontains $rule.IdentityReference.Value -and ($rule.FileSystemRights -band $mask)){throw 'Home permissions are not private'}}}";
    const input = { home, paths: [...entries.map(({ path }) => ({ path, ancestor: false })), ...ancestors.map(path => ({ path, ancestor: true }))] };
    const result = spawnSync(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", script], { input: Buffer.from(JSON.stringify(input)).toString("base64"),
        encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath")) });
    if (result.error || result.status !== 0)
      throw Error("Codex home_directory, contents and ancestors must have private, trusted Windows permissions; no ACL was changed.");
  }
  for (const { path, stat } of entries) {
    const after = lstatSync(path);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.isSymbolicLink() || after.mode !== stat.mode
      || normalize(realpathSync.native(path)) !== normalize(path)) throw Error("Codex home_directory changed during inspection.");
  }
  return home;
}

/** A selected temporary root must protect existing state and future private children. */
function temporaryDirectory(path, roots) {
  if (process.platform === "win32" && (typeof path !== "string" || !/^[a-z]:[\\/]/i.test(path)))
    throw Error("Team temporary_directory must be an absolute local disk directory.");
  // The downstream private-context guard binds the exact physical spelling,
  // including Windows drive/name casing; save that spelling rather than input.
  const directory = realpathSync.native(physicalPath(path, "directory", roots)), entries = [];
  let pathBytes = 0;
  const inspect = (path, ancestor = false) => {
    if (entries.length >= 2048 || (pathBytes += Buffer.byteLength(path)) > 1024 * 1024)
      throw Error("Team temporary_directory exceeds the bounded state inspection limit.");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (ancestor ? !stat.isDirectory() : !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
      || normalize(realpathSync.native(path)) !== normalize(path))
      throw Error("Team temporary_directory requires physical directories and single-link files without links.");
    entries.push({ path, stat, ancestor });
    return stat;
  };
  const visit = (path, depth) => {
    if (depth > 32)
      throw Error("Team temporary_directory exceeds the bounded state inspection limit.");
    if (inspect(path).isDirectory()) {
      const handle = opendirSync(path);
      try { for (let entry; (entry = handle.readSync()); ) visit(join(path, entry.name), depth + 1); }
      finally { handle.closeSync(); }
    }
  };
  visit(directory, 0);
  for (let cursor = dirname(directory); ; cursor = dirname(cursor)) {
    inspect(cursor, true);
    if (dirname(cursor) === cursor) break;
  }
  if (process.platform !== "win32") {
    for (const { stat, ancestor } of entries) {
      if (ancestor) {
        if (![0, process.getuid()].includes(stat.uid) || (stat.mode & 0o022))
          throw Error("Team temporary_directory ancestors must have trusted ownership and no group or other write permission.");
      } else if (stat.uid !== process.getuid() || !(stat.isDirectory() ? [0o700] : [0o400, 0o600]).includes(stat.mode & 0o7777)) {
        throw Error("Team temporary_directory and its contents must be private to the current user (directories 0700, files 0400 or 0600).");
      }
    }
  } else {
    // Raw ACEs include inherit-only grants: an empty directory must not grant
    // another principal access to the private context a future task creates.
    const script = "$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$script:code='collector_error';" +
      "function Reject([string]$code){$script:code=$code;throw 'Rejected'};try{$script:code='input_decode_failed';" +
      "$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))|ConvertFrom-Json;" +
      "$script:code='identity_read_failed';" +
      "$trusted=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');" +
      "foreach($item in $v.paths){$script:code='volume_inspection_failed';$drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($item.path));" +
      "if($drive.DriveType -ne 'Fixed' -or $drive.DriveFormat -ne 'NTFS'){Reject 'local_ntfs_required'};" +
      "$script:code='path_attributes_failed';$attributes=[IO.File]::GetAttributes($item.path);" +
      "if(([int]$attributes -band 1024) -or (([int]$attributes -band 16) -ne 0) -ne $item.directory){Reject 'path_kind_changed'};" +
      "$script:code='acl_read_failed';$acl=Microsoft.PowerShell.Security\\Get-Acl -LiteralPath $item.path;" +
      "$script:code='descriptor_read_failed';if($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value){Reject 'untrusted_owner'};" +
      "if(-not $acl.AreAccessRulesCanonical){Reject 'noncanonical_dacl'};" +
      "$raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0);" +
      "if(-not ($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -or $null -eq $raw.DiscretionaryAcl){Reject 'missing_dacl'};" +
      "if($raw.DiscretionaryAcl.Count -gt 256){Reject 'acl_entry_limit'};" +
      "foreach($ace in $raw.DiscretionaryAcl){$flags=[int]$ace.AceFlags;" +
      "if(-not ($ace -is [Security.AccessControl.CommonAce]) -or $ace.IsCallback -or $flags -lt 0 -or $flags -gt 31 " +
      "-or $ace.AceType -notin @([Security.AccessControl.AceType]::AccessAllowed,[Security.AccessControl.AceType]::AccessDenied)){Reject 'unsupported_ace'};" +
      "if($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or $trusted -contains $ace.SecurityIdentifier.Value){continue};" +
      "$mask=[long]$ace.AccessMask -band [long]4294967295;$effective=($flags -band 8) -eq 0;$futureChild=$item.directory -and ($flags -band 3) -ne 0;" +
      // Private FullControl + all generic rights; ancestor replacement matches
      // windows-local-acl.ts and permits ordinary read/sibling creation grants.
      "if($item.ancestor -and $effective -and ($mask -band [long]1343029586)){Reject 'ancestor_replacement_grant'};" +
      "if(-not $item.ancestor -and ($mask -band [long]4028563967)){" +
      "if($effective){Reject 'private_effective_grant'};if($futureChild){Reject 'private_future_child_grant'}}}};" +
      "[Console]::Out.WriteLine('ok');exit 0}catch{[Console]::Out.WriteLine($script:code);exit 1}";
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    const result = spawnSync(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", script], {
        input: Buffer.from(JSON.stringify({ paths: entries.map(({ path, stat, ancestor }) => ({ path, directory: stat.isDirectory(), ancestor })) })).toString("base64"),
        encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024,
        env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: join(systemRoot, "System32"),
          PSModulePath: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules") },
      });
    const failure = classifyTemporaryDirectoryAudit(result);
    if (failure)
      throw Error(`Team temporary_directory, contents and ancestors require local fixed NTFS storage and private, trusted Windows permissions; no ACL was changed. Audit: ${failure}.`);
  }
  for (const { path, stat } of entries) {
    const after = lstatSync(path);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.mode !== stat.mode || after.uid !== stat.uid
      || after.nlink !== stat.nlink || after.isSymbolicLink() || normalize(realpathSync.native(path)) !== normalize(path))
      throw Error("Team temporary_directory changed during inspection.");
  }
  return directory;
}

function codexConfiguration(value, roots) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["model", "provider_url", "provider_key_file", "home_directory"].includes(key))
    || (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim() || value.model.length > 200 || /[\u0000-\u001f\u007f]/u.test(value.model))))
    throw Error("Invalid Codex configuration. Use only model, provider_url, provider_key_file and home_directory.");
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
    ...(value.home_directory !== undefined ? { home_directory: codexHome(value.home_directory, roots) } : {}),
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
    ...(value.temporary_directory !== undefined ? { temporary_directory: temporaryDirectory(value.temporary_directory, roots) } : {}),
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
    ...(configuration.temporary_directory ? { ARTOO_MANAGED_TEMPORARY_DIRECTORY: configuration.temporary_directory,
      TMP: configuration.temporary_directory, TEMP: configuration.temporary_directory, TMPDIR: configuration.temporary_directory } : {}),
    ...(configuration.research_receipts_directory ? { ARTOO_RESEARCH_ENABLED: "1",
      ARTOO_RESEARCH_RECEIPTS_DIR: configuration.research_receipts_directory } : {}),
    ...(configuration.verification_profiles_file ? { ARTOO_VERIFICATION_PROFILES_FILE: configuration.verification_profiles_file,
      ...(process.platform === "win32" ? packagedWindowsProcessEnvironment(release) : {}) } : {}),
    ...(configuration.initialize_repository === true ? { ARTOO_INITIALIZE_REPOSITORY: "1" } : {}),
    ...(configuration.codex?.model ? { ARTOO_CODEX_MODEL: configuration.codex.model } : {}),
    ...(configuration.codex?.provider_url ? { ARTOO_CODEX_PROVIDER_URL: configuration.codex.provider_url } : {}),
    ...(configuration.codex?.home_directory ? { CODEX_HOME: configuration.codex.home_directory } : {}),
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
  const cleanBase = cleanSelectedEnvironment(base, configuration);
  return { ...connectionEnvironment(connection, cleanBase), ...teamConfigurationEnvironment(configuration, release), ...providerKey(configuration) };
}

function cleanSelectedEnvironment(base, configuration) {
  return Object.fromEntries(Object.entries(base).filter(([key]) => !/^(?:NODE_OPTIONS|NODE_PATH)$/i.test(key)
    && !(configuration.codex?.home_directory && /^CODEX_HOME$/i.test(key))
    && !(configuration.temporary_directory && /^(?:TMP|TEMP|TMPDIR)$/i.test(key))));
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
  const home = configuration.codex?.home_directory;
  if (home && readdirSync(home).length) {
    // Only the already saved selection may contain runtime-created state. A new
    // selection cannot silently import an operator's global tools or credentials.
    let saved;
    try { saved = JSON.parse(readPrivateFile(join(directory, filename)).toString("utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw Error("Saved team settings could not qualify the existing Codex home_directory."); }
    if (typeof saved?.codex?.home_directory !== "string" || normalize(saved.codex.home_directory) !== normalize(home))
      throw Error("A newly selected Codex home_directory must be empty; do not copy global settings or credentials.");
  }
  const temporary = configuration.temporary_directory;
  if (temporary && readdirSync(temporary).length) {
    let saved;
    try { saved = JSON.parse(readPrivateFile(join(directory, filename)).toString("utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw Error("Saved team settings could not qualify the existing temporary_directory."); }
    if (typeof saved?.temporary_directory !== "string" || normalize(saved.temporary_directory) !== normalize(temporary))
      throw Error("A newly selected temporary_directory must be empty; use a dedicated private directory.");
  }
  const configured = { ...connectionEnvironment(connection, cleanSelectedEnvironment(env, configuration)), ...teamConfigurationEnvironment(configuration, release),
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
