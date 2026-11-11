import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowUpRight, Check, Clock3, FileCheck2, Rocket, ShieldCheck, X } from "lucide-react";
import type { Goal, ProductRelease } from "@artoo/domain";
import { useApi } from "../app/ApiContext.js";
import { useProject } from "../app/useProject.js";
import { Badge, Button, EmptyState } from "../ui/index.js";
import { ActionError } from "./ActionError.js";
import { ApplicationPublicationProgress } from "./GoalsPage.js";

/** A release is backed by executor evidence, never inferred from completed tasks. */
export function ReleasePage(): React.ReactNode {
  const api = useApi();
  const { projectId, bootstrap } = useProject();
  const [selectedId, setSelectedId] = useState<string>();
  const [params] = useSearchParams();
  const goals = useQuery({ queryKey: ["goals", projectId], queryFn: () => api.listGoals(projectId!), enabled: !!projectId, refetchInterval: 10000 });
  const selected = goals.data?.goals.find((goal) => goal.id === (selectedId ?? params.get("goal"))) ?? goals.data?.goals[0];
  return <section className="product-page os-release-page" aria-label="Releases">
    <header className="os-page-heading"><div><span className="os-eyebrow"><Rocket size={14} aria-hidden="true" />Deliver with confidence</span><h1>Release</h1><p>Verified output, publication checks, and the latest reported health.</p></div><Link className="os-secondary-link" to={selected ? `/goals?goal=${encodeURIComponent(selected.id)}` : "/goals"}>Manage in Plan<ArrowUpRight size={14} aria-hidden="true" /></Link></header>
    <ActionError error={bootstrap.error ?? goals.error} />
    {(bootstrap.isLoading || goals.isLoading) && <p role="status">Loading release goals…</p>}
    {(bootstrap.error || goals.error) && <Button onClick={() => { void bootstrap.refetch(); void goals.refetch(); }}>Retry release goals</Button>}
    {goals.data?.goals.length === 0 && <EmptyState icon={Rocket} title="Your first release starts with a plan" description="Create a goal in Plan and select a configured publishing destination. Release evidence will appear here as your team delivers." action={<Link className="os-primary-link" to="/goals">Open Plan<ArrowUpRight size={14} aria-hidden="true" /></Link>} />}
    {selected && <div className="os-release-layout"><nav className="os-release-goals" aria-label="Release goals"><span className="os-section-label">Goals</span>{goals.data?.goals.map((goal) => <button key={goal.id} type="button" className={`os-release-goal${goal.id === selected.id ? " is-active" : ""}`} aria-pressed={goal.id === selected.id} onClick={() => setSelectedId(goal.id)}><strong>{goal.title}</strong><span>Goal · {goal.status.replaceAll("_", " ")}</span></button>)}</nav><ReleaseDetail key={selected.id} goal={selected} /></div>}
  </section>;
}

function safeEndpoint(release: ProductRelease | null | undefined, syncFailed: boolean): string | undefined {
  if (syncFailed || release?.status !== "published" || release.receipt?.outcome !== "published" || (release.health && release.health.state !== "healthy")) return;
  try {
    const url = new URL(release.receipt.endpoint ?? "");
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Invalid addresses are retained in evidence, never exposed as links. */ }
}

