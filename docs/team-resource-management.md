# Agent teams and admission

Logical Agents can be created before choosing execution machines. Their role,
description and instructions are versioned guidance. A Run freezes that guidance
in its ContextPack; editing an Agent does not replace an existing Run's inputs,
admission permission or node-owned verifier profile. Runtime compatibility still
comes from actual registered machine runtimes and configured instances.

New APIs:

- `POST /api/v1/agents`: `{version:1,request_key,configuration}`. Creation keys
  deduplicate retries even after later configuration edits. A different original
  payload with the same key is rejected.
- `GET/PUT /api/v1/agents/:id/configuration`: edits use
  `{version:1,expected_revision,configuration}`. Configuration contains
  `version`, `display_name`, `kind`, `capabilities`, `role`, `description` and
  `instructions`. Responses wrap the versioned record in `configuration`.
- `GET/PUT /api/v1/projects/:id/squad`: edits use
  `{version:1,expected_revision,agent_ids}`; responses contain `squad` with
  `project_id`, `revision`, `agent_ids` and `source`. Without an explicit record,
  membership derives from existing project-bound instances with revision zero.
  Explicit logical membership admits eligible instances bound to that project or
  organization-wide instances; it cannot borrow an instance bound elsewhere.
- `GET/PUT /api/v1/computers/:id/admission`: edits use
  `{version:1,expected_revision,state:"accepting"|"draining"}`. Responses wrap
  the versioned record in `admission`. Missing records retain accepting behavior.
  Draining prevents new assignments and preserves existing reservations, Runs,
  processes and retained workspaces. It never powers a machine off.
- Scheduling-policy PUT endpoints also accept
  `{version:1,expected_revision,policy}`. Legacy unwrapped v1 policy bodies remain
  compatible. New editors should use the revision wrapper.

Resource reads require current organization membership. Writes require an
administrator, scope every referenced object to the organization, and reject
stale revisions. New metadata does not enable execution: the operator rollout,
original user execution request, current paired node, capacity and protected
node admission checks remain required.

Regression coverage has been written for creation replay, concurrent-edit
conflicts, organization/role boundaries, logical Squad selection, drain resource
retention and immutable Run guidance. Validation is deferred to the requested
final integrated pass; no passing checks or product acceptance is claimed here.
