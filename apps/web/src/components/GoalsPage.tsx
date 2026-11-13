import { queryKeys } from "../app/queryKeys.js";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Flag, Plus, Download, ListChecks, MessageSquare, ArrowRight, Sparkles, ArrowUpRight } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  PreparedGoalEntryV1Schema,
  canProposePlan,
  canTransitionGoal,
  type Goal,
  type GoalAutomation,
} from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { usePollMs } from "../app/RealtimeContext.js";
import { useProject } from "../app/useProject.js";
import { useSelection } from "../app/SelectionContext.js";
import { useGoalContext } from "../app/useGoalContext.js";
import { readDiscussionGoalDraft, type DiscussionGoalDraft } from "../app/discussionGoalDraft.js";
import { LoadingView } from "./LoadingView.js";
import { PlanForm } from "./PlanForm.js";
import { GoalOverview } from "./GoalOverview.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { Badge, Button, Input, Modal, Select, StatusBadge, Textarea, useToast } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import { RoomConversation } from "./RoomConversation.js";
import { PreparedGoalRequest } from "./PreparedGoalRequest.js";
import { GoalDiscussion } from "./GoalDiscussion.js";
import { taskUpdatedLabel } from "./taskPresentation.js";
import "../ui/work-insights.css";

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export function GoalsPage(): React.ReactNode {
  const { projectId, bootstrap } = useProject();
  const { goals, items, goal: contextGoal, requested, selectGoal } = useGoalContext(true);
  const location = useLocation();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ objective: "", mode: "manual" });
  const [source, setSource] = useState<DiscussionGoalDraft>();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const entryResult =
    bootstrap.data?.goal_entry === undefined
      ? undefined
      : PreparedGoalEntryV1Schema.safeParse(bootstrap.data.goal_entry);
  const entry = entryResult?.success && entryResult.data.project_id === projectId ? entryResult.data : undefined;
  const entryError =
    entryResult && !entryResult.success
      ? new Error("This prepared product session has an unsupported configuration.")
      : null;
  const goal = !requested && entry?.goal_id ? items.find((item) => item.id === entry.goal_id) : contextGoal;
  useEffect(() => {
    const requestedProject = location.state?.createGoalProjectId;
    if (typeof requestedProject !== "string" || !bootstrap.data || !projectId) return;
    if (requestedProject === projectId && !entry && !entryError) {
      setDraft({ objective: "", mode: "manual" });
      setSource(undefined);
      setCreating(true);
    }
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [bootstrap.data, projectId, location.state, location.pathname, location.search, navigate, entry, entryError]);
  useEffect(() => {
    if (!bootstrap.data || !projectId || !location.state?.goalDraft) return;
    const incoming =
      !entry && !entryError
        ? readDiscussionGoalDraft(location.state.goalDraft, {
            organizationId: bootstrap.data.organization.id,
            userId: bootstrap.data.user.id,
            projectId,
          })
        : undefined;
    if (incoming) {
      setDraft({ objective: incoming.objective, mode: "manual" });
      setSource(incoming);
      setCreating(true);
    }
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [bootstrap.data, projectId, location.state, location.pathname, location.search, navigate, entry, entryError]);
  const matching = items.filter(
    (item) =>
      `${item.title} ${item.objective}`.toLowerCase().includes(search.trim().toLowerCase()) &&
      (filter === "all" ||
        (filter === "closed"
          ? ["completed", "cancelled", "archived"].includes(item.status)
          : !["completed", "cancelled", "archived"].includes(item.status))),
  );
  return (
    <section className="product-page insights-page insights-goals" aria-label="Goals">
      <header className="insights-page__header">
        <div>
          <span className="insights-eyebrow">
            <Flag size={15} aria-hidden="true" /> From an idea to a clear outcome
          </span>
          <h1 className="t-h1">Plan</h1>
          <p>One goal, a shared plan, and a clear next step.</p>
        </div>
        {!entry && !entryError && (
          <Button
            iconLeft={Plus}
            disabled={!projectId}
            onClick={() => {
              setDraft({ objective: "", mode: "manual" });
              setSource(undefined);
              setCreating(true);
            }}
          >
            New goal
          </Button>
        )}
      </header>
      <ActionError error={bootstrap.error ?? goals.error ?? entryError} />
      {entry && bootstrap.data && (
        <PreparedGoalRequest
          key={`${bootstrap.data.user.id}:${entry.session_id}`}
          entry={entry}
          organizationId={bootstrap.data.organization.id}
          userId={bootstrap.data.user.id}
          onCreated={selectGoal}
        />
      )}
      {!entry && !entryError && (
        <details className="delivery-new-outcome" open={!!goals.data && items.length === 0}>
          <summary>Plan another outcome</summary>
          <OutcomeComposer
            key={`composer:${projectId ?? "pending"}`}
            disabled={!projectId}
            onContinue={(objective, mode) => {
              setDraft({ objective, mode });
              setSource(undefined);
              setCreating(true);
            }}
          />
        </details>
      )}
      {creating && projectId && !entry && !entryError && (
        <GoalForm
          key={`form:${projectId}`}
          projectId={projectId}
          initialObjective={draft.objective}
          initialMode={draft.mode}
          source={source}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            selectGoal(id);
            setCreating(false);
          }}
        />
      )}
      {requested && goals.isSuccess && !goal && (
        <p role="status">This goal is unavailable in the selected project. Choose a goal below.</p>
      )}
      {goals.data?.goals.length === 0 && !entry && (
        <p className="os-plan-empty">
          No goals yet. Start with the outcome above; your plans and progress will appear here.
        </p>
      )}
      {!goals.data && (bootstrap.isLoading || goals.isLoading) && <LoadingView label="Loading goals…" shape="goals" />}
      {(goals.data?.goals.length ?? 0) > 0 && (
        <div className="insights-goal-layout">
          <nav className="product-list insights-goal-picker" aria-label="Goal list">
            <div className="insights-picker-tools">
              <Input
                label="Search goals"
                placeholder="Find an outcome…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <Select label="Goal view" value={filter} onChange={(event) => setFilter(event.target.value)}>
                <option value="all">All goals</option>
                <option value="open">Open goals</option>
                <option value="closed">Closed goals</option>
              </Select>
            </div>
            {matching.map((item) => (
              <button
                key={item.id}
                aria-pressed={item.id === goal?.id}
                className={item.id === goal?.id ? "is-selected" : ""}
                onClick={() => selectGoal(item.id)}
              >
                <strong title={item.title}>{item.title}</strong>
                <span className="insights-row-meta">
                  <Badge>{item.status}</Badge>
                  <time dateTime={item.updated_at}>{taskUpdatedLabel(item.updated_at)}</time>
                </span>
              </button>
            ))}
            {goals.data && matching.length === 0 && (search || filter !== "all") && (
              <p className="insights-help">No goals match this view.</p>
            )}
          </nav>
          {goal && <GoalDetail key={goal.id} goal={goal} />}
        </div>
      )}
    </section>
  );
}

