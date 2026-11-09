# Native Windows Console launcher

`Start-ArtooDaily.ps1` provides the Console entry for the adjacent `start.mjs` and the retained-product entry for `reopen.mjs`. It requires PowerShell 7.5 or later and native Windows. PowerShell 7.5 uses the .NET version needed to preserve an environment variable that exists with an empty value. It does not install or qualify a product, start a second controller, submit a second goal, or add a GUI. The selected Node entry owns publication hold, original stdin shutdown and process-closure checks described in `README.md`.

A maintainer first prepares installation metadata from the final reviewed candidate and its matching successful normal run, and validates this delivered entry with a separate real daily run. Do not copy private installation JSON, credentials, sessions or evidence into Git. The original three-file Console draft remains retained outside this combined source as audit evidence. The adjacent entry includes the coordinated browser revision and requires matching Web/server code and evidence.

## Use after installation qualification

The default configuration is `%LOCALAPPDATA%\Artoo\windows-local-request\LOCAL-INSTALLATION.json`. The launcher never chooses Node from PATH: it checks the configuration's installation-manifest pin, reads `programs.node` from that manifest, and checks its path, length and SHA-256 before direct invocation. These pins are trusted local installation metadata, not signatures. The Node entry still validates the complete runtime trees, other executable pins, private session roots and exact authorization before starting work.

A maintainer may select the optional versioned `product` application mode described in `README.md`. The strict configuration and installation schemas admit its exact fields; the Node entry checks every application tool pin and complete dependency tree before local profile admission. No end-user mode, profile or command argument is added. An omitted `product` retains the static Web flow. Development delivers a verified workspace; publication runs the configured bounded local application. The original source supervisor remains specific to static Web; application mode uses the existing daemon IPC owner protocol and native ownership for each operation. It does not claim shared-supervisor recovery.

```powershell
& .\scripts\windows-local-request\Start-ArtooDaily.ps1
```

With no requirement argument it asks once for the objective. The prompt uses UTF-8 standard input/output and restores the caller's Console encodings before invoking Node. A maintainer can instead select another prepared configuration or supply an objective/file:

```powershell
& .\scripts\windows-local-request\Start-ArtooDaily.ps1 -Config '<prepared absolute configuration path>' -Objective 'Build a browser notes app that retains notes after reload.'
& .\scripts\windows-local-request\Start-ArtooDaily.ps1 -ObjectiveFile '<absolute UTF-8 requirement file>'
```

Use `&`, not dot-sourcing. The configuration path must already exist; there are no username, executable or installation-path placeholders inside the script. File input is useful for longer or multiline requirements. The script forces PowerShell's standard native argument passing and accepts no arbitrary Node/entry/shell arguments.

When installed together with the reviewed browser runtime, matching Web/server revision and qualified local development Web build, use `-BrowserInput`. This switch is mutually exclusive with `-Objective` and `-ObjectiveFile`: the launcher asks for no requirement and forwards only `--browser-input`. The browser then owns the only requirement submission. Install these components as one matching version; a standalone launcher does not add browser capability to an older runtime.

```powershell
& .\scripts\windows-local-request\Start-ArtooDaily.ps1 -BrowserInput
```

## Open a retained product

After the original daily session has published and stopped successfully, select its absolute session directory, `RESULT.json`, or `PUBLISHED.json`:

```powershell
& .\scripts\windows-local-request\Start-ArtooDaily.ps1 -OpenProduct '<absolute original session directory>'
& .\scripts\windows-local-request\Start-ArtooDaily.ps1 -OpenProduct '<absolute original session directory>\PUBLISHED.json'
```

This mode asks for no requirement and is mutually exclusive with `-Objective`, `-ObjectiveFile` and `-BrowserInput`. It selects the original configuration from the sibling `RESULT.json`'s `configuration` pin and verifies that pin before selecting the installed Node. It does not use the current default configuration. An optional `-Config` must name that same original configuration path; a different configuration is rejected even if its contents match. Selection paths must be normalized absolute Windows paths with no links or reparse points in the selected path or its parents.

`-OpenProduct` is only for qualified static Web sessions. Application configuration and retained application results reject it. The application's one normal same-database reopen occurs inside its original bounded publication; this launcher does not add another service generation after shutdown.

The launcher directly invokes the adjacent `reopen.mjs --product <selected path> --config <original configuration> --stdin-control` with the selected Node. The result record only selects the configuration at this stage: the real reopen entry must validate the complete stopped publication, retained product and installation bindings before serving it. Passing launcher checks or a controlled test is not product validation. This operation opens the retained product; it does not resume a goal or generate a new product. Keep the original process open and use the same stdin shutdown protocol below.

