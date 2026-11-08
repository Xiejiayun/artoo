# Native Windows application development verification

This opt-in path adds local application development to Agent Team. It is an
implementation increment awaiting the checks recorded below. It does not claim
that the complete one-request-to-publication product is ready.

The goal's original authorization is `app_delivery: { "version": 1,
"kind": "local-application-development" }`. The server preserves that grant,
initiating user and verification profile through planning, author execution,
node-owned verification and independent review. An application goal cannot use
`source_handoff`, a managed/worktree allocation or a static release profile.
Only a native Windows x64 node advertising `application-verification.v1` and its
locally prepared application capability can receive this work. Existing manual
and static workflows retain their previous contract.

## Executed path

The existing ordinary `run.start` remains the execution entry. On author
completion the node stops and confirms the original author, then runs the
configured static prototype checks. Application implementation and validation
stages additionally perform the following work:

1. Read the exact verified subject's client/server source, application definition
   and accepted design.
2. Invoke the fixed compiler through its original native owner. Read its capture
   only after actual normal closure and content validation.
3. Use the existing installation writer to create an immutable candidate package.
   Runtime, broker, native helper, QuickJS vendor and bootstrap bytes come from
   protected local pins. Generated runtime/database configuration is host owned;
   source text cannot supply paths, argv, grants or native programs.
4. Initialize a new independent test store using the fixed installed bootstrap.
   Start a fresh service process and execute every unchanged v3 design program
   at its actual loopback origin, at 1280 × 900 with device scale factor 1.
5. Execute the declared POST and GET business assertions, close the first
   service normally, reopen the same installed database in another service
   process, repeat GET, replay the identical POST, and require unchanged data.
   A fresh browser context runs the declared read-only persistence program.
6. Require normal closure of both original services and the original browser,
   recheck the complete source and protected inputs, then emit the application
   observation in `run.verification`.

An independent reviewer receives the exact original candidate and author
run/request binding. The same daemon retrieves the original opaque candidate,
reuses the same immutable package, creates another test store and repeats the
measurement. Copied JSON cannot recreate this authority. After daemon restart,
or on another computer lacking the original candidate, this increment rejects
the review instead of rebuilding a different package and calling it identical.

Successful observations bind source, artifact, toolchain, package and schema
digests; actual browser trace and capture digests; read/replay digests; the
original run/request; and a fresh test-store ID. No model adapter can emit this
node-only observation. Failed runs do not carry successful application evidence.
Normal native closure and business assertions are separate: an expected HTTP
error does not become an ownership error, while cancelled work cannot contribute
a normal-closure count merely because cleanup completed.

## Protected local configuration

Add `application: { version: 1, configuration: { path, bytes, sha256 } }` to a
local verification profile. The configuration pin must contain an absolute path
and the exact reviewed byte count and SHA-256 digest. The complete profile still
declares protected v3 static-web checks, covers `product` and `.artoo/product`,
and supplies every configured agent write root. This version rejects
`measurement_plan_policy` on an application profile. Research/design retain
prototype checks; application execution is additional to implementation and
validation checks.

The pinned JSON has version 1 and format
`artoo.application-verification-profile.v1`. Its exact keys are:

| Field | Local selection |
| --- | --- |
| `node` | Reviewed `node.exe` pin, shared by compiler and host |
| `compiler` | `helper`, `helperManifest`, `node`, `entry`, `configuration` pins |
| `runtime` | `helper`, `helperManifest`, `entry`, `vendorManifest`, `guestBootstrap` pins |
| `broker` | Fixed `application-broker.mjs` pin |
| `hostManifest` | Complete `application-service-host-manifest.json` pin |
| `browser` | Fixed Chromium executable pin |
| `candidate_parent` | Separate protected parent for immutable candidate packages |
| `installation_parent` | Separate protected parent for fresh test installations and stores |
| `selection_parent` | Separate protected parent for immutable host selections |
| `origin` | Fixed `http://127.0.0.1:<port>` without a path |
| `timeout_ms` | Original application verification deadline, at most 600000 ms |
| `operation_timeout_ms` | Per API/native operation ceiling, at most 30000 ms |
| `action_timeout_ms` | Browser action ceiling, 500–10000 ms |

Pins have exactly `path`, `bytes` and `sha256`. Mutable parents must not overlap
one another, agent write roots or immutable tools. Existing Windows ACL and
physical-file admission applies before advertisement and at operation boundaries.
Selections use the same exclusive installation writer and one prepare transition
as candidate files. A failed prepare, unknown process closure or partial store is
retained for diagnosis; this path does not delete, retry, replace its baseline or
adopt another process to manufacture success.

