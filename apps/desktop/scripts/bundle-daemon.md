# Desktop daemon bundle

The existing `npm run bundle-daemon --workspace @artoo/desktop` command keeps its default destination, `apps/desktop/daemon`. The script can also be imported without starting a build:

```js
await buildDaemon({
  repoRoot: "C:/workspace/artoo",
  outputDirectory: "C:/builds/new-artoo-daemon",
  // Optional: a genuine, previously validated Windows x64 helper bundle.
  windowsProcessBundle: {
    directory: "C:/protected/artoo-windows-process",
    manifestSha256: "sha256:<exact 64 lowercase hex characters>",
  },
});
```

Custom output directories must be new, and their parent must already exist and use its physical path. For a candidate script stored outside its eventual repository path, always supply `repoRoot`, for example:

```powershell
node apps/desktop/scripts/bundle-daemon.mjs --repo-root C:/workspace/artoo --output-directory C:/builds/new-artoo-daemon
```

The CLI also accepts the paired local build options `--windows-process-bundle` and `--windows-process-manifest-sha256`. These select build inputs; they do not enable a node, grant runtime authority, install a service, sign an application or publish anything. Native helper input is accepted only on an actual Windows x64 host. The helper's manifest, complete member set, sizes and hashes are checked before copying and checked again after copying. No fake executable is generated. The copy is under `daemon/native/windows-process`; runtime installation qualification and local configuration remain separate.

The output contains `artood.mjs`, the existing CommonJS `journal-worker.js`, and executable CommonJS `workspace-tools-mcp.js`, `research-mcp.js` and `web-acceptance-cli.js`. The CommonJS files use a filename-derived `import.meta.url` replacement. A bundle-local `package.json` fixes `.js` interpretation even when custom output is beneath an ESM package. The verifier's installed-CLI reference is relocated during bundling to its real sibling. Source text is not edited, and a changed relocation expression fails the build.

`playwright` and `playwright-core` are external modules. Their complete installed package directories, including runtime resources and package metadata, are copied to `daemon/node_modules`. The exact version must match artood's pinned dependency, the lockfile and both installed packages. A child process loads both packaged modules, checks their resolution stays inside this bundle, loads `browsers.json` and imports the daemon. Browser executables in external Playwright caches are not bundled or downloaded; a configured browser installation is still required for browser acceptance.

A build runs in a new sibling staging directory under an exclusive build lock. It does not overwrite existing output files. A recognized previous default output is moved to a unique `.daemon.previous-*` backup only after the new package and its runtime imports validate. Backups are retained. The initial legacy output may contain only `artood.mjs` and optional `journal-worker.js`; other unrecognized files block replacement. A failed final rename restores the old directory if the output name is free. If another actor occupies that name, the previous directory remains in its backup and is never overwritten. Failed staging directories are retained for diagnosis. Cleanup of old backups, retained staging or an abandoned lock is an explicit operator action, after verifying the named paths and ensuring no build is active.

On Windows, only an `EPERM` from the final staging-to-output rename is eligible for retry. The same stage is tried at most five times, with 50/100/200/400 ms waits and one monotonic 2000 ms retry deadline starting at the first rejection. Every retry checks the physical directory identity, the complete staged tree including its manifest, and an absent destination before committing. A new destination, altered stage, validation failure, other error (including `EACCES` or `EBUSY`), or exhausted budget fails closed and retains the original error chain. Filesystem calls remain synchronous and are not cancellable; the deadline is checked at boundaries and is not a hard wall-clock limit on a blocked filesystem call. Backup restoration and retention rules above still apply. The isolated Windows lock regression uses the system Windows PowerShell to hold a fixture file without delete sharing and verifies the original child's actual exit, close, and both EOFs. This reproduces a real `EPERM` boundary, not the identity of a past build's lock holder.

On Windows the runtime import probe uses the bundle's parent as its working directory and resolves modules from the absolute bundle path. This avoids the process working-directory limit for long staging names; the parent must still be a supported working directory.

Run the packaging regression from the repository root, or set `ARTOO_BUNDLE_TEST_REPO_ROOT` to that root:

```powershell
node --test apps/desktop/scripts/bundle-daemon.test.mjs
```

The tests build into new temporary output, load actual packaged dependencies, execute both MCP initialize handlers, validate a protected profile against the actual packaged verifier path, run that CLI's missing-context gate, and boot the CommonJS journal worker with deliberately invalid input. Separate controlled source and filesystem-failure fixtures check restoration and backup behavior. They do not execute a provider, publish a product or establish signed distribution qualification. An optional native-copy case requires both `ARTOO_BUNDLE_TEST_WINDOWS_PROCESS_DIR` and `ARTOO_BUNDLE_TEST_WINDOWS_PROCESS_MANIFEST_SHA256`, pointing to a genuine previously validated bundle. Without those values it is explicitly skipped; no synthetic Windows helper substitutes for it.
