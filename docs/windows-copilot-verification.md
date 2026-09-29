# Installed Windows provider verification

The ordinary Windows smoke uses a deterministic CLI fixture. An optional
extension exercises real Codex inference through the installed worker using
the provider settings saved in the desktop UI. The default `all` scope requests
five model turns: two conversational replies and a three-contribution planning
discussion with two distinct agent instances. The `discussion` scope requests
only the three discussion contributions. A failed run may stop earlier and can
still consume provider usage. Run only with an operator-authorized provider.

Start Aerial, select its GitHub Copilot route, and make sure its Responses API
and the requested model are available. Install the Codex CLI. Use an absolute
path to its executable and to the existing local API-key file; the key itself
must not appear in shell arguments, source files or logs.

From a logged-in Windows desktop, configure only the current test process:

```powershell
$env:ARTOO_DESKTOP_INTERACTIVE = '1'
$env:VITE_AUTH_ENABLED = 'true'
$env:ARTOO_DESKTOP_LIVE_CODEX = '1'
$env:ARTOO_DESKTOP_LIVE_SCOPE = 'all'
$env:ARTOO_DESKTOP_LIVE_BINARY = (Get-Command codex).Source
$env:ARTOO_DESKTOP_LIVE_MODEL = 'gpt-5.4-mini'
$env:ARTOO_DESKTOP_LIVE_URL = 'http://127.0.0.1:18181/v1'
$env:ARTOO_DESKTOP_LIVE_KEY_FILE = 'C:\path\to\existing\aerial\api_key'
Remove-Item Env:ARTOO_SMOKE_SKIP_BUILD -ErrorAction SilentlyContinue
npm run verify:desktop
Remove-Item Env:ARTOO_DESKTOP_LIVE_*
```

Model names are provider-dependent; `gpt-5.4-mini` is the model used by the
recorded local checks, not a guarantee of future catalog availability.
The key file is read only inside the test process. The app receives it through
its password field, encrypts it with Electron safeStorage, and passes it to
Codex through an environment variable. Playwright tracing is not enabled.
Failures report the stage, error class and helper source location without
echoing submitted field values. Once a discussion exists, the helper also tries
to retain its status and step, turn/run statuses, and fixed categories for errors,
failure reasons and at most five recent stderr entries per turn. Categories are
authentication, rate limit, timeout, unavailable, or other; they do not establish
a root cause. The report never copies provider-controlled text, including encoded
credentials. Raw stdout, stderr, error text and model reply bodies are not
retained as failure logs. A failure before that snapshot is available may have
only a stage-level error; absence of details does not identify its cause.

The harness installs the rebuilt NSIS package into a temporary directory,
creates isolated server/app data, and pairs the app through the ordinary UI.
It first runs the deterministic installed smoke with an empty PATH. The live
extension then saves an explicit real Codex program, model, API address and key
through Settings, restarts the app, and restores the process PATH so Codex can
find its normal shell tools. User-wide Git, Codex and provider configuration
is not changed. Sign-out and uninstall finish the enclosing smoke.

Checks in `all` scope include:

- Provider settings and encrypted credential survive app restart.
- The actual installed worker connects through authenticated node WebSocket.
- Two real replies persist once, and the follow-up uses the first answer.
- Two registered agents share real prior answers and synthesize a validated
  plan; the installed UI shows task criteria and named dependencies.
- Viewing the suggestion and creating a proposal leave goal tasks empty.
  Accepting the plan through the UI creates exactly the two specified tasks.
- Five independent provider sessions record input/output token usage.
- The model creates no work files in the isolated live workspace.

For a targeted discussion recheck, retain the earlier reports and logs before
starting: the harness replaces top-level evidence files. Configure the same
provider variables above, then select `ARTOO_DESKTOP_LIVE_SCOPE=discussion`.
This still runs the deterministic installation/worker checks, three real
discussion contributions, plan review and acceptance, logout, and cleanup; it
does not send or verify the two conversational chat turns.

An unchanged installer can be reused with `ARTOO_SMOKE_SKIP_BUILD=1` after
comparing its SHA-256 with the retained report. The packaged product and server
source must still correspond to the earlier revision; the harness rebuilds the
server even when installer building is skipped. For example, after verifying
the hash and setting the provider variables:

```powershell
$env:ARTOO_DESKTOP_LIVE_SCOPE = 'discussion'
$env:ARTOO_SMOKE_SKIP_BUILD = '1'
npm run verify:desktop
Remove-Item Env:ARTOO_SMOKE_SKIP_BUILD -ErrorAction SilentlyContinue
Remove-Item Env:ARTOO_DESKTOP_LIVE_*
```

Use a fresh build when packaged product code changes. A targeted pass covers
its declared scope; keep independent chat evidence separately.

Reports are in `apps/desktop/release/smoke-artifacts`:
`windows-desktop-smoke.json` identifies the installer hash and enclosing checks;
`windows-live-copilot.json` records live checks, usage and cleanup status;
`windows-live-copilot-plan.png` shows the installed plan card. A live pass
requires the enclosing smoke to pass and cleanup to complete. Evidence files
are ignored by Git; published milestone records identify the verified revision.

## Recorded checks on 2026-09-29

The Windows product was built from
`bd0ee48970c3f74e7858803916a907563b2b7e8b`. Both attempts used
`Artoo Setup 0.1.0.exe` with SHA-256
`51f5b8430a7205a3445979a5888ec598783c66ba1f9c240f7ad26a249f5eaf61`.
The second attempt changed only test diagnostics and scope selection and reused
that installer. The model was `gpt-5.4-mini` through the local Aerial / GitHub
Copilot route.

| Attempt | Evidence and observed result |
| --- | --- |
| Initial full run, finished `2026-09-29T07:46:37.238Z` | The deterministic fixture and two real chat turns passed, including prior-answer context and single persistence. The discussion failed at step 0/3. Both enclosing and live reports remain **fail**; cleanup completed. The original JSON reports, failure screenshot and log are retained under `smoke-artifacts/attempt-1/`. |
| Targeted discussion run, finished `2026-09-29T07:55:22.634Z` | `scope: "discussion"` passed three real contributions, prior-answer sharing, the rendered plan, zero goal tasks before proposal/acceptance, and two accepted tasks retaining their criteria and dependency. Both reports are **pass**, with cleanup complete. Evidence is in the top-level `smoke-artifacts` reports and plan screenshot; its log is `artifacts/preview-gate/windows-installed-copilot-discussion-diagnostic.log`. |

The initial discussion failure's cause remains unknown: its older helper
retained only the broad stage, and the temporary database was removed during
cleanup. The targeted pass does not establish why the first attempt failed or
that a production defect was fixed. These are two independent pieces of
evidence, not one successful five-turn run. The five completed runs have usage
records, but any consumption by the failed discussion is not included in those
records.

The original second enclosing report uses a generic successful-check label
that mentions chat as well as discussion. Its companion live report's explicit
`scope: "discussion"`, three measurements and three provider sessions define
what was actually executed. The source harness now uses scope-specific wording;
the original generated reports and logs have not been rewritten.

## Verification limits

Only the Web owner's cookie is test-provisioned. Native pairing, authorization,
model settings, task actions and execution transport use production paths.
The test runs on loopback; it does not certify real Google login, a public
deployment, physical iOS devices, package signing or Claude protocol support.
The ordinary Codex filesystem sandbox and existing CLI customizations remain
in effect. Token usage does not establish a monetary cost when the provider
does not report pricing.
