# Team content moderation

This feature is under verification. It does not yet establish App Store review readiness or an operated moderation service.

Members can report a message using its flag action and follow their own reports in **My reports**. The report records the original message and a bounded reason. Only team owners/admins can read original report evidence and private resolution notes. Duplicate reports by the same person for the same message return the existing report. Both staff and personal report histories are paginated.

Owners and admins use **Content management** to review reports, remove a message or dismiss a report with a private note, configure literal blocked phrases, and suspend/reinstate members. Only owners can change another administrator's access; nobody can suspend themselves. The staff queue shows the authoritative message sender so administrators can identify the correct member.

A removal replaces the message and mention preview with a notice. Protected database columns establish the removal; legacy/user-supplied payloads cannot impersonate a staff action. Thread IDs and reply counts stay intact. Clients reconcile previously loaded message IDs through a bounded visibility endpoint, so a removal is applied after a missed WebSocket event as well as through realtime updates. A delayed original history page cannot restore a removal already learned by that client. Staff report evidence, historical ContextPacks/execution records, backups and previously exported copies can still retain original data; this is not a data-deletion guarantee.

Phrase filtering applies to new team messages and agent requests. Rules normalize Unicode compatibility forms, case, invisible direction/control markers and whitespace. They perform literal substring matching, including within words, and never execute administrator-supplied regular expressions. Up to 128 phrases of 3–200 characters can be configured. Clearing existing rules requires explicit UI confirmation. No configured phrases means phrase filtering is off. This method is not a comprehensive automated content-safety classifier. Administrators must choose and maintain meaningful rules for their service.

Suspension revokes existing browser sessions, device credentials and AI consent, expires pending pairing codes and rejects new OAuth/session/pairing access for that account. Connected paired clients are closed; browser sessions revalidate at the existing configured interval. Reinstatement enables new sign-in/pairing, without restoring old credentials or withdrawn AI grants. Revoking a worker's access does not prove its OS processes stopped. Check affected executions and use their acknowledged Stop controls; an offline or unreachable process remains unconfirmed and must be checked on its computer.

The server operator is responsible for monitoring reports, responding promptly, acting on abuse and publishing usable support/contact information and accurate retention/privacy policies. Software controls alone do not supply staffing, response-time guarantees or a legal retention policy.

## Validation boundaries

The real Chrome moderation E2E at `artifacts/content-moderation/web-2026-10-10T09-21-49-136Z/report.html` passed with eight actual screenshots, complete/stable source fingerprints and graceful browser/server cleanup. It exercises member reporting, staff removal, both realtime and HTTP-only removal of already-loaded old messages, private status visibility, account suspension/reinstatement and filtered-draft preservation. Its identities and sessions are disposable fixtures; it does not claim a real Google login or public deployment.

The prior `09-16-32-040Z` run retains its functional results and screenshots but is marked incomplete because its untracked-source fingerprint was unavailable. The shared report collector was subsequently repaired in main `3eae291`.

The latest isolated native Debug build passed all 179 ArtooTests with no failures, including editable drafts after definite posting rejection and preservation of planning-discussion structure. Product sources, resources and unit tests matched the recorded snapshot. The extended Release UI run at `artifacts/content-moderation/native-2026-10-10T12-21-55-632Z/report.html` passed its exact case on its owned iPhone 16 / iOS 26.5 simulator, with all eleven required screenshots, complete/stable source fingerprints, and confirmed simulator/credential/server cleanup. It verifies actual editing and exactly one corrected send after a rule rejection, plus removal after relaunch.

The refreshed Chrome run at `artifacts/content-moderation/web-2026-10-10T12-30-01-890Z/report.html` passed with eight reviewed screenshots and complete/stable source fingerprints. Its browser was forcibly closed after graceful shutdown timed out; the report retains that cleanup detail. The first refresh attempt could not launch a missing Playwright browser and retains its failure report separately.

The full local Vitest run passed 2,115 tests, with 30 skipped and no failures (240 passed files, 10 skipped). These counts include overlapping targeted regression coverage and must not be added to earlier test counts. The existing eleven native business cases and installed Mac workflows remain separate integration regression requirements for the promoted commit.

Visual review found a remaining layout issue: the destination picker wraps “Team discussion” onto multiple lines when a delivery warning is visible. The editor and corrected send work, but this layout still needs refinement. Personal blocking, operated moderation response and actual account/data deletion are separate unfinished release requirements; this milestone does not establish full commercial or App Store readiness.
