import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const plainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
export const containsPath = (root, path) => { const part = relative(root, path); return part === "" || (!part.startsWith(`..${sep}`) && part !== ".." && !isAbsolute(part)); };

export function stateDirectory(env = process.env) {
  const directory = env.ARTOO_HOME || join(homedir(), ".artoo", "daemon");
  if (!isAbsolute(directory) || /[\u0000-\u001f]/u.test(directory)) throw Error("ARTOO_HOME must be an absolute local directory.");
  return resolve(directory);
}

function powershell(script, input) {
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop';" + script], {
    input, encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024,
    // PowerShell 7 module paths can prevent Windows PowerShell 5's ACL and
    // cryptography cmdlets from loading. Let the system host build its own path.
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath")),
  });
  // PowerShell errors can embed its input. Never propagate its stderr or argv.
  if (result.error || result.status !== 0) throw Error("Windows could not protect the local Artoo credentials.");
  return result.stdout.trim();
}

export function protectDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  const normalize = value => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(realpathSync(directory)) !== normalize(directory))
    throw Error("Artoo configuration must use a physical directory outside agent workspaces.");
  if (process.platform === "win32") {
    powershell("$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));" +
      "$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[Security.AccessControl.DirectorySecurity]::new();" +
      "$acl.SetOwner($owner);$acl.SetAccessRuleProtection($true,$false);" +
      "foreach($sid in @($owner,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){" +
      "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};" +
      // Set-Acl may request SACL privileges when reapplying a protected DACL.
      // Persist only the owner/access sections that this descriptor changes.
      "[IO.Directory]::SetAccessControl($p,$acl)", Buffer.from(directory).toString("base64"));
  } else {
    if (stat.uid !== process.getuid()) throw Error("Artoo configuration must be owned by the current user.");
    chmodSync(directory, 0o700);
  }
  return directory;
}

export function readPrivateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024)
    throw Error("Invalid local Artoo configuration file.");
  if (process.platform !== "win32" && (stat.uid !== process.getuid() || (stat.mode & 0o077)))
    throw Error("Artoo configuration is readable by other users. Restrict its permissions before continuing.");
  return readFileSync(path);
}

/** Inspect an operator-selected credential without reading it or changing its ACL. */
export function assertPrivateProviderKeyFile(path) {
  const stat = lstatSync(path);
  const normalize = value => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > 4096
    || normalize(realpathSync.native(path)) !== normalize(path))
    throw Error("Provider key requires a bounded physical single-link file.");
  if (process.platform !== "win32") {
    if (stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error("Provider key file must be private to the current user (mode 0600).");
    return;
  }
  try {
    powershell("$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));" +
      "$trusted=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');" +
      "$fileMask=[Security.AccessControl.FileSystemRights]'Read,Write,ExecuteFile,Delete,ChangePermissions,TakeOwnership';" +
      "$parentMask=[Security.AccessControl.FileSystemRights]'DeleteSubdirectoriesAndFiles,Delete,ChangePermissions,TakeOwnership,WriteAttributes,WriteExtendedAttributes';" +
      "$cursor=[IO.FileInfo]::new($p);$first=$true;while($null -ne $cursor){" +
      "$acl=Get-Acl -LiteralPath $cursor.FullName;$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;" +
      "if($trusted -notcontains $owner){throw 'Untrusted credential owner'};" +
      "$raw=[Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(),0);" +
      "if(-not ($raw.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -or $null -eq $raw.DiscretionaryAcl){throw 'Missing credential DACL'};" +
      "foreach($ace in $raw.DiscretionaryAcl){if($ace.AceType -notin @([Security.AccessControl.AceType]::AccessAllowed,[Security.AccessControl.AceType]::AccessDenied)){throw 'Unsupported credential ACE'}};" +
      "$mask=if($first){$fileMask}else{$parentMask};" +
      "foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){" +
      "if($rule.AccessControlType -eq 'Allow' -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) " +
      "-and $trusted -notcontains $rule.IdentityReference.Value -and ($rule.FileSystemRights -band $mask)){throw 'Credential permissions are not private'}};" +
      "$cursor=if($first){$cursor.Directory}else{$cursor.Parent};$first=$false}", Buffer.from(path).toString("base64"));
  } catch { throw Error("Provider key file and its parent paths must have private, trusted Windows permissions; no ACL was changed."); }
}

