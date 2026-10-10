import { loadAiDataSharingPolicy } from "./config/ai-data-sharing.js";
import { grantAiDataSharingConsent } from "./services/ai-data-sharing-service.js";
import type { ServerContext } from "./context.js";

/** Real CLI endpoints are operator-controlled; a CLI name cannot identify its recipient. */
export async function authorizeLiveSmokeSharing(ctx: ServerContext): Promise<void> {
  const policy = loadAiDataSharingPolicy(process.env);
  if (policy?.mode !== "external" || process.env.ARTOO_LIVE_AI_SHARING_CONSENT !== "1") {
    throw new Error("Live AI smoke requires an explicit external ARTOO_AI_DATA_SHARING_POLICY and ARTOO_LIVE_AI_SHARING_CONSENT=1 for the isolated fixture user.");
  }
  ctx.aiDataSharingPolicy = policy;
  await grantAiDataSharingConsent(ctx, policy.version);
}
