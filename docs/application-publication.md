# Bounded local application publication

This increment implements the publication contracts, original-session admission,
local executor and server completion gate. Type checking, workspace build,
focused controlled tests and fixed-host packaging have passed. Full regression
and real Windows publication acceptance remain incomplete; the feature is not
ready for enablement.
The existing [development verification](application-development-verification.md)
and its `qualified_for_product: false` evidence retain their original meaning.

## Implemented source boundaries

- `packages/domain/src/application-publication.ts` defines a separate original
  user grant, protected capability binding, immutable publication request, bounded
  root lease, publication receipt and subsequent service observations. These
  schemas validate data; parsing them does not create execution authority.
- `apps/artood/src/application-publication-profile.ts` prepares a node-local
  opaque profile from a protected configuration pin. It retains the original
  application verifier and native backend, audits the fixed host and toolchain,
  and isolates deployment, selection and journal storage from agent write roots
  and verification stores. An integrity failure invalidates that profile token.
- The application verifier retains the original successful observation's
  candidate, definition and run binding privately. The final verifier separately
  retains only its original successful result after its final source audit.
  Equal JSON, a changed run or result, and a different prepared profile cannot
  retrieve this provenance. It is not a publication permit: original native
  writer closure, independent accepted review and original publication
  authorization must still be established by the publication acceptance registry.
- The installation materializer has an additive provenance result for its fixed
  four-configuration relocation. It records the original manifest and profile,
  intended target plan, unchanged member pins, and preserved application scope,
  HTTP configuration and runtime expectations. The existing materialization API
  retains its result and admission reads. This is a plan record; it does not
  prove installation, database identity or a running application.

Old `app_delivery` grants cannot be promoted to publication. The separate new
grant is `app_publication: { version: 1,
kind: "same-computer-local-application-publication", publication_profile_id }`.
Goal submission records its original user authorization and publisher session.
Migration `0055` adds immutable requests, append-only observations and a separate
completion settlement. The initiating user and system decisions remain separate.

The acceptance registry requires the original completed author and reviewer,
node-owned verification objects, actual committed evidence ACKs and original
native closure. Its single-use permit cannot be reconstructed from JSON. The
executor owns initialization, two service generations, fixed read-only HTTP
health probes, normal drain, reopen and the finite root lease. Receipt delivery
retains exact bodies and ordered observations when acknowledgements fail.

Publication uses a separate ordinary WebSocket session announcement. A reconnect
cannot adopt an existing grant, candidate or running service. New work requires
the current authorization; stop and closure reporting retain captured original
owners after execution permission ends.

The server API exposes `GET /api/v1/goals/:id/application-publication` and
`POST /api/v1/goals/:id/application-publication/stop`. The latter remains available
after goal completion. These endpoints distinguish historical publication from
current availability and refuse to show stale observations as healthy. The goal
page now shows this history, current availability and a stop action in source;
the prepared request form still needs only the objective. Expired or uncertain
observations do not expose an availability link.

## Bounded publication scope

The configured native Windows x64 publisher installs the final independently
reviewed candidate into one new deployment store. It must confirm initialization,
start and check health, drain the first original service normally, and reopen
the same descriptor at the same URL with the same database. Only after the
second original service is healthy and observed live can it emit a publication
receipt. The second service remains running within the original finite lease.

Each service retains the existing 256 accepted-request limit and concurrency of
one. There are exactly two service generations and no lease renewal or third
owner. Health probes also consume the request budget. A historic successful
publication and the current service state are separate records. Expired, closed
or unknown service state must not be presented as currently available.

The first version does not provide permanent hosting, automatic owner rotation,
daemon-restart recovery, cross-computer adoption, migration rollback or database
restore. A normal reopen is not crash recovery. The same computer's two nodes
do not establish physical cross-computer acceptance.

## Configuration and remaining validation

The node accepts protected publication profile selections programmatically. The
CLI supports one selection through `ARTOO_APPLICATION_PUBLICATION_PROFILE_FILE`,
`ARTOO_APPLICATION_PUBLICATION_PROFILE_SHA256` and
`ARTOO_APPLICATION_PUBLICATION_VERIFIER`, supplied together with the original
native Windows verifier. Profile preparation enforces the file pin, ACLs, host
and storage boundaries before advertising the capability. There is no enabled
default profile or verified installation recipe yet.

Completion requires exhaustive must-criterion coverage from accepted research
and design, actual development verification, substantive independent review and
the explicit bounded publication claim. A fresh health and original native-owner
observation of the second service is required in the completion transaction.
Completed tasks alone are insufficient. Controlled service UI tests passed;
actual installed-profile validation and a live-provider publication acceptance
run remain outstanding.

The new source includes controlled regression cases for data contracts,
protected-profile boundaries, original verification provenance, the server
publication chain and service UI. Six focused node suites passed 108 cases,
the publication migration suite passed three, and the updated host-builder tests
passed 56.
Actual host packaging and readback passed with `qualifiedForProduct: false`.
These results do not establish native or live-provider publication acceptance.

