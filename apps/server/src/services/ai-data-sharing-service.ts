import { aiDataSharingConsents, users } from "@artoo/db";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, isNull } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";

export interface AiSharingAuthorization {
  consentId: string | null;
  policyVersion: string;
}

function configuredPolicy(ctx: ServerContext) {
  if (!ctx.aiDataSharingPolicy) throw new AppError("ai_sharing_unconfigured",
    "Your team operator must disclose the AI providers before agent work can start.", 503);
  return ctx.aiDataSharingPolicy;
}

function consentRequired() {
  return new AppError("ai_consent_required", "Review and allow your team's AI data sharing before requesting agent work.", 428);
}

async function activeGrant(ctx: ServerContext, db: DrizzleDb = ctx.db.db) {
  return (await db.select().from(aiDataSharingConsents).where(and(
    eq(aiDataSharingConsents.organizationId, ctx.organizationId), eq(aiDataSharingConsents.userId, ctx.actorUserId),
    isNull(aiDataSharingConsents.revokedAt),
  )))[0];
}

export async function aiDataSharingState(ctx: ServerContext) {
  const policy = ctx.aiDataSharingPolicy ?? null;
  const grant = await activeGrant(ctx);
  return { user_id: ctx.actorUserId, configured: policy !== null, policy,
    consent: policy?.mode === "external" && grant?.policyVersion === policy.version
      ? { id: grant.id, policy_version: grant.policyVersion, granted_at: grant.grantedAt } : null };
}

/** Use inside enqueue transactions and recheck before context leaves the server. */
export async function requireAiSharingAuthorization(ctx: ServerContext, db: DrizzleDb = ctx.db.db,
  expected?: { consentId: string | null; policyVersion: string | null }): Promise<AiSharingAuthorization> {
  const policy = configuredPolicy(ctx);
  if (policy.mode === "local") {
    if (expected && (expected.consentId !== null || (expected.policyVersion !== null && expected.policyVersion !== policy.version))) throw consentRequired();
    return { consentId: null, policyVersion: policy.version };
  }
  const grant = await activeGrant(ctx, db);
  if (!grant || grant.policyVersion !== policy.version) throw consentRequired();
  if (expected && (expected.consentId !== grant.id || expected.policyVersion !== policy.version)) throw consentRequired();
  return { consentId: grant.id, policyVersion: policy.version };
}

export async function grantAiDataSharingConsent(ctx: ServerContext, version: unknown) {
  const policy = configuredPolicy(ctx);
  if (policy.mode !== "external") throw AppError.invalidState("The team has declared local-only processing; no external AI consent is needed.");
  if (version !== policy.version) throw AppError.conflict("The AI disclosure changed. Review its current providers before allowing sharing.");
  await ctx.db.transaction(async (tx) => {
    const actor = (await tx.select().from(users).where(and(eq(users.id, ctx.actorUserId), eq(users.organizationId, ctx.organizationId))).for("update"))[0];
    if (!actor) throw AppError.permissionDenied("The account does not belong to this team.");
    const current = await activeGrant(ctx, tx);
    if (current?.policyVersion === policy.version) return;
    const now = ctx.clock.nowIso();
    await tx.update(aiDataSharingConsents).set({ revokedAt: now }).where(and(
      eq(aiDataSharingConsents.organizationId, ctx.organizationId), eq(aiDataSharingConsents.userId, ctx.actorUserId), isNull(aiDataSharingConsents.revokedAt),
    ));
    await tx.insert(aiDataSharingConsents).values({ id: ctx.idGen.generate("consent"), organizationId: ctx.organizationId,
      userId: ctx.actorUserId, policyVersion: policy.version, policySnapshot: policy, grantedAt: now });
  });
  return aiDataSharingState(ctx);
}

/** Persist withdrawal first. Route orchestration must then stop affected work. */
export async function revokeAiDataSharingConsent(ctx: ServerContext) {
  await ctx.db.transaction(async (tx) => {
    const actor = (await tx.select().from(users).where(and(eq(users.id, ctx.actorUserId), eq(users.organizationId, ctx.organizationId))).for("update"))[0];
    if (!actor) throw AppError.permissionDenied("The account does not belong to this team.");
    await tx.update(aiDataSharingConsents).set({ revokedAt: ctx.clock.nowIso() }).where(and(
      eq(aiDataSharingConsents.organizationId, ctx.organizationId), eq(aiDataSharingConsents.userId, ctx.actorUserId), isNull(aiDataSharingConsents.revokedAt),
    ));
  });
  return aiDataSharingState(ctx);
}

/** The original grant, not a user's newer re-consent, authorizes a queued run. */
export async function requireRunAiSharingAuthorization(ctx: ServerContext, run: {
  requestedByUserId: string | null; aiDataSharingConsentId: string | null; aiDataSharingPolicyVersion: string | null;
}) {
  const policy = configuredPolicy(ctx);
  if (policy.mode === "external" && !run.requestedByUserId) throw consentRequired();
  return requireAiSharingAuthorization({ ...ctx, actorUserId: run.requestedByUserId ?? ctx.actorUserId }, ctx.db.db,
    { consentId: run.aiDataSharingConsentId, policyVersion: run.aiDataSharingPolicyVersion });
}
