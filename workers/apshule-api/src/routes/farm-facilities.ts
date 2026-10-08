import { Hono } from "hono";
import { getDb } from "../db.js";
import { requireRole } from "../auth.js";
import { readJson } from "../http.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";
import {
  actorIp,
  assertLocationInOrganization,
  auditMutation,
  dateValue,
  fail,
  farmScope,
  moneyValue,
  optionalText,
  optionalUuid,
  pathUuid,
  requiredText,
} from "../farm-commerce-shared.js";

const facilities = new Hono<AppEnv>();
const FARM_ROLES = ["farm_admin", "farm_manager", "farm_worker"] as const;
const ADMIN_MANAGER = ["farm_admin", "farm_manager"] as const;
const PAYMENT_METHODS = new Set(["cash", "momo", "bank", "credit"]);
const CAMERA_PURPOSES = new Set(["egg_counting", "animal_monitoring", "security", "feed_check"]);

function actor(c: { get(key: "user"): AuthenticatedUser }): AuthenticatedUser {
  return c.get("user");
}

function validPaymentMethod(value: unknown): string {
  if (typeof value !== "string" || !PAYMENT_METHODS.has(value)) {
    fail(400, "VALIDATION_ERROR", "payment_method must be cash, momo, bank, or credit.");
  }
  return value;
}

function validCameraUrl(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(400, "VALIDATION_ERROR", "stream_url must be an absolute camera URL.");
  }
  if (!["http:", "https:", "rtsp:"].includes(url.protocol)) {
    fail(400, "VALIDATION_ERROR", "stream_url must use http, https, or rtsp.");
  }
  return value;
}

facilities.get("/expenses", requireRole(...ADMIN_MANAGER), async (c) => {
  const user = actor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, user);
  const from = dateValue(c.req.query("from"), "from", true);
  const to = dateValue(c.req.query("to"), "to", true);
  if (from && to && from > to) fail(400, "VALIDATION_ERROR", "from must be on or before to.");
  const locationId = c.req.query("location_id")
    ? pathUuid(c.req.query("location_id")!, "location_id")
    : null;
  if (locationId) await assertLocationInOrganization(sql, scope.organizationId, locationId);
  const category = optionalText({ category: c.req.query("category") }, "category", 80) ?? null;
  const rows = await sql`
    SELECT e.id, e.organization_id, e.location_id, l.name AS location_name,
      e.expense_date, e.category, e.description, e.amount, e.payment_method,
      e.reference, e.vendor, e.recorded_by, u.name AS recorded_by_name,
      e.created_at, e.updated_at
    FROM farm_expenses e
    LEFT JOIN farm_locations l ON l.id = e.location_id
    LEFT JOIN users u ON u.id = e.recorded_by
    WHERE e.organization_id = ${scope.organizationId} AND e.active IS TRUE
      AND (${from}::date IS NULL OR e.expense_date >= ${from}::date)
      AND (${to}::date IS NULL OR e.expense_date <= ${to}::date)
      AND (${locationId}::uuid IS NULL OR e.location_id = ${locationId})
      AND (${category}::text IS NULL OR e.category = ${category})
    ORDER BY e.expense_date DESC, e.created_at DESC
    LIMIT 1000
  `;
  return c.json({ expenses: rows });
});

facilities.post("/expenses", requireRole(...ADMIN_MANAGER), async (c) => {
  const user = actor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, user);
  const body = await readJson(c);
  const locationId = optionalUuid(body, "location_id") ?? null;
  await assertLocationInOrganization(sql, scope.organizationId, locationId);
  const expenseDate = dateValue(body.expense_date, "expense_date")!;
  const category = requiredText(body, "category", 80);
  const description = optionalText(body, "description", 1000) ?? null;
  const amount = moneyValue(body.amount, "amount")!;
  if (amount <= 0) fail(400, "VALIDATION_ERROR", "amount must be greater than zero.");
  const method = body.payment_method === undefined ? "cash" : validPaymentMethod(body.payment_method);
  const reference = optionalText(body, "reference", 160) ?? null;
  const vendor = optionalText(body, "vendor", 200) ?? null;
  const rows = await sql`
    INSERT INTO farm_expenses
      (organization_id, location_id, expense_date, category, description, amount,
       payment_method, reference, vendor, recorded_by)
    VALUES (${scope.organizationId}, ${locationId}, ${expenseDate}::date, ${category},
      ${description}, ${amount}, ${method}, ${reference}, ${vendor}, ${user.id})
    RETURNING *
  `;
  const expense = rows[0] as Record<string, unknown>;
  await auditMutation(sql, user, scope.organizationId, "farm.expense.created", "farm_expenses",
    String(expense.id), { amount, category, expense_date: expenseDate }, actorIp(c));
  return c.json({ expense }, 201);
});

