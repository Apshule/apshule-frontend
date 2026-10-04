import { Hono, type Context } from "hono";
import { ApiError, getDb } from "../db.js";
import {
  authMiddleware,
  createAccessToken,
  requireImpersonationSession,
  requireRealSuperAdmin,
} from "../auth.js";
import type { AppEnv, UserRole } from "../types.js";

const impersonationRoutes = new Hono<AppEnv>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IMPERSONATION_LIFETIME_SECONDS = 60 * 60;

function requestIp(c: Context<AppEnv>): string | null {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    null
  )?.slice(0, 255) ?? null;
}

impersonationRoutes.post(
  "/impersonate/end",
  authMiddleware,
  requireImpersonationSession(),
  async (c) => {
    const user = c.get("user");
    const actorId = user.impersonatedBy;
    if (!actorId) {
      throw new ApiError(403, "FORBIDDEN", "An active impersonation session is required.");
    }
    const sql = getDb(c.env);
    await sql`
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      VALUES (
        ${actorId}, ${user.sector}, 'impersonate_end', 'users', ${user.id},
        '{}'::jsonb, ${requestIp(c)}
      )
    `;
    await sql`
      INSERT INTO revoked_tokens (token_id, user_id, expires_at)
      VALUES (${user.tokenId}, ${user.id}, to_timestamp(${user.tokenExpiresAt}))
      ON CONFLICT (token_id) DO NOTHING
    `;
    return c.json({ ok: true });
  },
);

impersonationRoutes.post(
  "/impersonate/:userId",
  authMiddleware,
  requireRealSuperAdmin(),
  async (c) => {
    const targetId = c.req.param("userId");
    if (!uuidPattern.test(targetId)) {
      throw new ApiError(403, "IMPERSONATION_FORBIDDEN", "This user cannot be impersonated.");
    }

    const sql = getDb(c.env);
    const rows = await sql`
      SELECT id, name, email, role, school_id, sector
      FROM users
      WHERE id = ${targetId}
      LIMIT 1
    `;
    const target = rows[0] as
      | {
          id: string;
          name: string;
          email: string;
          role: UserRole;
          school_id: string | null;
          sector: string | null;
        }
      | undefined;
    if (!target || target.role === "superadmin") {
      throw new ApiError(403, "IMPERSONATION_FORBIDDEN", "This user cannot be impersonated.");
    }

    const actor = c.get("user");
    const sector = target.sector ?? "education";
    const issued = await createAccessToken(
      c.env,
      {
        id: target.id,
        email: target.email,
        role: target.role,
        schoolId: target.school_id,
        sector,
      },
      {
        expiresInSeconds: IMPERSONATION_LIFETIME_SECONDS,
        impersonatedBy: actor.id,
      },
    );

    await sql`
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      VALUES (
        ${actor.id}, ${sector}, 'impersonate_start', 'users', ${target.id},
        ${JSON.stringify({ target_email: target.email })}::jsonb, ${requestIp(c)}
      )
    `;

    return c.json({
      token: issued.token,
      user: {
        id: target.id,
        name: target.name,
        email: target.email,
        role: target.role,
        sector,
      },
      expiresIn: IMPERSONATION_LIFETIME_SECONDS,
    });
  },
);

export default impersonationRoutes;