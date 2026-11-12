# Computer and Agent lifecycle

Owners and admins can delete computers, reusable Agents, and individual Agent
instances from Machines and Agents. Deleting a computer removes its instances,
revokes its linked device credentials and disconnects its node. Deleting an Agent
removes all of its instances; deleting only an instance keeps the reusable Agent.
Local workspace files are never deleted. Historical tasks, runs and audit records
keep their original references through database tombstones.

Deletion fails while a resource has active work, pending publication or a
disconnected process whose exit has not been confirmed. Deleted resources cannot
be scheduled, re-enabled or restored by heartbeat. Connect a new device or create
a new Agent/instance to replace them.

Resources automatically show **Expired** after 30 days without activity. Set
`ARTOO_RESOURCE_EXPIRY_DAYS` on the server to an integer from 1 to 3650 to change
this threshold. The API adds an optional `lifecycle` object with `version: 1`,
state, last activity, expiration deadline and inactivity timeout. Existing clients
and stored status values remain compatible.

Computer expiration follows its heartbeat (creation time before its first
connection). Instance expiration follows its runtime heartbeat, falling back to
the computer heartbeat for older daemons without a runtime row. New instances
receive a full inactivity window. An Agent expires once all its instances have
expired; an identity without instances ages from its creation time.

Expiration retains the resource and its credentials. Reconnecting the computer
and advertising its runtime restores availability automatically. Manual disabled
settings remain in effect. Short presence and scheduler heartbeat timeouts still
exclude unavailable nodes promptly; the inactivity deadline is an additional
long-term guard, including the legacy missing-runtime fallback.
