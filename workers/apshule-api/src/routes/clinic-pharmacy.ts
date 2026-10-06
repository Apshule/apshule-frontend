import { Hono } from "hono";
import { ApiError, getDb, isUniqueViolation } from "../db.js";
import { requireRole } from "../auth.js";
import { parseLimit, readJson } from "../http.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";

type Sql = ReturnType<typeof getDb>;
type OrganizationResolver = (
  sql: Sql,
  user: AuthenticatedUser,
  requestedId?: string,
) => Promise<string>;
type RequestIp = (c: { req: { header(name: string): string | undefined } }) => string | null;

interface ClinicPharmacyHelpers {
  organizationForRequest: OrganizationResolver;
  requestIp: RequestIp;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MEDICINE_FORMS = new Set(["tablet", "capsule", "syrup", "injection", "cream", "other"]);
const MOVEMENT_TYPES = new Set(["restock", "adjustment", "expiry", "damage", "return"]);
const PRESCRIPTION_STATUSES = new Set(["pending", "dispensed", "cancelled"]);
const MAX_RX_ITEMS = 40;

function isValidClinicDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

type PrescriptionItemInput = {
  medicine_id: string | null;
  medicine_name: string;
  dosage: string;
  frequency: string;
  duration: string;
  route: string | null;
  quantity: number;
  instructions: string | null;
};

function pathUuid(value: string, field = "id"): string {
  if (!UUID_PATTERN.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a valid UUID.`);
  }
  return value;
}

function queryUuid(value: string | undefined, field: string): string | null {
  if (!value) return null;
  return pathUuid(value, field);
}

function assertAllowedKeys(body: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(body).find((key) => !allowed.includes(key));
  if (unexpected) {
    throw new ApiError(400, "VALIDATION_ERROR", `Unsupported field: ${unexpected}.`);
  }
}

function requiredText(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} is required.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must contain 1-${max} characters.`);
  }
  return normalized;
}

function optionalText(
  body: Record<string, unknown>,
  field: string,
  max = 500,
): string | null | undefined {
  if (!(field in body)) return undefined;
  const value = body[field];
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > max) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be text of at most ${max} characters.`);
  }
  return value.trim() || null;
}

function numericValue(
  value: unknown,
  field: string,
  min: number,
  max: number,
  integer = false,
): number {
  const parsed = typeof value === "number" || typeof value === "string"
    ? Number(value)
    : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max ||
      (integer && !Number.isInteger(parsed))) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} is outside the allowed range.`);
  }
  return parsed;
}

function optionalMoney(body: Record<string, unknown>, field: string): number | null | undefined {
  if (!(field in body)) return undefined;
  if (body[field] === null || body[field] === "") return null;
  const value = numericValue(body[field], field, 0, 1_000_000_000);
  return Math.round(value * 100) / 100;
}

function parseMedicineFields(
  body: Record<string, unknown>,
  creating: boolean,
): {
  code?: string;
  name?: string;
  genericName?: string | null;
  category?: string | null;
  form?: string | null;
  strength?: string | null;
  manufacturer?: string | null;
  unit?: string;
  reorderLevel?: number;
  currentStock?: number;
  costPrice?: number | null;
  sellingPrice?: number | null;
} {
  const allowed = [
    "code", "name", "generic_name", "category", "form", "strength",
    "manufacturer", "unit", "reorder_level", "current_stock", "cost_price",
    "selling_price",
  ];
  assertAllowedKeys(body, allowed);
  const fields: ReturnType<typeof parseMedicineFields> = {};
  if (creating || "code" in body) fields.code = requiredText(body.code, "code", 60);
  if (creating || "name" in body) fields.name = requiredText(body.name, "name", 160);
  for (const [input, output] of [
    ["generic_name", "genericName"],
    ["category", "category"],
    ["strength", "strength"],
    ["manufacturer", "manufacturer"],
  ] as const) {
    const value = optionalText(body, input, 160);
    if (value !== undefined) fields[output] = value;
  }
  if ("form" in body) {
    const value = optionalText(body, "form", 40);
    if (value && !MEDICINE_FORMS.has(value)) {
      throw new ApiError(400, "VALIDATION_ERROR", "form must be tablet, capsule, syrup, injection, cream, or other.");
    }
    if (value !== undefined) fields.form = value;
  }
  if ("unit" in body) fields.unit = requiredText(body.unit, "unit", 60);
  if ("reorder_level" in body) {
    fields.reorderLevel = numericValue(body.reorder_level, "reorder_level", 0, 2_000_000_000, true);
  }
  if (creating && "current_stock" in body) {
    fields.currentStock = numericValue(body.current_stock, "current_stock", 0, 2_000_000_000, true);
  } else if ("current_stock" in body) {
    throw new ApiError(400, "VALIDATION_ERROR", "Use stock adjustment to change current_stock.");
  }
  const costPrice = optionalMoney(body, "cost_price");
  if (costPrice !== undefined) fields.costPrice = costPrice;
  const sellingPrice = optionalMoney(body, "selling_price");
  if (sellingPrice !== undefined) fields.sellingPrice = sellingPrice;
  return fields;
}

function parsePrescriptionItems(value: unknown): PrescriptionItemInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RX_ITEMS) {
    throw new ApiError(400, "VALIDATION_ERROR", `items must contain 1-${MAX_RX_ITEMS} medicines.`);
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError(400, "VALIDATION_ERROR", `items[${index}] must be an object.`);
    }
    const item = raw as Record<string, unknown>;
    assertAllowedKeys(item, [
      "medicine_id", "medicine_name", "dosage", "frequency", "duration",
      "route", "quantity", "instructions",
    ]);
    let medicineId: string | null = null;
    if (item.medicine_id != null && item.medicine_id !== "") {
      if (typeof item.medicine_id !== "string") {
        throw new ApiError(400, "VALIDATION_ERROR", `items[${index}].medicine_id must be a UUID.`);
      }
      medicineId = pathUuid(item.medicine_id, `items[${index}].medicine_id`);
    }
    return {
      medicine_id: medicineId,
      medicine_name: requiredText(item.medicine_name, `items[${index}].medicine_name`, 200),
      dosage: requiredText(item.dosage, `items[${index}].dosage`, 120),
      frequency: requiredText(item.frequency, `items[${index}].frequency`, 120),
      duration: requiredText(item.duration, `items[${index}].duration`, 120),
      route: optionalText(item, "route", 80) ?? null,
      quantity: numericValue(item.quantity, `items[${index}].quantity`, 1, 100_000, true),
      instructions: optionalText(item, "instructions", 1_000) ?? null,
    };
  });
}

