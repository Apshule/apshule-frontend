import { Hono } from "hono";
import { ApiError, getDb, isUniqueViolation } from "../db.js";
import { requireRole } from "../auth.js";
import { optionalString, readJson, requiredString } from "../http.js";
import type { AuthenticatedUser, AppEnv } from "../types.js";
import { computeFarmFaceHash, hammingDistance } from "../farm-face-hash.js";

const operations = new Hono<AppEnv>();
const STAFF_ROLES = ["farm_admin", "farm_manager", "farm_worker"] as const;
const ADMIN_MANAGER_ROLES = ["farm_admin", "farm_manager"] as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MOVEMENT_DIRECTIONS = new Set(["in", "out", "transfer"]);
const EGG_SHIFTS = new Set(["morning", "afternoon", "evening"]);
const HEALTH_TYPES = new Set(["checkup", "vaccination", "illness", "treatment", "recovery"]);
const FACE_MATCH_THRESHOLD = 15;
const FACE_PHOTO_LIMIT = 200 * 1024;

type FarmSql = ReturnType<typeof getDb>;
type JsonBody = Record<string, unknown>;
type WorkerRow = {
  id: string;
  user_id: string;
  organization_id?: string;
  location_id: string | null;
  role: string;
  active: boolean;
  face_hash?: string | null;
};

function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}

function uuid(value: string, field = "id"): string {
  if (!UUID_PATTERN.test(value)) fail(400, "VALIDATION_ERROR", `${field} must be a valid UUID.`);
  return value;
}

function optionalUuid(body: JsonBody, key: string): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null || value === "") return null;
  if (typeof value !== "string") fail(400, "VALIDATION_ERROR", `${key} must be a UUID.`);
  return uuid(value, key);
}

function optionalText(body: JsonBody, key: string, max = 500): string | null | undefined {
  const value = optionalString(body, key, { max, allowNull: true });
  if (value === undefined || value === null) return value;
  return value.length ? value : null;
}

function requiredText(body: JsonBody, key: string, max = 200): string {
  return requiredString(body, key, { max });
}

function requiredInteger(body: JsonBody, key: string, min = 0): number {
  const value = body[key];
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < min) {
    fail(400, "VALIDATION_ERROR", `${key} must be a whole number of at least ${min}.`);
  }
  return number;
}

function optionalMoney(body: JsonBody, key: string): number | null | undefined {
  if (!(key in body)) return undefined;
  if (body[key] === null || body[key] === "") return null;
  const value = typeof body[key] === "number" ? body[key] : Number(body[key]);
  if (!Number.isFinite(value) || value < 0) {
    fail(400, "VALIDATION_ERROR", `${key} must be a non-negative number.`);
  }
  return value;
}