The publisher continues the health monitoring and withdrawal policies authorized by its original protected profile. Monitoring may update health journals and `current.json`. If the selected product is withdrawn or the current selection changes, reopening must fail and retain evidence from before and after the change. Reopening does not start the old goal, agents, source-recovery or clean workflow; this boundary does not disable the publisher's existing monitoring actions.

## Credential and environment behavior

For new requirements, an existing process `ARTOO_CODEX_PROVIDER_KEY` takes precedence. If present but empty or invalid, startup is rejected; it does not fall back to another identity. Only when the variable is absent may the launcher read the existing `%APPDATA%\aerial\api_key` file. Trailing file line endings are removed, but internal line breaks/NUL or an empty credential are rejected. If neither source exists, it leaves the key unset, preserving the Node entry's support for a provider that needs no credential; actual provider failure is not hidden.

For `-OpenProduct`, the launcher does not read or validate the process credential, inspect the Aerial credential file, or change the caller's credential environment. The production reopen entry deletes its own inherited credential without reading its value. This mode needs no model credential.

The credential is never a command-line argument, log line or installation-manifest field. Both modes temporarily remove `NODE_OPTIONS` and `NODE_PATH` before starting the root Node process, preventing preloads before installation checks. A `finally` block restores their original process presence and values, including present empty values, after success or a nonzero Node exit. New-requirement modes also restore the original credential presence/value. Forced termination of the PowerShell host cannot guarantee that `finally` ran. The launcher does not change Aerial files or machine/user environment settings.

## Hold and stop

Keep the original console open after publication. To stop, send this complete line on that same stdin and press Enter:

```json
{"version":1,"kind":"shutdown"}
```

The launcher directly invokes the original Node entry and returns its exit code. It does not convert an early EOF, timeout, force kill or missing closure into success. Ctrl+C and long-lived background hosting remain separate qualification scopes. A stopped local publisher is not permanent hosting.

For application mode, the same input first fences unfinished GoalRunner work and requests the formal application stop API. It then sends shutdown on the original daemon IPC channel with its unique launch ID and observes the original stopped message, disconnection, process exit/close and both output EOFs. A `draining` status means stop is still pending. Historical URLs and a successful HTTP stop response cannot replace actual original-owner closure.

## Regression and delivery checks

The prepared controlled launcher suite is run separately from workspace Vitest:

```powershell
node --test scripts/windows-local-request/launcher.test.mjs
```

It uses real PowerShell/Node with explicitly fake `start.mjs` and `reopen.mjs` entries, isolated local configuration and fixture credentials. It covers quoted arguments, file input, mutually exclusive browser delegation without an objective prompt, config/Node rejection, credential precedence/fallback and restoration, Windows key-name case behavior, present empty Node environment values, root-preload isolation, nonzero exit propagation, and one interactive prompt followed by shutdown on the same stdin. Reopen cases cover all three selection forms, original configuration pins and override rejection, mutually exclusive modes, no objective prompt, the original stdin, selected Node, caller environment preservation and independence from invalid credential files/values. Their minimal synthetic result records exercise only launcher configuration selection, not the real reopen validator. Non-Windows runs skip this Windows-only suite. Missing PowerShell 7.5+ is a failed prerequisite on Windows. The suite does not call Aerial or qualify the product runtime or browser submission. Timed-out fixtures retain their files rather than claiming process cleanup.

On 2026-11-07, the launcher, entry-preflight and reopen-input suites passed all 164 controlled tests with no skips and actual process exit 0. The backend suites passed 29 tests, including actual HTTP withdrawal during startup and observation with the existing publisher executor; native installation admission and original closure records were explicitly controlled. Workspace type checking passed. These checks do not establish live-provider or installed-product acceptance. The earlier baseline's 24 tests and separate terminal fixture remain historical evidence; failed attempts and their input versions are retained.

Actual delivery still requires a matching final build/normal result, real daily one-demand execution, publication hold, original shutdown and observed process closure. Web input must own the only objective submission and be validated through its actual installed local-development page; the Console mode must not submit an additional goal.

Retained-product delivery additionally requires real reopen validation against that successful stopped session, HTTP product checks, hold and the new process's original stdin shutdown and observed closure. A successful fake reopen entry cannot provide that evidence.
