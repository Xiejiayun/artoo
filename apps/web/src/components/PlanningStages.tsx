import type { Goal, Plan } from "@artoo/domain";

/** Saved milestones only; this deliberately has no simulated progress clock. */
export function PlanningStages({
  goal,
  plans,
  automatic,
}: {
  goal: Goal;
  plans?: Plan[];
  automatic: boolean;
}): React.ReactNode {
  const accepted = plans?.find((plan) => plan.id === goal.current_plan_id && plan.status === "accepted");
  const proposed = plans?.some((plan) => plan.status === "proposed");
  const stages = [
    { title: "Describe outcome", state: "Saved" },
    {
      title: "Plan together",
      state:
        plans === undefined ? "Awaiting observation" : plans.length > 0 ? "Proposal recorded" : "Awaiting proposal",
    },
    {
      title: automatic ? "Authorized plan decision" : "Review & accept",
      state: accepted
        ? "Accepted"
        : proposed
          ? automatic
            ? "Managed by goal policy"
            : "Needs your review"
          : "Not accepted",
    },
    { title: "Create team tasks", state: accepted?.materialized_at ? "Tasks recorded" : "No materialized plan" },
  ];
  return (
    <ol className="cowork-planning-stages" aria-label="Planning milestones">
      {stages.map((stage, index) => (
        <li key={stage.title}>
          <span>{index + 1}</span>
          <div>
            <strong>{stage.title}</strong>
            <small>{stage.state}</small>
          </div>
        </li>
      ))}
    </ol>
  );
}
