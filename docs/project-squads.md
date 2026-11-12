# Project squads

Machines and Agent identities are organization resources. Each execution instance
belongs to at most one project's squad, with its own configured workspace and
runtime. Reuse an Agent identity by creating another instance for another project;
choose a separate workspace for that project. Creating a project starts an empty
squad and does not inherit another project's agents.

The sidebar lists only the selected project's instances and their machines.
**Manage project squad** opens the Agent library filtered to that project. Use
**Project scope → All projects / Unassigned** to find existing instances. Owners
and administrators can select **Project squad** on an instance and save its
membership. Moving it retains the existing workspace path, which is shown on its
card; it does not move or create files. Registration defaults the project selector
to the currently selected project.
The iOS Team screen provides the same membership controls and project selector
when creating an instance.

`AgentInstance.project_id` is an additive nullable field. Older API snapshots may
omit it; clients treat those instances as unassigned. Registration accepts an
optional `project_id`; omission or null creates unassigned inventory. Assign it
before execution. `PATCH /api/v1/agent-instances/:id/project` accepts
`{ "project_id": "..." }` or null and requires an owner/admin in the same
organization. Both automatic scheduling and manual pins require matching project
membership. Goal planning participants and a conversation's explicit execution
agent have the same restriction. Unassigned
instances are not scheduling candidates. Browser, desktop and iOS execution,
planning and conversation selectors show only the corresponding project's squad.

Membership changes take the assignment instance lock and reject active runs,
unconfirmed disconnected processes, unsettled standalone operations and active
planning discussions. Completed runs and audit records retain their original
project and execution bindings.

Migration `0058_project_squads.sql` adds the nullable ownership column and index.
It associates a legacy instance only when its exact workspace match, historical
task/run usage, or sole organization project identify one project. Conflicting or
unknown ownership stays unassigned for an administrator to review. No execution
history is rewritten. Apply the migration through the normal server migration
path with the environment's database backup and recovery procedure; this change
does not apply migrations to an existing running deployment.
