import { useQueries, useQuery } from "@tanstack/react-query";

import { CAPABILITIES, PERMISSION_CATEGORIES, SKILL_API_VERSION } from "@artoo/domain";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { Badge, ErrorState, Skeleton, type Tone } from "../ui/index.js";

function list(values: readonly string[] | undefined): string {
  return values !== undefined && values.length > 0 ? values.join(", ") : "none";
}

function value(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === "") return "none";
  return String(value);
}

/** Map an inventory status string to a semantic badge tone. */
function invTone(status: string): Tone {
  const s = status.toLowerCase();
  if (["online", "available", "enabled", "active", "ready", "completed"].includes(s)) return "success";
  if (["stale", "degraded", "awaiting_input", "paused", "pending"].includes(s)) return "warning";
  if (["error", "failed", "revoked", "blocked"].includes(s)) return "danger";
  if (["busy", "running", "starting"].includes(s)) return "info";
  return "neutral";
}

function StatusBadgeInv({ status }: { status: string }): React.ReactNode {
  return <Badge tone={invTone(status)}>{status}</Badge>;
}

/** label/value row inside an `.inv-meta` definition list. */
function Row({ label, children }: { label: string; children: React.ReactNode }): React.ReactNode {
  return (
    <div className="inv-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function InventoryLoading({ label }: { label: string }): React.ReactNode {
  return (
    <section className="inventory-page">
      <p className="inventory-loading-label" role="status">
        {label}
      </p>
      <header>
        <Skeleton height={26} width={160} />
      </header>
      <div className="inventory-list" aria-hidden="true">
        {Array.from({ length: 2 }).map((_, i) => (
          <article key={i} className="inventory-item u-stack">
            <Skeleton height={18} width="40%" />
            <Skeleton height={64} />
          </article>
        ))}
      </div>
    </section>
  );
}

/** Read-only computer inventory from bootstrap plus heartbeat-backed runtime rows. */
export function ComputersPage(): React.ReactNode {
  const api = useApi();
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  const computers = bootstrap.data?.computers ?? [];
  const runtimeQueries = useQueries({
    queries: computers.map((computer) => ({
      queryKey: queryKeys.computerRuntimes(computer.id),
      queryFn: () => api.listComputerRuntimes(computer.id),
      enabled: bootstrap.data !== undefined,
    })),
  });

  if (bootstrap.isLoading) return <InventoryLoading label="Loading computers…" />;
  if (bootstrap.isError || bootstrap.data === undefined) {
    return (
      <section className="inventory-page" aria-label="Computers">
        <ErrorState title="Failed to load computers" />
      </section>
    );
  }

  return (
    <section className="inventory-page" aria-label="Computers">
      <header className="inventory-header">
        <h1 className="t-h1">Computers</h1>
        <Badge tone="neutral">{computers.length}</Badge>
      </header>
      {computers.length === 0 ? <p className="inv-empty">No computers registered.</p> : null}
      <div className="inventory-list">
        {computers.map((computer, index) => {
          const runtimes = runtimeQueries[index]?.data?.runtimes ?? [];
          return (
            <article key={computer.id} aria-label={computer.display_name} className="inventory-item">
              <header className="inventory-item__head">
                <h2 className="t-h3">{computer.display_name}</h2>
                <StatusBadgeInv status={computer.status} />
              </header>
              <dl className="inv-meta">
                <Row label="Host">
                  <span className="t-mono">{computer.hostname}</span>
                </Row>
                <Row label="Platform">
                  {computer.os} / {computer.arch}
                </Row>
                <Row label="Last heartbeat">{value(computer.last_heartbeat_at)}</Row>
                <Row label="Capabilities">{list(computer.capabilities)}</Row>
              </dl>
              <section className="inventory-item__sub" aria-label={`${computer.display_name} runtimes`}>
                <h3 className="inventory-subtitle">Runtimes</h3>
                {runtimeQueries[index]?.isLoading ? <p role="status">Loading runtimes…</p> : null}
                {runtimeQueries[index]?.isError ? <p role="alert">Failed to load runtimes.</p> : null}
                {!runtimeQueries[index]?.isLoading && runtimes.length === 0 ? (
                  <p className="inv-empty">No runtime heartbeat rows.</p>
                ) : null}
                <ul className="inv-runtimes">
                  {runtimes.map((runtime) => (
                    <li key={runtime.id} className="inv-runtime">
                      <div className="inv-runtime__head">
                        <strong>{runtime.runtime}</strong>
                        <StatusBadgeInv status={runtime.status} />
                        <span className="t-mono inv-runtime__ver">{value(runtime.version)}</span>
                      </div>
                      <span className="t-subtle">
                        last seen {value(runtime.last_seen_at)} · capabilities: {list(runtime.capabilities)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/** Read-only agent inventory joined client-side from bootstrap read models. */
export function AgentsPage(): React.ReactNode {
  const api = useApi();
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });

  if (bootstrap.isLoading) return <InventoryLoading label="Loading agents…" />;
  if (bootstrap.isError || bootstrap.data === undefined) {
    return (
      <section className="inventory-page" aria-label="Agents">
        <ErrorState title="Failed to load agents" />
      </section>
    );
  }

  const agents = new Map(bootstrap.data.agents.map((agent) => [agent.id, agent]));
  const computers = new Map(bootstrap.data.computers.map((computer) => [computer.id, computer]));
  const models = new Map(bootstrap.data.model_profiles.map((profile) => [profile.id, profile]));
  const efforts = new Map(bootstrap.data.effort_profiles.map((profile) => [profile.id, profile]));

  return (
    <section className="inventory-page" aria-label="Agents">
      <header className="inventory-header">
        <h1 className="t-h1">Agents</h1>
        <Badge tone="neutral">{bootstrap.data.agent_instances.length}</Badge>
      </header>
      {bootstrap.data.agent_instances.length === 0 ? (
        <p className="inv-empty">No agent instances registered.</p>
      ) : null}
      <div className="inventory-list">
        {bootstrap.data.agent_instances.map((instance) => {
          const agent = agents.get(instance.agent_id);
          const computer = computers.get(instance.computer_id);
          const model = models.get(instance.model_profile_id ?? "");
          const effort = efforts.get(instance.effort_profile_id ?? "");
          return (
            <article key={instance.id} aria-label={agent?.display_name ?? instance.id} className="inventory-item">
              <header className="inventory-item__head">
                <h2 className="t-h3">{agent?.display_name ?? instance.id}</h2>
                <StatusBadgeInv status={instance.status} />
              </header>
              <dl className="inv-meta">
                <Row label="Instance">
                  <span className="t-mono">{instance.id}</span>
                </Row>
                <Row label="Runtime">{instance.runtime}</Row>
                <Row label="Computer">{computer?.display_name ?? instance.computer_id}</Row>
                <Row label="Model profile">
                  {model !== undefined ? `${model.name} (${model.provider}/${model.model})` : "none"}
                </Row>
                <Row label="Effort profile">
                  {effort !== undefined
                    ? `${effort.name} (${effort.effort}, ${effort.max_runtime_minutes}m)`
                    : "none"}
                </Row>
                <Row label="Workspace root">
                  <span className="t-mono">{value(instance.workspace_root)}</span>
                </Row>
                <Row label="Capabilities">{list(agent?.capabilities)}</Row>
              </dl>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/** Read-only installed skill registry backed by the #24 server API. */
export function SkillsPage(): React.ReactNode {
  const api = useApi();
  const skillsQuery = useQuery({
    queryKey: queryKeys.skillInstalls,
    queryFn: () => api.listSkillInstalls(),
  });
  const skills = skillsQuery.data?.skills ?? [];

  return (
    <section className="inventory-page" aria-label="Skills">
      <header className="inventory-header">
        <h1 className="t-h1">Skills</h1>
      </header>
      <section className="inventory-section" aria-label="Installed skills">
        <h2 className="inventory-subtitle">Installed Skills</h2>
        {skillsQuery.isLoading ? <p role="status">Loading skills…</p> : null}
        {skillsQuery.isError ? <p role="alert">Failed to load skills.</p> : null}
        {!skillsQuery.isLoading && !skillsQuery.isError && skills.length === 0 ? (
          <p className="inv-empty">No skills installed.</p>
        ) : null}
        {skills.length > 0 ? (
          <div className="inventory-list">
            {skills.map((skill) => (
              <article key={skill.id} aria-label={skill.name} className="inventory-item">
                <header className="inventory-item__head">
                  <h3 className="t-h3">{skill.name}</h3>
                  <Badge tone={skill.enabled ? "success" : "neutral"}>
                    {skill.enabled ? "enabled" : "disabled"}
                  </Badge>
                  <Badge tone={invTone(skill.permission_summary.risk)}>
                    {skill.permission_summary.risk} risk
                  </Badge>
                </header>
                <dl className="inv-meta">
                  <Row label="Scope">{skill.project_id ?? "organization"}</Row>
                  <Row label="Skill id">
                    <span className="t-mono">{skill.skill_id}</span>
                  </Row>
                  <Row label="Version">{skill.version}</Row>
                  <Row label="Capabilities">{list(skill.capabilities)}</Row>
                  <Row label="Compatible runtimes">{list(skill.compatible_runtimes)}</Row>
                  <Row label="Permission categories">{list(skill.permission_summary.categories)}</Row>
                  <Row label="Installed by">
                    {skill.installed_by_type}:{skill.installed_by_id}
                  </Row>
                  <Row label="Updated">{value(skill.updated_at)}</Row>
                </dl>
              </article>
            ))}
          </div>
        ) : null}
      </section>
      <section className="inventory-section" aria-label="Skill manifest contract">
        <h2 className="inventory-subtitle">Manifest Contract</h2>
        <dl className="inv-meta">
          <Row label="API version">{SKILL_API_VERSION}</Row>
          <Row label="Capability source">manifest capabilities plus compatible_runtimes</Row>
          <Row label="Storage/API status">durable install read API</Row>
        </dl>
      </section>
      <section className="inventory-section" aria-label="Permission categories">
        <h2 className="inventory-subtitle">Permission Categories</h2>
        <ul className="inv-chips">
          {PERMISSION_CATEGORIES.map((category) => (
            <li key={category}>{category}</li>
          ))}
        </ul>
      </section>
      <section className="inventory-section" aria-label="Known capabilities">
        <h2 className="inventory-subtitle">Known Capabilities</h2>
        <ul className="inv-chips">
          {CAPABILITIES.map((capability) => (
            <li key={capability}>{capability}</li>
          ))}
        </ul>
      </section>
    </section>
  );
}