export function atomicPrivateFile(path, bytes) {
  const temporary = join(dirname(path), `.write-${randomUUID()}`);
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function saveConnection(directory, connection) {
  validateConnection(connection);
  protectDirectory(directory);
  const bytes = Buffer.from(JSON.stringify(connection));
  const protectedBytes = process.platform === "win32"
    ? Buffer.from(powershell("Add-Type -AssemblyName System.Security;" +
      "$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd());" +
      "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))",
    bytes.toString("base64")), "base64") : bytes;
  atomicPrivateFile(join(directory, "connection.dat"), protectedBytes);
}

export function loadConnection(directory) {
  const path = join(directory, "connection.dat");
  if (!existsSync(path)) return null;
  const bytes = readPrivateFile(path);
  let connection;
  try {
    const plain = process.platform === "win32" ? Buffer.from(powershell("Add-Type -AssemblyName System.Security;" +
      "$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd());" +
      "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))",
    bytes.toString("base64")), "base64") : bytes;
    connection = JSON.parse(plain.toString("utf8"));
  } catch { throw Error("Saved Artoo credentials cannot be read by this user."); }
  validateConnection(connection);
  return connection;
}

export function serverOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw Error("Use your Artoo HTTPS website address with --server."); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw Error("--server must be an HTTPS website origin (HTTP is allowed only on localhost).");
  return url.origin;
}

export function validateConnection(connection) {
  const token = value => typeof value === "string" && value.length >= 16 && value.length <= 4096 && !/[\s\u0000-\u001f]/u.test(value);
  const id = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,256}$/u.test(value);
  if (!plainObject(connection) || connection.version !== 1 || connection.origin !== serverOrigin(connection.origin)
    || !id(connection.deviceId) || (connection.computerId !== null && !id(connection.computerId))
    || !token(connection.nodeToken) || (connection.controlToken !== null && !token(connection.controlToken))
    || !Array.isArray(connection.roots) || !connection.roots.length || connection.roots.some(root => typeof root !== "string" || !isAbsolute(root) || /[,;\u0000-\u001f]/u.test(root))
    || !Array.isArray(connection.runtimes) || connection.runtimes.some(runtime => !["codex", "claude-code"].includes(runtime))
    || (connection.codexBinary !== null && (typeof connection.codexBinary !== "string" || !isAbsolute(connection.codexBinary))))
    throw Error("Saved Artoo connection is invalid. No connection was attempted.");
  return connection;
}

export function prepareWorkspace(path, state, packageDirectory) {
  if (typeof path !== "string" || !isAbsolute(path) || /[,;\u0000-\u001f]/u.test(path)) throw Error("--workspace must be an absolute local directory without commas, semicolons or control characters.");
  const selected = resolve(path);
  // Protect credentials and installed executable files from task write scopes.
  if (containsPath(selected, state) || containsPath(selected, packageDirectory) || containsPath(state, selected))
    throw Error("Choose a workspace outside the Artoo configuration and installation directories.");
  mkdirSync(selected, { recursive: true });
  const physical = realpathSync(selected);
  if (/[,;\u0000-\u001f]/u.test(physical)) throw Error("The workspace resolves to a path containing commas, semicolons or control characters.");
  if (containsPath(physical, state) || containsPath(physical, packageDirectory) || containsPath(state, physical))
    throw Error("The workspace resolves into the Artoo configuration or installation.");
  return physical;
}

export function discoverRuntimes(env = process.env) {
  const paths = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1]?.split(delimiter).filter(isAbsolute) ?? [];
  const find = name => {
    for (const directory of paths) for (const extension of process.platform === "win32" ? [".exe", ".cmd", ""] : [""]) {
      const path = join(directory, name + extension);
      try {
        if (!lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) continue;
        accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        if (extension === ".cmd" && !/["']%dp0%[\\/]([^"'\r\n]+\.(?:c?js|mjs))["']/i.test(readFileSync(path, "utf8"))) continue;
        return realpathSync(path);
      } catch { /* Continue across missing PATH entries. */ }
    }
    return null;
  };
  const codexBinary = find("codex"), claudeBinary = find("claude");
  return { codexBinary, runtimes: [...(codexBinary ? ["codex"] : []), ...(claudeBinary ? ["claude-code"] : [])] };
}

export function connectionEnvironment(connection, base = process.env) {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !/^ARTOO_/i.test(key)));
  const url = new URL("/api/v1/node", connection.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", connection.nodeToken);
  return { ...env, ARTOO_NODE_URL: url.href, ARTOO_NODE_ID: connection.computerId,
    ARTOO_ALLOWED_ROOTS: connection.roots.join(";"), ARTOO_RUNTIMES: connection.runtimes.length ? connection.runtimes.join(",") : "none",
    ...(connection.codexBinary ? { ARTOO_CODEX_BINARY: connection.codexBinary } : {}) };
}