Build the fixed host graph with
`npm run build:application-service-host --workspace @artoo/artood`, review it and
install it with its complete manifest. The ordinary TypeScript build alone does
not update an existing protected host installation or its pins. Existing
compiler/runtime/native-helper installation procedures still apply. Configuration
and installation are administrator setup, never product-author instructions.

## Product input and limits

The model writes nonempty client HTML/CSS/TypeScript and server TypeScript,
including `product/client/index.html` and `product/server/handler.ts`, under the
existing bounded compiler contract. The design prototype remains
`product/index.html`. Every accepted design case must have its unchanged v3
program. Missing programs, legacy steps, storage fault/precondition injection
and static release cases cannot satisfy this application path.

Fixed author instructions include the exact type-only `@artoo/application`
declaration from `packages/domain/src/application-sdk-v1.ts`; the compiler uses
the same declaration source. Return stable business data instead of exposing
`DataReply.result.scope`, `request_digest` or `replayed`. Independent test stores
have different directories and `test_store_id`; this development path preserves
the candidate scope, including `data_generation`. The `replayed` flag changes on
identical POST replay and is unsuitable for an exact business response assertion.
Compiler rejections preserve bounded file/line/code/message diagnostics as data
after original process closure and unchanged-input confirmation. A rejection
never supplies a compiled capture or successful execution qualification.

`.artoo/product/application.json` has version 1, format
`artoo.application-definition.v1`, a bounded application data schema, and
`persistence.write`, `persistence.read` and
`persistence.after_restart_browser_program`. Write/read paths are same-origin
`/api` paths. Request and expected JSON bodies are each at most 65536 bytes. The
reopen program uses the application capability's `contract_digest`, starts with
navigation and contains a substantive text/value/count assertion. Only main-page
navigation and read assertions are allowed after restart. The author implements
a stable idempotency key and meaningful exact business expectations.
The browser action whitelist does not make the application's JavaScript
read-only: a loaded page can itself issue API writes. This is a persistence/UI
observation, not proof that loading the page performed no writes.

## Explicit remaining gaps

Every capability, candidate and observation retains
`qualified_for_product: false`. Application publication and failure recovery are
`unsupported`. After all four stages and reviews, the application goal remains
waiting with an explicit unsupported-publication reason. It cannot enter the
static release executor or substitute a static site's receipt to become complete.

The fixed bootstrap uses its original `ChildProcess`, fixed stdin shutdown,
original exit/close and both output EOFs. Its trusted internal summary additionally
requires original runtime/broker normal-closure counts, installed-session release
and final audits. This is **not atomic outer Windows Job containment**. Compiler,
runtime and broker retain their original native owners; a complete outer Job
stdin bridge and its failure qualification remain production requirements.
Forced or unknown host closure cannot pass.

Normal API/browser/reopen checks do not prove crash recovery, migration rollback,
backup/restore, arbitrary application stacks, all viewport behavior, every
research requirement, signed distribution or production health/recovery. The
application trace/capture digests currently support node comparison; this
increment does not publish an application screenshot artifact browser.

## Validation record

Validation on native Windows at `ca6028e`, including the subsequent fixture
corrections, has produced these results:

- `npm ci`: passed. Its existing dependency audit reported 16 vulnerabilities;
  this increment did not update dependencies.
- `npm run typecheck`: passed after correcting the ordinary-workspace fixture's
  request/evidence projection. The original type error is retained.
- `npm run build`: passed.
- The first 27-suite focused run closed with 488 passed, 6 failed and 5 skipped.
  The failures exposed missing authenticated Windows workspace advertisement in
  the two new server cases and missing capability binding in the four application
  routing cases. Both fixture corrections preserve the production checks and all
  assertions. Running the two complete affected suites afterward passed all
  66 tests; typecheck also passed again.
- All three fixed compiler packagers assembled their fresh outputs successfully.
  This is packaging evidence, not native compiler execution.
- The first actual fixed service-host packaging attempt failed its early-module
  guard: the new pure domain application contract was pulled into the bootstrap
  graph. That failure and its staging directory are retained for diagnosis.

The full unit suite, Web E2E and real native/provider application acceptance have
not yet run on this implementation. Controlled owner/HTTP fixtures do not prove
real Windows process, real browser or live-model acceptance. Do not enable this
capability in a user's node configuration on the basis of these checks alone.
