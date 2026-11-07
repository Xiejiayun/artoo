# Native Windows Console launcher

`Start-ArtooDaily.ps1` provides the Console entry for the adjacent `start.mjs`. It requires PowerShell 7.5 or later and native Windows. PowerShell 7.5 uses the .NET version needed to preserve an environment variable that exists with an empty value. It does not install or qualify a product, start a second controller, submit a second goal, or add a GUI. The existing entry owns the one goal, publication hold, original stdin shutdown and process-closure checks described in `README.md`.

A maintainer first prepares installation metadata from the final reviewed candidate and its matching successful normal run, and validates this delivered entry with a separate real daily run. Do not copy private installation JSON, credentials, sessions or evidence into Git. The original three-file Console draft remains retained outside this combined source as audit evidence. The adjacent entry includes the coordinated browser revision and requires matching Web/server code and evidence.

## Use after installation qualification

The default configuration is `%LOCALAPPDATA%\Artoo\windows-local-request\LOCAL-INSTALLATION.json`. The launcher never chooses Node from PATH: it checks the configuration's installation-manifest pin, reads `programs.node` from that manifest, and checks its path, length and SHA-256 before direct invocation. These pins are trusted local installation metadata, not signatures. The Node entry still validates the complete runtime trees, other executable pins, private session roots and exact authorization before starting work.

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

## Credential and environment behavior

An existing process `ARTOO_CODEX_PROVIDER_KEY` takes precedence. If present but empty or invalid, startup is rejected; it does not fall back to another identity. Only when the variable is absent may the launcher read the existing `%APPDATA%\aerial\api_key` file. Trailing file line endings are removed, but internal line breaks/NUL or an empty credential are rejected. If neither source exists, it leaves the key unset, preserving the Node entry's support for a provider that needs no credential; actual provider failure is not hidden.

The credential is never a command-line argument, log line or installation-manifest field. `NODE_OPTIONS` and `NODE_PATH` are temporarily removed before starting the root Node process, preventing preloads before installation checks. A `finally` block restores their original process presence and values, including present empty values, and the original credential presence/value, including after a nonzero Node exit. Forced termination of the PowerShell host cannot guarantee that `finally` ran. The launcher does not change Aerial files or machine/user environment settings.

## Hold and stop

Keep the original console open after publication. To stop, send this complete line on that same stdin and press Enter:

```json
{"version":1,"kind":"shutdown"}
```

The launcher directly invokes the original Node entry and returns its exit code. It does not convert an early EOF, timeout, force kill or missing closure into success. Ctrl+C and long-lived background hosting remain separate qualification scopes. A stopped local publisher is not permanent hosting.

## Regression and delivery checks

The prepared controlled launcher suite is run separately from workspace Vitest:

```powershell
node --test scripts/windows-local-request/launcher.test.mjs
```

It uses real PowerShell/Node with an explicitly fake entry, isolated local configuration and fixture credentials. It covers quoted arguments, file input, mutually exclusive browser delegation without an objective prompt, config/Node rejection, credential precedence/fallback and restoration, Windows key-name case behavior, present empty Node environment values, root-preload isolation, nonzero exit propagation, and one interactive prompt followed by shutdown on the same stdin. Non-Windows runs skip this Windows-only suite. Missing PowerShell 7.5+ is a failed prerequisite on Windows. The suite does not call Aerial or qualify the product runtime or browser submission. Timed-out fixtures retain their files rather than claiming process cleanup.

Local validation on 2026-11-07 passed all 24 controlled tests with no skips. A separate fresh fixture also passed in a real terminal, including one Chinese prompt and requirement, intact Node Unicode output, the same stdin shutdown, selected Node, environment/Console encoding restoration and actual original process closure. Both checks use a fake entry and fake credential; neither is real-provider or product acceptance. Earlier failed attempts and their input versions remain retained in maintainer evidence.

Actual delivery still requires a matching final build/normal result, real daily one-demand execution, publication hold, original shutdown and observed process closure. Web input must own the only objective submission and be validated through its actual installed local-development page; the Console mode must not submit an additional goal.