function ReleaseDetail({ goal }: { goal: Goal }): React.ReactNode {
  const api = useApi();
  const automation = useQuery({ queryKey: ["goal-automation", goal.id], queryFn: () => api.getGoalAutomation(goal.id), refetchInterval: 5000 });
  const releaseQuery = useQuery({ queryKey: ["goal-release", goal.id], queryFn: () => api.getGoalRelease(goal.id), refetchInterval: 5000 });
  const release = releaseQuery.data?.release;
  const receipt = release?.receipt;
  const health = release?.health;
  const published = release?.status === "published" && receipt?.outcome === "published";
  const endpoint = safeEndpoint(release, releaseQuery.isError);
  const checks = health?.health_checks ?? receipt?.health_checks ?? [];
  const status = releaseQuery.isError ? "Sync unavailable" : health ? health.state.replaceAll("_", " ") : published ? "Published" : release?.status.replaceAll("_", " ") ?? "Not published";
  const checkPassed = checks.length > 0 && checks.every((check) => check.passed);
  const tone = releaseQuery.isError ? "warning" : health && health.state !== "healthy" ? "danger" : published ? "success" : release?.status === "failed" ? "danger" : "neutral";
  return <div className="os-release-content">
    <section className="os-card os-release-overview" aria-label="Publication overview"><div className="os-release-overview__top"><span className="os-feature-icon"><Rocket size={22} aria-hidden="true" /></span><Badge tone={tone}>{status}</Badge></div><h2>{goal.title}</h2><p>{goal.objective}</p>
      {(automation.isLoading || releaseQuery.isLoading) && <p role="status">Loading publication evidence…</p>}
      {!release && releaseQuery.isSuccess && !automation.data?.automation?.app_publication && <p className="os-release-note">{automation.data?.automation?.release_profile_id ? "Publication is waiting for implementation, verification, and independent review." : "This goal has no recorded publication. Configure publishing when creating an Agent Team goal in Plan."}</p>}
      {release && <p className="os-release-note">{published ? "Publication was confirmed by the executor. Health below reflects the latest received observation." : "The publication is not confirmed. Review its recorded state before continuing."}</p>}
      {endpoint && <a className="os-primary-link" href={endpoint} target="_blank" rel="noopener noreferrer">Open published product<ArrowUpRight size={15} aria-hidden="true" /></a>}
      {(health?.reason ?? receipt?.reason) && <p className="os-release-reason">{health?.reason ?? receipt?.reason}</p>}
      <ActionError error={automation.error ?? releaseQuery.error} />{(automation.error || releaseQuery.error) && <Button onClick={() => { void automation.refetch(); void releaseQuery.refetch(); }}>Retry publication sync</Button>}
    </section>
    {automation.data?.automation?.app_publication && <div className="os-card os-application-publication"><ApplicationPublicationProgress goalId={goal.id} /></div>}
    <section className="os-card os-release-gates" aria-label="Release checks"><div className="os-card-heading"><ShieldCheck size={16} aria-hidden="true" /><h3>Release checks</h3></div>
      <Gate label="Verified version" detail={release ? "The request names an immutable verified artifact." : "Waiting for verification evidence."} state={release ? "passed" : "pending"} />
      <Gate label="Publication receipt" detail={published ? "The executor confirmed publication." : receipt ? `Executor result: ${receipt.outcome.replaceAll("_", " ")}.` : "Waiting for the publishing executor."} state={published ? "passed" : receipt ? "failed" : "pending"} />
      <Gate label="Endpoint health" detail={checks.length ? `${checks.filter((check) => check.passed).length} of ${checks.length} ${health ? "latest" : "publication-time"} checks passed.` : "No endpoint measurement received."} state={checks.length ? checkPassed ? "passed" : "failed" : "pending"} />
      {release?.request.acceptance_binding && <Gate label="Publication acceptance" detail={receipt?.acceptance ? `${receipt.acceptance.settled_criteria.length} configured criteria satisfied at publication time.` : "Configured publication criteria are still pending."} state={receipt?.acceptance ? "passed" : "pending"} />}
    </section>
    {checks.length > 0 && <section className="os-card" aria-label="Endpoint measurements"><div className="os-card-heading"><FileCheck2 size={16} aria-hidden="true" /><h3>Endpoint measurements</h3></div><div className="os-measurements">{checks.map((check) => <div key={check.path}><code>{check.path}</code><Badge tone={check.passed ? "success" : "danger"}>{check.status_code ?? "No response"}</Badge><time dateTime={check.checked_at}>{new Date(check.checked_at).toLocaleString()}</time></div>)}</div></section>}
    {release && <section className="os-card" aria-label="Release record"><div className="os-card-heading"><Clock3 size={16} aria-hidden="true" /><h3>Release record</h3></div><dl className="os-release-record"><div><dt>Requested</dt><dd><time dateTime={release.created_at}>{new Date(release.created_at).toLocaleString()}</time></dd></div><div><dt>Last updated</dt><dd><time dateTime={release.updated_at}>{new Date(release.updated_at).toLocaleString()}</time></dd></div>{health && <div><dt>Last health observation</dt><dd><time dateTime={health.checked_at}>{new Date(health.checked_at).toLocaleString()}</time></dd></div>}<div><dt>Recovery</dt><dd>{(health?.recovery_checks ?? receipt?.recovery_checks)?.length ? `${(health?.recovery_checks ?? receipt?.recovery_checks)?.filter((check) => check.passed).length} recovery checks passed` : "No recovery checks recorded"}</dd></div></dl><details className="os-evidence"><summary>Technical evidence</summary><dl><dt>Release</dt><dd><code>{release.id}</code></dd><dt>Publishing profile</dt><dd><code>{release.request.release_profile_id}</code></dd><dt>Verified artifact</dt><dd><code>{release.request.subject_digest}</code></dd><dt>Verification request</dt><dd><code>{release.request.verification_request_id}</code></dd></dl></details></section>}
  </div>;
}

function Gate({ label, detail, state }: { label: string; detail: string; state: "passed" | "pending" | "failed" }): React.ReactNode {
  return <div className="os-release-gate" data-state={state}><span className="os-gate-icon" aria-hidden="true">{state === "passed" ? <Check size={14} /> : state === "failed" ? <X size={14} /> : <Clock3 size={14} />}</span><div><strong>{label}</strong><p>{detail}</p></div><span>{state === "passed" ? "Passed" : state === "failed" ? "Failed" : "Pending"}</span></div>;
}
