# User-requested Agent artifact opinions

Implementation candidate, not validated. This slice adds no automatic acceptance,
Provider, platform or publication owner. Existing automatic product peer review
retains its separate evidence and authorization contracts.

A user may POST `/api/v1/tasks/:id/agent-reviews` with
`{version:1,source_run_id,reviewer_agent_id,artifact_ids?:string[]}`. The source
must be the current `review` Task and latest completed Run. The other logical
Agent must belong to the same project's current Squad. One to 100 selected
content-addressed artifacts, at most 10 MiB in total, are frozen by source Run,
artifact ID, type and SHA-256. Path-only artifact metadata is insufficient.
The original requesting user's AI sharing grant/policy is retained and rechecked.

The result `{review:TaskAgentReviewV1}` binds a new ready project Task and its
room atomically. It has no parent, Goal, execution-policy parent or ordinary DAG
edge, so it cannot block the source's Goal completion or inherit another owner.
It does not start automatically. Explicit duplicate requests for the same
source Run/reviewer return the same relation only when user and artifacts match.

Assignment and prepared scheduling restrict this Task to the chosen logical
Agent, current Squad and a paired node that advertised `dependency_inputs` v1.
An old node's `code.read` advertisement alone does not qualify. On the same
computer, missing/overlapping author and reviewer workspace roots are rejected;
lexical isolation is not a new sandbox or permission to write source files.
Dispatch rechecks the persisted relation, source and exact reviewer Run.

The frozen ContextPack contains optional `agent_review_subject` v1 and an
ordinary-shaped dependency input of type `user_requested_review`. Its source
workspace is null. Only this exact persisted relation permits reading source
artifacts while the source is still `review`; ordinary dependencies continue to
require `done`. The paired-node content route rechecks the exact relationship,
source candidate, consent and SHA-256 identity both before and after blob IO.
The node's existing immutable input loader transfers and checks actual bytes.

GET `/api/v1/tasks/:id/agent-reviews` returns `{reviews:TaskAgentReviewViewV1[]}`,
bounded to the latest 50. It includes review Task/Run status, genuine final
`run.answer` message text, report artifact IDs, stale reason and any applied
feedback event. Stdout logs are not promoted to reports. A moderated latest
report does not fall back to an older answer. Historical opinions remain visible
when stale, with their original attribution; they cannot be applied again.

POST `/api/v1/tasks/:id/agent-reviews/:reviewId/request-changes` accepts
`{version:1,review_run_id,comment?:string}` and returns `{task:Task}`. Only an
explicit user command may apply the review Task's exact latest completed Run and
unmoderated final report. The server retrieves that report itself; clients cannot
replace it. Source candidate checks, the existing `changes_requested` kernel,
provenance event and immutable applied-feedback record share one transaction.
The original report and optional user comment flow into normal retry ContextPack
feedback. An Agent answer cannot alter the author's status or accept it.

Leaving the source's exact review candidate, a later source Run, changed artifacts
or withdrawn consent makes the relation stale. Creation's descriptive UI event
does not invalidate its own relation. Migration `0079_task_agent_reviews.sql`
adds append-only relationships and feedback; old migrations are unchanged.

No checks, tests, builds, formatters or native/browser probes were run during
implementation, per the implementation-stage instruction. Final verification
must cover this server slice together with the Web review UI, node input owner
and the controlled collaboration E2E; a fixture does not establish real Provider,
two-machine execution or inspection of the author's complete workspace.