facilities.patch("/expenses/:id", requireRole("farm_admin"), async (c) => {
  const user = actor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, user);
  const id = pathUuid(c.req.param("id"));
  const body = await readJson(c);
  const locationId = optionalUuid(body, "location_id");
  if (locationId !== undefined) await assertLocationInOrganization(sql, scope.organizationId, locationId);
  const expenseDate = dateValue(body.expense_date, "expense_date", true);
  const category = optionalText(body, "category", 80);
  if ("category" in body && !category) fail(400, "VALIDATION_ERROR", "category cannot be empty.");
  const description = optionalText(body, "description", 1000);
  const amount = body.amount === undefined ? undefined : moneyValue(body.amount, "amount");
  if (amount === 0) fail(400, "VALIDATION_ERROR", "amount must be greater than zero.");
  const method = body.payment_method === undefined ? undefined : validPaymentMethod(body.payment_method);
  const reference = optionalText(body, "reference", 160);
  const vendor = optionalText(body, "vendor", 200);
  if (![locationId, expenseDate, category, description, amount, method, reference, vendor]
    .some((value) => value !== undefined)) {
    fail(400, "VALIDATION_ERROR", "Provide at least one expense field to update.");
  }
  const rows = await sql`
    UPDATE farm_expenses SET
      location_id = CASE WHEN ${locationId !== undefined} THEN ${locationId ?? null} ELSE location_id END,
      expense_date = CASE WHEN ${expenseDate !== null} THEN ${expenseDate}::date ELSE expense_date END,
      category = CASE WHEN ${category !== undefined} THEN ${category ?? null} ELSE category END,
      description = CASE WHEN ${description !== undefined} THEN ${description ?? null} ELSE description END,
      amount = CASE WHEN ${amount !== undefined} THEN ${amount ?? 0} ELSE amount END,
      payment_method = CASE WHEN ${method !== undefined} THEN ${method ?? "cash"} ELSE payment_method END,
      reference = CASE WHEN ${reference !== undefined} THEN ${reference ?? null} ELSE reference END,
      vendor = CASE WHEN ${vendor !== undefined} THEN ${vendor ?? null} ELSE vendor END,
      updated_at = NOW()
    WHERE id = ${id} AND organization_id = ${scope.organizationId} AND active IS TRUE
    RETURNING *
  `;
  const expense = rows[0] as Record<string, unknown> | undefined;
  if (!expense) fail(404, "EXPENSE_NOT_FOUND", "Active expense was not found.");
  await auditMutation(sql, user, scope.organizationId, "farm.expense.updated", "farm_expenses",
    id, { fields: Object.keys(body) }, actorIp(c));
  return c.json({ expense });
});

facilities.delete("/expenses/:id", requireRole("farm_admin"), async (c) => {
  const user = actor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, user);
  const id = pathUuid(c.req.param("id"));
  const rows = await sql`
    UPDATE farm_expenses SET active = FALSE, updated_at = NOW()
    WHERE id = ${id} AND organization_id = ${scope.organizationId} AND active IS TRUE
    RETURNING id, amount, category
  `;
  const expense = rows[0] as Record<string, unknown> | undefined;
  if (!expense) fail(404, "EXPENSE_NOT_FOUND", "Active expense was not found.");
  await auditMutation(sql, user, scope.organizationId, "farm.expense.deleted", "farm_expenses",
    id, { amount: expense.amount, category: expense.category, soft_delete: true }, actorIp(c));
  return c.json({ ok: true });
});

facilities.get("/cameras", requireRole(...FARM_ROLES), async (c) => {
  const user = actor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, user);
  const rows = await sql`
    SELECT c.id, c.organization_id, c.location_id, l.name AS location_name,
      c.name, c.camera_type, ${user.role !== "farm_worker"} AS can_view_stream_url,
      CASE WHEN ${user.role !== "farm_worker"} THEN c.stream_url ELSE NULL END AS stream_url,
      c.purpose, c.active, c.last_seen_at, c.notes, c.created_at, c.updated_at,
      CASE WHEN c.last_seen_at >= NOW() - INTERVAL '5 minutes' THEN 'online' ELSE 'offline' END AS status
    FROM farm_cameras c
    LEFT JOIN farm_locations l ON l.id = c.location_id
    WHERE c.organization_id = ${scope.organizationId} AND c.active IS TRUE
      AND (${user.role !== "farm_worker"} OR c.location_id IS NULL OR c.location_id = ${scope.locationId})
    ORDER BY c.name
  `;
  return c.json({ cameras: rows });
});

