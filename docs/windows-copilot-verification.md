# Installed Windows provider verification

The ordinary Windows smoke uses a deterministic CLI fixture. An optional
extension exercises real Codex inference through the installed worker using
the provider settings saved in the desktop UI. It consumes five model turns:
two conversational replies and a three-contribution planning discussion with
two distinct agent instances. Run it only with an operator-authorized provider.

Start Aerial, select its GitHub Copilot route, and make sure its Responses API
and the requested model are available. Install the Codex CLI. Use an absolute
path to its executable and to the existing local API-key file; the key itself
must not appear in shell arguments, source files or logs.

From a logged-in Windows desktop, configure only the current test process:

```powershell
$env:ARTOO_DESKTOP_INTERACTIVE = '1'
$env:VITE_AUTH_ENABLED = 'true'
$env:ARTOO_DESKTOP_LIVE_CODEX = '1'
$env:ARTOO_DESKTOP_LIVE_BINARY = (Get-Command codex).Source
$env:ARTOO_DESKTOP_LIVE_MODEL = 'gpt-5.4-mini'
$env:ARTOO_DESKTOP_LIVE_URL = 'http://127.0.0.1:18181/v1'
$env:ARTOO_DESKTOP_LIVE_KEY_FILE = 'C:\path\to\existing\aerial\api_key'
npm run verify:desktop
Remove-Item Env:ARTOO_DESKTOP_LIVE_*
```

Model names are provider-dependent; `gpt-5.4-mini` is the model used by the
recorded local checks, not a guarantee of future catalog availability.
The key file is read only inside the test process. The app receives it through
its password field, encrypts it with Electron safeStorage, and passes it to
Codex through an environment variable. Playwright tracing is not enabled.
Failures report the stage without echoing provider diagnostics or input values.

The harness installs the rebuilt NSIS package into a temporary directory,
creates isolated server/app data, and pairs the app through the ordinary UI.
It first runs the deterministic installed smoke with an empty PATH. The live
extension then saves an explicit real Codex program, model, API address and key
through Settings, restarts the app, and restores the process PATH so Codex can
find its normal shell tools. User-wide Git, Codex and provider configuration
is not changed. Sign-out and uninstall finish the enclosing smoke.

Checks include:

- Provider settings and encrypted credential survive app restart.
- The actual installed worker connects through authenticated node WebSocket.
- Two real replies persist once, and the follow-up uses the first answer.
- Two registered agents share real prior answers and synthesize a validated
  plan; the installed UI shows task criteria and named dependencies.
- Viewing the suggestion and creating a proposal leave goal tasks empty.
  Accepting the plan through the UI creates exactly the two specified tasks.
- Five independent provider sessions record input/output token usage.
- The model creates no work files in the isolated live workspace.

Reports are in `apps/desktop/release/smoke-artifacts`:
`windows-desktop-smoke.json` identifies the installer hash and enclosing checks;
`windows-live-copilot.json` records live checks, usage and cleanup status;
`windows-live-copilot-plan.png` shows the installed plan card. A live pass
requires the enclosing smoke to pass and cleanup to complete. Evidence files
are ignored by Git; published milestone records identify the verified revision.

Only the Web owner's cookie is test-provisioned. Native pairing, authorization,
model settings, task actions and execution transport use production paths.
The test runs on loopback; it does not certify real Google login, a public
deployment, physical iOS devices, package signing or Claude protocol support.
The ordinary Codex filesystem sandbox and existing CLI customizations remain
in effect. Token usage does not establish a monetary cost when the provider
does not report pricing.
