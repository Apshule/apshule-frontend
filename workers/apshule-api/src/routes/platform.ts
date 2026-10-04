import { Hono } from "hono";
import { ApiError, getDb } from "../db.js";
import { authMiddleware, requireRealSuperAdmin, requireRole } from "../auth.js";
import { optionalString, parseLimit, readJson, requiredString } from "../http.js";
import type { AppEnv } from "../types.js";

const platformRoutes = new Hono<AppEnv>();

platformRoutes.get("/sectors", async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT
      s.code,
      s.name,
      s.enabled,
      s.waitlist_enabled,
      COUNT(u.id)::int AS user_count,
      COUNT(u.id) FILTER (WHERE u.waitlist = TRUE)::int AS waitlist_count
    FROM sectors s
    LEFT JOIN users u ON u.sector = s.code
    GROUP BY s.code, s.name, s.enabled, s.waitlist_enabled, s.created_at
    ORDER BY CASE s.code
      WHEN 'education' THEN 1
      WHEN 'mfi' THEN 2
      WHEN 'clinic' THEN 3
      WHEN 'farm' THEN 4
      ELSE 5
    END, s.created_at ASC
  `;
  return c.json(rows);
});

platformRoutes.post("/audit", authMiddleware, requireRole("superadmin"), async (c) => {
  const body = await readJson(c);
  const action = requiredString(body, "action", { max: 120 });
  const sector = optionalString(body, "sector", { max: 80, allowNull: true }) ?? null;
  const targetTable = optionalString(body, "target_table", { max: 120, allowNull: true }) ?? null;
  const targetId = optionalString(body, "target_id", { max: 36, allowNull: true }) ?? null;
  if (targetId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(targetId)) {
    throw new ApiError(400, "VALIDATION_ERROR", "target_id must be a valid UUID.");
  }
  const metadataValue = body.metadata;
  if (
    metadataValue !== undefined &&
    metadataValue !== null &&
    (typeof metadataValue !== "object" || Array.isArray(metadataValue))
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", "metadata must be a JSON object or null.");
  }
  const metadata = metadataValue === undefined || metadataValue === null
    ? null
    : JSON.stringify(metadataValue);
  const ip = (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    null
  )?.slice(0, 255) ?? null;
  const sql = getDb(c.env);
  const rows = await sql`
    INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
    VALUES (
      ${c.get("user").id}, ${sector}, ${action}, ${targetTable}, ${targetId},
      ${metadata}::jsonb, ${ip}
    )
    RETURNING id, actor_id, sector, action, target_table, target_id, metadata, ip, created_at
  `;
  return c.json({ audit: rows[0] }, 201);
});

platformRoutes.get("/audit-log", authMiddleware, requireRealSuperAdmin(), async (c) => {
  const sectorValue = c.req.query("sector");
  if (sectorValue !== undefined && (!sectorValue.trim() || sectorValue.length > 80)) {
    throw new ApiError(400, "VALIDATION_ERROR", "sector must be a non-empty value of at most 80 characters.");
  }
  const sector = sectorValue ?? null;
  const limit = parseLimit(c.req.query("limit"), 100);
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT
      a.id,
      a.action,
      a.sector,
      a.target_table,
      a.target_id,
      a.metadata,
      actor.email AS actor_email,
      actor.name AS actor_name,
      a.created_at
    FROM audit_log a
    LEFT JOIN users actor ON actor.id = a.actor_id
    WHERE ${sector === null} OR a.sector = ${sector}
    ORDER BY a.created_at DESC
    LIMIT ${limit}
  `;
  return c.json(rows);
});

export default platformRoutes;