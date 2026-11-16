# Cross-computer dependency input delivery

An artifact reference in a ContextPack does not establish access to its bytes.
The target node can use the dedicated read endpoint below for a frozen dependency
of its own assigned Run. It cannot use this permission to browse organization
artifacts, access another computer's filesystem, or merge/apply a patch.

`GET /api/v1/node/runs/:id/dependency-artifacts/:artifactId/content`

The caller supplies a paired node bearer and `x-artoo-session-id` for its current
transport generation. Development tokens and control/session credentials are not
accepted here. The server checks node/device/token/session ownership, an active
Run, its exact stored ContextPack, original user AI-sharing authorization, the
project-scoped dependency, and the source task's latest accepted completed Run.
The artifact's id, source Run, type and checksum must match the frozen reference.

An ordinary paired node can opt in with `dependency_inputs: { version: 1 }` in
its hello. The server announces `node.dependency-inputs.session.v1` on that exact
authenticated socket after registration, containing only version, node id and
the server-owned session UUID. A reconnect gets a new identity; old, unpaired
and non-opted-in sockets receive no announcement. This is separate from
publication and managed execution negotiation and grants neither capability.
The HTTP route still checks the paired bearer and all Run/source permissions.

For scheduler Runs, pre-ready input download is allowed only for the original
consumed device/session while the Run is queued and no lease has ever been
issued. This read confers no physical launch authority and does not consume or
extend the original five-second launch window. Once a lease exists, the original
current unexpired lease and session are required; expiry cannot fall back to the
pre-ready rule.

The response contains raw `application/octet-stream` bytes, at most 10 MiB, with
`x-artoo-checksum`, `x-artoo-artifact-id`, and `x-artoo-source-run-id` headers.
Content is private and not cacheable. The server validates retained bytes and
checks authorization again after object-store IO. Missing content remains a
failure; local file URIs and arbitrary content paths are never followed.

The node constructs this route from its configured server origin and frozen ids,
rejects redirects, bounds response and aggregate sizes, and independently checks
provenance and digest before exposing a read-only input snapshot to the CLI.
Binary content must retain its binary identity rather than be decoded as text.
The managed scheduler path now performs this transfer before journal ready and
hands a private, payload-bound, once-consumed input snapshot to the existing
physical Run owner. Cancellation closes untaken snapshots; taken snapshots stay
with the owner until actual resource closure. Changed inventory or identity is
retained as an error rather than recursively deleted. This path remains behind
the existing local scheduler opt-in and native platform qualification guards.
It requires frozen source-Run artifacts; it does not extend ordinary manual
execution or invent a source Run for legacy manually attached artifacts.

Regression sources cover controlled two-computer/two-Agent inventory, real
device-token authentication, source upload and acceptance, exact delivery,
unrelated ids, replaced sessions, changed upstream state, terminal recipients,
object integrity and authorization changes during storage IO. These tests are
deferred to the final integrated pass. They do not constitute a real two-computer
or live-Provider acceptance run.
