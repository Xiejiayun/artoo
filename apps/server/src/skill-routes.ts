import { InstallSkillRequestSchema } from "@artoo/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { requestContext } from "./auth/auth-routes.js";
import type { ServerContext } from "./context.js";
import { AppError } from "./errors.js";
import * as skillService from "./services/skill-service.js";

/** Register skill installs and scoped reads in the existing app scope. */
export function registerSkillRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const rc = (req: FastifyRequest): ServerContext => requestContext(ctx, req);
  // Skill registry (#24): durable installs/read APIs over the v1alpha1 manifest contract.
  app.post("/api/v1/skills/install", async (req, reply) => {
    const parsed = InstallSkillRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw AppError.validation("invalid skill install payload", { issues: parsed.error.issues });
    }
    const skill = await skillService.installSkill(rc(req), parsed.data);
    void reply.status(201);
    return { skill };
  });

  app.get("/api/v1/skills", async (req) => {
    const q = req.query as { project_id?: string; enabled?: string };
    let enabled: boolean | undefined;
    if (q.enabled !== undefined && q.enabled !== "") {
      if (q.enabled !== "true" && q.enabled !== "false") {
        throw AppError.validation("enabled filter must be 'true' or 'false'", { enabled: q.enabled });
      }
      enabled = q.enabled === "true";
    }
    return {
      skills: await skillService.listSkillInstalls(rc(req), {
        projectId: q.project_id,
        enabled,
      }),
    };
  });

  app.get("/api/v1/skills/:id", async (req) => {
    const { id } = req.params as { id: string };
    return { skill: await skillService.getSkillInstall(rc(req), id) };
  });
}
