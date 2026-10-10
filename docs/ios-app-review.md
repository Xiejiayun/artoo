# iOS App Store review preparation

Distribution decision confirmed by the publisher on 2026-10-10: public App
Store, first version free. The intended signing team is `39A247273J`, with the
existing Apple Distribution identity for Jiayun Xie. This document does not
establish App Store Connect registration, uploaded builds or Apple approval.

## Proposed store metadata

- Name: **Artoo**
- Subtitle: **Teamwork, agents and approvals**
- Primary category: **Productivity**
- Price: **Free** for the first version; there are no in-app purchase products.
- Support: https://xiejiayun.github.io/artoo/support.html
- Privacy: https://xiejiayun.github.io/artoo/privacy.html
- Marketing page: https://xiejiayun.github.io/artoo/
- Keywords: `team,agents,approvals,tasks,workflow,collaboration,projects`

Suggested description:

> Keep your team's work moving with Artoo, a native companion for your Artoo
> workspace. Read channel conversations and threads, follow mentions, review
> approvals, create and assign tasks, and inspect agent results from your
> iPhone or iPad.
>
> Stay informed about queued, running, failed and completed work. Review
> artifacts, request changes and confirm when to stop a run. Your team remains
> in control of approvals and the computers that execute agent work.
>
> Artoo requires an existing Artoo team server and an account provided by that
> team's operator. Pair the app using a code from your own account in the team
> web app. Agent execution also requires a connected execution computer and
> your team's configured provider. The phone does not execute agent programs.

The description must be reconciled with the final accepted build before
submission. Do not claim App Store availability before approval.

## Review access

The native app starts with server pairing. A reviewer needs a reachable HTTPS
team server, a limited review account, a method to obtain a fresh pairing code,
and an available execution computer/provider to exercise the advertised flows.
An expiring one-time code alone is insufficient for a repeatable review.

Supply the actual review account credentials only through App Store Connect's
private review fields. Do not commit credentials, reuse a team administrator's
account, or publish pairing codes in the screenshot/report bundle. The review
server must contain non-sensitive sample projects and remain available during
review. No actual review endpoint/account has yet been qualified.

Suggested reviewer sequence after the review environment is ready:

1. Sign into the provided review web workspace and generate an iOS pairing code.
2. Pair Artoo using that server origin and code; open Privacy and data from the
   pairing screen to verify publisher policy/support access.
3. Open Channels, enter a conversation and reply in a thread; open Mentions
   from Inbox and confirm the historical destination.
4. Create a task, mark it Ready, request execution approval, review the request
   in Inbox, and assign an available executor after approval.
5. Inspect the resulting run and artifact, request changes or accept the task.
   Verify running work requires explicit confirmation before stopping it.
6. Relaunch and verify connection/history recovery, then sign out.

## Privacy, encryption and age rating

The app declares linked user/device identifiers, messages and other user content
for app functionality, and UserDefaults reason `CA92.1`. The full service's
name/email handling and AI-provider processing still need to be reflected in
the App Store Connect privacy answers. The client has no advertising/tracking
SDK and no custom cryptographic implementation; it uses Apple's HTTPS/Keychain
APIs and declares no non-exempt encryption. Confirm the final binary and
distribution-region questions before submitting those answers.

Age-rating questions must describe team messaging and user-generated content
truthfully; do not select a rating without completing Apple's current
questionnaire. Assess reporting/moderation, account deletion and AI-data consent
against the actual hosted review/product service and applicable guidelines.

## Required final evidence

- Exact release commit and SDK, valid distribution archive and exported IPA.
- App Store Connect app ID, upload validation and completed build processing.
- Native full-suite pass with matching HTML/photos and physical iPhone/iPad
  TestFlight validation; earlier or simulator-only reports are insufficient.
- Store screenshots from the shipping build and required device sizes, free
  of pairing secrets and private account/project content.
- Reachable review service/account, publisher support/contact and completed
  privacy, age-rating and export-compliance fields.
- Apple review decision, tracked separately from upload and internal testing.