facilities.post("/cameras", requireRole("farm_admin"), async (c) => {
  const user = actor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, user);
  const body = await readJson(c);
  const locationId = optionalUuid(body, "location_id") ?? null;
  await assertLocationInOrganization(sql, scope.organizationId, locationId);
  const name = requiredText(body, "name", 160);
  const cameraType = optionalText(body, "camera_type", 80) || "ip";
  const streamUrl = validCameraUrl(optionalText(body, "stream_url", 1000));
  const purpose = optionalText(body, "purpose", 40) ?? null;
  if (purpose && !CAMERA_PURPOSES.has(purpose)) fail(400, "VALIDATION_ERROR", "purpose is not supported.");
  const notes = optionalText(body, "notes", 1000) ?? null;
  const rows = await sql`
    INSERT INTO farm_cameras
      (organization_id, location_id, name, camera_type, stream_url, purpose, notes)
    VALUES (${scope.organizationId}, ${locationId}, ${name}, ${cameraType}, ${streamUrl}, ${purpose}, ${notes})
    RETURNING *
  `;
  const camera = rows[0] as Record<string, unknown>;
  await auditMutation(sql, user, scope.organizationId, "farm.camera.created", "farm_cameras",
    String(camera.id), { name, purpose }, actorIp(c));
  return c.json({ camera }, 201);
});

facilities.patch("/cameras/:id", requireRole("farm_admin"), async (c) => {
  const user = actor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, user);
  const id = pathUuid(c.req.param("id"));
  const body = await readJson(c);
  const locationId = optionalUuid(body, "location_id");
  if (locationId !== undefined) await assertLocationInOrganization(sql, scope.organizationId, locationId);
  const name = optionalText(body, "name", 160);
  const cameraType = optionalText(body, "camera_type", 80);
  if ("name" in body && !name) fail(400, "VALIDATION_ERROR", "name cannot be empty.");
  if ("camera_type" in body && !cameraType) fail(400, "VALIDATION_ERROR", "camera_type cannot be empty.");
  const streamUrl = body.stream_url === undefined
    ? undefined
    : validCameraUrl(optionalText(body, "stream_url", 1000));
  const purpose = optionalText(body, "purpose", 40);
  if (purpose && !CAMERA_PURPOSES.has(purpose)) fail(400, "VALIDATION_ERROR", "purpose is not supported.");
  const notes = optionalText(body, "notes", 1000);
  if (![locationId, name, cameraType, streamUrl, purpose, notes].some((value) => value !== undefined)) {
    fail(400, "VALIDATION_ERROR", "Provide at least one camera field to update.");
  }
  const rows = await sql`
    UPDATE farm_cameras SET
      location_id = CASE WHEN ${locationId !== undefined} THEN ${locationId ?? null} ELSE location_id END,
      name = CASE WHEN ${name !== undefined} THEN ${name ?? null} ELSE name END,
      camera_type = CASE WHEN ${cameraType !== undefined} THEN ${cameraType ?? "ip"} ELSE camera_type END,
      stream_url = CASE WHEN ${streamUrl !== undefined} THEN ${streamUrl ?? null} ELSE stream_url END,
      purpose = CASE WHEN ${purpose !== undefined} THEN ${purpose ?? null} ELSE purpose END,
      notes = CASE WHEN ${notes !== undefined} THEN ${notes ?? null} ELSE notes END,
      updated_at = NOW()
    WHERE id = ${id} AND organization_id = ${scope.organizationId} AND active IS TRUE
    RETURNING *
  `;
  const camera = rows[0] as Record<string, unknown> | undefined;
  if (!camera) fail(404, "CAMERA_NOT_FOUND", "Active camera was not found.");
  await auditMutation(sql, user, scope.organizationId, "farm.camera.updated", "farm_cameras",
    id, { fields: Object.keys(body) }, actorIp(c));
  return c.json({ camera });
});

facilities.delete("/cameras/:id", requireRole("farm_admin"), async (c) => {
  const user = actor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, user);
  const id = pathUuid(c.req.param("id"));
  const rows = await sql`
    UPDATE farm_cameras SET active = FALSE, updated_at = NOW()
    WHERE id = ${id} AND organization_id = ${scope.organizationId} AND active IS TRUE
    RETURNING id, name
  `;
  const camera = rows[0] as Record<string, unknown> | undefined;
  if (!camera) fail(404, "CAMERA_NOT_FOUND", "Active camera was not found.");
  await auditMutation(sql, user, scope.organizationId, "farm.camera.deleted", "farm_cameras",
    id, { name: camera.name, soft_delete: true }, actorIp(c));
  return c.json({ ok: true });
});

facilities.post("/cameras/:id/heartbeat", requireRole(...FARM_ROLES), async (c) => {
  const user = actor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, user);
  const id = pathUuid(c.req.param("id"));
  const rows = await sql`
    UPDATE farm_cameras SET last_seen_at = NOW(), updated_at = NOW()
    WHERE id = ${id} AND organization_id = ${scope.organizationId} AND active IS TRUE
      AND (${user.role !== "farm_worker"} OR location_id IS NULL OR location_id = ${scope.locationId})
    RETURNING id, last_seen_at
  `;
  const camera = rows[0] as Record<string, unknown> | undefined;
  if (!camera) fail(404, "CAMERA_NOT_FOUND", "Active camera was not found at this farm location.");
  return c.json({ camera });
});

export default facilities;
