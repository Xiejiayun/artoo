import { createHash } from "node:crypto";
import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { seed } from "./seed.js";
import { applicationPublications, applicationPublicationObservations, applicationPublicationSettlements, contextPacks, eventLog, goals, goalAutomations } from "./schema.js";

const at = (seconds = 0) => new Date(Date.UTC(2026, 10, 9) + seconds * 1000).toISOString();
const digest = `sha256:${"a".repeat(64)}`;
const canonical = (value: unknown): string => JSON.stringify(value === null || typeof value !== "object" ? value
  : Array.isArray(value) ? value.map(item => JSON.parse(canonical(item)))
    : Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, JSON.parse(canonical(item))])));
const hash = (value: unknown) => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;

it("adds nullable publication state without changing 0054, historical rows or repeat migration history", async () => {
  const before = await loadMigrationStatements("0054_application_development.sql"), after = await loadMigrationStatements("0055_application_publication.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  const client = await PgliteDbClient.create();
  try {
    await client.migrate(before); const ids = await seed(client, at());
    await client.db.insert(goals).values({ id: "legacy-goal", organizationId: ids.organizationId, projectId: ids.projectId,
      ownerUserId: ids.userId, title: "Legacy development", status: "running", createdAt: at(), updatedAt: at() });
    await client.db.execute(sql`INSERT INTO goal_automations(goal_id,organization_id,actor_user_id,policy_version,status,verification_profile_id,execution_mode,app_delivery,created_at,updated_at)
      VALUES ('legacy-goal',${ids.organizationId},${ids.userId},'policy','waiting','verifier','agent_team','{"version":1,"kind":"local-application-development"}',${at()},${at()})`);
    const original = (await client.db.execute(sql`SELECT to_jsonb(a) AS row FROM goal_automations a`)).rows;
    const journal = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    await client.migrate(after);
    expect((await client.db.execute(sql`SELECT to_jsonb(a)-'app_publication'-'application_publication_authorization_event_id' AS row FROM goal_automations a`)).rows).toEqual(original);
    expect((await client.db.execute(sql`SELECT app_publication,application_publication_authorization_event_id FROM goal_automations`)).rows)
      .toEqual([{ app_publication: null, application_publication_authorization_event_id: null }]);
    await expect(client.db.execute(sql`UPDATE goal_automations SET status='completed' WHERE goal_id='legacy-goal'`)).rejects.toThrow();
    const upgraded = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    expect(upgraded.slice(0, journal.length)).toEqual(journal);
    await client.migrate(after); expect((await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(upgraded);
    expect(await client.db.select().from(applicationPublications)).toEqual([]);
    expect(await client.db.select().from(applicationPublicationObservations)).toEqual([]);
    expect(await client.db.select().from(applicationPublicationSettlements)).toEqual([]);
  } finally { await client.close(); }
});

async function fixture(client: PgliteDbClient) {
  await client.migrate(await loadMigrationStatements("0055_application_publication.sql"));
  const ids = await seed(client, at());
  await client.db.insert(goals).values({ id: "goal", organizationId: ids.organizationId, projectId: ids.projectId,
    ownerUserId: ids.userId, title: "Application", status: "running", createdAt: at(), updatedAt: at() });
  const grant = { version: 1, kind: "same-computer-local-application-publication", publication_profile_id: "publisher" };
  const authorization = { version: 1, event_id: "authorization", actor_user_id: ids.userId, consent_id: null, policy_version: "policy", grant };
  const capabilities = { version: 1, binding: { publication_profile_id: "publisher", project_id: ids.projectId,
    computer_id: ids.computerId, verification_profile_id: "verifier" }, contract: { limits: { health_freshness_ms: 30_000 } } };
  const event = async (id: string, type: string, payload: Record<string, unknown>, seconds = 0, actorType = "system", actorId = "goal_runner") => {
    await client.db.insert(eventLog).values({ id, organizationId: ids.organizationId, projectId: ids.projectId, goalId: "goal",
      type, schemaVersion: "1", actorType, actorId, correlationId: "goal", payload, occurredAt: at(seconds) });
  };
  await event("authorization", "goal.application-publication.authorized", { app_publication: grant, authorization, capabilities,
    publisher_session_id: "session", verification_profile_id: "verifier" }, 0, "user", ids.userId);
  await client.db.insert(goalAutomations).values({ goalId: "goal", organizationId: ids.organizationId, actorUserId: ids.userId,
    policyVersion: "policy", status: "waiting", verificationProfileId: "verifier", executionMode: "agent_team",
    appPublication: grant, applicationPublicationAuthorizationEventId: "authorization", createdAt: at(), updatedAt: at() });
  return { ids, grant, authorization, capabilities, event };
}

it("requires an original immutable user grant and refuses completion without a publication settlement", async () => {
  const client = await PgliteDbClient.create();
  try {
    const f = await fixture(client);
    for (const change of [sql`status='completed'`, sql`actor_user_id='other'`, sql`policy_version='changed'`,
      sql`app_publication=NULL, application_publication_authorization_event_id=NULL`, sql`release_profile_id='static'`,
      sql`verification_profile_id='different'`])
      await expect(client.db.execute(sql`UPDATE goal_automations SET ${change} WHERE goal_id='goal'`)).rejects.toThrow();
    await expect(client.db.execute(sql`UPDATE goals SET status='completed' WHERE id='goal'`)).rejects.toThrow();
    await expect(client.db.execute(sql`DELETE FROM goal_automations WHERE goal_id='goal'`)).rejects.toThrow();
    await expect(client.db.execute(sql`UPDATE event_log SET actor_type='system' WHERE id='authorization'`)).rejects.toThrow();
    await expect(client.db.execute(sql`DELETE FROM event_log WHERE id='authorization'`)).rejects.toThrow();
    await client.db.insert(goals).values({ id: "other-goal", organizationId: f.ids.organizationId, projectId: f.ids.projectId,
      ownerUserId: f.ids.userId, title: "Other goal", createdAt: at(), updatedAt: at() });
    await expect(client.db.insert(goalAutomations).values({ goalId: "other-goal", organizationId: f.ids.organizationId, actorUserId: f.ids.userId,
      policyVersion: "policy", status: "waiting", verificationProfileId: "verifier", executionMode: "agent_team",
      appPublication: f.grant, applicationPublicationAuthorizationEventId: "authorization", createdAt: at(), updatedAt: at() })).rejects.toThrow();
  } finally { await client.close(); }
});

it("keeps request/receipt/history immutable, fences old sessions and settles only the latest fresh observation", async () => {
  const client = await PgliteDbClient.create();
  try {
    const f = await fixture(client);
    // Controlled committed evidence rows exercise database lineage, not live model/native publication.
    const projection = { authorization_event_id: "authorization", research_digest: digest, design_digest: digest,
      measurement_plan_digest: digest, application_definition_digest: digest, development_criteria: [{ requirement_id: "save" }], publication_criteria: [{ requirement_id: "publish" }] };
    const sources: Record<string, unknown>[] = [];
    for (const name of ["author", "reviewer"]) {
      await client.db.execute(sql`INSERT INTO agents(id,organization_id,display_name,kind,status,created_at) VALUES
        (${name},${f.ids.organizationId},${name},'reviewer','idle',${at()})`);
      await client.db.execute(sql`INSERT INTO agent_instances(id,organization_id,computer_id,agent_id,runtime,status,created_at) VALUES
        (${name},${f.ids.organizationId},${f.ids.computerId},${name},'mock','idle',${at()})`);
      await client.db.execute(sql`INSERT INTO tasks(id,organization_id,project_id,goal_id,title,status,created_by_type,created_by_id,created_at,updated_at) VALUES
        (${name},${f.ids.organizationId},${f.ids.projectId},'goal',${name},'done','system','goal_runner',${at()},${at()})`);
      await client.db.execute(sql`INSERT INTO runs(id,organization_id,task_id,computer_id,agent_instance_id,runtime_id,status,created_at) VALUES
        (${name},${f.ids.organizationId},${name},${f.ids.computerId},${name},'mock','completed',${at()})`);
      await client.db.insert(contextPacks).values({ id: `${name}-context`, organizationId: f.ids.organizationId, taskId: name, runId: name,
        payload: { application_publication: { publisher_session_id: "session", authorization: f.authorization, capabilities: f.capabilities } }, createdAt: at() });
      await client.db.execute(sql`UPDATE runs SET context_pack_id=${`${name}-context`} WHERE id=${name}`);
      const evidenceId = `${name}-evidence`, requestId = `${name}-request`, candidate = { package_digest: digest };
      await f.event(`${name}-event`, "run.verification", { request_id: requestId });
      await client.db.execute(sql`INSERT INTO run_evidence(id,organization_id,run_id,request_id,payload,event_id,created_at) VALUES
        (${evidenceId},${f.ids.organizationId},${name},${requestId},${JSON.stringify({ application: { stage: "validation", candidate, publication: projection } })}::jsonb,${`${name}-event`},${at()})`);
      sources.push({ evidence_id: evidenceId, run_id: name, request_id: requestId, agent_id: name, agent_instance_id: name, candidate });
    }
    const request = { version: 1, publication_id: "publication", goal_id: "goal", project_id: f.ids.projectId, computer_id: f.ids.computerId,
      publisher_session_id: "session", authorization: f.authorization, capabilities: f.capabilities,
      author: sources[0], reviewer: sources[1], application_definition_digest: digest, acceptance: projection };
    const requestDigest = hash(request);
    await client.db.insert(applicationPublications).values({ id: "publication", organizationId: f.ids.organizationId, goalId: "goal", projectId: f.ids.projectId,
      computerId: f.ids.computerId, publisherSessionId: "session", authorizationEventId: "authorization", request, requestDigest,
      status: "queued", createdAt: at(), updatedAt: at() });
    await expect(client.db.execute(sql`UPDATE application_publications SET publisher_session_id='replacement' WHERE id='publication'`)).rejects.toThrow();
    const lease = { lease_id: "lease", publication_id: "publication", publisher_session_id: "session", request_digest: requestDigest, deadline_at: at(3600) };
    const deployment = { deployment_generation: "deployment" };
    const service = { owner_id: "service-2", generation: 2 }, native = { root_pid: 123, root_creation_time: "133000000000000001" };
    const healthyParts = (seconds: number) => ({ health: { service, checked_at: at(seconds) },
      live: { service, native, observed_at: at(seconds), counters_observed_at: at(seconds), requests_used: 2 } });
    const receipt = { outcome: "published", scope: "bounded-local-application-publication", request, request_digest: requestDigest, lease, deployment,
      second_service: healthyParts(5), recorded_at: at(5) };
    const receiptDigest = hash(receipt);
    await f.event("receipt-event", "goal.application-publication.receipt", { publication_id: "publication", request_digest: requestDigest, receipt_digest: receiptDigest, outcome: "published" }, 5);
    await client.db.execute(sql`UPDATE application_publications SET status='published',receipt=${JSON.stringify(receipt)}::jsonb,
      receipt_digest=${receiptDigest},receipt_event_id='receipt-event',updated_at=${at(5)} WHERE id='publication'`);
    await expect(client.db.execute(sql`UPDATE application_publications SET receipt='{}'::jsonb WHERE id='publication'`)).rejects.toThrow();
    const append = async (sequence: number, state: string, seconds: number, session = "session", change: Record<string, unknown> = {}, suffix = "") => {
      const id = `observation-${sequence}${suffix}`, payload = { version: 1, event_id: id, sequence, generation: 2, request, request_digest: requestDigest,
        lease, deployment, state, observed_at: at(seconds), ...(state === "healthy" ? healthyParts(seconds) : { health: null, live: null }), closure: null, ...change };
      const payloadDigest = hash(payload);
      await f.event(`${id}-event`, "goal.application-publication.observation", { publication_id: "publication", request_digest: requestDigest,
        event_id: id, sequence, observation_digest: payloadDigest, state }, seconds);
      await client.db.insert(applicationPublicationObservations).values({ id, organizationId: f.ids.organizationId, publicationId: "publication",
        publisherSessionId: session, sequence, generation: 2, state, requestDigest, payload, payloadDigest, eventId: `${id}-event`, createdAt: at(seconds) });
    };
    await expect(append(1, "healthy", 6, "old-session")).rejects.toThrow();
    // The failed observation insert did not commit a row; its separately inserted event is immutable diagnostic history.
    await client.db.insert(applicationPublicationObservations).values({ id: "observation-1", organizationId: f.ids.organizationId, publicationId: "publication",
      publisherSessionId: "session", sequence: 1, generation: 2, state: "healthy", requestDigest,
      payload: { version: 1, event_id: "observation-1", sequence: 1, generation: 2, request, request_digest: requestDigest,
        lease, deployment, state: "healthy", observed_at: at(6), ...healthyParts(6), closure: null },
      payloadDigest: hash({ version: 1, event_id: "observation-1", sequence: 1, generation: 2, request, request_digest: requestDigest,
        lease, deployment, state: "healthy", observed_at: at(6), ...healthyParts(6), closure: null }),
      eventId: "observation-1-event", createdAt: at(6) });
    for (const [suffix, change] of [
      ["-owner", { live: { ...healthyParts(7).live, service: { ...service, owner_id: "replacement-owner" } } }],
      ["-pid", { live: { ...healthyParts(7).live, native: { ...native, root_pid: 124 } } }],
      ["-creation", { live: { ...healthyParts(7).live, native: { ...native, root_creation_time: "replacement" } } }],
      ["-counter", { live: { ...healthyParts(7).live, requests_used: 1 } }],
      ["-time", { live: { ...healthyParts(7).live, counters_observed_at: at(5) } }],
      ["-drain", { closure: { kind: "normal-drain", service, counters: { accepted_transports: 1 } } }],
    ] as const) await expect(append(2, "healthy", 7, "session", change, suffix)).rejects.toThrow();
    await append(2, "healthy", 7);
    const binding = { version: 1, publication_id: "publication", request_digest: requestDigest, receipt_digest: receiptDigest,
      authorization_event_id: "authorization", observation_id: "observation-2", observation_sequence: 2, lease_id: "lease", deadline_at: at(3600), scope: "bounded-local-application-publication" };
    const settlement = { goalId: "goal", organizationId: f.ids.organizationId, publicationId: "publication",
      requestDigest, receiptDigest, authorizationEventId: "authorization", observationId: "observation-2", observationSequence: 2,
      leaseId: "lease", deadlineAt: at(3600), scope: binding.scope, eventId: "completed", createdAt: at(8) };
    await f.event("older-completed", "goal.completed", { application_publication: { ...binding, observation_id: "observation-1", observation_sequence: 1 } }, 8);
    await expect(client.db.insert(applicationPublicationSettlements).values({ ...settlement, observationId: "observation-1", observationSequence: 1, eventId: "older-completed" })).rejects.toThrow();
    await f.event("stale-completed", "goal.completed", { application_publication: binding }, 100);
    await expect(client.db.insert(applicationPublicationSettlements).values({ ...settlement, eventId: "stale-completed", createdAt: at(100) })).rejects.toThrow();
    await f.event("completed", "goal.completed", { application_publication: binding }, 8);
    await client.db.insert(applicationPublicationSettlements).values(settlement);
    await client.db.execute(sql`UPDATE goals SET status='completed' WHERE id='goal'`);
    await client.db.execute(sql`UPDATE goal_automations SET status='completed' WHERE goal_id='goal'`);
    await append(3, "expired", 3600);
    await expect(client.db.execute(sql`UPDATE application_publication_observations SET state='healthy' WHERE id='observation-3'`)).rejects.toThrow();
    await expect(append(4, "healthy", 3601)).rejects.toThrow();
    await expect(client.db.execute(sql`DELETE FROM application_publication_settlements WHERE goal_id='goal'`)).rejects.toThrow();
    await expect(client.db.execute(sql`UPDATE event_log SET payload='{}' WHERE id='completed'`)).rejects.toThrow();
    expect((await client.db.select().from(applicationPublications))[0]?.receipt).toEqual(receipt);
    expect((await client.db.select().from(applicationPublicationSettlements))[0]?.observationId).toBe("observation-2");
  } finally { await client.close(); }
});
