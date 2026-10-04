import { Hono } from "hono";
import { ApiError, getDb } from "../db.js";
import { authMiddleware, requireRole } from "../auth.js";
import { optionalString, readJson, requiredString } from "../http.js";
import type { AppEnv } from "../types.js";

const events = new Hono<AppEnv>();

async function ensureEventAccess(
  sql: ReturnType<typeof getDb>,
  eventId: string,
  schoolId: string | null,
) {
  const rows = await sql`SELECT id, school_id FROM events WHERE id = ${eventId} LIMIT 1`;
  const event = rows[0] as { id: string; school_id: string | null } | undefined;
  if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event was not found.");
  if (schoolId && event.school_id !== schoolId) {
    throw new ApiError(403, "FORBIDDEN", "You can only manage events for your school.");
  }
}

events.get("/", async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT e.id, e.title, e.date, e.fee, e.school_id, e.created_at, s.name AS school_name
    FROM events e
    LEFT JOIN schools s ON s.id = e.school_id
    ORDER BY e.created_at DESC
  `;
  return c.json({ events: rows });
});

events.post("/", authMiddleware, requireRole("school", "superadmin"), async (c) => {
  const body = await readJson(c);
  const title = requiredString(body, "title", { max: 200 });
  const date = requiredString(body, "date", { max: 80 });
  const fee = requiredString(body, "fee", { max: 80 });
  const user = c.get("user");
  const requestedSchoolId = optionalString(body, "schoolId", { max: 80 }) ?? null;
  const schoolId = user.role === "school" ? user.schoolId : requestedSchoolId;
  if (user.role === "school" && !schoolId) {
    throw new ApiError(403, "SCHOOL_NOT_LINKED", "This school account is not linked to a school record.");
  }
  const sql = getDb(c.env);
  const rows = await sql`
    INSERT INTO events (title, date, fee, school_id)
    VALUES (${title}, ${date}, ${fee}, ${schoolId})
    RETURNING id, title, date, fee, school_id, created_at
  `;
  return c.json({ event: rows[0] }, 201);
});

events.patch("/:id", authMiddleware, requireRole("school", "superadmin"), async (c) => {
  const body = await readJson(c);
  const title = optionalString(body, "title", { max: 200 });
  const date = optionalString(body, "date", { max: 80 });
  const fee = optionalString(body, "fee", { max: 80 });
  if (![title, date, fee].some((value) => value !== undefined)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one event field to update.");
  }
  const user = c.get("user");
  const sql = getDb(c.env);
  await ensureEventAccess(sql, c.req.param("id"), user.role === "school" ? user.schoolId : null);
  const rows = await sql`
    UPDATE events
    SET
      title = CASE WHEN ${title !== undefined} THEN ${title ?? null} ELSE title END,
      date = CASE WHEN ${date !== undefined} THEN ${date ?? null} ELSE date END,
      fee = CASE WHEN ${fee !== undefined} THEN ${fee ?? null} ELSE fee END
    WHERE id = ${c.req.param("id")}
    RETURNING id, title, date, fee, school_id, created_at
  `;
  return c.json({ event: rows[0] });
});

events.delete("/:id", authMiddleware, requireRole("school", "superadmin"), async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  await ensureEventAccess(sql, c.req.param("id"), user.role === "school" ? user.schoolId : null);
  await sql`DELETE FROM events WHERE id = ${c.req.param("id")}`;
  return c.json({ message: "Event deleted." });
});

export default events;