// Run after building: node --test scripts/npm-daemon/temporary-context-real.test.mjs
// Exercises the existing Windows private-context guard with real inherited ACLs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { readWindowsBrowserPrivateContext } from "../../apps/artood/dist/windows-browser-private-context.js";
import { launchManagedRuntime } from "./cli.mjs";
import { protectDirectory } from "./local-config.mjs";
import { teamConfigurationEnvironment, validateTeamConfiguration } from "./team-config.mjs";

test("selected temporary root admits real private contexts while unsafe inherited storage still fails the original Windows guard",
  { skip: process.platform !== "win32", timeout: 60_000 }, async t => {
    const home = realpathSync.native(homedir()), root = protectDirectory(mkdtempSync(join(home, ".artoo-context-temp-test-")));
    const temporaryKeys = /^(?:TMP|TEMP|TMPDIR)$/i;
    const before = Object.fromEntries(Object.entries(process.env).filter(([key]) => temporaryKeys.test(key)));
    t.after(() => {
      for (const key of Object.keys(process.env)) if (temporaryKeys.test(key)) delete process.env[key];
      Object.assign(process.env, before);
      assert.ok(realpathSync.native(root).startsWith(`${home}${sep}.artoo-context-temp-test-`));
      rmSync(root, { recursive: true });
    });
    const safe = protectDirectory(join(root, "selected")), unsafeParent = protectDirectory(join(root, "untrusted-ancestor"));
    const inherited = protectDirectory(join(unsafeParent, "inherited")), workspace = join(root, "workspace"); mkdirSync(workspace);
    // Controlled fixture replaces any assumption about this computer's AppData ACL.
    const grant = spawnSync(join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop';" +
        "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()));$acl=Get-Acl -LiteralPath $p;" +
        "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'DeleteSubdirectoriesAndFiles','Allow'));" +
        "[IO.Directory]::SetAccessControl($p,$acl)"], { input: Buffer.from(unsafeParent).toString("base64"),
        encoding: "utf8", windowsHide: true, timeout: 15_000,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath")) });
    assert.ifError(grant.error); assert.equal(grant.status, 0, grant.stderr); assert.equal(grant.signal, null);
    const context = () => {
      const directory = mkdtempSync(join(tmpdir(), "artoo-verification-context-")), file = join(directory, "context.json");
      const bytes = Buffer.from('{"synthetic":"private-context"}'); writeFileSync(file, bytes, { mode: 0o400 });
      return { file, bytes, checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
    };
    for (const key of Object.keys(process.env)) if (temporaryKeys.test(key)) delete process.env[key];
    Object.assign(process.env, { TMP: inherited, TEMP: inherited, TMPDIR: inherited });
    await launchManagedRuntime({}, async () => {
      assert.equal(tmpdir(), inherited);
      const rejected = context();
      assert.throws(() => readWindowsBrowserPrivateContext(rejected.file, rejected.checksum), /another principal can read, modify or replace/);
      return {};
    });
    assert.throws(() => validateTeamConfiguration({ version: 1, temporary_directory: inherited }, [workspace]), /Audit: ancestor_replacement_grant\./);
    const selected = teamConfigurationEnvironment(validateTeamConfiguration({ version: 1, temporary_directory: safe }, [workspace]));
    const node = await launchManagedRuntime(selected, async () => {
      assert.equal(tmpdir(), safe);
      const accepted = context();
      assert.deepEqual(readWindowsBrowserPrivateContext(accepted.file, accepted.checksum), accepted.bytes);
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import {mkdtempSync,writeFileSync} from 'node:fs'; import {tmpdir} from 'node:os'; import {join} from 'node:path';
        import {createHash} from 'node:crypto';
        import {readWindowsBrowserPrivateContext} from ${JSON.stringify(new URL("../../apps/artood/dist/windows-browser-private-context.js", import.meta.url).href)};
        const directory=mkdtempSync(join(tmpdir(),'artoo-verification-context-')),file=join(directory,'context.json'),bytes=Buffer.from('{}');
        writeFileSync(file,bytes,{mode:0o400});
        readWindowsBrowserPrivateContext(file,'sha256:'+createHash('sha256').update(bytes).digest('hex'));
        process.stdout.write(tmpdir());
      `], { encoding: "utf8", windowsHide: true, timeout: 15_000 });
      assert.ifError(child.error); assert.equal(child.status, 0, child.stderr); assert.equal(child.signal, null); assert.equal(child.stdout, safe);
      return { stop: async () => {} };
    });
    await node.stop();
    assert.equal(tmpdir(), inherited);
  });