async function resolveMedicineNames(
  sql: Sql,
  organizationId: string,
  items: PrescriptionItemInput[],
): Promise<PrescriptionItemInput[]> {
  const medicineIds = [...new Set(items.flatMap((item) => item.medicine_id ? [item.medicine_id] : []))];
  if (!medicineIds.length) return items;
  const requestJson = JSON.stringify(medicineIds.map((medicine_id) => ({ medicine_id })));
  const rows = await sql`
    SELECT m.id, m.name
    FROM clinic_medicines m
    JOIN (
      SELECT DISTINCT requested.medicine_id
      FROM jsonb_to_recordset(${requestJson}::jsonb)
        AS requested(medicine_id uuid)
    ) selected ON selected.medicine_id = m.id
    WHERE m.organization_id = ${organizationId}
      AND m.active IS TRUE
  `;
  const medicines = new Map(
    (rows as Array<{ id: string; name: string }>).map((row) => [String(row.id), row.name]),
  );
  const missing = medicineIds.find((id) => !medicines.has(id));
  if (missing) {
    throw new ApiError(400, "MEDICINE_NOT_AVAILABLE", "A selected medicine is not active in this clinic.");
  }
  return items.map((item) => ({
    ...item,
    medicine_name: item.medicine_id ? medicines.get(item.medicine_id)! : item.medicine_name,
  }));
}

function itemPayload(items: PrescriptionItemInput[]): string {
  return JSON.stringify(items);
}

function routeError(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw new ApiError(409, "CLINIC_RECORD_CONFLICT", "A medicine with that code already exists in this clinic.");
  }
  throw error;
}

