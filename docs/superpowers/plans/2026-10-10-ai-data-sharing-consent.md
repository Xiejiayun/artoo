# AI data sharing consent implementation plan

> Execute inline. This branch is isolated from the live iPad E2E worktree. No source changes in the running iPad candidate.

**Goal:** Before Artoo sends personal/workspace data to external AI providers, show the actual configured recipients and data use, obtain explicit permission, and enforce that permission through queued dispatch and subsequent work.

**Evidence:** Apple's current App Review Guidelines 5.1.2(i), fetched on 2026-10-10, explicitly require disclosure and permission for third-party AI sharing. Main f3b7b79 has descriptive privacy text but no explicit permission operation. Assistant turns, goal discussions and task assignment can send context through `node-binding.ts` to an execution computer. The approval workflow authorizes execution risk; it does not identify AI recipients or substitute for privacy consent.

**Architecture:** A server-operator-supplied, versioned disclosure describes external providers and their HTTPS privacy policies. An explicit local-only declaration is separate from missing configuration; missing configuration cannot silently permit AI execution. Persist user consent by organization and disclosure version. Bind every queued run to its requester/version and recheck at transport dispatch, including reconnect/resume. Native and web clients offer a readable consent sheet and a withdrawal control; ordinary workspace browsing remains available without AI consent.

## Required invariants

- No invented provider identity, policy URL or processing region. Provider metadata is public configuration, never a place for API keys.
- A changed disclosure requires renewed permission. User and server/organization boundaries cannot reuse another consent.
- Missing/stale/withdrawn consent prevents enqueue/dispatch. Queued work cannot bypass the check after restart.
- Withdrawal persists before cancelling affected queued/running work; already-transmitted information cannot be recalled. Report any unconfirmed process stop honestly.
- Exact request/idempotency semantics survive the consent UI; cancelling the dialog submits no work and preserves drafts.
- UI/fixture tests use explicitly declared deterministic local execution where applicable. Separate external-sharing tests prove rejection before permission and genuine UI acceptance. No test-only bypass in production.
- Existing eleven business cases, per-attempt HTML/photos, isolated workspaces and real-provider/physical/TestFlight boundaries remain intact.

## Work sequence

1. Add pure configuration/parser contracts in `apps/server/src/config/ai-data-sharing.ts` and `.test.ts`: external provider metadata, explicit local mode, missing configuration, canonical versioning, invalid/secret-bearing input refusal. Integrate the resulting policy into `ServerContext` and startup; test fixtures explicitly describe their local process setup.
2. Add migration/schema and service for per-user consent plus queued-run requester/version stamps. Add authenticated status/accept/withdraw routes. Test user isolation, stale policies, withdrawal and durable reload.
3. Gate assistant enqueue/retry, discussion initiation and lifecycle assignment. Recheck just before `run.start`/`run.resume` in `node-binding.ts`; preserve release/stop invariants for rejected starts. Add dispatch-race/reconnect tests and prove no context reaches the fake transport without authorization.
4. Add iOS and web consent presentation, provider policy links and withdrawal controls. Make declined permission non-destructive to drafts and pending user actions. Keep native session changes from retrying a previous account's request.
5. Validate real UI permission/decline/change/withdraw flows with HTML and actual screenshots, then complete relevant native/web regressions and current provider acceptance. Update deployment/operator and App Store privacy documentation using actual configured service facts.
6. Promote only the completed, verified implementation to main with a normal milestone commit/push. The configuration parser alone is not the release requirement.
