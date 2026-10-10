# Team content moderation implementation plan

> Execute inline under the user's existing authority for implementation, verification and normal milestone pushes. Work is isolated from the running iPad business candidate. Do not promote a server-only draft as completed App Store moderation.

**Goal:** Give trusted teams working content filtering, private reporting and administrator suspension controls, with native/Web access and actual screenshot evidence, addressing the current App Review 1.2 gap.

**Evidence:** Apple's retrieved current guideline 1.2 explicitly requires a filtering method, reporting and timely responses, blocking abusive users, and published contact information. Current main 5811761 supports shared human/agent conversations but source search and review found no report queue or durable member suspension. Device revocation is not an account ban: a user can sign in again and pair a fresh device.

**Architecture:** Persist organization-scoped content rules, report records and member suspension. Reporters can submit a bounded reason for a real message in their team; staff can review/resolve reports and suspend abusive members. Suspended users cannot regain access through OAuth, existing sessions, new pairing or an existing worker. Preserve acknowledged-stop and lease invariants. Filtering uses bounded normalized literal phrases, never operator-provided executable regular expressions, and emits generic rejection messages without leaking hidden rule contents. Native and Web clients surface reporting and administration through existing conversation/settings UI.

## Requirements and tasks

- [ ] Map all content creation/read paths, identity/pairing/node authority and administrator rules before changing them. Specify how removed content remains represented in threaded conversations and historical audit records; do not silently claim backups or previously exported files were deleted.
- [ ] Add durable schema/migration, pure filter policy validation, organization/user ownership tests, duplicate-report semantics, and private staff/reporting APIs. Cross-team message IDs and client-supplied actors cannot create or expose reports.
- [ ] Integrate filtering into actual user-posting services and account suspension into current HTTP/WS, OAuth and device/node authority. Validate suspended accounts cannot relogin/re-pair and do not release uncertain execution leases. Prevent self-suspension and administrative escalation.
- [ ] Implement message reporting, immediate personal blocking/hiding where needed, staff resolution/removal, content-rule editing and member suspension/reinstatement controls. Report records must be discoverable to staff and actionable; no buttons with absent server behavior.
- [ ] Complete authenticated negative/race/session regressions, then actual native and Web E2E reports with screenshots, including report ownership, rule rejection, blocked-user access and administrator resolution. Existing eleven business workflows remain required separately.
- [ ] Document the real moderation/response responsibilities and service contact requirements. Ensure privacy and review materials describe actual hosting and retention. Inspect operational contact/review coverage before claiming 1.2 readiness. Commit/push the completed verified milestone normally to main.

## Boundaries

This is a restricted team tool, not anonymous/public chat. Configurable phrase rules are a filtering method, not a claim of comprehensive automated safety classification. Server administrators remain responsible for actual policies and timely report handling. Do not invent contact details, moderation staffing, legal retention obligations or deletion guarantees. Account deletion applicability is a separate audit of actual signup behavior and must not be marked complete by this work.
