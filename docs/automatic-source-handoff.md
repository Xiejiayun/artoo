# Automatic Windows source handoff

This opt-in extends Agent Team publication with a first cross-computer handoff. The source computer plans, researches and independently reviews the research. GoalRunner then selects a prepared Windows destination and two different agents there, creates the first source-transfer intent, and continues the existing imported research review, design, implementation, validation and publication flow. It does not require the user to build a team or invoke a handoff API after creation.

This implementation covers one research-to-design handoff. It requires exactly four ordered tasks: research, design, implementation and validation, with each later task depending directly on the preceding task. All three later stages use the selected destination workspace. Arbitrary multi-hop placement, a different computer for every stage, mobile execution and new deployment providers are outside this version.

## Create a goal

In **Goals → New goal**, choose **Agent Team — build and publish**, describe the objective, and select **Allow Artoo to divide work across configured computers**. The checkbox starts unchecked and clears when the mode changes or the dialog closes. It grants the system permission to use prepared computers for this new goal. The progress panel shows the grant and assigned team; a grant alone does not mean that a destination has been selected or that publication succeeded.

API clients can make the same single request to `POST /api/v1/autonomous-goals`:

```json
{
  "project_id": "your-project",
  "objective": "Build and publish the requested static product",
  "execution_mode": "agent_team",
  "verification_profile_id": "default",
  "release_profile_id": "default",
  "max_retries": 3,
  "source_handoff": { "version": 1, "mode": "automatic" }
}
```

The requested verifier and release profile identify the source's configured profiles. The destination uses its own locally prepared profiles from the matching route; their identifiers may differ. The Web form uses the `default` source profile names.

The new field is optional. Requests without it, historical goals and manual execution retain their existing placement behavior. SQL migration `0047_automatic_source_handoff.sql` stores the original grant and prevents changing it after creation. Normal pause, cancel and sharing-consent revocation remain effective. A user-attributed `goal.product-handoff.authorized` event records the grant; a separate system-attributed `goal.product-handoff.selected` event records GoalRunner's route and team choice.

## Prepare computers once

Follow the [native Windows source-node setup](windows-native-source-nodes.md) for paired node identity, protected local configuration, qualified run-event receipts, native process supervision, verification profiles and release storage. Both computers need current paired sessions in the same organization. Each participating node must be enabled and available under the ordinary scheduler and project capability checks.

The source needs a policy-v2 verifier and corresponding prepared release profile, `sourceResearch`, source operations, and two independent Agent Team contributors including a research-capable contributor. Its discovery message advertises `source_exports` only when these local source operations are actually configured.

The destination needs a complete local policy-v2 `destinationResearchMappings` entry for the source release, with every source/destination verification command mapped one-to-one, matching command contracts and the same release contract. Its configured operations must include imported research review, design and its review, implementation and its review, and final validation. It also needs a corresponding prepared publication profile and two different available agents supporting `code.read`, `code.modify` and `code.review` in that workspace. The design/validation author must cover the capabilities required by those two stages; the implementation author must cover that stage's requirements. Each agent must independently declare `code.read` and `code.review` for imported research review. GoalRunner checks these separate roles before selecting the first hop, allowing agents with complementary specializations. A configured recovery destination still follows the existing supervisor registration gates.

The optional `product_source_routing` hello field describes these prepared choices. The node builds it from protected local configuration and original prepared profile readers. Recovery discovery does not open a new source runtime or create writer authority. The server exposes a private copy only for the current paired session with qualified receipts and matching current release descriptors. Discovery metadata does not authorize commands, verification, review or publication.

## Runtime behavior and evidence

After research is accepted, GoalRunner requires the original completed source run, qualified verification, independent review and one original node-owned semantic export. It chooses an available destination, locks and rechecks its agents and workspace, then invokes the existing trusted handoff admission in the same database transaction. That admission repeats the original user's sharing authorization, active pairing, source proof and complete profile bindings. Selection is refused when configuration, sessions, capabilities or workspace availability do not match.

The original source computer/workspace, planning snapshot, research context, export and review stay intact. Later team assignments reference the destination agents; source reviewers remain in the team history. Subsequent execution and release use the existing protected node-local operations and exact evidence bindings. A lost session or occupied workspace may leave the goal waiting; the system does not silently substitute ordinary execution for the required handoff.

The regression suites cover request authorization, immutable grants, discovery snapshots, GoalRunner's first handoff, workspace conflicts and changed configuration/session rejection. Their DB and protocol inputs are explicitly controlled. Passing them does not establish a live model run, native process closure, signed distribution or actual publication. Product acceptance must separately start with a real one-time goal request and exercise the paired native Windows nodes through publication and health checks.
