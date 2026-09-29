# Project planning with agents

Create a goal with an objective and observable acceptance criteria. In the goal's
**Agent planning** section, select two to six distinct agent instances and give
each a role, for example design, implementation review, security review, or
verification. Choose one to three rounds and a two to sixty minute deadline.
The discussion can live in the goal's conversation or a channel in that project.

Each agent reads the objective and the earlier replies in that thread before
contributing. The first selected agent produces a final synthesis after all
rounds. The maximum number of model turns is `participants × rounds + 1`.
Waiting for an unavailable agent consumes the discussion's time allowance.
Human team replies add context for subsequent contributions. Planning threads
do not accept independent **Send to agent** requests: the coordinator owns the
turn order and the stopping boundary.

The final reply must contain a structured plan with task descriptions, acceptance
criteria and dependency references. Web, Windows and native iOS show a readable
**Suggested plan** card for a server-validated final synthesis, including task
criteria and named dependencies. **Show original reply** reveals the unchanged
model response. Ordinary messages and invalid or unattributed JSON remain raw;
historical final replies are enriched only after checking their discussion,
turn, run and thread links. Viewing the card creates neither proposals nor tasks.

**Create plan proposal** validates that
reply, including dependency cycles and unsupported controls. It saves a versioned
proposal; it does not create execution tasks. Inspect the proposed tasks and use
**Accept plan and create tasks** to materialize the dependency graph. Invalid
model output stays visible in the thread and can be used as context in the manual
plan editor. Existing plans require the goal's normal pause/replan workflow.

Discussion sessions, their next-turn cursor, messages and assistant intents live
in the server database. Restarting a dispatcher does not create duplicate turns.
Each thread has separate message cursors and model context. A deadline or **Stop
discussion** prevents later rounds. If the daemon cannot confirm that its process
has exited, the session stays **stopping**, including after server restart.

Built-in discussion runtimes use Codex's read-only sandbox or Claude's restricted
Read/Glob/Grep tool set. Codex's sandbox restricts filesystem writes; it does not
disable inherited MCP servers or plugins. Node administrators must separately
restrict those external capabilities before using a discussion runtime.
Custom process commands must provide an explicit local
`discussionCommand`; otherwise discussion execution fails closed. Model replies
come from structured provider output, not arbitrary stdout. The UI separately
shows runtime output and available provider token/cost measurements. Unknown
prices remain unavailable, and a monetary spending cap is not yet supported.

This is a shared trusted-team preview. Channels are project rooms shared by the
team, with threads, real user mentions and personal notifications; they do not
have per-channel private membership or Slack/Discord federation. Decomposition
still needs human review, and does not automatically assign every resulting
task or guarantee the quality of a model's plan.

Validation combines server/scheduler/database tests, fixture CLI subprocesses,
browser workflows and native simulator tests. Separate local Codex gates passed
using Aerial 0.3.3's GitHub Copilot route with requested model `gpt-5.4-mini`:
a two-turn conversation reused the first answer, and a three-turn discussion
between two agent instances reused the actual prior replies and materialized
the proposed tasks, criteria and dependency only after explicit acceptance.
Provider token usage was recorded; costs remain unknown.

Those initial live checks use temporary process-level provider settings, fixture
authentication and in-process node transport. Additional installed Windows
verification at `bd0ee48` saves the Aerial/Copilot connection through Settings,
restarts the app, and uses its actual worker and authenticated node WebSocket.
The first attempt passed two chat turns but failed during discussion for an
undetermined reason. A discussion-only retry with the same installer then
passed three real contributions, card rendering, unchanged original-response
expansion, zero tasks before acceptance, and the two accepted tasks with their
criteria and dependency. Both attempts completed cleanup; this does not claim
one passing five-turn run. The Web owner cookie is test-provisioned and the
server runs on loopback. Live Claude execution, task-writing model execution
and production deployment remain unverified.

At `eae1166`, native Debug and Release builds passed, with all 71 unit XCTest
cases and three Release UI scenarios passing without failures. The UI scenarios
cover chat synchronization, daemon recovery and discussion/proposal/acceptance;
the native discussion uses deterministic subprocess fixtures. Physical iOS
devices, signing and distribution need separate validation. See the
[acceptance record](cross-client-sync.md) for evidence by revision and the
[live gate instructions](shared-server.md#optional-live-conversation-gate).
