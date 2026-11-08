# Bounded local application publication

This increment prepares the publication contracts and local provenance checks.
It does not yet publish an application, enable a node capability, accept a new
goal grant through the API, or let GoalRunner complete an application goal.
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
  authorization must still be established by the future publisher.
- The installation materializer has an additive provenance result for its fixed
  four-configuration relocation. It records the original manifest and profile,
  intended target plan, unchanged member pins, and preserved application scope,
  HTTP configuration and runtime expectations. The existing materialization API
  retains its result and admission reads. This is a plan record; it does not
  prove installation, database identity or a running application.

Old `app_delivery` grants cannot be promoted to publication. The proposed new
grant is `app_publication: { version: 1,
kind: "same-computer-local-application-publication", publication_profile_id }`.
Its API, UI, durable authorization event and database integration remain pending.

## Intended first publication scope

The configured native Windows x64 publisher will install the final independently
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

## Remaining integration and validation

The publication acceptance registry and permit, use of relocation provenance by
the fixed process executor, independent health checks, original session routing,
append-only database migration, GoalRunner completion gate and user-visible
service status still need implementation. A completed goal must also bind the
accepted requirements to actual development evidence and the explicit bounded
publication claim. Completed tasks alone are insufficient.

The new source includes controlled regression cases for data contracts,
protected-profile boundaries and original verification provenance. Local checks
have not yet run: the original live Windows acceptance attempt owns the local
test/native/browser window. Source review is not typecheck, unit, native,
live-provider or publication acceptance evidence. The implementation must pass
the repository's full checks and actual native application acceptance before
the feature is enabled.