The integrated coordination correction separates actual owner closure from
terminal observation delivery, so Stop can retry its retained evidence after a
transient delivery failure. Before auditing mutable publication storage, the
parent pauses its original service, waits for admitted HTTP work and original
runtime/broker settlement, and then performs the complete ACL and file-identity
checks. Conflicting source/verifier writers remain excluded until actual owner
closure; unrelated workspaces remain available. Neither a routing record nor an
earlier successful audit supplies execution authority.

Before this correction, the complete regression run passed 8,137 tests with 90
conditional skips. The integrated version has passed type checking, workspace
build and 592 focused tests across 17 suites. These include real HTTP transport
with controlled native-owner boundaries, not real native process execution.
The complete regression/Web checks on the final version and actual native
application acceptance are still required.

The subsequent Web regression passed all 27 cases on an isolated local server.
The current native helper passed 18 target-control cases, seven target-input
cases and one ordinary-node compatibility case. QuickJS passed its 13-case
native fixture. These verify their respective protocol and process boundaries;
the ordinary-node case uses controlled admission and none is a live-provider
product acceptance run. Earlier failed attempts remain recorded.

Native testing also found that Windows can update a newly written internal
dispatch record's ctime and extended attributes without changing its content.
Only dispatches sealed by the original exclusive local writer now use a semantic
integrity check: the independently expected canonical bytes, original file
identity, final write time, current owner/group/DACL, protected parent paths and
single default data stream remain binding. ctime and extended attributes are
diagnostic facts, not execution authority or a claim about a particular Windows
cache. Existing files cannot be registered or rebaselined through this API;
other files, directories, external source and tools keep their original checks.
This trusted-node-user boundary does not promise detection of every transient
same-user change between observations.

The fixed collector uses a validated compiler temporary directory under
`%USERPROFILE%\.artoo\windows-sealed-compiler`; it creates missing fixed
directories after checking their parents and does not change ACLs. The 39 focused
sealed-record tests, a fresh-record startup audit and five real Guardian cases
passed. The latter confirms collector ownership and cleanup, including compiler
descendants; its deliberate fixture-worker termination is not application
graceful-drain evidence. See the [native collector instructions](../apps/artood/test-fixtures/windows-sealed-collector-README.md).
The final complete regression and real application publication remain pending.

## Publication host protocol source

The publication process and fixed host now have separate versioned initialization,
listening, counter and normal-drain statuses. Existing verification selections,
`qualified_for_product: false` statuses and the verification parent's shutdown
bytes are unchanged. Initialization retains single-message target-input v1.
The publication service explicitly requires the separate bounded
`artoo.windows-target-control.v1` capability on its original anonymous stdin
pipe. The parent sends the fixed final `drain` command and requires its original
target-control byte acknowledgement and input closure plus the original root, Job,
stdout/stderr EOF and helper closure before admitting the second owner. It never
adopts a PID, promotes a verification store, renews the lease or starts a third
service. Original cleanup facts remain readable after execution permission ends.

Both service generations begin with business admission paused. A private,
single-use nonce arms exactly one fixed health GET; it is not reflected in the
response or exposed in product state. Each probe must settle its original
transport and runtime/broker owners before another storage audit. The second
owner resumes only after fresh validation, and publication/healthy observations
follow its actual resume acknowledgement. Periodic health inspections use this
same pause/audit/probe/resume cycle within the original deadlines and lease.

Initialization captures relocation provenance and the original installation's
REOPEN pin, physical database identity, stored scope, schema and client-entry
digest before retiring that installation authority. Normal reopen checks these
same facts and completes the original open-only broker preflight before exposing
readiness. The trusted HTTP ingress overwrites the reserved publication identity
and probe headers. Its request counts have a separate observation timestamp from
native Job membership; these are point observations, not an atomic snapshot.
After the two health reads, a barrier waits for the original host's verified
stdout count to include both admissions and report no request in flight. It uses
the same health deadline and cancellation signal, observes original service
closure and makes no additional request or synthetic counter update.

The host build audit allows only the exact source/build locations of the pure
domain application-development, application-publication and
application-publication-measurement contracts, plus the exact artood
application-publication-process-protocol source. The latter imports the narrow
publication contract rather than the domain barrel. The new control protocol
and bootstrap control parser also have exact source-path allowances. They have
no module-evaluation side effects; binding the original stream and host
operations requires the explicit installer call. These additions contain no
installation or process authority. The parent executor remains outside the early host graph; the runtime,
broker and SQLite remain behind the fixed deferred host import. Similar names in
other directories remain rejected.

Type checking, workspace build and the new fixed-host bundle's packaging and
readback passed for the integrated coordination changes. The bundle retains
`qualifiedForProduct: false`; packaging does not establish native execution.
Full regression on the final version and native publication acceptance remain
incomplete. The separate
original live static-web attempt ended at its original deadline with a failed
handoff storage audit; its shutdown completed and its evidence is retained.
It does not establish application publication.
