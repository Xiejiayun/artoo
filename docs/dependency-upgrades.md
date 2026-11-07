# Dependency migration: Zod 4 and static file discovery

This migration uses the production `zod` entry point at locked version 4.6.7.
It addresses [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5):
oversized collections must be rejected before traversing their members. Importing
`zod/v3` from the newer package would retain the vulnerable traversal behavior.
`packages/domain/src/zod-bounds.test.ts` exercises the real entry point for
sync/async arrays, sets and maps, including valid and invalid in-limit controls.

The source migration supplies explicit string keys to records, derives product
design versions from an unrefined base, and updates Zod issue adapters while
preserving their versioned diagnostic vocabulary and input privacy. Session
identifiers use `guid()` to retain the former hexadecimal 8-4-4-4-12 shape; the
upgrade must not impose new UUID version/variant rules on existing opaque tokens.

Zod 4 `int()` also adds safe-integer limits. Eleven existing public or persisted
fields retain their prior finite JSON integer range through direct
`Number.isInteger` refinements:

| Contract | Fields |
| --- | --- |
| Goal budgets in JSONB | `max_elapsed_ms`, `max_retries`, `max_concurrent_runs` |
| Checkpoint references in JSONB | `event_cursor` |
| Review history and context feedback | `TaskReview.position`, `ContextPack.review_feedback.entries[].position` |
| Public database projections | `Run.sequence`, `Message.sequence`, `AuditEvent.position` |
| Notification page | `unread_count` |
| Node heartbeat | `sequence` |

For example, `9007199254740992` is a finite integer that the old schemas accepted
and JSON can round-trip. Its acceptance does not promise precision for every
integer beyond the JavaScript safe range. Existing positive/nonnegative,
optional, nullable and default constraints remain; signed run/audit projections
also retain their old sign behavior. Fractions and non-finite numbers are
rejected. No blanket integer shim is introduced. Database int32 projections,
fixed managed-session negotiation values and node-measured bounded files/process
results keep their existing `int()` checks.

The only bare object `unknown()` property is the protected signed-record envelope
`data`. Missing data already failed canonical signing, so it needs no optionality
compatibility exception. Record/array values and explicitly optional properties
remain unchanged. No non-finite transport compatibility exception is added.

The static-file dependency override is limited to the `@fastify/static` chain:
static 10.1.4 resolves glob 14.0.2 and minimatch 11.0.1. Other glob/minimatch users
are not globally overridden. The real server fixture covers nested and escaped
asset names, directory indexes, MIME, HEAD, JSON 404 responses and traversal
non-disclosure. The Windows preview job already runs the full Vitest suite; the
Mac focused gate now includes `apps/server/src/web-static.test.ts` while retaining
its previous suites and single-worker setting.

Fastify is also updated to 5.12.6. The lock resolves its affected URI dependency
chains to fast-uri 3.1.9 and 4.2.3 without a global override.

## Validation scope

On native Windows, the finalized lock installed successfully with `npm ci`.
`npm run typecheck`, `npm run build` with `VITE_AUTH_ENABLED=true`, all 859 focused
schema/protocol/verification/REST/static tests, and all 27 Web end-to-end tests
passed on the new dependency tree. Both lock-only and installed production
audits reported zero vulnerabilities. The build retains the existing chunk-size
warning. An initial installed audit received HTTP 429; the later successful audit
used the same TLS and audit settings.

The first full `npm test -- --maxWorkers=2` attempt recorded 4,374 passes, one
failure and 90 conditional skips. The failure was the unchanged Windows browser
snapshot fixture exceeding its existing 10-second PowerShell subprocess limit.
The unchanged isolated fixture later passed, but the original cause remains
unconfirmed. Temporary diagnostic variants and their failed runs are retained
outside the source changes; no timeout, assertion or production behavior is
relaxed. The complete dependency-stage rerun on source committed as `5cb6cc3`
then passed: 4,375 tests passed, 90 conditional skips and zero failures. This
does not identify the cause of the earlier timeout.

The macOS CI job on `5cb6cc3` also passed its installed DMG application and
recovery gates. Its four selected source suites passed all 93 tests, including
all eight static-file tests and the POSIX ownership cases. Shared and iOS checks
were still running when the Windows continuation integration began; the installed
Windows job was skipped. Later source integrations require their own checks.

The continuation integration also updates three explicit Zod generic annotations:
strict objects retain their named shapes with `z.core.$strict`, and the named
command union uses the Zod 4 option/discriminator parameter order. Their runtime
schemas and declaration-size safeguards remain unchanged.

Earlier acceptance on another dependency snapshot does not validate this one.
These checks do not establish live-provider, physical multi-computer,
signed-distribution or product-deployment acceptance.
