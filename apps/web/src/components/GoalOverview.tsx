import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Flag, ListChecks, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import type { Goal, GoalAutomation, Plan } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { ActionError } from "./ActionError.js";

/** Counts come from current tasks, never a historical checkpoint or model output. */
export function GoalOverview({ goal, automation, plans }: { goal: Goal; automation?: GoalAutomation | null; plans?: Plan[] }): React.ReactNode {
  const api = useApi();
  const tasks = useQuery({ queryKey: queryKeys.tasks(goal.project_id), queryFn: () => api.listTasks(goal.project_id), refetchInterval: 10000 });
  const linked = tasks.data?.tasks.filter((task) => task.project_id === goal.project_id && task.goal_id === goal.id && (!goal.current_plan_id || task.source_plan_id === goal.current_plan_id)) ?? [];
  const done = linked.filter((task) => task.status === "done").length;
  const attention = linked.filter((task) => ["blocked", "awaiting_approval", "review"].includes(task.status)).length;
  const proposal = plans?.some((plan) => plan.status === "proposed");
  const closed = ["completed", "cancelled", "archived"].includes(goal.status);
  const next = goal.status === "completed" ? { title: "Ready to review the outcome", text: "Review delivery evidence and publication availability before sharing the product.", label: "Review delivery", to: `/release?goal=${encodeURIComponent(goal.id)}` }
    : goal.status === "paused" ? { title: "This goal is paused", text: "Resume when you are ready for new work to be scheduled. Existing runs can finish.", label: "Goal controls", to: "#goal-controls" }
    : closed ? { title: "This goal is closed", text: "Its plans and evidence are retained for reference.", label: "Review delivery", to: `/release?goal=${encodeURIComponent(goal.id)}` }
    : automation?.status === "failed" || automation?.status === "waiting" || goal.status === "blocked" ? { title: "The team needs attention", text: automation?.last_error ?? "Review blocked work and approvals to help the team continue.", label: "Inspect work", to: `/board?goal=${encodeURIComponent(goal.id)}` }
    : proposal && automation === null ? { title: "A plan is ready for your review", text: "Review the tasks and success criteria. Accepting the plan creates its work.", label: "Review plan", to: "#goal-plans" }
    : !goal.current_plan_id ? { title: automation ? "The team is preparing a plan" : automation === null ? "Turn the outcome into a plan" : "Checking the next step…", text: automation ? "You can follow the conversation while the team works." : "Discuss the approach with your agents or propose a plan below.", label: "View plan", to: "#goal-plans" }
    : { title: attention ? `${attention} plan ${attention === 1 ? "task needs" : "tasks need"} attention` : "Follow the current plan", text: "Follow current tasks on the board. Verification and publication are reported separately.", label: "Follow work", to: `/board?goal=${encodeURIComponent(goal.id)}` };
  return <section className="delivery-overview" aria-label="Current goal progress">
    <div className="delivery-next"><span className="delivery-next__icon" aria-hidden="true"><Flag size={19} /></span><div><span className="insights-eyebrow">Next step</span><h3>{next.title}</h3><p>{next.text}</p></div><Link className="os-secondary-link" to={next.to}>{next.label}<ArrowRight size={14} aria-hidden="true" /></Link></div>
    <div className="delivery-facts"><div><ListChecks size={16} aria-hidden="true" /><span>Current plan tasks<strong>{tasks.isError ? "Unavailable" : tasks.isLoading ? "Loading…" : linked.length ? `${done} / ${linked.length} done` : "No linked tasks reported"}</strong></span></div><div><ShieldCheck size={16} aria-hidden="true" /><span>Delivery scope<strong>{automation === undefined ? "Loading…" : automation?.release_profile_id || automation?.app_publication ? "Build & publish" : automation ? "Verified workspace" : "Review each step"}</strong></span></div></div>
    <ActionError error={tasks.error} />
  </section>;
}
