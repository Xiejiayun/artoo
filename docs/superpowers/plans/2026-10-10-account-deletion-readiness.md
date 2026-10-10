# Account deletion release-readiness plan

> Execute inline after the current content-management milestone is verified. This document records an unimplemented release requirement; a support link, suspension, or empty request endpoint must not be counted as completed account deletion.

**Goal:** Let account holders initiate deletion from the app and complete removal of their account and associated personal/user-created data, with honest status, safe execution handling and verification of actual effects.

**Evidence:** Apple's current guidance at https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion says apps supporting account creation must offer in-app deletion; disabling/deactivating alone is insufficient; shared user-generated content is included unless legally required retention applies. Linking to browser signup does not remove the requirement. A manual process is permitted if it takes a reasonable stated time and completion is confirmed; non-regulated apps should not require a phone call, email or support chat to initiate it. The Artoo project automatically provisions user records from verified Google identities in `auth/auth-service.ts`. The native app pairs an existing account, but that alone does not prove an exemption for the overall service.

**Current state:** Native PrivacyView directs deletion requests to the team administrator. There is no deletion operation or status workflow. Suspension implemented in the separate moderation draft revokes access and retains records; it is explicitly NOT account deletion.

## Work and evidence required

- [ ] Inventory every direct user FK and untyped author/actor reference before deleting anything. Include users, user identities, sessions, devices/tokens, pending pairings, AI consent, notifications, assistant turns, discussions, goals, task authors, approvals/reviews, memories, plans, decisions/handoffs/blockers, event/audit payloads and idempotency receipts. Identify artifacts/context snapshots and shared references separately.
- [ ] Define ownership transfer or workspace closure for the final owner without silently deleting other members' work or requiring an unnecessary support detour. Static `AUTH_OWNER_EMAILS` is currently authoritative, so a database-only role change cannot implement ownership transfer correctly.
- [ ] Implement actor-bound initiation/confirmation and durable completion state. A request must target only the authenticated account and reject an account switch during confirmation. Do not auto-replay deletion across sessions. Preserve cancellation before the final explicit confirmation.
- [ ] Revoke access and stop affected work without claiming unconfirmed OS processes stopped or releasing their write leases. Resolve how safety-critical execution metadata is retained/anonymized while actual account/content data is deleted. An incomplete cleanup must remain incomplete; never mark a job complete just because access was revoked.
- [ ] Delete account identity and user-created content under service control, retaining only justified structural placeholders that do not restore identity/content. Do not invent legal retention exceptions. Shared artifacts require reference-aware cleanup; another member's independent work must not be silently destroyed.
- [ ] Make managed backup/restore behavior deletion-aware so restoration cannot resurrect deleted accounts/content. The current backup CLI accepts arbitrary export destinations; previously exported third-party/local copies require an explicit, accurate boundary rather than an erasure claim.
- [ ] Clear this server/account's native and Web drafts/pending sends and local credentials when deletion completes or access is revoked, without clearing other accounts/servers. `RoomDraftStore` keys encode `[origin,user,room,...]` in base64 and can be decoded for precise cleanup.
- [ ] Add native/Web initiation and status/completion UI with a real backend operation. If any manual operator work remains, configure and operate a truthful completion timeline and confirmation channel before release; do not ship an invented SLA.
- [ ] Test account isolation, duplicate requests, partial failures/restart, unconfirmed executions, last-owner handling, genuine removal of shared UGC, cleanup of linked artifacts, old-token rejection, fresh re-registration without old data, and backup restoration. Every client E2E needs HTML and actual screenshots.
- [ ] Update the actual operator's privacy policy and App Review notes using implemented behavior and real deployment facts. Verify the complete path in the review service before declaring the release gate satisfied.

## Initial source inventory

`packages/db/src/schema.ts` includes direct user references in `ai_data_sharing_consents`, `content_rules`, `member_suspensions`, `devices`, `pairing_codes`, `user_identities`, `sessions`, `runs.requested_by_user_id`, `messages.moderated_by_user_id`, `content_reports`, `notifications`, `assistant_turns`, `goals.owner_user_id` and `discussions`. Generic `created_by_id`, `actor_id`, `author_id` and `resolved_by` fields occur elsewhere and cannot be found by FK traversal alone.

The current artifact/backup and execution retention guarantees are material: `storage-operations.ts` exports whole database snapshots and artifact files, and a disconnected run may still own a live process. This plan must reconcile those facts with deletion rather than suppressing a check or relabeling suspension.