export function createClinicPharmacyRoutes({
  organizationForRequest,
  requestIp,
}: ClinicPharmacyHelpers) {
  const routes = new Hono<AppEnv>();

  routes.get(
    "/clinic/medicines",
    requireRole("clinic_admin", "doctor", "nurse", "pharmacist", "receptionist"),
    async (c) => {
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await organizationForRequest(
        sql,
        actor,
        c.req.query("organization_id"),
      );
      const search = c.req.query("search")?.trim().slice(0, 100) || null;
      const category = c.req.query("category")?.trim().slice(0, 120) || null;
      const lowStockValue = c.req.query("low_stock");
      if (lowStockValue && !["true", "false", "1", "0"].includes(lowStockValue)) {
        throw new ApiError(400, "VALIDATION_ERROR", "low_stock must be true or false.");
      }
      const lowStock = lowStockValue === "true" || lowStockValue === "1";
      const includeInactive = c.req.query("include_inactive") === "true" &&
        ["clinic_admin", "pharmacist"].includes(actor.role);
      const limit = parseLimit(c.req.query("limit"), 100);
      const rows = await sql`
        SELECT id, organization_id, code, name, generic_name, category, form,
          strength, manufacturer, unit, reorder_level, current_stock, cost_price,
          selling_price, active, created_at, updated_at
        FROM clinic_medicines
        WHERE organization_id = ${organizationId}
          AND (${includeInactive} OR active IS TRUE)
          AND (${search}::text IS NULL OR code ILIKE ${search ? `%${search}%` : null}
            OR name ILIKE ${search ? `%${search}%` : null}
            OR generic_name ILIKE ${search ? `%${search}%` : null})
          AND (${category}::text IS NULL OR category = ${category})
          AND (NOT ${lowStock} OR current_stock <= reorder_level)
        ORDER BY name, code
        LIMIT ${limit}
      `;
      return c.json({ medicines: rows });
    },
  );

  routes.post(
    "/clinic/medicines",
    requireRole("clinic_admin", "pharmacist"),
    async (c) => {
      const actor = c.get("user");
      const body = await readJson(c);
      const fields = parseMedicineFields(body, true);
      const organizationId = await organizationForRequest(
        getDb(c.env),
        actor,
        c.req.query("organization_id"),
      );
      const ip = requestIp(c);
      const metadata = JSON.stringify({
        code: fields.code,
        name: fields.name,
        initial_stock: fields.currentStock ?? 0,
      });
      const sql = getDb(c.env);
      try {
        const rows = await sql`
          WITH created AS (
            INSERT INTO clinic_medicines (
              organization_id, code, name, generic_name, category, form,
              strength, manufacturer, unit, reorder_level, current_stock,
              cost_price, selling_price, created_by
            ) VALUES (
              ${organizationId}, ${fields.code}, ${fields.name},
              ${fields.genericName ?? null}, ${fields.category ?? null},
              ${fields.form ?? null}, ${fields.strength ?? null},
              ${fields.manufacturer ?? null}, ${fields.unit ?? "tablet"},
              ${fields.reorderLevel ?? 20}, ${fields.currentStock ?? 0},
              ${fields.costPrice ?? null}, ${fields.sellingPrice ?? null},
              ${actor.id}
            )
            RETURNING *
          ),
          initial_movement AS (
            INSERT INTO clinic_stock_movements (
              organization_id, medicine_id, movement_type, quantity,
              balance_after, reference, notes, created_by
            )
            SELECT organization_id, id, 'restock', current_stock,
              current_stock, 'initial stock', 'Opening inventory', ${actor.id}
            FROM created
            WHERE current_stock > 0
            RETURNING id
          ),
          local_audit AS (
            INSERT INTO clinic_audit (
              organization_id, actor_id, action, target_table, target_id, metadata
            )
            SELECT organization_id, ${actor.id}, 'clinic.medicine_created',
              'clinic_medicines', id, ${metadata}::jsonb
            FROM created
            RETURNING id
          ),
          platform_audit AS (
            INSERT INTO audit_log (
              actor_id, sector, action, target_table, target_id, metadata, ip
            )
            SELECT ${actor.id}, 'clinic', 'clinic.medicine_created',
              'clinic_medicines', id, ${metadata}::jsonb, ${ip}
            FROM created
            RETURNING id
          )
          SELECT to_jsonb(created) AS medicine FROM created
        `;
        return c.json({ medicine: (rows[0] as { medicine: unknown } | undefined)?.medicine }, 201);
      } catch (error) {
        routeError(error);
      }
    },
  );

  routes.patch(
    "/clinic/medicines/:id",
    requireRole("clinic_admin", "pharmacist"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const actor = c.get("user");
      const body = await readJson(c);
      const fields = parseMedicineFields(body, false);
      const changedFields = Object.keys(body).filter((key) => key !== "organization_id");
      if (!changedFields.length) {
        throw new ApiError(400, "VALIDATION_ERROR", "At least one medicine field is required.");
      }
      const organizationId = await organizationForRequest(
        getDb(c.env),
        actor,
        c.req.query("organization_id"),
      );
      const metadata = JSON.stringify({ changed_fields: changedFields });
      const ip = requestIp(c);
      const sql = getDb(c.env);
      const rows = await sql`
        WITH updated AS (
          UPDATE clinic_medicines
          SET code = CASE WHEN ${fields.code !== undefined} THEN ${fields.code ?? null} ELSE code END,
            name = CASE WHEN ${fields.name !== undefined} THEN ${fields.name ?? null} ELSE name END,
            generic_name = CASE WHEN ${fields.genericName !== undefined} THEN ${fields.genericName ?? null} ELSE generic_name END,
            category = CASE WHEN ${fields.category !== undefined} THEN ${fields.category ?? null} ELSE category END,
            form = CASE WHEN ${fields.form !== undefined} THEN ${fields.form ?? null} ELSE form END,
            strength = CASE WHEN ${fields.strength !== undefined} THEN ${fields.strength ?? null} ELSE strength END,
            manufacturer = CASE WHEN ${fields.manufacturer !== undefined} THEN ${fields.manufacturer ?? null} ELSE manufacturer END,
            unit = CASE WHEN ${fields.unit !== undefined} THEN ${fields.unit ?? null} ELSE unit END,
            reorder_level = CASE WHEN ${fields.reorderLevel !== undefined} THEN ${fields.reorderLevel ?? null} ELSE reorder_level END,
            cost_price = CASE WHEN ${fields.costPrice !== undefined} THEN ${fields.costPrice ?? null} ELSE cost_price END,
            selling_price = CASE WHEN ${fields.sellingPrice !== undefined} THEN ${fields.sellingPrice ?? null} ELSE selling_price END,
            updated_at = NOW()
          WHERE id = ${id} AND organization_id = ${organizationId}
            AND active IS TRUE
          RETURNING *
        ),
        local_audit AS (
          INSERT INTO clinic_audit (
            organization_id, actor_id, action, target_table, target_id, metadata
          )
          SELECT organization_id, ${actor.id}, 'clinic.medicine_updated',
            'clinic_medicines', id, ${metadata}::jsonb
          FROM updated
          RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (
            actor_id, sector, action, target_table, target_id, metadata, ip
          )
          SELECT ${actor.id}, 'clinic', 'clinic.medicine_updated',
            'clinic_medicines', id, ${metadata}::jsonb, ${ip}
          FROM updated
          RETURNING id
        )
        SELECT to_jsonb(updated) AS medicine FROM updated
      `;
      if (!rows[0]) throw new ApiError(404, "MEDICINE_NOT_FOUND", "Medicine was not found.");
      return c.json({ medicine: (rows[0] as { medicine: unknown }).medicine });
    },
  );

  routes.delete(
    "/clinic/medicines/:id",
    requireRole("clinic_admin"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const actor = c.get("user");
      const organizationId = await organizationForRequest(
        getDb(c.env),
        actor,
        c.req.query("organization_id"),
      );
      const metadata = JSON.stringify({ soft_deleted: true });
      const ip = requestIp(c);
      const rows = await getDb(c.env)`
        WITH updated AS (
          UPDATE clinic_medicines
          SET active = FALSE, updated_at = NOW()
          WHERE id = ${id} AND organization_id = ${organizationId}
            AND active IS TRUE
          RETURNING id, organization_id, code, name, active
        ),
        local_audit AS (
          INSERT INTO clinic_audit (
            organization_id, actor_id, action, target_table, target_id, metadata
          )
          SELECT organization_id, ${actor.id}, 'clinic.medicine_deactivated',
            'clinic_medicines', id, ${metadata}::jsonb
          FROM updated
          RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (
            actor_id, sector, action, target_table, target_id, metadata, ip
          )
          SELECT ${actor.id}, 'clinic', 'clinic.medicine_deactivated',
            'clinic_medicines', id, ${metadata}::jsonb, ${ip}
          FROM updated
          RETURNING id
        )
        SELECT to_jsonb(updated) AS medicine FROM updated
      `;
      if (!rows[0]) throw new ApiError(404, "MEDICINE_NOT_FOUND", "Medicine was not found.");
      return c.json({ medicine: (rows[0] as { medicine: unknown }).medicine });
    },
  );

  routes.post(
    "/clinic/medicines/:id/adjust-stock",
    requireRole("clinic_admin", "pharmacist"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const actor = c.get("user");
      const body = await readJson(c);
      assertAllowedKeys(body, ["quantity_change", "movement_type", "notes"]);
      const quantityChange = numericValue(body.quantity_change, "quantity_change", -2_000_000_000, 2_000_000_000, true);
      if (!quantityChange) {
        throw new ApiError(400, "VALIDATION_ERROR", "quantity_change must not be zero.");
      }
      const movementType = requiredText(body.movement_type, "movement_type", 20);
      if (!MOVEMENT_TYPES.has(movementType)) {
        throw new ApiError(400, "VALIDATION_ERROR", "movement_type is not supported.");
      }
      if ((["restock", "return"].includes(movementType) && quantityChange < 0) ||
          (["expiry", "damage"].includes(movementType) && quantityChange > 0)) {
        throw new ApiError(400, "VALIDATION_ERROR", "quantity_change sign does not match movement_type.");
      }
      const notes = optionalText(body, "notes", 1_000) ?? null;
      const organizationId = await organizationForRequest(
        getDb(c.env),
        actor,
        typeof body.organization_id === "string" ? body.organization_id : undefined,
      );
      const metadata = JSON.stringify({ movement_type: movementType, quantity_change: quantityChange });
      const ip = requestIp(c);
      const rows = await getDb(c.env)`
        WITH locked AS MATERIALIZED (
          SELECT id, organization_id, code, name, current_stock
          FROM clinic_medicines
          WHERE id = ${id} AND organization_id = ${organizationId}
            AND active IS TRUE
          FOR UPDATE
        ),
        updated AS (
          UPDATE clinic_medicines medicine
          SET current_stock = locked.current_stock + ${quantityChange},
            updated_at = NOW()
          FROM locked
          WHERE medicine.id = locked.id
            AND locked.current_stock + ${quantityChange} >= 0
          RETURNING medicine.*
        ),
        movement AS (
          INSERT INTO clinic_stock_movements (
            organization_id, medicine_id, movement_type, quantity,
            balance_after, notes, created_by
          )
          SELECT organization_id, id, ${movementType}, ${quantityChange},
            current_stock, ${notes}, ${actor.id}
          FROM updated
          RETURNING *
        ),
        local_audit AS (
          INSERT INTO clinic_audit (
            organization_id, actor_id, action, target_table, target_id, metadata
          )
          SELECT organization_id, ${actor.id}, 'clinic.medicine_stock_adjusted',
            'clinic_medicines', id, ${metadata}::jsonb
          FROM updated
          RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (
            actor_id, sector, action, target_table, target_id, metadata, ip
          )
          SELECT ${actor.id}, 'clinic', 'clinic.medicine_stock_adjusted',
            'clinic_medicines', id, ${metadata}::jsonb, ${ip}
          FROM updated
          RETURNING id
        )
        SELECT
          EXISTS(SELECT 1 FROM locked) AS found,
          (SELECT to_jsonb(updated) FROM updated) AS medicine,
          (SELECT to_jsonb(movement) FROM movement) AS movement
      `;
      const result = rows[0] as {
        found: boolean;
        medicine: unknown | null;
        movement: unknown | null;
      } | undefined;
      if (!result?.found) throw new ApiError(404, "MEDICINE_NOT_FOUND", "Medicine was not found.");
      if (!result.medicine) {
        throw new ApiError(409, "INSUFFICIENT_STOCK", "The adjustment would reduce stock below zero.");
      }
      return c.json({ medicine: result.medicine, movement: result.movement });
    },
  );

  routes.get(
    "/clinic/medicines/:id/movements",
    requireRole("clinic_admin", "pharmacist"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await organizationForRequest(
        sql,
        actor,
        c.req.query("organization_id"),
      );
      const medicineRows = await sql`
        SELECT id, organization_id, code, name, generic_name, category, form,
          strength, manufacturer, unit, reorder_level, current_stock,
          cost_price, selling_price, active, created_at, updated_at
        FROM clinic_medicines
        WHERE id = ${id} AND organization_id = ${organizationId}
        LIMIT 1
      `;
      const medicine = medicineRows[0];
      if (!medicine) throw new ApiError(404, "MEDICINE_NOT_FOUND", "Medicine was not found.");
      const limit = parseLimit(c.req.query("limit"), 50);
      const movements = await sql`
        SELECT movement.id, movement.medicine_id, movement.movement_type,
          movement.quantity, movement.balance_after, movement.reference,
          movement.notes, movement.created_at, movement.created_by,
          actor.name AS created_by_name
        FROM clinic_stock_movements movement
        LEFT JOIN users actor ON actor.id = movement.created_by
        WHERE movement.organization_id = ${organizationId}
          AND movement.medicine_id = ${id}
        ORDER BY movement.created_at DESC
        LIMIT ${limit}
      `;
      return c.json({ medicine, movements });
    },
  );

  routes.get(
    "/clinic/pharmacy/stats",
    requireRole("clinic_admin", "pharmacist"),
    async (c) => {
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await organizationForRequest(
        sql,
        actor,
        c.req.query("organization_id"),
      );
      const rows = await sql`
        SELECT
          (SELECT COUNT(*)::int FROM clinic_medicines
            WHERE organization_id = ${organizationId} AND active IS TRUE) AS total_medicines,
          (SELECT COUNT(*)::int FROM clinic_medicines
            WHERE organization_id = ${organizationId} AND active IS TRUE
              AND current_stock <= reorder_level) AS low_stock_count,
          (SELECT COUNT(*)::int FROM clinic_medicines
            WHERE organization_id = ${organizationId} AND active IS TRUE
              AND current_stock = 0) AS out_of_stock_count,
          (SELECT COALESCE(SUM(current_stock * COALESCE(cost_price, 0)), 0)::numeric(16,2)
            FROM clinic_medicines
            WHERE organization_id = ${organizationId} AND active IS TRUE) AS total_stock_value,
          (SELECT COUNT(*)::int FROM clinic_prescriptions
            WHERE organization_id = ${organizationId} AND status = 'pending') AS pending_prescriptions,
          (SELECT COUNT(*)::int FROM clinic_prescriptions
            WHERE organization_id = ${organizationId} AND status = 'dispensed'
              AND (dispensed_at AT TIME ZONE 'Africa/Kampala')::date =
                (NOW() AT TIME ZONE 'Africa/Kampala')::date) AS dispensed_today
      `;
      return c.json({ stats: rows[0] || {} });
    },
  );

  routes.get(
    "/clinic/prescriptions/stats",
    requireRole("clinic_admin", "doctor", "pharmacist"),
    async (c) => {
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await organizationForRequest(
        sql,
        actor,
        c.req.query("organization_id"),
      );
      const doctorId = actor.role === "doctor" ? actor.id : null;
      const rows = await sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          COUNT(*) FILTER (
            WHERE status = 'dispensed'
              AND (dispensed_at AT TIME ZONE 'Africa/Kampala')::date =
                (NOW() AT TIME ZONE 'Africa/Kampala')::date
          )::int AS dispensed_today,
          COUNT(*) FILTER (
            WHERE status = 'dispensed'
              AND (dispensed_at AT TIME ZONE 'Africa/Kampala')::date >=
                DATE_TRUNC('week', NOW() AT TIME ZONE 'Africa/Kampala')::date
          )::int AS dispensed_this_week
        FROM clinic_prescriptions
        WHERE organization_id = ${organizationId}
          AND (${doctorId}::uuid IS NULL OR doctor_id = ${doctorId})
      `;
      return c.json({ stats: rows[0] || { pending: 0, dispensed_today: 0, dispensed_this_week: 0 } });
    },
  );

  routes.get(
    "/clinic/prescriptions",
    requireRole("clinic_admin", "doctor", "pharmacist"),
    async (c) => {
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await organizationForRequest(
        sql,
        actor,
        c.req.query("organization_id"),
      );
      const requestedDoctorId = queryUuid(c.req.query("doctor_id"), "doctor_id");
      if (actor.role === "doctor" && requestedDoctorId && requestedDoctorId !== actor.id) {
        throw new ApiError(403, "PRESCRIPTION_FORBIDDEN", "Doctors can only view their own prescriptions.");
      }
      const doctorId = actor.role === "doctor" ? actor.id : requestedDoctorId;
      const patientId = queryUuid(c.req.query("patient_id"), "patient_id");
      const visitId = queryUuid(c.req.query("visit_id"), "visit_id");
      const status = c.req.query("status") || null;
      if (status && !PRESCRIPTION_STATUSES.has(status)) {
        throw new ApiError(400, "VALIDATION_ERROR", "status is not supported.");
      }
      const date = c.req.query("date") || null;
      if (date && !isValidClinicDate(date)) {
        throw new ApiError(400, "VALIDATION_ERROR", "date must be a valid YYYY-MM-DD date.");
      }
      const limit = parseLimit(c.req.query("limit"), 100);
      const rows = await sql`
        SELECT p.id, p.organization_id, p.visit_id, p.patient_id, p.doctor_id,
          p.prescription_number, p.status, p.notes, p.dispensed_at,
          p.dispensed_by, p.created_at, p.updated_at,
          concat_ws(' ', patient.first_name, patient.last_name) AS patient_name,
          patient.patient_number,
          doctor.name AS doctor_name,
          COUNT(item.id)::int AS item_count,
          COALESCE(SUM(item.quantity), 0)::int AS total_quantity
        FROM clinic_prescriptions p
        JOIN clinic_patients patient
          ON patient.id = p.patient_id AND patient.organization_id = p.organization_id
        LEFT JOIN users doctor ON doctor.id = p.doctor_id
        LEFT JOIN clinic_prescription_items item ON item.prescription_id = p.id
        WHERE p.organization_id = ${organizationId}
          AND (${doctorId}::uuid IS NULL OR p.doctor_id = ${doctorId})
          AND (${patientId}::uuid IS NULL OR p.patient_id = ${patientId})
          AND (${visitId}::uuid IS NULL OR p.visit_id = ${visitId})
          AND (${status}::text IS NULL OR p.status = ${status})
          AND (${date}::date IS NULL OR
            (p.created_at AT TIME ZONE 'Africa/Kampala')::date = ${date}::date)
        GROUP BY p.id, patient.first_name, patient.last_name,
          patient.patient_number, doctor.name
        ORDER BY p.created_at DESC
        LIMIT ${limit}
      `;
      return c.json({ prescriptions: rows });
    },
  );

  routes.post(
    "/clinic/prescriptions",
    requireRole("doctor", "clinic_admin"),
    async (c) => {
      const actor = c.get("user");
      const body = await readJson(c);
      assertAllowedKeys(body, ["organization_id", "visit_id", "patient_id", "notes", "items"]);
      const visitId = body.visit_id == null || body.visit_id === ""
        ? null
        : pathUuid(String(body.visit_id), "visit_id");
      const bodyPatientId = body.patient_id == null || body.patient_id === ""
        ? null
        : pathUuid(String(body.patient_id), "patient_id");
      if (!visitId && !bodyPatientId) {
        throw new ApiError(400, "VALIDATION_ERROR", "patient_id is required when no visit is selected.");
      }
      const notes = optionalText(body, "notes", 4_000) ?? null;
      const items = parsePrescriptionItems(body.items);
      const sql = getDb(c.env);
      const organizationId = await organizationForRequest(
        sql,
        actor,
        typeof body.organization_id === "string" ? body.organization_id : undefined,
      );
      let patientId = bodyPatientId;
      if (visitId) {
        const visitRows = await sql`
          SELECT id, organization_id, patient_id, doctor_id, status
          FROM clinic_visits
          WHERE id = ${visitId} AND organization_id = ${organizationId}
            AND deleted_at IS NULL
          LIMIT 1
        `;
        const visit = visitRows[0] as {
          id: string;
          patient_id: string;
          doctor_id: string | null;
          status: string;
        } | undefined;
        if (!visit) throw new ApiError(404, "VISIT_NOT_FOUND", "The selected visit was not found.");
        if (visit.status === "voided") {
          throw new ApiError(409, "VISIT_NOT_PRESCRIBABLE", "A voided visit cannot have a prescription.");
        }
        if (actor.role === "doctor" && visit.doctor_id !== actor.id) {
          throw new ApiError(404, "VISIT_NOT_FOUND", "The selected visit was not found.");
        }
        if (patientId && patientId !== visit.patient_id) {
          throw new ApiError(400, "VISIT_PATIENT_MISMATCH", "The visit and patient must match.");
        }
        patientId = visit.patient_id;
      }
      const patientRows = await sql`
        SELECT id FROM clinic_patients
        WHERE id = ${patientId} AND organization_id = ${organizationId}
          AND status = 'active'
        LIMIT 1
      `;
      if (!patientRows[0]) {
        throw new ApiError(404, "PATIENT_NOT_FOUND", "The active patient was not found in this clinic.");
      }
      const validatedItems = await resolveMedicineNames(sql, organizationId, items);
      const itemsJson = itemPayload(validatedItems);
      const ip = requestIp(c);
      const metadata = JSON.stringify({
        patient_id: patientId,
        visit_id: visitId,
        item_count: validatedItems.length,
      });
      try {
        const rows = await sql`
          WITH current_period AS (
            SELECT TO_CHAR(NOW() AT TIME ZONE 'Africa/Kampala', 'YYYYMM') AS period
          ),
          allocation AS (
            INSERT INTO clinic_rx_number_counters (
              organization_id, period, current_value
            )
            SELECT ${organizationId}, current_period.period, 1
            FROM current_period
            ON CONFLICT (organization_id, period) DO UPDATE
              SET current_value = clinic_rx_number_counters.current_value + 1,
                updated_at = NOW()
            RETURNING period, current_value
          ),
          created AS (
            INSERT INTO clinic_prescriptions (
              organization_id, visit_id, patient_id, doctor_id,
              prescription_number, status, notes
            )
            SELECT ${organizationId}, ${visitId}, ${patientId}, ${actor.id},
              'RX-' || allocation.period || '-' ||
                LPAD(allocation.current_value::text, 4, '0'),
              'pending', ${notes}
            FROM allocation
            RETURNING *
          ),
          incoming AS (
            SELECT *
            FROM jsonb_to_recordset(${itemsJson}::jsonb) AS entry(
              medicine_id uuid, medicine_name text, dosage text,
              frequency text, duration text, route text, quantity integer,
              instructions text
            )
          ),
          inserted_items AS (
            INSERT INTO clinic_prescription_items (
              prescription_id, medicine_id, medicine_name, dosage,
              frequency, duration, route, quantity, instructions
            )
            SELECT created.id, incoming.medicine_id, incoming.medicine_name,
              incoming.dosage, incoming.frequency, incoming.duration,
              incoming.route, incoming.quantity, incoming.instructions
            FROM created CROSS JOIN incoming
            RETURNING id
          ),
          local_audit AS (
            INSERT INTO clinic_audit (
              organization_id, actor_id, action, target_table, target_id, metadata
            )
            SELECT organization_id, ${actor.id}, 'clinic.prescription_created',
              'clinic_prescriptions', id, ${metadata}::jsonb
            FROM created
            RETURNING id
          ),
          platform_audit AS (
            INSERT INTO audit_log (
              actor_id, sector, action, target_table, target_id, metadata, ip
            )
            SELECT ${actor.id}, 'clinic', 'clinic.prescription_created',
              'clinic_prescriptions', id, ${metadata}::jsonb, ${ip}
            FROM created
            RETURNING id
          )
          SELECT to_jsonb(created) AS prescription,
            (SELECT COUNT(*)::int FROM inserted_items) AS item_count
          FROM created
        `;
        if (!rows[0]) {
          throw new ApiError(500, "PRESCRIPTION_CREATE_FAILED", "The prescription could not be created.");
        }
        return c.json({
          prescription: (rows[0] as { prescription: unknown }).prescription,
          item_count: (rows[0] as { item_count: number }).item_count,
        }, 201);
      } catch (error) {
        routeError(error);
      }
    },
  );

  routes.get(
    "/clinic/prescriptions/:id",
    requireRole("clinic_admin", "doctor", "pharmacist"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await organizationForRequest(
        sql,
        actor,
        c.req.query("organization_id"),
      );
      const rows = await sql`
        SELECT p.id, p.organization_id, p.visit_id, p.patient_id, p.doctor_id,
          p.prescription_number, p.status, p.notes, p.dispensed_at,
          p.dispensed_by, p.created_at, p.updated_at,
          concat_ws(' ', patient.first_name, patient.last_name) AS patient_name,
          patient.patient_number, patient.phone AS patient_phone,
          doctor.name AS doctor_name, dispenser.name AS dispensed_by_name
        FROM clinic_prescriptions p
        JOIN clinic_patients patient
          ON patient.id = p.patient_id AND patient.organization_id = p.organization_id
        LEFT JOIN users doctor ON doctor.id = p.doctor_id
        LEFT JOIN users dispenser ON dispenser.id = p.dispensed_by
        WHERE p.id = ${id} AND p.organization_id = ${organizationId}
          AND (${actor.role !== "doctor"} OR p.doctor_id = ${actor.id})
        LIMIT 1
      `;
      const prescription = rows[0];
      if (!prescription) {
        throw new ApiError(404, "PRESCRIPTION_NOT_FOUND", "Prescription was not found.");
      }
      const [items, timeline] = await Promise.all([
        sql`
          SELECT id, medicine_id, medicine_name, dosage, frequency, duration,
            route, quantity, instructions, dispensed_quantity, created_at
          FROM clinic_prescription_items
          WHERE prescription_id = ${id}
          ORDER BY created_at, id
        `,
        sql`
          SELECT event.id, event.action, event.metadata, event.created_at,
            actor.name AS actor_name
          FROM clinic_audit event
          LEFT JOIN users actor ON actor.id = event.actor_id
          WHERE event.organization_id = ${organizationId}
            AND event.target_table = 'clinic_prescriptions'
            AND event.target_id = ${id}
          ORDER BY event.created_at, event.id
        `,
      ]);
      return c.json({ prescription, items, timeline });
    },
  );

  routes.patch(
    "/clinic/prescriptions/:id",
    requireRole("doctor"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const actor = c.get("user");
      const body = await readJson(c);
      assertAllowedKeys(body, ["organization_id", "notes", "items"]);
      const notes = optionalText(body, "notes", 4_000);
      const hasItems = "items" in body;
      const items = hasItems ? parsePrescriptionItems(body.items) : [];
      if (notes === undefined && !hasItems) {
        throw new ApiError(400, "VALIDATION_ERROR", "Provide notes or replacement items.");
      }
      const sql = getDb(c.env);
      const organizationId = await organizationForRequest(
        sql,
        actor,
        typeof body.organization_id === "string" ? body.organization_id : undefined,
      );
      const validatedItems = hasItems
        ? await resolveMedicineNames(sql, organizationId, items)
        : [];
      const itemsJson = itemPayload(validatedItems);
      const changed = JSON.stringify({
        notes_changed: notes !== undefined,
        items_replaced: hasItems,
        item_count: validatedItems.length,
      });
      const ip = requestIp(c);
      const rows = await sql`
        WITH target AS MATERIALIZED (
          SELECT id, organization_id, status
          FROM clinic_prescriptions
          WHERE id = ${id} AND organization_id = ${organizationId}
            AND doctor_id = ${actor.id}
          FOR UPDATE
        ),
        updated AS (
          UPDATE clinic_prescriptions p
          SET notes = CASE WHEN ${notes !== undefined} THEN ${notes ?? null} ELSE p.notes END,
            updated_at = NOW()
          FROM target
          WHERE p.id = target.id AND target.status = 'pending'
          RETURNING p.*
        ),
        removed_items AS (
          DELETE FROM clinic_prescription_items old_item
          USING updated
          WHERE old_item.prescription_id = updated.id AND ${hasItems}
          RETURNING old_item.id
        ),
        incoming AS (
          SELECT *
          FROM jsonb_to_recordset(${itemsJson}::jsonb) AS entry(
            medicine_id uuid, medicine_name text, dosage text,
            frequency text, duration text, route text, quantity integer,
            instructions text
          )
        ),
        inserted_items AS (
          INSERT INTO clinic_prescription_items (
            prescription_id, medicine_id, medicine_name, dosage,
            frequency, duration, route, quantity, instructions
          )
          SELECT updated.id, incoming.medicine_id, incoming.medicine_name,
            incoming.dosage, incoming.frequency, incoming.duration,
            incoming.route, incoming.quantity, incoming.instructions
          FROM updated CROSS JOIN incoming
          WHERE ${hasItems}
          RETURNING id
        ),
        local_audit AS (
          INSERT INTO clinic_audit (
            organization_id, actor_id, action, target_table, target_id, metadata
          )
          SELECT organization_id, ${actor.id}, 'clinic.prescription_updated',
            'clinic_prescriptions', id, ${changed}::jsonb
          FROM updated
          RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (
            actor_id, sector, action, target_table, target_id, metadata, ip
          )
          SELECT ${actor.id}, 'clinic', 'clinic.prescription_updated',
            'clinic_prescriptions', id, ${changed}::jsonb, ${ip}
          FROM updated
          RETURNING id
        )
        SELECT
          EXISTS(SELECT 1 FROM target) AS found,
          (SELECT status FROM target) AS current_status,
          (SELECT to_jsonb(updated) FROM updated) AS prescription
      `;
      const result = rows[0] as {
        found: boolean;
        current_status: string | null;
        prescription: unknown | null;
      } | undefined;
      if (!result?.found) {
        throw new ApiError(404, "PRESCRIPTION_NOT_FOUND", "Prescription was not found.");
      }
      if (!result.prescription) {
        throw new ApiError(409, "PRESCRIPTION_NOT_EDITABLE", "Only pending prescriptions can be edited.");
      }
      return c.json({ prescription: result.prescription });
    },
  );

  routes.post(
    "/clinic/prescriptions/:id/cancel",
    requireRole("doctor"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const actor = c.get("user");
      const body = await readJson(c);
      assertAllowedKeys(body, ["organization_id", "reason"]);
      const reason = requiredText(body.reason, "reason", 1_000);
      const sql = getDb(c.env);
      const organizationId = await organizationForRequest(
        sql,
        actor,
        typeof body.organization_id === "string" ? body.organization_id : undefined,
      );
      const metadata = JSON.stringify({ reason });
      const ip = requestIp(c);
      const rows = await sql`
        WITH target AS MATERIALIZED (
          SELECT id, organization_id, status
          FROM clinic_prescriptions
          WHERE id = ${id} AND organization_id = ${organizationId}
            AND doctor_id = ${actor.id}
          FOR UPDATE
        ),
        updated AS (
          UPDATE clinic_prescriptions p
          SET status = 'cancelled', updated_at = NOW()
          FROM target
          WHERE p.id = target.id AND target.status = 'pending'
          RETURNING p.*
        ),
        local_audit AS (
          INSERT INTO clinic_audit (
            organization_id, actor_id, action, target_table, target_id, metadata
          )
          SELECT organization_id, ${actor.id}, 'clinic.prescription_cancelled',
            'clinic_prescriptions', id, ${metadata}::jsonb
          FROM updated
          RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (
            actor_id, sector, action, target_table, target_id, metadata, ip
          )
          SELECT ${actor.id}, 'clinic', 'clinic.prescription_cancelled',
            'clinic_prescriptions', id, ${metadata}::jsonb, ${ip}
          FROM updated
          RETURNING id
        )
        SELECT
          EXISTS(SELECT 1 FROM target) AS found,
          (SELECT status FROM target) AS current_status,
          (SELECT to_jsonb(updated) FROM updated) AS prescription
      `;
      const result = rows[0] as {
        found: boolean;
        current_status: string | null;
        prescription: unknown | null;
      } | undefined;
      if (!result?.found) {
        throw new ApiError(404, "PRESCRIPTION_NOT_FOUND", "Prescription was not found.");
      }
      if (!result.prescription) {
        throw new ApiError(409, "PRESCRIPTION_NOT_CANCELLABLE", "Only pending prescriptions can be cancelled.");
      }
      return c.json({ prescription: result.prescription });
    },
  );

  routes.post(
    "/clinic/prescriptions/:id/dispense",
    requireRole("clinic_admin", "pharmacist"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await organizationForRequest(
        sql,
        actor,
        c.req.query("organization_id"),
      );
      const ip = requestIp(c);
      const metadata = JSON.stringify({ action: "dispense_all" });
      const rows = await sql`
        WITH target AS MATERIALIZED (
          SELECT p.*
          FROM clinic_prescriptions p
          WHERE p.id = ${id} AND p.organization_id = ${organizationId}
          FOR UPDATE
        ),
        rx_items AS MATERIALIZED (
          SELECT item.id, item.prescription_id, item.medicine_id,
            item.medicine_name, item.quantity
          FROM clinic_prescription_items item
          JOIN target ON target.id = item.prescription_id
        ),
        requirements AS MATERIALIZED (
          SELECT medicine_id, MAX(medicine_name) AS medicine_name,
            SUM(quantity)::int AS required_quantity
          FROM rx_items
          WHERE medicine_id IS NOT NULL
          GROUP BY medicine_id
        ),
        locked_medicines AS MATERIALIZED (
          SELECT medicine.id, medicine.name, medicine.current_stock,
            requirements.required_quantity
          FROM clinic_medicines medicine
          JOIN requirements ON requirements.medicine_id = medicine.id
          JOIN target ON target.organization_id = medicine.organization_id
          WHERE medicine.active IS TRUE
          ORDER BY medicine.id
          FOR UPDATE OF medicine
        ),
        shortages AS MATERIALIZED (
          SELECT requirements.medicine_id, requirements.medicine_name,
            requirements.required_quantity,
            COALESCE(locked_medicines.current_stock, 0)::int AS available
          FROM requirements
          LEFT JOIN locked_medicines
            ON locked_medicines.id = requirements.medicine_id
          WHERE locked_medicines.id IS NULL
            OR locked_medicines.current_stock < requirements.required_quantity
        ),
        stock_check AS MATERIALIZED (
          SELECT
            EXISTS(SELECT 1 FROM target WHERE status = 'pending')
              AND NOT EXISTS(SELECT 1 FROM shortages) AS can_dispense
        ),
        stock_updated AS (
          UPDATE clinic_medicines medicine
          SET current_stock = medicine.current_stock - locked_medicines.required_quantity,
            updated_at = NOW()
          FROM locked_medicines, stock_check
          WHERE medicine.id = locked_medicines.id
            AND stock_check.can_dispense IS TRUE
          RETURNING medicine.id, medicine.name, medicine.current_stock,
            locked_medicines.required_quantity
        ),
        updated AS (
          UPDATE clinic_prescriptions prescription
          SET status = 'dispensed', dispensed_at = NOW(),
            dispensed_by = ${actor.id}, updated_at = NOW()
          FROM target, stock_check
          WHERE prescription.id = target.id
            AND target.status = 'pending'
            AND stock_check.can_dispense IS TRUE
            AND (SELECT COUNT(*) FROM stock_updated) =
              (SELECT COUNT(*) FROM requirements)
          RETURNING prescription.*
        ),
        items_dispensed AS (
          UPDATE clinic_prescription_items item
          SET dispensed_quantity = item.quantity
          FROM updated
          WHERE item.prescription_id = updated.id
          RETURNING item.id
        ),
        movements AS (
          INSERT INTO clinic_stock_movements (
            organization_id, medicine_id, movement_type, quantity,
            balance_after, reference, notes, created_by
          )
          SELECT updated.organization_id, stock_updated.id, 'dispense',
            -stock_updated.required_quantity, stock_updated.current_stock,
            updated.prescription_number, 'Prescription dispensed', ${actor.id}
          FROM stock_updated CROSS JOIN updated
          RETURNING id
        ),
        local_audit AS (
          INSERT INTO clinic_audit (
            organization_id, actor_id, action, target_table, target_id, metadata
          )
          SELECT organization_id, ${actor.id}, 'clinic.prescription_dispensed',
            'clinic_prescriptions', id, ${metadata}::jsonb
          FROM updated
          RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (
            actor_id, sector, action, target_table, target_id, metadata, ip
          )
          SELECT ${actor.id}, 'clinic', 'clinic.prescription_dispensed',
            'clinic_prescriptions', id, ${metadata}::jsonb, ${ip}
          FROM updated
          RETURNING id
        )
        SELECT
          EXISTS(SELECT 1 FROM target) AS found,
          (SELECT status FROM target) AS current_status,
          (SELECT to_jsonb(updated) FROM updated) AS prescription,
          COALESCE((
            SELECT json_agg(json_build_object(
              'medicine_id', medicine_id,
              'medicine_name', medicine_name,
              'required_quantity', required_quantity,
              'available', available
            ))
            FROM shortages
          ), '[]'::json) AS shortages
      `;
      const result = rows[0] as {
        found: boolean;
        current_status: string | null;
        prescription: unknown | null;
        shortages: Array<{ medicine_name: string; required_quantity: number; available: number }> | string;
      } | undefined;
      if (!result?.found) {
        throw new ApiError(404, "PRESCRIPTION_NOT_FOUND", "Prescription was not found.");
      }
      if (result.current_status !== "pending") {
        throw new ApiError(409, "PRESCRIPTION_NOT_DISPENSABLE", "Only pending prescriptions can be dispensed.");
      }
      const shortages = typeof result.shortages === "string"
        ? JSON.parse(result.shortages) as Array<{ medicine_name: string; required_quantity: number; available: number }>
        : result.shortages || [];
      if (shortages.length) {
        return c.json({ error: `Insufficient stock for ${shortages[0].medicine_name}` }, 400);
      }
      if (!result.prescription) {
        throw new ApiError(409, "PRESCRIPTION_NOT_DISPENSABLE", "The prescription could not be dispensed.");
      }
      return c.json({ prescription: result.prescription });
    },
  );

  return routes;
}