function dateValue(value: unknown, field: string, required = false): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) fail(400, "VALIDATION_ERROR", `${field} must be a valid YYYY-MM-DD date.`);
    return null;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    fail(400, "VALIDATION_ERROR", `${field} must be a valid YYYY-MM-DD date.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(400, "VALIDATION_ERROR", `${field} must be a valid YYYY-MM-DD date.`);
  }
  return value;
}

function timestampValue(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail(400, "VALIDATION_ERROR", `${field} must be a valid date and time.`);
  }
  return new Date(value).toISOString();
}

function checkDateRange(from: string | null, to: string | null): void {
  if (from && to && from > to) {
    fail(400, "VALIDATION_ERROR", "The start date must be on or before the end date.");
  }
}

function requestIp(c: { req: { header(name: string): string | undefined } }): string | null {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    null
  )?.slice(0, 255) ?? null;
}

async function organizationForUser(sql: FarmSql, actor: AuthenticatedUser): Promise<string> {
  const rows = actor.role === "farm_admin"
    ? await sql`SELECT id FROM farm_organizations WHERE created_by = ${actor.id} LIMIT 1`
    : await sql`
        SELECT organization_id AS id
        FROM farm_workers
        WHERE user_id = ${actor.id} AND active IS TRUE
        LIMIT 1
      `;
  const organizationId = (rows[0] as { id?: string } | undefined)?.id;
  if (!organizationId) {
    fail(403, "FARM_ACCESS_NOT_PROVISIONED", "This Farm account is inactive or not linked to an organization.");
  }
  return organizationId;
}

async function workerInOrganization(
  sql: FarmSql,
  organizationId: string,
  workerId: string,
  activeOnly = true,
): Promise<WorkerRow> {
  const rows = await sql`
    SELECT id, user_id, organization_id, location_id, role, active, face_hash
    FROM farm_workers
    WHERE id = ${workerId}
      AND organization_id = ${organizationId}
      AND (${!activeOnly} OR active IS TRUE)
    LIMIT 1
  `;
  const worker = rows[0] as WorkerRow | undefined;
  if (!worker) fail(404, "WORKER_NOT_FOUND", "Worker was not found in this farm.");
  return worker;
}

async function actorWorker(
  sql: FarmSql,
  organizationId: string,
  actor: AuthenticatedUser,
): Promise<WorkerRow> {
  const rows = await sql`
    SELECT id, user_id, organization_id, location_id, role, active, face_hash
    FROM farm_workers
    WHERE user_id = ${actor.id}
      AND organization_id = ${organizationId}
      AND active IS TRUE
    LIMIT 1
  `;
  const worker = rows[0] as WorkerRow | undefined;
  if (!worker) fail(403, "FARM_ACCESS_NOT_PROVISIONED", "No active worker record is linked to this account.");
  return worker;
}

async function activeLocation(
  sql: FarmSql,
  organizationId: string,
  locationId: string | null,
): Promise<void> {
  if (!locationId) return;
  const rows = await sql`
    SELECT id FROM farm_locations
    WHERE id = ${locationId} AND organization_id = ${organizationId} AND active IS TRUE
    LIMIT 1
  `;
  if (!rows[0]) fail(400, "LOCATION_NOT_FOUND", "The location is not active in this farm.");
}

async function localToday(sql: FarmSql, organizationId: string): Promise<string> {
  const rows = await sql`
    SELECT to_char(
      NOW() AT TIME ZONE COALESCE(
        (SELECT timezone FROM farm_settings WHERE organization_id = ${organizationId} LIMIT 1),
        'Africa/Kampala'
      ),
      'YYYY-MM-DD'
    ) AS today
  `;
  return String((rows[0] as { today?: string } | undefined)?.today || new Date().toISOString().slice(0, 10));
}

async function auditMutation(
  sql: FarmSql,
  actor: AuthenticatedUser,
  organizationId: string,
  action: string,
  targetTable: string,
  targetId: string | null,
  metadata: Record<string, unknown>,
  ip: string | null,
): Promise<void> {
  const metadataJson = JSON.stringify(metadata);
  await sql`
    WITH farm_entry AS (
      INSERT INTO farm_audit
        (organization_id, actor_id, action, target_table, target_id, metadata)
      VALUES
        (${organizationId}, ${actor.id}, ${action}, ${targetTable},
         ${targetId}, ${metadataJson}::jsonb)
      RETURNING id
    )
    INSERT INTO audit_log
      (actor_id, sector, action, target_table, target_id, metadata, ip)
    VALUES
      (${actor.id}, 'farm', ${action}, ${targetTable},
       ${targetId}, ${metadataJson}::jsonb, ${ip})
  `;
}

function actor(c: { get(key: "user"): AuthenticatedUser }): AuthenticatedUser {
  return c.get("user");
}

function faceNotRecognized(c: { json(body: unknown, status?: number): Response }, score: number | null): Response {
  return c.json({ error: "Face not recognized", score }, 400);
}

function faceImage(body: JsonBody): string {
  const value = optionalText(body, "face_photo_base64", 280_000);
  if (!value || !/^data:image\/jpeg;base64,[a-z0-9+/]+={0,2}$/iu.test(value)) {
    fail(400, "FACE_IMAGE_INVALID", "Provide a JPEG face image.");
  }
  const encoded = value.slice(value.indexOf(",") + 1);
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  if (Math.floor((encoded.length * 3) / 4) - padding > FACE_PHOTO_LIMIT) {
    fail(400, "FACE_IMAGE_TOO_LARGE", "Face images must be no larger than 200 KB.");
  }
  return value;
}

function hammingFromPhoto(photo: string): string {
  try {
    return computeFarmFaceHash(photo);
  } catch {
    fail(400, "FACE_IMAGE_INVALID", "The face image is invalid or could not be decoded.");
  }
}

async function resolveHealthStatus(
  sql: FarmSql,
  organizationId: string,
  animalId: string,
): Promise<void> {
  const latest = await sql`
    SELECT log_type
    FROM farm_health_logs
    WHERE organization_id = ${organizationId}
      AND animal_id = ${animalId}
      AND log_type IN ('illness', 'recovery')
    ORDER BY log_date DESC, created_at DESC, id DESC
    LIMIT 1
  `;
  const logType = (latest[0] as { log_type?: string } | undefined)?.log_type;
  await sql`
    UPDATE farm_animals
    SET health_status = ${logType === "illness" ? "sick" : "healthy"},
        updated_at = NOW()
    WHERE id = ${animalId} AND organization_id = ${organizationId}
  `;
}

function normalizedDirection(value: unknown): "in" | "out" | "transfer" {
  if (typeof value !== "string" || !MOVEMENT_DIRECTIONS.has(value)) {
    fail(400, "VALIDATION_ERROR", "direction must be in, out, or transfer.");
  }
  return value as "in" | "out" | "transfer";
}

function normalizedShift(value: unknown): string {
  if (typeof value !== "string" || !EGG_SHIFTS.has(value.toLowerCase())) {
    fail(400, "VALIDATION_ERROR", "shift must be Morning, Afternoon, or Evening.");
  }
  return value[0].toUpperCase() + value.slice(1).toLowerCase();
}

function normalizedHealthType(value: unknown): string {
  if (typeof value !== "string" || !HEALTH_TYPES.has(value.toLowerCase())) {
    fail(400, "VALIDATION_ERROR", "log_type must be checkup, vaccination, illness, treatment, or recovery.");
  }
  return value.toLowerCase();
}

function defaultWeekStart(today: string): string {
  const date = new Date(`${today}T00:00:00.000Z`);
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - ((day + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function monthStart(today: string): string {
  return `${today.slice(0, 7)}-01`;
}

// Animal movements
operations.get("/movements", requireRole(...STAFF_ROLES), async (c) => {
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, actor(c));
  const animalId = c.req.query("animal_id") ? uuid(c.req.query("animal_id")!, "animal_id") : null;
  const locationId = c.req.query("location_id") ? uuid(c.req.query("location_id")!, "location_id") : null;
  const from = dateValue(c.req.query("from"), "from");
  const to = dateValue(c.req.query("to"), "to");
  checkDateRange(from, to);
  const rawDirection = c.req.query("direction");
  const direction = rawDirection ? normalizedDirection(rawDirection) : null;
  const rows = await sql`
    SELECT m.id, m.organization_id, m.animal_id, m.from_location_id, m.to_location_id,
      m.direction, m.movement_type, m.reason, m.count, m.moved_at, m.recorded_by,
      m.notes, m.created_at, a.tag_number, a.name AS animal_name,
      fl.name AS from_location_name, tl.name AS to_location_name,
      u.name AS recorded_by_name
    FROM farm_movements m
    JOIN farm_animals a ON a.id = m.animal_id AND a.organization_id = m.organization_id
    LEFT JOIN farm_locations fl ON fl.id = m.from_location_id AND fl.organization_id = m.organization_id
    LEFT JOIN farm_locations tl ON tl.id = m.to_location_id AND tl.organization_id = m.organization_id
    LEFT JOIN users u ON u.id = m.recorded_by
    WHERE m.organization_id = ${organizationId}
      AND (${animalId}::uuid IS NULL OR m.animal_id = ${animalId})
      AND (${locationId}::uuid IS NULL OR m.from_location_id = ${locationId} OR m.to_location_id = ${locationId})
      AND (${from}::date IS NULL OR m.moved_at::date >= ${from})
      AND (${to}::date IS NULL OR m.moved_at::date <= ${to})
      AND (${direction}::text IS NULL OR m.direction = ${direction})
    ORDER BY m.moved_at DESC, m.created_at DESC
    LIMIT 500
  `;
  return c.json({ movements: rows });
});

operations.post("/movements", requireRole(...ADMIN_MANAGER_ROLES), async (c) => {
  const body = await readJson(c);
  const animalId = uuid(requiredText(body, "animal_id", 36), "animal_id");
  const direction = normalizedDirection(body.direction);
  const providedFrom = optionalUuid(body, "from_location_id");
  const toLocationId = optionalUuid(body, "to_location_id") ?? null;
  const movedAt = timestampValue(body.moved_at, "moved_at");
  const reason = optionalText(body, "reason", 300) ?? null;
  const notes = optionalText(body, "notes", 1000) ?? null;
  const movementType = optionalText(body, "movement_type", 80) ??
    (direction === "in" ? "arrival" : direction === "out" ? "departure" : "transfer");
  const sql = getDb(c.env);
  const actorUser = actor(c);
  const organizationId = await organizationForUser(sql, actorUser);
  const animalRows = await sql`
    SELECT a.id, a.location_id, a.quantity, a.status, t.tracking_mode
    FROM farm_animals a
    JOIN farm_animal_types t ON t.id = a.animal_type_id
      AND t.organization_id = a.organization_id
    WHERE a.id = ${animalId}
      AND a.organization_id = ${organizationId}
      AND a.status <> 'deleted'
    LIMIT 1
  `;
  const animal = animalRows[0] as {
    id: string; location_id: string | null; quantity: number | null; status: string; tracking_mode: string;
  } | undefined;
  if (!animal) fail(404, "ANIMAL_NOT_FOUND", "Active animal record was not found in this farm.");
  const fromLocationId = direction === "in"
    ? null
    : providedFrom === undefined
      ? animal.location_id
      : providedFrom;
  if (direction === "transfer" && (!fromLocationId || !toLocationId)) {
    fail(400, "VALIDATION_ERROR", "A transfer requires both a from location and a to location.");
  }
  if ((direction === "in" || direction === "transfer") && !toLocationId) {
    fail(400, "VALIDATION_ERROR", "This movement direction requires a to location.");
  }
  if ((direction === "transfer" || (direction === "out" && toLocationId)) && fromLocationId === toLocationId) {
    fail(400, "VALIDATION_ERROR", "The from and to locations must be different.");
  }
  if (direction !== "in" && fromLocationId !== animal.location_id) {
    fail(409, "ANIMAL_LOCATION_CHANGED", "The animal is no longer at the selected from location.");
  }
  await activeLocation(sql, organizationId, fromLocationId);
  await activeLocation(sql, organizationId, toLocationId);
  const count = body.count === undefined
    ? Math.max(1, Number(animal.quantity ?? 1))
    : requiredInteger(body, "count", 1);
  const animalQuantity = Math.max(1, Number(animal.quantity ?? 1));
  if (count !== animalQuantity) {
    fail(400, "BATCH_SPLIT_UNSUPPORTED", "Move the full animal record quantity; partial batch movements are not supported.");
  }
  const nextLocationId = direction === "out" && toLocationId === null ? null : toLocationId;
  const rows = await sql`
    WITH current_animal AS (
      SELECT id, location_id, quantity
      FROM farm_animals
      WHERE id = ${animalId}
        AND organization_id = ${organizationId}
        AND status <> 'deleted'
      FOR UPDATE
    ),
    created AS (
      INSERT INTO farm_movements
        (organization_id, animal_id, from_location_id, to_location_id,
         direction, movement_type, reason, count, moved_at, recorded_by, notes)
      SELECT ${organizationId}, a.id, ${fromLocationId}, ${toLocationId},
        ${direction}, ${movementType}, ${reason}, ${count},
        COALESCE(${movedAt}::timestamptz, NOW()), ${actorUser.id}, ${notes}
      FROM current_animal a
      WHERE a.location_id IS NOT DISTINCT FROM ${fromLocationId}
        AND COALESCE(a.quantity, 1) = ${animalQuantity}
      RETURNING *
    ),
    updated AS (
      UPDATE farm_animals a
      SET location_id = ${nextLocationId}, updated_at = NOW()
      FROM created m
      WHERE a.id = m.animal_id AND a.organization_id = ${organizationId}
      RETURNING a.id
    )
    SELECT created.*, updated.id AS updated_animal_id
    FROM created JOIN updated ON updated.id = created.animal_id
  `;
  const movement = rows[0] as { id: string; direction: string; count: number } | undefined;
  if (!movement) {
    fail(409, "ANIMAL_LOCATION_CHANGED", "The animal record changed during the movement. Refresh and try again.");
  }
  await auditMutation(sql, actorUser, organizationId, "farm.movement_created", "farm_movements", movement.id, {
    animal_id: animalId,
    direction,
    from_location_id: fromLocationId,
    to_location_id: toLocationId,
    count,
  }, requestIp(c));
  return c.json({ movement }, 201);
});

operations.get("/movements/:id", requireRole(...STAFF_ROLES), async (c) => {
  const id = uuid(c.req.param("id"));
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, actor(c));
  const rows = await sql`
    SELECT m.*, a.tag_number, a.name AS animal_name,
      fl.name AS from_location_name, tl.name AS to_location_name
    FROM farm_movements m
    JOIN farm_animals a ON a.id = m.animal_id AND a.organization_id = m.organization_id
    LEFT JOIN farm_locations fl ON fl.id = m.from_location_id AND fl.organization_id = m.organization_id
    LEFT JOIN farm_locations tl ON tl.id = m.to_location_id AND tl.organization_id = m.organization_id
    WHERE m.id = ${id} AND m.organization_id = ${organizationId}
    LIMIT 1
  `;
  if (!rows[0]) fail(404, "MOVEMENT_NOT_FOUND", "Movement was not found in this farm.");
  return c.json({ movement: rows[0] });
});

operations.delete("/movements/:id", requireRole("farm_admin"), async (c) => {
  const id = uuid(c.req.param("id"));
  const sql = getDb(c.env);
  const actorUser = actor(c);
  const organizationId = await organizationForUser(sql, actorUser);
  const rows = await sql`
    DELETE FROM farm_movements
    WHERE id = ${id} AND organization_id = ${organizationId}
    RETURNING id, animal_id, direction, count
  `;
  const movement = rows[0] as { id: string; animal_id: string; direction: string; count: number } | undefined;
  if (!movement) fail(404, "MOVEMENT_NOT_FOUND", "Movement was not found in this farm.");
  await auditMutation(sql, actorUser, organizationId, "farm.movement_deleted", "farm_movements", id, {
    animal_id: movement.animal_id,
    direction: movement.direction,
    count: movement.count,
  }, requestIp(c));
  return c.json({ ok: true });
});

// Egg counts
operations.get("/eggs/summary", requireRole(...STAFF_ROLES), async (c) => {
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, actor(c));
  const locationId = c.req.query("location_id") ? uuid(c.req.query("location_id")!, "location_id") : null;
  const animalTypeId = c.req.query("animal_type_id") ? uuid(c.req.query("animal_type_id")!, "animal_type_id") : null;
  const from = dateValue(c.req.query("from"), "from");
  const to = dateValue(c.req.query("to"), "to");
  checkDateRange(from, to);
  const totals = await sql`
    SELECT COALESCE(SUM(eggs_collected), 0)::int AS total_collected,
      COALESCE(SUM(eggs_good), 0)::int AS total_good,
      COALESCE(SUM(eggs_broken), 0)::int AS total_broken
    FROM farm_egg_records
    WHERE organization_id = ${organizationId}
      AND (${locationId}::uuid IS NULL OR location_id = ${locationId})
      AND (${animalTypeId}::uuid IS NULL OR animal_type_id = ${animalTypeId})
      AND (${from}::date IS NULL OR record_date >= ${from})
      AND (${to}::date IS NULL OR record_date <= ${to})
  `;
  const byLocation = await sql`
    SELECT e.location_id, l.name AS location_name,
      COALESCE(SUM(e.eggs_collected), 0)::int AS total_collected,
      COALESCE(SUM(e.eggs_good), 0)::int AS total_good,
      COALESCE(SUM(e.eggs_broken), 0)::int AS total_broken
    FROM farm_egg_records e
    JOIN farm_locations l ON l.id = e.location_id AND l.organization_id = e.organization_id
    WHERE e.organization_id = ${organizationId}
      AND (${locationId}::uuid IS NULL OR e.location_id = ${locationId})
      AND (${animalTypeId}::uuid IS NULL OR e.animal_type_id = ${animalTypeId})
      AND (${from}::date IS NULL OR e.record_date >= ${from})
      AND (${to}::date IS NULL OR e.record_date <= ${to})
    GROUP BY e.location_id, l.name
    ORDER BY total_collected DESC, l.name
  `;
  const byDate = await sql`
    SELECT record_date, COALESCE(SUM(eggs_collected), 0)::int AS total_collected,
      COALESCE(SUM(eggs_good), 0)::int AS total_good,
      COALESCE(SUM(eggs_broken), 0)::int AS total_broken
    FROM farm_egg_records
    WHERE organization_id = ${organizationId}
      AND (${locationId}::uuid IS NULL OR location_id = ${locationId})
      AND (${animalTypeId}::uuid IS NULL OR animal_type_id = ${animalTypeId})
      AND (${from}::date IS NULL OR record_date >= ${from})
      AND (${to}::date IS NULL OR record_date <= ${to})
    GROUP BY record_date
    ORDER BY record_date
  `;
  const total = totals[0] as { total_collected?: number; total_good?: number; total_broken?: number } | undefined;
  const collected = Number(total?.total_collected || 0);
  const broken = Number(total?.total_broken || 0);
  return c.json({
    total_collected: collected,
    total_good: Number(total?.total_good || 0),
    total_broken: broken,
    broken_rate: collected ? Number(((broken / collected) * 100).toFixed(2)) : 0,
    by_location: byLocation,
    by_date: byDate,
  });
});

operations.get("/eggs", requireRole(...STAFF_ROLES), async (c) => {
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, actor(c));
  const locationId = c.req.query("location_id") ? uuid(c.req.query("location_id")!, "location_id") : null;
  const animalTypeId = c.req.query("animal_type_id") ? uuid(c.req.query("animal_type_id")!, "animal_type_id") : null;
  const from = dateValue(c.req.query("from"), "from");
  const to = dateValue(c.req.query("to"), "to");
  checkDateRange(from, to);
  const rows = await sql`
    SELECT e.id, e.organization_id, e.location_id, e.animal_type_id, e.record_date,
      e.shift, e.eggs_collected, e.eggs_broken, e.eggs_good, e.notes, e.recorded_by,
      e.created_at, l.name AS location_name, t.name AS animal_type_name, u.name AS recorded_by_name
    FROM farm_egg_records e
    JOIN farm_locations l ON l.id = e.location_id AND l.organization_id = e.organization_id
    LEFT JOIN farm_animal_types t ON t.id = e.animal_type_id AND t.organization_id = e.organization_id
    LEFT JOIN users u ON u.id = e.recorded_by
    WHERE e.organization_id = ${organizationId}
      AND (${locationId}::uuid IS NULL OR e.location_id = ${locationId})
      AND (${animalTypeId}::uuid IS NULL OR e.animal_type_id = ${animalTypeId})
      AND (${from}::date IS NULL OR e.record_date >= ${from})
      AND (${to}::date IS NULL OR e.record_date <= ${to})
    ORDER BY e.record_date DESC,
      CASE e.shift WHEN 'Morning' THEN 1 WHEN 'Afternoon' THEN 2 ELSE 3 END,
      l.name
    LIMIT 500
  `;
  return c.json({ eggs: rows });
});

operations.post("/eggs", requireRole(...STAFF_ROLES), async (c) => {
  const body = await readJson(c);
  const locationId = uuid(requiredText(body, "location_id", 36), "location_id");
  const animalTypeId = optionalUuid(body, "animal_type_id") ?? null;
  const recordDate = dateValue(body.record_date, "record_date", true)!;
  const shift = normalizedShift(body.shift);
  const eggsCollected = requiredInteger(body, "eggs_collected", 0);
  const eggsBroken = requiredInteger(body, "eggs_broken", 0);
  if (eggsBroken > eggsCollected) {
    fail(400, "VALIDATION_ERROR", "eggs_broken cannot be greater than eggs_collected.");
  }
  const notes = optionalText(body, "notes", 1000) ?? null;
  const sql = getDb(c.env);
  const actorUser = actor(c);
  const organizationId = await organizationForUser(sql, actorUser);
  await activeLocation(sql, organizationId, locationId);
  if (animalTypeId) {
    const types = await sql`
      SELECT id FROM farm_animal_types
      WHERE id = ${animalTypeId} AND organization_id = ${organizationId} AND active IS TRUE
      LIMIT 1
    `;
    if (!types[0]) fail(400, "ANIMAL_TYPE_NOT_FOUND", "Animal type is not active in this farm.");
  }
  if (actorUser.role === "farm_worker") {
    const worker = await actorWorker(sql, organizationId, actorUser);
    if (!worker.location_id || worker.location_id !== locationId) {
      fail(403, "FARM_LOCATION_FORBIDDEN", "Farm workers can record eggs only at their assigned active location.");
    }
  }
  try {
    const rows = await sql`
      INSERT INTO farm_egg_records
        (organization_id, location_id, animal_type_id, record_date, shift,
         eggs_collected, eggs_broken, eggs_good, notes, recorded_by)
      VALUES
        (${organizationId}, ${locationId}, ${animalTypeId}, ${recordDate}, ${shift},
         ${eggsCollected}, ${eggsBroken}, ${eggsCollected - eggsBroken}, ${notes}, ${actorUser.id})
      ON CONFLICT (organization_id, location_id, record_date, shift)
      DO UPDATE SET animal_type_id = EXCLUDED.animal_type_id,
        eggs_collected = EXCLUDED.eggs_collected,
        eggs_broken = EXCLUDED.eggs_broken,
        eggs_good = EXCLUDED.eggs_good,
        notes = EXCLUDED.notes,
        recorded_by = EXCLUDED.recorded_by
      RETURNING *
    `;
    const egg = rows[0] as { id: string; eggs_good: number } | undefined;
    if (!egg) fail(500, "EGG_RECORD_FAILED", "Egg record could not be saved.");
    await auditMutation(sql, actorUser, organizationId, "farm.egg_record_upserted", "farm_egg_records", egg.id, {
      location_id: locationId,
      record_date: recordDate,
      shift,
      eggs_collected: eggsCollected,
      eggs_broken: eggsBroken,
      eggs_good: eggsCollected - eggsBroken,
    }, requestIp(c));
    return c.json({ egg, eggs_good: eggsCollected - eggsBroken }, 201);
  } catch (error) {
    if (isUniqueViolation(error)) {
      fail(409, "EGG_RECORD_CONFLICT", "An egg record already exists for this location, date, and shift.");
    }
    throw error;
  }
});

operations.patch("/eggs/:id", requireRole(...ADMIN_MANAGER_ROLES), async (c) => {
  const id = uuid(c.req.param("id"));
  const body = await readJson(c);
  const sql = getDb(c.env);
  const actorUser = actor(c);
  const organizationId = await organizationForUser(sql, actorUser);
  const locationId = optionalUuid(body, "location_id");
  const animalTypeId = optionalUuid(body, "animal_type_id");
  const recordDate = dateValue(body.record_date, "record_date");
  const shift = body.shift === undefined ? undefined : normalizedShift(body.shift);
  const eggsCollected = body.eggs_collected === undefined ? undefined : requiredInteger(body, "eggs_collected", 0);
  const eggsBroken = body.eggs_broken === undefined ? undefined : requiredInteger(body, "eggs_broken", 0);
  const notes = optionalText(body, "notes", 1000);
  if ([locationId, animalTypeId, recordDate, shift, eggsCollected, eggsBroken, notes].every((value) => value === undefined)) {
    fail(400, "VALIDATION_ERROR", "Provide at least one egg record field to update.");
  }
  const existingRows = await sql`
    SELECT location_id, animal_type_id, record_date, shift, eggs_collected, eggs_broken
    FROM farm_egg_records
    WHERE id = ${id} AND organization_id = ${organizationId}
    LIMIT 1
  `;
  const existing = existingRows[0] as {
    location_id: string; animal_type_id: string | null; record_date: string; shift: string;
    eggs_collected: number; eggs_broken: number;
  } | undefined;
  if (!existing) fail(404, "EGG_RECORD_NOT_FOUND", "Egg record was not found in this farm.");
  const nextLocationId = locationId === undefined ? existing.location_id : locationId;
  const nextAnimalTypeId = animalTypeId === undefined ? existing.animal_type_id : animalTypeId;
  const nextRecordDate = recordDate ?? existing.record_date;
  const nextShift = shift ?? existing.shift;
  const nextCollected = eggsCollected ?? Number(existing.eggs_collected);
  const nextBroken = eggsBroken ?? Number(existing.eggs_broken);
  if (nextBroken > nextCollected) {
    fail(400, "VALIDATION_ERROR", "eggs_broken cannot be greater than eggs_collected.");
  }
  await activeLocation(sql, organizationId, nextLocationId);
  if (nextAnimalTypeId) {
    const types = await sql`
      SELECT id FROM farm_animal_types
      WHERE id = ${nextAnimalTypeId} AND organization_id = ${organizationId} AND active IS TRUE
      LIMIT 1
    `;
    if (!types[0]) fail(400, "ANIMAL_TYPE_NOT_FOUND", "Animal type is not active in this farm.");
  }
  const rows = await sql`
    UPDATE farm_egg_records SET
      location_id = ${nextLocationId},
      animal_type_id = ${nextAnimalTypeId},
      record_date = ${nextRecordDate},
      shift = ${nextShift},
      eggs_collected = ${nextCollected},
      eggs_broken = ${nextBroken},
      eggs_good = ${nextCollected - nextBroken},
      notes = CASE WHEN ${notes !== undefined} THEN ${notes ?? null} ELSE notes END
    WHERE id = ${id} AND organization_id = ${organizationId}
    RETURNING *
  `;
  const egg = rows[0] as { id: string } | undefined;
  if (!egg) fail(404, "EGG_RECORD_NOT_FOUND", "Egg record was not found in this farm.");
  await auditMutation(sql, actorUser, organizationId, "farm.egg_record_updated", "farm_egg_records", id, {
    fields: Object.keys(body),
  }, requestIp(c));
  return c.json({ egg });
});

operations.delete("/eggs/:id", requireRole("farm_admin"), async (c) => {
  const id = uuid(c.req.param("id"));
  const sql = getDb(c.env);
  const actorUser = actor(c);
  const organizationId = await organizationForUser(sql, actorUser);
  const rows = await sql`
    DELETE FROM farm_egg_records
    WHERE id = ${id} AND organization_id = ${organizationId}
    RETURNING id, location_id, record_date, shift, eggs_collected, eggs_broken
  `;
  const egg = rows[0] as Record<string, unknown> | undefined;
  if (!egg) fail(404, "EGG_RECORD_NOT_FOUND", "Egg record was not found in this farm.");
  await auditMutation(sql, actorUser, organizationId, "farm.egg_record_deleted", "farm_egg_records", id, egg, requestIp(c));
  return c.json({ ok: true });
});

// Attendance
operations.get("/attendance", requireRole(...STAFF_ROLES), async (c) => {
  const sql = getDb(c.env);
  const actorUser = actor(c);
  const organizationId = await organizationForUser(sql, actorUser);
  const date = dateValue(c.req.query("date"), "date");
  const from = dateValue(c.req.query("from"), "from");
  const to = dateValue(c.req.query("to"), "to");
  checkDateRange(from, to);
  let workerId = c.req.query("worker_id") ? uuid(c.req.query("worker_id")!, "worker_id") : null;
  if (actorUser.role === "farm_worker") {
    const ownWorker = await actorWorker(sql, organizationId, actorUser);
    if (workerId && workerId !== ownWorker.id) {
      fail(403, "FARM_ATTENDANCE_FORBIDDEN", "Farm workers can view only their own attendance.");
    }
    workerId = ownWorker.id;
  } else if (workerId) {
    await workerInOrganization(sql, organizationId, workerId, false);
  }
  const rows = await sql`
    SELECT a.id, a.organization_id, a.worker_id, a.attendance_date,
      a.check_in, a.check_out, a.hours_worked, a.status,
      a.face_match_score, a.notes, a.recorded_by, a.created_at,
      w.employee_code, w.location_id, u.name AS worker_name,
      l.name AS location_name
    FROM farm_attendance a
    JOIN farm_workers w ON w.id = a.worker_id AND w.organization_id = a.organization_id
    JOIN users u ON u.id = w.user_id
    LEFT JOIN farm_locations l ON l.id = w.location_id AND l.organization_id = w.organization_id
    WHERE a.organization_id = ${organizationId}
      AND (${workerId}::uuid IS NULL OR a.worker_id = ${workerId})
      AND (${date}::date IS NULL OR a.attendance_date = ${date})
      AND (${from}::date IS NULL OR a.attendance_date >= ${from})
      AND (${to}::date IS NULL OR a.attendance_date <= ${to})
    ORDER BY a.attendance_date DESC, u.name
    LIMIT 500
  `;
  return c.json({ attendance: rows });
});

operations.get("/attendance/summary", requireRole(...STAFF_ROLES), async (c) => {
  const sql = getDb(c.env);
  const actorUser = actor(c);
  const organizationId = await organizationForUser(sql, actorUser);
  const today = await localToday(sql, organizationId);
  const from = dateValue(c.req.query("from"), "from") ?? monthStart(today);
  const to = dateValue(c.req.query("to"), "to") ?? today;
  checkDateRange(from, to);
  let workerId: string | null = null;
  if (actorUser.role === "farm_worker") {
    workerId = (await actorWorker(sql, organizationId, actorUser)).id;
  }
  const totals = await sql`
    SELECT COUNT(*) FILTER (WHERE status = 'present')::int AS total_present,
      COUNT(*) FILTER (WHERE status = 'absent')::int AS total_absent,
      COUNT(*) FILTER (WHERE status = 'late')::int AS total_late,
      COALESCE(SUM(hours_worked), 0)::numeric AS total_hours
    FROM farm_attendance
    WHERE organization_id = ${organizationId}
      AND attendance_date BETWEEN ${from}::date AND ${to}::date
      AND (${workerId}::uuid IS NULL OR worker_id = ${workerId})
  `;
  const byWorker = await sql`
    SELECT w.id AS worker_id, u.name AS worker_name, w.employee_code,
      COUNT(a.id) FILTER (WHERE a.status = 'present')::int AS present_days,
      COUNT(a.id) FILTER (WHERE a.status = 'absent')::int AS absent_days,
      COUNT(a.id) FILTER (WHERE a.status = 'late')::int AS late_days,
      COALESCE(SUM(a.hours_worked), 0)::numeric AS hours_worked
    FROM farm_workers w
    JOIN users u ON u.id = w.user_id
    LEFT JOIN farm_attendance a ON a.worker_id = w.id
      AND a.organization_id = w.organization_id
      AND a.attendance_date BETWEEN ${from}::date AND ${to}::date
    WHERE w.organization_id = ${organizationId}
      AND (${workerId}::uuid IS NULL OR w.id = ${workerId})
      AND (w.active IS TRUE OR a.id IS NOT NULL)
    GROUP BY w.id, u.name, w.employee_code
    ORDER BY u.name
  `;
  const byDate = await sql`
    SELECT attendance_date,
      COUNT(*) FILTER (WHERE status = 'present')::int AS present,
      COUNT(*) FILTER (WHERE status = 'absent')::int AS absent,
      COUNT(*) FILTER (WHERE status = 'late')::int AS late
    FROM farm_attendance
    WHERE organization_id = ${organizationId}
      AND attendance_date BETWEEN ${from}::date AND ${to}::date
      AND (${workerId}::uuid IS NULL OR worker_id = ${workerId})
    GROUP BY attendance_date
    ORDER BY attendance_date
  `;
  const total = totals[0] as {
    total_present?: number; total_absent?: number; total_late?: number; total_hours?: number;
  } | undefined;
  return c.json({
    from,
    to,
    total_present: Number(total?.total_present || 0),
    total_absent: Number(total?.total_absent || 0),
    total_late: Number(total?.total_late || 0),
    total_hours: Number(total?.total_hours || 0),
    by_worker: byWorker,
    by_date: byDate,
  });
});

operations.post("/attendance/check-in", requireRole("farm_worker", "farm_manager"), async (c) => {
  const body = await readJson(c);
  const facePhoto = (() => {
    try {
      return faceImage(body);
    } catch {
      return null;
    }
  })();
  if (!facePhoto) return faceNotRecognized(c, null);
  let faceHash: string;
  try {
    faceHash = computeFarmFaceHash(facePhoto);
  } catch {
    return faceNotRecognized(c, null);
  }
  const sql = getDb(c.env);
  const actorUser = actor(c);
  const organizationId = await organizationForUser(sql, actorUser);
  const requestedWorkerId = optionalUuid(body, "worker_id");
  let worker: WorkerRow;
  if (actorUser.role === "farm_worker") {
    worker = await actorWorker(sql, organizationId, actorUser);
    if (requestedWorkerId && requestedWorkerId !== worker.id) {
      fail(403, "FARM_ATTENDANCE_FORBIDDEN", "Farm workers can check in only for themselves.");
    }
  } else {
    if (!requestedWorkerId) fail(400, "VALIDATION_ERROR", "worker_id is required for manager check-in.");
    worker = await workerInOrganization(sql, organizationId, requestedWorkerId);
  }
  if (!worker.face_hash) return faceNotRecognized(c, null);
  const distance = hammingDistance(faceHash, worker.face_hash);
  if (distance > FACE_MATCH_THRESHOLD) return faceNotRecognized(c, distance);
  const attendanceDate = await localToday(sql, organizationId);
  const rows = await sql`
    INSERT INTO farm_attendance
      (organization_id, worker_id, attendance_date, check_in, status,
       face_match_score, recorded_by)
    VALUES
      (${organizationId}, ${worker.id}, ${attendanceDate}, NOW(), 'present',
       ${64 - distance}, ${actorUser.id})
    ON CONFLICT (organization_id, worker_id, attendance_date)
    DO UPDATE SET
      check_in = COALESCE(farm_attendance.check_in, EXCLUDED.check_in),
      status = CASE WHEN farm_attendance.status = 'absent' THEN 'present' ELSE farm_attendance.status END,
      face_match_score = COALESCE(farm_attendance.face_match_score, EXCLUDED.face_match_score),
      recorded_by = CASE WHEN farm_attendance.check_in IS NULL THEN EXCLUDED.recorded_by ELSE farm_attendance.recorded_by END
    RETURNING id, worker_id, attendance_date, check_in, check_out, hours_worked, status, face_match_score
  `;
  const entry = rows[0] as { id: string; check_in: string } | undefined;
  if (!entry) fail(500, "ATTENDANCE_CHECK_IN_FAILED", "Attendance could not be recorded.");
  await auditMutation(sql, actorUser, organizationId, "farm.attendance_check_in", "farm_attendance", entry.id, {
    worker_id: worker.id,
    attendance_date: attendanceDate,
    hamming_distance: distance,
    face_match_score: 64 - distance,
  }, requestIp(c));
  return c.json({ attendance: entry, score: distance }, 201);
});

operations.post("/attendance/check-out", requireRole("farm_worker", "farm_manager"), async (c) => {
  const body = await readJson(c);
  const sql = getDb(c.env);
  const actorUser = actor(c);
  const organizationId = await organizationForUser(sql, actorUser);
  const requestedWorkerId = optionalUuid(body, "worker_id");
  let worker: WorkerRow;
  if (actorUser.role === "farm_worker") {
    worker = await actorWorker(sql, organizationId, actorUser);
    if (requestedWorkerId && requestedWorkerId !== worker.id) {
      fail(403, "FARM_ATTENDANCE_FORBIDDEN", "Farm workers can check out only for themselves.");
    }
  } else {
    if (!requestedWorkerId) fail(400, "VALIDATION_ERROR", "worker_id is required for manager check-out.");
    worker = await workerInOrganization(sql, organizationId, requestedWorkerId);
  }
  const attendanceDate = await localToday(sql, organizationId);
  const rows = await sql`
    UPDATE farm_attendance
    SET check_out = COALESCE(check_out, NOW()),
      hours_worked = CASE
        WHEN check_in IS NULL THEN hours_worked
        ELSE ROUND((EXTRACT(EPOCH FROM (COALESCE(check_out, NOW()) - check_in)) / 3600)::numeric, 2)
      END
    WHERE organization_id = ${organizationId}
      AND worker_id = ${worker.id}
      AND attendance_date = ${attendanceDate}
      AND check_in IS NOT NULL
    RETURNING id, worker_id, attendance_date, check_in, check_out, hours_worked, status
  `;
  const entry = rows[0] as {
    id: string; check_in: string; check_out: string; hours_worked: number | null;
  } | undefined;
  if (!entry) {
    const existing = await sql`
      SELECT check_in, check_out FROM farm_attendance
      WHERE organization_id = ${organizationId}
        AND worker_id = ${worker.id} AND attendance_date = ${attendanceDate}
      LIMIT 1
    `;
    if (!existing[0]) fail(404, "ATTENDANCE_NOT_FOUND", "There is no check-in to close for today.");
    fail(409, "ATTENDANCE_CHECK_IN_REQUIRED", "Check in before checking out.");
  }
  await auditMutation(sql, actorUser, organizationId, "farm.attendance_check_out", "farm_attendance", entry.id, {
    worker_id: worker.id,
    attendance_date: attendanceDate,
    hours_worked: entry.hours_worked,
  }, requestIp(c));
  return c.json({ attendance: entry });
});

operations.post("/attendance/enroll-face", requireRole("farm_admin"), async (c) => {
  const body = await readJson(c);
  const workerId = uuid(requiredText(body, "worker_id", 36), "worker_id");
  const photo = faceImage(body);
  let faceHash: string;
  try {
    faceHash = computeFarmFaceHash(photo);
  } catch {
    fail(400, "FACE_IMAGE_INVALID", "The face image is invalid or could not be decoded.");
  }
  const sql = getDb(c.env);
  const actorUser = actor(c);
  const organizationId = await organizationForUser(sql, actorUser);
  const worker = await workerInOrganization(sql, organizationId, workerId);
  const rows = await sql`
    UPDATE farm_workers SET face_hash = ${faceHash}, updated_at = NOW()
    WHERE id = ${worker.id} AND organization_id = ${organizationId} AND active IS TRUE
    RETURNING id
  `;
  if (!rows[0]) fail(404, "WORKER_NOT_FOUND", "Active worker was not found in this farm.");
  await auditMutation(sql, actorUser, organizationId, "farm.worker_face_enrolled", "farm_workers", worker.id, {
    face_enrolled: true,
  }, requestIp(c));
  return c.json({ worker: { id: worker.id, face_enrolled: true } });
});

operations.post("/attendance/manual", requireRole(...ADMIN_MANAGER_ROLES), async (c) => {
  const body = await readJson(c);
  const workerId = uuid(requiredText(body, "worker_id", 36), "worker_id");
  const attendanceDate = dateValue(body.attendance_date, "attendance_date", true)!;
  const status = requiredText(body, "status", 20).toLowerCase();
  if (!["present", "absent", "late"].includes(status)) {
    fail(400, "VALIDATION_ERROR", "status must be present, absent, or late.");
  }
  const checkIn = timestampValue(body.check_in, "check_in");
  const checkOut = timestampValue(body.check_out, "check_out");
  if (status === "absent" && (checkIn || checkOut)) {
    fail(400, "VALIDATION_ERROR", "Absent attendance cannot include check-in or check-out times.");
  }
  if (status !== "absent" && !checkIn) {
    fail(400, "VALIDATION_ERROR", "Present or late attendance requires a check-in time.");
  }
  if (checkOut && !checkIn) {
    fail(400, "VALIDATION_ERROR", "A check-out time requires a check-in time.");
  }
  if (checkIn && checkOut && Date.parse(checkOut) < Date.parse(checkIn)) {
    fail(400, "VALIDATION_ERROR", "check_out must be on or after check_in.");
  }
  const notes = optionalText(body, "notes", 1000) ?? null;
  const sql = getDb(c.env);
  const actorUser = actor(c);
  const organizationId = await organizationForUser(sql, actorUser);
  await workerInOrganization(sql, organizationId, workerId, false);
  const rows = await sql`
    INSERT INTO farm_attendance
      (organization_id, worker_id, attendance_date, check_in, check_out, hours_worked,
       status, face_match_score, notes, recorded_by)
    VALUES
      (${organizationId}, ${workerId}, ${attendanceDate}, ${checkIn}::timestamptz,
       ${checkOut}::timestamptz,
       CASE WHEN ${checkIn}::timestamptz IS NOT NULL AND ${checkOut}::timestamptz IS NOT NULL
         THEN ROUND((EXTRACT(EPOCH FROM (${checkOut}::timestamptz - ${checkIn}::timestamptz)) / 3600)::numeric, 2)
         ELSE NULL END,
        ${status}, NULL, ${notes}, ${actorUser.id})
    ON CONFLICT (organization_id, worker_id, attendance_date)
    DO UPDATE SET check_in = EXCLUDED.check_in,
      check_out = EXCLUDED.check_out,
      hours_worked = EXCLUDED.hours_worked,
      status = EXCLUDED.status,
      face_match_score = NULL,
      notes = EXCLUDED.notes,
      recorded_by = EXCLUDED.recorded_by
    RETURNING id, worker_id, attendance_date, check_in, check_out, hours_worked, status, notes
  `;
  const entry = rows[0] as { id: string } | undefined;
  if (!entry) fail(500, "ATTENDANCE_MANUAL_FAILED", "Manual attendance could not be saved.");
  await auditMutation(sql, actorUser, organizationId, "farm.attendance_manual", "farm_attendance", entry.id, {
    worker_id: workerId,
    attendance_date: attendanceDate,
    status,
    has_check_in: Boolean(checkIn),
    has_check_out: Boolean(checkOut),
  }, requestIp(c));
  return c.json({ attendance: entry }, 201);
});

operations.patch("/attendance/:id", requireRole(...ADMIN_MANAGER_ROLES), async (c) => {
  const attendanceId = uuid(c.req.param("id"), "id");
  const body = await readJson(c);
  const sql = getDb(c.env);
  const actorUser = actor(c);
  const organizationId = await organizationForUser(sql, actorUser);
  const existingRows = await sql`
    SELECT id, worker_id, attendance_date, check_in, check_out, status, notes
    FROM farm_attendance
    WHERE id = ${attendanceId} AND organization_id = ${organizationId}
    LIMIT 1
  `;
  const existing = existingRows[0] as {
    id: string;
    worker_id: string;
    attendance_date: string | Date;
    check_in: string | Date | null;
    check_out: string | Date | null;
    status: string;
    notes: string | null;
  } | undefined;
  if (!existing) fail(404, "ATTENDANCE_NOT_FOUND", "Attendance record was not found in this farm.");

  const suppliedWorkerId = optionalUuid(body, "worker_id");
  const workerId = suppliedWorkerId === undefined ? existing.worker_id : suppliedWorkerId;
  if (!workerId) fail(400, "VALIDATION_ERROR", "worker_id cannot be empty.");
  await workerInOrganization(sql, organizationId, workerId, false);
  const existingDate = existing.attendance_date instanceof Date
    ? existing.attendance_date.toISOString().slice(0, 10)
    : String(existing.attendance_date).slice(0, 10);
  const attendanceDate = body.attendance_date === undefined
    ? existingDate
    : dateValue(body.attendance_date, "attendance_date", true)!;
  const status = body.status === undefined ? existing.status : optionalText(body, "status", 20);
  if (!status || !["present", "absent", "late"].includes(status)) {
    fail(400, "VALIDATION_ERROR", "status must be present, absent, or late.");
  }
  const previousCheckIn = existing.check_in == null ? null : new Date(existing.check_in).toISOString();
  const previousCheckOut = existing.check_out == null ? null : new Date(existing.check_out).toISOString();
  let checkIn = body.check_in === undefined ? previousCheckIn : timestampValue(body.check_in, "check_in");
  let checkOut = body.check_out === undefined ? previousCheckOut : timestampValue(body.check_out, "check_out");
  if (status === "absent") {
    checkIn = null;
    checkOut = null;
  }
  if (status !== "absent" && !checkIn) {
    fail(400, "VALIDATION_ERROR", "Present or late attendance requires a check-in time.");
  }
  if (checkOut && !checkIn) {
    fail(400, "VALIDATION_ERROR", "A check-out time requires a check-in time.");
  }
  if (checkIn && checkOut && Date.parse(checkOut) < Date.parse(checkIn)) {
    fail(400, "VALIDATION_ERROR", "check_out must be on or after check_in.");
  }
  const notes = optionalText(body, "notes", 1000);
  if (!["worker_id", "attendance_date", "status", "check_in", "check_out", "notes"]
    .some((key) => key in body)) {
    fail(400, "VALIDATION_ERROR", "Provide at least one attendance field to update.");
  }

  let rows: unknown[];
  try {
    rows = await sql`
      UPDATE farm_attendance
      SET worker_id = ${workerId},
        attendance_date = ${attendanceDate}::date,
        check_in = ${checkIn}::timestamptz,
        check_out = ${checkOut}::timestamptz,
        hours_worked = CASE
          WHEN ${checkIn}::timestamptz IS NOT NULL AND ${checkOut}::timestamptz IS NOT NULL
          THEN ROUND((EXTRACT(EPOCH FROM (${checkOut}::timestamptz - ${checkIn}::timestamptz)) / 3600)::numeric, 2)
          ELSE NULL
        END,
        status = ${status},
        face_match_score = NULL,
        notes = CASE WHEN ${notes !== undefined} THEN ${notes ?? null} ELSE notes END,
        recorded_by = ${actorUser.id}
      WHERE id = ${attendanceId} AND organization_id = ${organizationId}
      RETURNING id, worker_id, attendance_date, check_in, check_out, hours_worked, status, notes
    `;
  } catch (error) {
    if (isUniqueViolation(error)) {
      fail(409, "ATTENDANCE_ALREADY_EXISTS", "This worker already has an attendance record for that date.");
    }
    throw error;
  }
  const entry = rows[0] as { id: string } | undefined;
  if (!entry) fail(404, "ATTENDANCE_NOT_FOUND", "Attendance record was not found in this farm.");
  await auditMutation(sql, actorUser, organizationId, "farm.attendance_updated", "farm_attendance", entry.id, {
    worker_id: workerId,
    attendance_date: attendanceDate,
    status,
  }, requestIp(c));
  return c.json({ attendance: entry });
});

operations.get("/workers/me", requireRole(...STAFF_ROLES), async (c) => {
  const sql = getDb(c.env);
  const actorUser = actor(c);
  const organizationId = await organizationForUser(sql, actorUser);
  const rows = await sql`
    SELECT w.id, w.organization_id, w.location_id, w.role, w.employee_code,
      w.active, w.wage_type, w.wage_rate, (w.face_hash IS NOT NULL) AS face_enrolled,
      u.name, u.email, l.name AS location_name, o.name AS organization_name
    FROM farm_workers w
    JOIN users u ON u.id = w.user_id
    JOIN farm_organizations o ON o.id = w.organization_id
    LEFT JOIN farm_locations l ON l.id = w.location_id AND l.organization_id = w.organization_id
    WHERE w.user_id = ${actorUser.id}
      AND w.organization_id = ${organizationId}
      AND w.active IS TRUE
    LIMIT 1
  `;
  if (!rows[0]) fail(404, "WORKER_NOT_FOUND", "No active worker record is linked to this account.");
  return c.json({ worker: rows[0] });
});

// Animal health history
operations.get("/health", requireRole(...STAFF_ROLES), async (c) => {
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, actor(c));
  const animalId = c.req.query("animal_id") ? uuid(c.req.query("animal_id")!, "animal_id") : null;
  const from = dateValue(c.req.query("from"), "from");
  const to = dateValue(c.req.query("to"), "to");
  checkDateRange(from, to);
  const rows = await sql`
    SELECT h.id, h.organization_id, h.animal_id, h.log_date, h.log_type,
      h.description, h.treatment, h.vet_name, h.cost, h.next_due_date,
      h.recorded_by, h.created_at, a.tag_number, a.name AS animal_name,
      a.health_status, u.name AS recorded_by_name
    FROM farm_health_logs h
    JOIN farm_animals a ON a.id = h.animal_id AND a.organization_id = h.organization_id
    LEFT JOIN users u ON u.id = h.recorded_by
    WHERE h.organization_id = ${organizationId}
      AND (${animalId}::uuid IS NULL OR h.animal_id = ${animalId})
      AND (${from}::date IS NULL OR h.log_date >= ${from})
      AND (${to}::date IS NULL OR h.log_date <= ${to})
    ORDER BY h.log_date DESC, h.created_at DESC
    LIMIT 500
  `;
  return c.json({ health_logs: rows });
});

operations.post("/health", requireRole(...ADMIN_MANAGER_ROLES), async (c) => {
  const body = await readJson(c);
  const animalId = uuid(requiredText(body, "animal_id", 36), "animal_id");
  const logDate = dateValue(body.log_date, "log_date", true)!;
  const logType = normalizedHealthType(body.log_type);
  const description = optionalText(body, "description", 2000) ?? null;
  const treatment = optionalText(body, "treatment", 1000) ?? null;
  const vetName = optionalText(body, "vet_name", 200) ?? null;
  const cost = optionalMoney(body, "cost") ?? null;
  const nextDueDate = dateValue(body.next_due_date, "next_due_date");
  const sql = getDb(c.env);
  const actorUser = actor(c);
  const organizationId = await organizationForUser(sql, actorUser);
  const animals = await sql`
    SELECT id FROM farm_animals
    WHERE id = ${animalId} AND organization_id = ${organizationId} AND status <> 'deleted'
    LIMIT 1
  `;
  if (!animals[0]) fail(404, "ANIMAL_NOT_FOUND", "Active animal record was not found in this farm.");
  const rows = await sql`
    INSERT INTO farm_health_logs
      (organization_id, animal_id, log_date, log_type, description, treatment,
       vet_name, cost, next_due_date, recorded_by)
    VALUES
      (${organizationId}, ${animalId}, ${logDate}, ${logType}, ${description},
       ${treatment}, ${vetName}, ${cost}, ${nextDueDate}, ${actorUser.id})
    RETURNING *
  `;
  const healthLog = rows[0] as { id: string } | undefined;
  if (!healthLog) fail(500, "HEALTH_LOG_CREATE_FAILED", "Health log could not be saved.");
  await resolveHealthStatus(sql, organizationId, animalId);
  await auditMutation(sql, actorUser, organizationId, "farm.health_log_created", "farm_health_logs", healthLog.id, {
    animal_id: animalId,
    log_type: logType,
    log_date: logDate,
  }, requestIp(c));
  return c.json({ health_log: healthLog }, 201);
});

operations.patch("/health/:id", requireRole(...ADMIN_MANAGER_ROLES), async (c) => {
  const id = uuid(c.req.param("id"));
  const body = await readJson(c);
  const sql = getDb(c.env);
  const actorUser = actor(c);
  const organizationId = await organizationForUser(sql, actorUser);
  const existingRows = await sql`
    SELECT animal_id, log_date, log_type
    FROM farm_health_logs
    WHERE id = ${id} AND organization_id = ${organizationId}
    LIMIT 1
  `;
  const existing = existingRows[0] as { animal_id: string; log_date: string; log_type: string } | undefined;
  if (!existing) fail(404, "HEALTH_LOG_NOT_FOUND", "Health log was not found in this farm.");
  const animalId = optionalUuid(body, "animal_id") ?? existing.animal_id;
  const logDate = dateValue(body.log_date, "log_date") ?? existing.log_date;
  const logType = body.log_type === undefined ? existing.log_type : normalizedHealthType(body.log_type);
  const description = optionalText(body, "description", 2000);
  const treatment = optionalText(body, "treatment", 1000);
  const vetName = optionalText(body, "vet_name", 200);
  const cost = optionalMoney(body, "cost");
  const nextDueDateProvided = "next_due_date" in body;
  const nextDueDate = dateValue(body.next_due_date, "next_due_date");
  if (!Object.keys(body).some((key) => key !== "organization_id")) {
    fail(400, "VALIDATION_ERROR", "Provide at least one health log field to update.");
  }
  if (animalId !== existing.animal_id) {
    const animals = await sql`
      SELECT id FROM farm_animals
      WHERE id = ${animalId} AND organization_id = ${organizationId} AND status <> 'deleted'
      LIMIT 1
    `;
    if (!animals[0]) fail(404, "ANIMAL_NOT_FOUND", "Active animal record was not found in this farm.");
  }
  const rows = await sql`
    UPDATE farm_health_logs SET
      animal_id = ${animalId},
      log_date = ${logDate},
      log_type = ${logType},
      description = CASE WHEN ${description !== undefined} THEN ${description ?? null} ELSE description END,
      treatment = CASE WHEN ${treatment !== undefined} THEN ${treatment ?? null} ELSE treatment END,
      vet_name = CASE WHEN ${vetName !== undefined} THEN ${vetName ?? null} ELSE vet_name END,
      cost = CASE WHEN ${cost !== undefined} THEN ${cost ?? null} ELSE cost END,
      next_due_date = CASE WHEN ${nextDueDateProvided} THEN ${nextDueDate}::date ELSE next_due_date END
    WHERE id = ${id} AND organization_id = ${organizationId}
    RETURNING *
  `;
  const healthLog = rows[0] as { id: string } | undefined;
  if (!healthLog) fail(404, "HEALTH_LOG_NOT_FOUND", "Health log was not found in this farm.");
  await resolveHealthStatus(sql, organizationId, existing.animal_id);
  if (animalId !== existing.animal_id) await resolveHealthStatus(sql, organizationId, animalId);
  await auditMutation(sql, actorUser, organizationId, "farm.health_log_updated", "farm_health_logs", id, {
    fields: Object.keys(body),
  }, requestIp(c));
  return c.json({ health_log: healthLog });
});

operations.delete("/health/:id", requireRole("farm_admin"), async (c) => {
  const id = uuid(c.req.param("id"));
  const sql = getDb(c.env);
  const actorUser = actor(c);
  const organizationId = await organizationForUser(sql, actorUser);
  const rows = await sql`
    DELETE FROM farm_health_logs
    WHERE id = ${id} AND organization_id = ${organizationId}
    RETURNING id, animal_id, log_date, log_type
  `;
  const healthLog = rows[0] as { id: string; animal_id: string; log_type: string } | undefined;
  if (!healthLog) fail(404, "HEALTH_LOG_NOT_FOUND", "Health log was not found in this farm.");
  await resolveHealthStatus(sql, organizationId, healthLog.animal_id);
  await auditMutation(sql, actorUser, organizationId, "farm.health_log_deleted", "farm_health_logs", id, {
    animal_id: healthLog.animal_id,
    log_type: healthLog.log_type,
  }, requestIp(c));
  return c.json({ ok: true });
});

operations.get("/stats/operations", requireRole(...ADMIN_MANAGER_ROLES), async (c) => {
  const sql = getDb(c.env);
  const actorUser = actor(c);
  const organizationId = await organizationForUser(sql, actorUser);
  const today = await localToday(sql, organizationId);
  const from = dateValue(c.req.query("from"), "from") ?? defaultWeekStart(today);
  const to = dateValue(c.req.query("to"), "to") ?? today;
  checkDateRange(from, to);
  const [eggs, attendance, attendanceByWorker, movements, health] = await Promise.all([
    sql`
      SELECT COALESCE(SUM(eggs_collected), 0)::int AS total,
        COALESCE(SUM(eggs_good), 0)::int AS good,
        COALESCE(SUM(eggs_broken), 0)::int AS broken
      FROM farm_egg_records
      WHERE organization_id = ${organizationId}
        AND record_date BETWEEN ${from}::date AND ${to}::date
    `,
    sql`
      SELECT COUNT(*) FILTER (WHERE status IN ('present', 'late'))::int AS present,
        COUNT(*) FILTER (WHERE status = 'absent')::int AS absent
      FROM farm_attendance
      WHERE organization_id = ${organizationId}
        AND attendance_date BETWEEN ${from}::date AND ${to}::date
    `,
    sql`
      SELECT w.id AS worker_id, u.name AS worker_name,
        COUNT(a.id) FILTER (WHERE a.status IN ('present', 'late'))::int AS present,
        COUNT(a.id) FILTER (WHERE a.status = 'absent')::int AS absent
      FROM farm_workers w
      JOIN users u ON u.id = w.user_id
      LEFT JOIN farm_attendance a ON a.worker_id = w.id
        AND a.organization_id = w.organization_id
        AND a.attendance_date BETWEEN ${from}::date AND ${to}::date
      WHERE w.organization_id = ${organizationId}
        AND (w.active IS TRUE OR a.id IS NOT NULL)
      GROUP BY w.id, u.name
      ORDER BY u.name
    `,
    sql`
      SELECT COALESCE(SUM(count) FILTER (WHERE direction = 'in'), 0)::int AS in_count,
        COALESCE(SUM(count) FILTER (WHERE direction = 'out'), 0)::int AS out_count
      FROM farm_movements
      WHERE organization_id = ${organizationId}
        AND moved_at::date BETWEEN ${from}::date AND ${to}::date
    `,
    sql`
      SELECT
        (SELECT COUNT(*)::int FROM farm_animals
          WHERE organization_id = ${organizationId} AND status <> 'deleted'
            AND lower(health_status) = 'sick') AS sick_count,
        (SELECT COUNT(*)::int FROM farm_health_logs
          WHERE organization_id = ${organizationId}
            AND next_due_date IS NOT NULL AND next_due_date <= ${today}::date) AS treatments_due
    `,
  ]);
  const eggTotals = eggs[0] as { total?: number; good?: number; broken?: number } | undefined;
  const attendanceTotals = attendance[0] as { present?: number; absent?: number } | undefined;
  const movementTotals = movements[0] as { in_count?: number; out_count?: number } | undefined;
  const healthTotals = health[0] as { sick_count?: number; treatments_due?: number } | undefined;
  return c.json({
    from,
    to,
    eggs: {
      total: Number(eggTotals?.total || 0),
      good: Number(eggTotals?.good || 0),
      broken: Number(eggTotals?.broken || 0),
    },
    attendance: {
      present: Number(attendanceTotals?.present || 0),
      absent: Number(attendanceTotals?.absent || 0),
      by_worker: attendanceByWorker,
    },
    movements: {
      in_count: Number(movementTotals?.in_count || 0),
      out_count: Number(movementTotals?.out_count || 0),
    },
    health: {
      sick_count: Number(healthTotals?.sick_count || 0),
      treatments_due: Number(healthTotals?.treatments_due || 0),
    },
  });
});

export default operations;