function OutcomeComposer({
  disabled,
  onContinue,
}: {
  disabled: boolean;
  onContinue: (objective: string, mode: string) => void;
}): React.ReactNode {
  const [objective, setObjective] = useState("");
  return (
    <section className="os-outcome-composer" aria-label="Plan an outcome">
      <div>
        <h2>What should the team build?</h2>
        <p>Describe the result in your own words. Nothing starts until you confirm.</p>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!disabled && objective.trim()) onContinue(objective.trim(), "manual");
        }}
      >
        <Textarea
          label="Outcome to plan"
          placeholder="Describe the feature, the problem it solves, and what a good result looks like…"
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
          disabled={disabled}
          required
          maxLength={10000}
          rows={3}
        />
        <div className="os-outcome-composer__footer">
          <span className="insights-help">Start with the outcome. Decide how to work next.</span>
          <Button
            type="submit"
            variant="primary"
            iconLeft={Sparkles}
            iconRight={ArrowRight}
            disabled={disabled || !objective.trim()}
          >
            Review setup
          </Button>
        </div>
      </form>
    </section>
  );
}

function GoalForm({
  projectId,
  onCreated,
  onClose,
  initialObjective = "",
  initialMode = "manual",
  source,
}: {
  projectId: string;
  onCreated: (id: string) => void;
  onClose: () => void;
  initialObjective?: string;
  initialMode?: string;
  source?: DiscussionGoalDraft;
}): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const [title, setTitle] = useState(initialObjective.split("\n")[0]?.slice(0, 120) ?? "");
  const [customTitle, setCustomTitle] = useState(false);
  const [objective, setObjective] = useState(initialObjective);
  const [criteria, setCriteria] = useState("");
  const [minutes, setMinutes] = useState("");
  const [mode, setMode] = useState(initialMode);
  const [sourceHandoff, setSourceHandoff] = useState(false);
  const [requestKey, setRequestKey] = useState(newIdempotencyKey);
  const autonomous = mode !== "manual";
  const effectiveTitle = title.trim() || objective.trim().split("\n")[0]?.slice(0, 120) || "";
  const mutation = useMutation({
    mutationFn: () =>
      autonomous
        ? api.createAutonomousGoal(
            {
              project_id: projectId,
              objective: objective.trim(),
              verification_profile_id: "default",
              execution_mode: "agent_team",
              ...(mode === "publish" ? { release_profile_id: "default" } : {}),
              max_retries: 3,
              ...(mode === "publish" && sourceHandoff
                ? { source_handoff: { version: 1 as const, mode: "automatic" as const } }
                : {}),
            },
            requestKey,
          )
        : api.createGoal(
            {
              project_id: projectId,
              title: effectiveTitle,
              objective: objective.trim(),
              priority: "p2",
              acceptance_criteria: lines(criteria),
              budgets: {
                max_elapsed_ms: minutes ? Number(minutes) * 60000 : null,
                max_cost_usd: null,
                max_retries: null,
                max_concurrent_runs: null,
                allowed_runtimes: null,
              },
            },
            requestKey,
          ),
    onSuccess: async ({ goal }) => {
      await query.invalidateQueries({ queryKey: queryKeys.goals(projectId) });
      onCreated(goal.id);
    },
  });
  return (
    <Modal
      open
      onClose={() => {
        if (!mutation.isPending) onClose();
      }}
      title="New goal"
    >
      <form
        className="insights-goal-form u-stack"
        aria-label="Create goal"
        onChange={() => setRequestKey(newIdempotencyKey())}
        onSubmit={(event) => {
          event.preventDefault();
          if (!mutation.isPending) mutation.mutate();
        }}
      >
        {source && (
          <p className="delivery-draft-source">
            Draft from a conversation. Review and edit it before creating a goal.{" "}
            <Link
              to={`/channels?room=${encodeURIComponent(source.roomId)}&project=${encodeURIComponent(projectId)}&thread=${encodeURIComponent(source.messageId)}`}
            >
              Back to message
            </Link>
          </p>
        )}
        <Textarea
          label="Objective"
          placeholder="Describe the result and why it matters."
          value={objective}
          required
          maxLength={10000}
          rows={4}
          disabled={mutation.isPending}
          onChange={(event) => {
            setObjective(event.target.value);
            if (!customTitle) setTitle(event.target.value.trim().split("\n")[0]?.slice(0, 120) ?? "");
          }}
        />
        <Select
          label="Execution mode"
          value={mode}
          disabled={mutation.isPending}
          onChange={(event) => {
            setMode(event.target.value);
            setSourceHandoff(false);
          }}
        >
          <option value="manual">Review each step</option>
          <option value="autonomous">Agent Team — verified workspace</option>
          <option value="publish">Agent Team — build and publish</option>
        </Select>
        <p className="insights-help">
          {autonomous
            ? `Describe what you need. Your team handles research, design, implementation, tests and independent review, with up to three retries and an eight-hour scheduling budget. ${mode === "publish" ? "Publish to your team's configured destination after acceptance checks pass, then check the live product. A configured publishing destination is required." : "Deliver a verified workspace. Choose build and publish to include deployment."}`
            : "Describe the outcome first. You can build or discuss the plan after creating this goal."}
        </p>
        {mode === "publish" && (
          <div className="u-stack-sm">
            <label>
              <input
                type="checkbox"
                checked={sourceHandoff}
                disabled={mutation.isPending}
                onChange={(event) => setSourceHandoff(event.target.checked)}
              />
              Allow ARTOO to divide work across configured computers
            </label>
            <p className="insights-help">
              After research is accepted, ARTOO can choose another prepared Windows computer and its agents for the
              remaining work.
            </p>
          </div>
        )}
        {!autonomous && (
          <>
            <Textarea
              label="Goal acceptance criteria"
              helperText="One criterion per line"
              value={criteria}
              required
              disabled={mutation.isPending}
              onChange={(event) => setCriteria(event.target.value)}
            />
            <details className="insights-disclosure">
              <summary>Title & time budget · optional</summary>
              <Input
                label="Goal title"
                placeholder="What do you want to achieve?"
                value={title}
                maxLength={300}
                disabled={mutation.isPending}
                onChange={(event) => {
                  setCustomTitle(true);
                  setTitle(event.target.value);
                }}
              />
              <Input
                label="Time budget (minutes, optional)"
                type="number"
                min="1"
                step="1"
                value={minutes}
                disabled={mutation.isPending}
                onChange={(event) => setMinutes(event.target.value)}
              />
              <p className="insights-help">
                The title is filled from your objective. Cost budgets are unavailable until runtimes report reliable
                usage costs.
              </p>
            </details>
          </>
        )}
        <ActionError error={mutation.error} />
        <div className="action-row">
          <Button
            variant="primary"
            type="submit"
            loading={mutation.isPending}
            disabled={!objective.trim() || (!autonomous && !lines(criteria).length)}
          >
            {autonomous ? "Start autonomous goal" : "Create goal"}
          </Button>
          <Button onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function GoalDetail({ goal }: { goal: Goal }): React.ReactNode {
  const api = useApi();
  const query = useQueryClient();
  const navigate = useNavigate();
  const { setSelectedTaskId } = useSelection();
  const [proposing, setProposing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const poll5s = usePollMs(5000);
  const automation = useQuery({
    queryKey: queryKeys.goalAutomation(goal.id),
    queryFn: () => api.getGoalAutomation(goal.id),
    refetchInterval: poll5s,
  });
  const autonomous = !!automation.data?.automation;
  const manual = automation.data?.automation === null;
  const poll10s = usePollMs(10000);
  const plans = useQuery({
    queryKey: queryKeys.plans(goal.id),
    queryFn: () => api.listPlans(goal.id),
    refetchInterval: autonomous ? poll5s : false,
  });
  const checkpoints = useQuery({
    queryKey: queryKeys.checkpoints(goal.id),
    queryFn: () => api.listCheckpoints(goal.id),
    refetchInterval: poll10s,
  });
  const refresh = async (): Promise<void> => {
    await Promise.all(
      [
        queryKeys.goals(goal.project_id),
        queryKeys.plans(goal.id),
        queryKeys.checkpoints(goal.id),
        queryKeys.tasks(goal.project_id),
        queryKeys.goalAutomation(goal.id),
        queryKeys.goalRelease(goal.id),
        queryKeys.goalApplicationPublication(goal.id),
        queryKeys.discussions(goal.id),
      ].map((key) => query.invalidateQueries({ queryKey: key })),
    );
  };
  const action = useMutation({
    mutationFn: (name: "pause" | "resume" | "cancel" | "reconcile") =>
      api.goalAction(goal.id, name, newIdempotencyKey()),
    onSuccess: async () => {
      setConfirmCancel(false);
      await refresh();
    },
    onError: refresh,
  });
  const toast = useToast();
  const planAction = useMutation({
    mutationFn: ({ id, name }: { id: string; name: "accept" | "reject" }) =>
      api.planAction(id, name, newIdempotencyKey()),
    onSuccess: async (_, { name }) => {
      toast.push({ tone: "success", message: name === "accept" ? "Plan accepted." : "Plan rejected." });
      await refresh();
    },
  });
  const audit = useMutation({
    mutationFn: async () => {
      const result = await api.goalAuditExport(goal.id, "ed25519-v1");
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.export, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${goal.id}-audit.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    onSuccess: () => toast.push({ tone: "success", message: "Goal evidence download started." }),
  });
  const latestCheckpoint = checkpoints.data?.checkpoints.reduce<
    NonNullable<typeof checkpoints.data>["checkpoints"][number] | undefined
  >((latest, item) => (!latest || item.created_at > latest.created_at ? item : latest), undefined);
  return (
    <article className="insights-goal-detail u-stack">
      <header className="insights-goal-title">
        <span className="insights-eyebrow">Outcome</span>
        <div className="action-row">
          <h2>{goal.title}</h2>
          <Badge tone={goal.status === "completed" ? "success" : goal.status === "blocked" ? "warning" : "neutral"}>
            {goal.status}
          </Badge>
        </div>
        {goal.objective !== goal.title && (
          <details className="delivery-objective">
            <summary>Full objective</summary>
            <p className="insights-prose">{goal.objective}</p>
          </details>
        )}
      </header>
      <GoalOverview goal={goal} automation={automation.data?.automation} plans={plans.data?.plans} />
      <ActionError error={automation.error} />
      {automation.data?.automation && <AutonomousProgress goal={goal} automation={automation.data.automation} />}
      <details className="delivery-criteria">
        <summary>
          <ListChecks size={16} aria-hidden="true" /> Success criteria <span>{goal.acceptance_criteria.length}</span>
        </summary>
        <section className="insights-criteria" aria-label="Goal acceptance criteria">
          <ul>
            {goal.acceptance_criteria.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      </details>
      <div className="action-row insights-goal-actions" id="goal-controls">
        {(canTransitionGoal(goal.status, "pause") || (autonomous && goal.status === "draft")) && (
          <Button disabled={action.isPending} onClick={() => action.mutate("pause")}>
            Pause goal
          </Button>
        )}
        {canTransitionGoal(goal.status, "resume") && (
          <Button disabled={action.isPending} onClick={() => action.mutate("resume")}>
            Resume goal
          </Button>
        )}
        {canTransitionGoal(goal.status, "cancel") && (
          <Button variant="danger" disabled={action.isPending} onClick={() => setConfirmCancel(true)}>
            Cancel goal
          </Button>
        )}
        <Link className="os-goal-release-link" to={`/release?goal=${encodeURIComponent(goal.id)}`}>
          Release details
          <ArrowUpRight size={13} aria-hidden="true" />
        </Link>
      </div>
      {(canTransitionGoal(goal.status, "pause") || canTransitionGoal(goal.status, "resume")) && (
        <p className="insights-help">
          Pausing prevents new task scheduling; existing runs can finish. Resume allows new scheduling. Cancelling stops
          active runs before the goal is marked cancelled.
        </p>
      )}
      {confirmCancel && (
        <div className="product-card">
          <p>Cancel this goal and its remaining work?</p>
          <div className="action-row">
            <Button variant="danger" loading={action.isPending} onClick={() => action.mutate("cancel")}>
              Confirm cancel goal
            </Button>
            <Button onClick={() => setConfirmCancel(false)}>Keep goal</Button>
          </div>
        </div>
      )}
      <ActionError error={action.error ?? planAction.error ?? audit.error} />
      <section className="u-stack insights-plans" aria-label="Plans" id="goal-plans">
        <div className="insights-section-heading">
          <h3>Plans</h3>
          <Badge>{plans.data?.plans.length ?? 0}</Badge>
        </div>
        <ActionError error={plans.error} />
        {plans.isLoading && <LoadingView label="Loading plans…" />}
        {manual && canProposePlan(goal.status, !!goal.current_plan_id) && (
          <Button onClick={() => setProposing(!proposing)}>{proposing ? "Close plan editor" : "Propose plan"}</Button>
        )}
        {goal.current_plan_id && (goal.status === "paused" || goal.status === "blocked") && (
          <p className="t-subtle">
            To replace a plan, pause the goal and stop its active runs first. Accepted replacement tasks remain paused
            until you resume the goal; prior execution evidence is kept.
          </p>
        )}
        {proposing && (
          <PlanForm
            goalId={goal.id}
            onCreated={async () => {
              setProposing(false);
              await refresh();
            }}
          />
        )}
        {plans.data?.plans.length === 0 && (
          <p>
            {autonomous
              ? "The plan will appear here when agent planning finishes."
              : "No plan proposed. Add tasks and acceptance criteria, then review the plan before creating its tasks."}
          </p>
        )}
        {plans.data?.plans.map((plan) => (
          <article key={plan.id} className="insights-plan u-stack-sm">
            <div className="action-row">
              <h4>Plan {plan.version}</h4>
              <Badge tone={plan.status === "accepted" ? "success" : plan.status === "proposed" ? "info" : "neutral"}>
                {plan.status}
              </Badge>
              <span className="insights-help">{plan.task_specs.length} tasks</span>
            </div>
            <p className="insights-prose">{plan.rationale}</p>
            <ol className="insights-plan-tasks">
              {plan.task_specs.map((spec, i) => (
                <li key={i}>
                  <span className="insights-step-number" aria-hidden="true">
                    {i + 1}
                  </span>
                  <details className="delivery-plan-task">
                    <summary>
                      <strong>{spec.title}</strong>
                      {spec.development_stage && <Badge>{stageLabels[spec.development_stage]}</Badge>}
                      <span>{spec.acceptance_criteria.length} checks</span>
                    </summary>
                    {spec.description && <p>{spec.description}</p>}
                    <ul>
                      {spec.acceptance_criteria.map((criterion, j) => (
                        <li key={j}>{criterion}</li>
                      ))}
                    </ul>
                    {spec.dependencies.length > 0 && (
                      <p className="insights-dependency">
                        Depends on:{" "}
                        {spec.dependencies.map((dep) => plan.task_specs[Number(dep.ref)]?.title ?? dep.ref).join(", ")}
                      </p>
                    )}
                  </details>
                </li>
              ))}
            </ol>
            {manual && plan.status === "proposed" && (
              <div className="action-row">
                <Button
                  variant="primary"
                  disabled={planAction.isPending}
                  onClick={() => planAction.mutate({ id: plan.id, name: "accept" })}
                >
                  Accept plan and create tasks
                </Button>
                <Button
                  disabled={planAction.isPending}
                  onClick={() => planAction.mutate({ id: plan.id, name: "reject" })}
                >
                  Reject plan
                </Button>
              </div>
            )}
          </article>
        ))}
      </section>
      {manual && <GoalDiscussion goal={goal} />}
      <details className="os-goal-history">
        <summary>
          Checkpoints & evidence <span>{checkpoints.data?.checkpoints.length ?? 0} checkpoints</span>
        </summary>
        <section className="u-stack-sm insights-checkpoints" aria-label="Checkpoints">
          <p className="insights-help">
            Historical snapshots, not current progress.
            {latestCheckpoint ? ` Last saved ${taskUpdatedLabel(latestCheckpoint.created_at)}.` : ""}
          </p>
          <div className="action-row">
            {goal.current_plan_id && (
              <Button disabled={action.isPending} onClick={() => action.mutate("reconcile")}>
                Refresh from checkpoint
              </Button>
            )}
            <Button variant="ghost" iconLeft={Download} loading={audit.isPending} onClick={() => audit.mutate()}>
              Export goal evidence
            </Button>
          </div>
          <ActionError error={checkpoints.error} />
          {checkpoints.isLoading && <LoadingView label="Loading checkpoints…" shape="list" />}
          {checkpoints.data?.checkpoints.length === 0 && <p>No checkpoints yet.</p>}
          {checkpoints.data?.checkpoints.map((checkpoint) => (
            <details className="insights-disclosure" key={checkpoint.id}>
              <summary>
                {checkpoint.type.replaceAll("_", " ")} · {new Date(checkpoint.created_at).toLocaleString()}
              </summary>
              <p>{checkpoint.summary}</p>
              <p>
                {checkpoint.state_refs.active_runs.length} active runs · {checkpoint.state_refs.open_blockers.length}{" "}
                blockers · {checkpoint.state_refs.pending_approvals.length} approvals at this checkpoint
              </p>
              <ul>
                {checkpoint.state_refs.task_statuses.map((task) => (
                  <li key={task.task_id}>
                    <Button
                      size="sm"
                      onClick={() => {
                        setSelectedTaskId(task.task_id);
                        navigate(`/?goal=${encodeURIComponent(goal.id)}`);
                      }}
                    >
                      Open task {task.task_id}
                    </Button>
                    <StatusBadge status={task.status} />
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </section>
      </details>
      {goal.room_id && (
        <section className="insights-goal-conversation" aria-label="Goal conversation">
          <h3>
            <MessageSquare size={16} aria-hidden="true" /> Goal conversation
          </h3>
          <RoomConversation key={goal.room_id} roomId={goal.room_id} projectId={goal.project_id} goalId={goal.id} />
        </section>
      )}
    </article>
  );
}

const stageLabels = { research: "Research", design: "Design", implementation: "Implementation", validation: "Testing" };

function AutonomousProgress({ goal, automation }: { goal: Goal; automation: GoalAutomation }): React.ReactNode {
  const api = useApi();
  const { bootstrap } = useProject();
  const release = useQuery({
    queryKey: queryKeys.goalRelease(goal.id),
    queryFn: () => api.getGoalRelease(goal.id),
    enabled: !!automation.release_profile_id,
    refetchInterval: usePollMs(5000),
  });
  const publication = release.data?.release;
  const published = publication?.status === "published" && publication.receipt?.outcome === "published";
  const health = publication?.health;
  const unhealthy = health && health.state !== "healthy";
  const endpoint = published && !unhealthy ? publication.receipt?.endpoint : null;
  let link: string | null = null;
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) link = url.href;
    } catch {
      /* Invalid endpoints stay visible in the evidence export only. */
    }
  }
  const name = (instanceId: string): string => {
    const instance = bootstrap.data?.agent_instances.find((item) => item.id === instanceId);
    const agent = bootstrap.data?.agents.find((item) => item.id === instance?.agent_id);
    return agent?.display_name ?? instance?.runtime ?? "Assigned agent";
  };
  return (
    <section className="product-card u-stack-sm" aria-label="Autonomous progress">
      <div className="action-row">
        <strong>{automation.execution_mode === "agent_team" ? "Agent Team" : "Autonomous development"}</strong>
        <Badge>{goal.status === "paused" ? "paused" : automation.status}</Badge>
      </div>
      {automation.source_handoff?.mode === "automatic" && (
        <p className="insights-help" aria-label="Cross-computer authorization">
          Cross-computer work is allowed for this goal. ARTOO selects a destination after the required checks pass.
        </p>
      )}
      <p>
        {automation.app_publication
          ? "ARTOO manages development, independent review and local application publication. Publication history and current availability appear below."
          : published
            ? unhealthy
              ? "The product was published; a later health check reported a problem."
              : "The verified product was published and its endpoint passed the configured health checks."
            : automation.status === "completed" && !automation.release_profile_id
              ? "Configured acceptance checks passed. The verified workspace is ready; it has not been automatically published."
              : "ARTOO manages the plan, task execution and acceptance checks. You can pause or cancel at any time."}
      </p>
      {automation.team && (
        <div aria-label="Team responsibilities">
          <ul>
            {automation.team.members.map((member) => (
              <li key={member.stage}>
                <strong>{stageLabels[member.stage]}</strong> · {name(member.agent_instance_id)}
              </li>
            ))}
          </ul>
          <p className="insights-help">
            Each task is reviewed by another team member against the same verified source version.
          </p>
        </div>
      )}
      {automation.release_profile_id && (
        <details className="os-publication-details">
          <summary>
            Publication details{" "}
            <span>{health?.state ?? (published ? "published" : (publication?.status ?? "pending"))}</span>
          </summary>
          <div aria-label="Product publication">
            <strong>Publication</strong>
            <p role="status">
              {health?.state === "rolled_back"
                ? "Post-publication health checks failed; the previous release was restored and checked."
                : health?.state === "unavailable"
                  ? "The publication was taken offline after failed health checks."
                  : health?.state === "degraded"
                    ? "The latest health check failed. The worker is checking recovery."
                    : health?.state === "healthy"
                      ? "Published — the latest health check passed."
                      : published
                        ? "Published"
                        : publication?.status === "rolled_back"
                          ? "Health checks failed; the previous release was restored."
                          : publication?.status === "failed"
                            ? "Publication failed. See the recorded reason below."
                            : publication?.status === "queued"
                              ? "Publishing and checking the product endpoint…"
                              : "Waiting for implementation, tests and independent review."}
            </p>
            {publication?.request.acceptance_binding && (
              <p className="insights-help" aria-label="Publication acceptance">
                {publication.receipt?.acceptance
                  ? `The published version satisfied ${publication.receipt.acceptance.settled_criteria.length} publication acceptance ${publication.receipt.acceptance.settled_criteria.length === 1 ? "criterion" : "criteria"} at publication time.`
                  : publication.status === "failed" || publication.status === "rolled_back"
                    ? "Publication acceptance remains unsatisfied."
                    : "Publication acceptance remains pending until the configured endpoint checks pass."}
              </p>
            )}
            {health && (
              <p className="insights-help">
                Last measured: <time dateTime={health.checked_at}>{new Date(health.checked_at).toLocaleString()}</time>.
                This is the latest received observation.
              </p>
            )}
            {link && (
              <a href={link} target="_blank" rel="noopener noreferrer">
                Open published product
              </a>
            )}
            {(health?.reason ?? publication?.receipt?.reason) && (
              <p>{health?.reason ?? publication?.receipt?.reason}</p>
            )}
            <ActionError error={release.error} />
          </div>
        </details>
      )}
      {automation.last_error && <p role="status">{automation.last_error}</p>}
      {automation.app_publication && <ApplicationPublicationProgress goalId={goal.id} />}
    </section>
  );
}

export function ApplicationPublicationProgress({ goalId }: { goalId: string }): React.ReactNode {
  const api = useApi(),
    query = useQueryClient(),
    key = queryKeys.goalApplicationPublication(goalId);
  // Availability observations have their own freshness deadline; keep checking
  // every 5s even with WS connected so a healthy link does not age out at 30s.
  const publicationQuery = useQuery({
    queryKey: key,
    queryFn: () => api.getGoalApplicationPublication(goalId),
    refetchInterval: 5000,
  });
  const publication = publicationQuery.data?.publication,
    receipt = publication?.receipt,
    report = publication?.latest_observation;
  const published = publication?.status === "published" && receipt?.outcome === "published";
  const stop = useMutation({
    mutationFn: () => api.stopGoalApplicationPublication(goalId, newIdempotencyKey()),
    onSuccess: (result) => {
      query.setQueryData(key, result);
    },
    // A hanging status GET must not withhold the stop result or prevent retry.
    onSettled: () => {
      void query.invalidateQueries({ queryKey: key });
    },
  });
  const [now, setNow] = useState(Date.now);
  const deadline = receipt?.lease?.deadline_at ?? report?.lease.deadline_at;
  const freshness = publication?.request.capabilities.contract.limits.health_freshness_ms ?? 0;
  const samples = [
    report?.observed_at,
    report?.health?.checked_at,
    report?.live?.observed_at,
    report?.live?.counters_observed_at,
  ]
    .filter((value): value is string => !!value)
    .map(Date.parse);
  const freshUntil = Math.min(...samples.map((time) => time + freshness), deadline ? Date.parse(deadline) : Infinity);
  // An old successful response cannot keep an availability link alive after its
  // own observation window expires, including while the next GET is failing.
  useEffect(() => {
    setNow(Date.now());
    if (!Number.isFinite(freshUntil)) return;
    const remaining = freshUntil - Date.now();
    if (remaining < 0) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining + 1);
    return () => clearTimeout(timer);
  }, [freshUntil, publicationQuery.dataUpdatedAt]);
  const reportedState = publication?.current_state ?? "pending";
  const reportsRunning = ["healthy", "live", "draining"].includes(reportedState);
  const stale =
    reportsRunning &&
    (!report ||
      !samples.length ||
      samples.some((time) => !Number.isFinite(time) || time > now) ||
      now >= freshUntil ||
      publicationQuery.isError ||
      // A stop attempt invalidates earlier running evidence even if it is rejected.
      // Only actual newer observations, not a completed GET, can restore the link.
      (stop.submittedAt > 0 && samples.some((time) => time <= stop.submittedAt)));
  const state = stale || (publicationQuery.isError && !publication) ? "unknown" : reportedState;
  const closed = !!report?.closure || (receipt?.outcome === "failed" && receipt.cleanup.state !== "unconfirmed");
  const stateLabel =
    closed && receipt?.outcome === "failed"
      ? "No application is running from this attempt."
      : stop.isPending
        ? "Stopping — waiting for the application to close."
        : {
            pending: publication
              ? "Publishing and checking the application…"
              : "Waiting for implementation, tests and independent review.",
            healthy: "Running — the latest health check passed.",
            live: "Running — a fresh health check is unavailable.",
            draining: "Stopping — waiting for the application to close.",
            "closed-normal": "Stopped.",
            "closed-aborted": "Stopped after an interruption.",
            expired: "The configured running time has ended.",
            unknown: "Current availability is unconfirmed.",
          }[state];
  let link: string | undefined;
  const endpoint = publication?.endpoint;
  if (
    published &&
    state === "healthy" &&
    !stop.isPending &&
    !publicationQuery.isError &&
    endpoint &&
    endpoint === receipt.deployment.origin
  ) {
    try {
      const url = new URL(endpoint);
      if (
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        url.port &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password
      )
        link = url.href;
    } catch {
      /* Invalid addresses are never advertised as a usable product. */
    }
  }
  return (
    <section className="u-stack-sm" aria-label="Application publication">
      <strong>Application publication</strong>
      <p aria-label="Publication history">
        {published ? (
          <>
            Published at <time dateTime={receipt.recorded_at}>{new Date(receipt.recorded_at).toLocaleString()}</time>.
            Initial health checks and a normal restart passed.
          </>
        ) : publication?.status === "failed" ? (
          "Publication failed."
        ) : publicationQuery.isError && !publication ? (
          "Publication history is unavailable."
        ) : publicationQuery.isLoading ? (
          "Loading publication history…"
        ) : (
          "No completed application publication has been recorded."
        )}
      </p>
      {publicationQuery.isLoading ? (
        <p role="status">Loading application availability…</p>
      ) : (
        <p role="status" aria-label="Current application availability">
          {stateLabel}
        </p>
      )}
      {report && (
        <p className="insights-help">
          Last received observation:{" "}
          <time dateTime={report.observed_at}>{new Date(report.observed_at).toLocaleString()}</time>.
        </p>
      )}
      {deadline && (
        <p className="insights-help">
          Running time limit: <time dateTime={deadline}>{new Date(deadline).toLocaleString()}</time>.
        </p>
      )}
      <p className="insights-help">
        This application runs on the publishing computer within its configured time and request limits. Continuous
        hosting and recovery after failure are unavailable.
      </p>
      {link && (
        <a href={link} target="_blank" rel="noopener noreferrer">
          Open local application
        </a>
      )}
      {publication && !closed && (
        <Button disabled={stop.isPending} loading={stop.isPending} onClick={() => stop.mutate()}>
          Stop application
        </Button>
      )}
      {(receipt?.outcome === "failed" ? receipt.reason : report?.reason) && (
        <p>{receipt?.outcome === "failed" ? receipt.reason : report?.reason}</p>
      )}
      <ActionError error={stop.error ?? publicationQuery.error} />
    </section>
  );
}
