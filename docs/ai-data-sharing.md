# AI data sharing configuration

Artoo requires the team operator to describe the actual AI recipients before agent work starts. Ordinary workspace browsing and pairing remain available when the disclosure is missing. This configuration describes the execution computers as well as the server: audit their actual CLI endpoints, including custom gateways, before publishing a disclosure.

Set `ARTOO_AI_DATA_SHARING_POLICY` to JSON with `mode` and `providers`. For external processing, each recipient needs a stable lowercase `id`, its real `name`, and its public HTTPS `privacy_url`. Include every recipient that can receive the work. Do not put API keys, credentials, query tokens, or private endpoints in this public metadata. The server returns it to authenticated clients.

Example **format only**, not a production declaration:

```json
{"mode":"external","providers":[{"id":"example","name":"Example AI recipient","privacy_url":"https://provider.example.com/privacy"}]}
```

Use `{"mode":"local","providers":[]}` only when every enabled agent processes locally and sends no data to an external AI provider. Missing configuration is never treated as a local-processing declaration. Deterministic subprocess fixtures in the repository use explicit local declarations. Live CLI smoke tests require the actual external disclosure plus `ARTOO_LIVE_AI_SHARING_CONSENT=1`, which authorizes only their isolated fixture user's work.

Changing recipients or their published metadata changes the disclosure version and requires new permission. Consent is scoped to a user and organization; every new run retains the exact grant that authorized it. Re-consenting after withdrawal does not restore authority to older queued work. Older external runs without recorded permission cannot be dispatched or resumed.

Users review providers and data categories before permission is granted. They can also manage permission through iOS More → AI data sharing, or Web/Mac Settings → AI data sharing. Withdrawal is stored before affected execution is stopped. The response lists unconfirmed stops, such as an offline computer; operators must stop those processes on the execution computers. Data already transmitted cannot be recalled. Withdrawal can be retried after reconnection or even after the disclosure is removed.

Before production use, verify recipients, update the public privacy policy with the actual hosting and processing facts, and run the client consent E2E. A configuration declaration alone does not prove an executor's behavior.


## Verification milestone, 2026-10-10

The current implementation passed the real Chrome permission/decline/withdrawal flow (4 screenshots) and the iPhone 16 iOS 26.5 native flow (one XCTest case, 5 screenshots). Native consent was presented above the existing assignment sheet; declining preserved the form and zero runs, accepting created one run, withdrawal reported the offline stop as unconfirmed, and relaunch retained withdrawn permission. These use an explicitly fictional external recipient and do not send data to a live AI provider.

The final HTTP account-boundary/replay group passed 12 tests. Separate transport plus existing Web client/auth/settings regressions passed 52; task/goal/allocation regressions passed 40. Native ApiClient tests passed 31, including unchanged request replay, decline and logout cancellation. Configuration and durable grant service tests passed 4 and 5 respectively. Typecheck and the preview build passed; the production dependency audit found zero vulnerabilities.

Every E2E attempt retains its own HTML. Final reports in the implementation worktree are:

- `artifacts/ai-data-sharing/web-2026-10-10T07-31-40-243Z/report.html`
- `artifacts/ai-data-sharing/native-2026-10-10T07-30-24-614Z/report.html`

The earlier native attempts at `07-08-43-066Z` (pairing fixture switch) and `07-18-15-852Z` (offscreen state assertion) remain failed. All three attempts removed their owned simulator and temporary runner credentials. The current iOS source, resources, unit tests and UI tests match the successful isolated build snapshot byte for byte.

This milestone does not qualify the full iPad suite, installed-Mac consent UI, live-provider configuration, physical devices, App Store signing, TestFlight, or production deployment. These remain separate release gates. The new consent test is a dedicated additional native command, `node scripts/ios-ai-data-sharing-e2e.mjs`, and does not replace the existing eleven business cases. Build the preview first. Browser consent verification uses `node scripts/ai-data-sharing-e2e.mjs` and accepts the existing `ARTOO_CHROMIUM_CHANNEL` override.
