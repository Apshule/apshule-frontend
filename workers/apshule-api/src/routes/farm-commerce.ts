import { Hono, type Context } from "hono";
import { getDb, isUniqueViolation } from "../db.js";
import { requireRole } from "../auth.js";
import { readJson } from "../http.js";
import { calculateSaleTotals, nextMonthlySaleNumber } from "../farm-commerce-domain.js";
import type { AuthenticatedUser, AppEnv } from "../types.js";
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
  quantityValue,
  requiredText,
  workerLocation,
} from "../farm-commerce-shared.js";

const commerce = new Hono<AppEnv>();
const FARM_ROLES = ["farm_admin", "farm_manager", "farm_worker"] as const;
const ADMIN_MANAGER = ["farm_admin", "farm_manager"] as const;
const PAYMENT_CHANNELS = new Set(["mobile_money", "paypal", "bank", "card"]);
const SALE_STATUSES = new Set([
  "pending_owner_review", "payment_confirmed", "release_authorized",
  "released", "closed", "rejected", "cancelled",
]);
const PRODUCE_MOVEMENT_TYPES = new Set(["harvest", "purchase", "adjustment", "loss", "return"]);

function currentActor(c: { get(key: "user"): AuthenticatedUser }): AuthenticatedUser {
  return c.get("user");
}

function paymentChannel(value: unknown, field = "payment_channel"): string {
  if (typeof value !== "string" || !PAYMENT_CHANNELS.has(value)) {
    fail(400, "VALIDATION_ERROR", `${field} must be mobile_money, paypal, bank, or card.`);
  }
  return value;
}

function authorizationAudio(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") fail(400, "VALIDATION_ERROR", "verbal_authorization_audio must be base64 audio.");
  const match = value.match(/^data:(audio\/(?:mpeg|mp3|webm|ogg|wav|mp4|aac|x-m4a));base64,([A-Za-z0-9+/]*={0,2})$/iu);
  if (!match || !match[2] || match[2].length % 4 !== 0) {
    fail(400, "VALIDATION_ERROR", "Upload a valid audio recording encoded as base64.");
  }
  const decodedBytes = (match[2].length * 3) / 4 - (match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0);
  if (decodedBytes > 500 * 1024) {
    fail(400, "AUDIO_TOO_LARGE", "Verbal authorization audio must be 500 KB or smaller.");
  }
  return value;
}

function textQuery(value: string | undefined, name: string, max = 100): string | null {
  if (value === undefined || value === "") return null;
  if (value.length > max) fail(400, "VALIDATION_ERROR", `${name} is too long.`);
  return value.trim() || null;
}

async function validateProductLocation(
  sql: ReturnType<typeof getDb>,
  organizationId: string,
  produceId: string,
  locationId: string | null,
  workerOnly = false,
): Promise<Record<string, unknown>> {
  const rows = await sql`
    SELECT id, name, location_id, unit, current_stock, reorder_level, cost_price, selling_price, active
    FROM farm_produce
    WHERE id = ${produceId}
      AND organization_id = ${organizationId}
      AND active IS TRUE
      AND (${!workerOnly} OR location_id IS NULL OR location_id = ${locationId})
      AND (${locationId === null} OR location_id IS NULL OR location_id = ${locationId})
    LIMIT 1
  `;
  const produce = rows[0] as Record<string, unknown> | undefined;
  if (!produce) fail(404, "PRODUCE_NOT_FOUND", "Active produce was not found at this farm location.");
  return produce;
}

// Produce catalog and stock ledger
commerce.get("/produce", requireRole(...FARM_ROLES), async (c) => {
  const actor = currentActor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor);
  const requestedLocation = c.req.query("location_id");
  const locationId = requestedLocation ? pathUuid(requestedLocation, "location_id") : null;
  if (locationId) await assertLocationInOrganization(sql, scope.organizationId, locationId);
  const workerLocationId = actor.role === "farm_worker"
    ? workerLocation(actor, scope, locationId)
    : null;
  const search = textQuery(c.req.query("search"), "search");
  const category = textQuery(c.req.query("category"), "category");
  const lowStockValue = c.req.query("low_stock");
  if (lowStockValue && !["true", "false", "1", "0"].includes(lowStockValue)) {
    fail(400, "VALIDATION_ERROR", "low_stock must be true or false.");
  }
  const lowStock = lowStockValue === "true" || lowStockValue === "1";
  const includeInactive = actor.role !== "farm_worker" && c.req.query("active") === "all";
  const rows = await sql`
    SELECT p.id, p.organization_id, p.location_id, l.name AS location_name,
      p.name, p.category, p.unit, p.current_stock, p.reorder_level,
      p.cost_price, p.selling_price, p.active, p.created_at, p.updated_at,
      (p.reorder_level > 0 AND p.current_stock <= p.reorder_level) AS low_stock
    FROM farm_produce p
    LEFT JOIN farm_locations l ON l.id = p.location_id
    WHERE p.organization_id = ${scope.organizationId}
      AND (${includeInactive} OR p.active IS TRUE)
      AND (${search}::text IS NULL OR p.name ILIKE '%' || ${search} || '%' OR COALESCE(p.category, '') ILIKE '%' || ${search} || '%')
      AND (${category}::text IS NULL OR p.category = ${category})
      AND (NOT ${lowStock} OR (p.reorder_level > 0 AND p.current_stock <= p.reorder_level))
      AND (${locationId}::uuid IS NULL OR p.location_id = ${locationId})
      AND (${actor.role !== "farm_worker"} OR p.location_id IS NULL OR p.location_id = ${workerLocationId})
    ORDER BY p.active DESC, p.category NULLS LAST, p.name
  `;
  const produce = (rows as Array<Record<string, unknown>>).map((item) => {
    if (actor.role !== "farm_worker") return item;
    const { cost_price: _costPrice, ...publicItem } = item;
    return publicItem;
  });
  return c.json({ produce });
});

commerce.post("/produce", requireRole(...ADMIN_MANAGER), async (c) => {
  const actor = currentActor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor);
  const body = await readJson(c);
  const name = requiredText(body, "name");
  const category = optionalText(body, "category", 100);
  const unit = optionalText(body, "unit", 32) ?? "kg";
  const locationId = optionalUuid(body, "location_id") ?? null;
  const reorderLevel = quantityValue(body.reorder_level ?? 0, "reorder_level", { min: 0 });
  const costPrice = moneyValue(body.cost_price, "cost_price", true);
  const sellingPrice = moneyValue(body.selling_price, "selling_price", true);
  await assertLocationInOrganization(sql, scope.organizationId, locationId);
  const rows = await sql`
    INSERT INTO farm_produce
      (organization_id, location_id, name, category, unit, current_stock,
       reorder_level, cost_price, selling_price, created_by)
    VALUES
      (${scope.organizationId}, ${locationId}, ${name}, ${category}, ${unit}, 0,
       ${reorderLevel}, ${costPrice}, ${sellingPrice}, ${actor.id})
    RETURNING *
  `;
  const produce = rows[0] as Record<string, unknown>;
  await auditMutation(sql, actor, scope.organizationId, "farm.produce.created", "farm_produce",
    String(produce.id), { name, category, unit, location_id: locationId }, actorIp(c));
  return c.json({ produce }, 201);
});

commerce.patch("/produce/:id", requireRole(...ADMIN_MANAGER), async (c) => {
  const actor = currentActor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor);
  const id = pathUuid(c.req.param("id") || "");
  const body = await readJson(c);
  const name = optionalText(body, "name", 200);
  const category = optionalText(body, "category", 100);
  const unit = optionalText(body, "unit", 32);
  const locationId = optionalUuid(body, "location_id");
  const reorderLevel = body.reorder_level === undefined
    ? undefined
    : quantityValue(body.reorder_level, "reorder_level", { min: 0 });
  const costPrice = moneyValue(body.cost_price, "cost_price", true);
  const sellingPrice = moneyValue(body.selling_price, "selling_price", true);
  const active = body.active === undefined ? undefined : body.active;
  if (active !== undefined && typeof active !== "boolean") {
    fail(400, "VALIDATION_ERROR", "active must be true or false.");
  }
  if ([name, category, unit, locationId, reorderLevel, costPrice, sellingPrice, active].every((value) => value === undefined)) {
    fail(400, "VALIDATION_ERROR", "Provide at least one field to update.");
  }
  await assertLocationInOrganization(sql, scope.organizationId, locationId);
  const rows = await sql`
    UPDATE farm_produce
    SET name = CASE WHEN ${name !== undefined} THEN ${name} ELSE name END,
        category = CASE WHEN ${category !== undefined} THEN ${category} ELSE category END,
        unit = CASE WHEN ${unit !== undefined} THEN ${unit} ELSE unit END,
        location_id = CASE WHEN ${locationId !== undefined} THEN ${locationId}::uuid ELSE location_id END,
        reorder_level = CASE WHEN ${reorderLevel !== undefined} THEN ${reorderLevel}::numeric ELSE reorder_level END,
        cost_price = CASE WHEN ${"cost_price" in body} THEN ${costPrice}::numeric ELSE cost_price END,
        selling_price = CASE WHEN ${"selling_price" in body} THEN ${sellingPrice}::numeric ELSE selling_price END,
        active = CASE WHEN ${active !== undefined} THEN ${active}::boolean ELSE active END,
        updated_at = NOW()
    WHERE id = ${id} AND organization_id = ${scope.organizationId}
    RETURNING *
  `;
  const produce = rows[0] as Record<string, unknown> | undefined;
  if (!produce) fail(404, "PRODUCE_NOT_FOUND", "Produce was not found.");
  await auditMutation(sql, actor, scope.organizationId, "farm.produce.updated", "farm_produce",
    id, { changed_fields: Object.keys(body) }, actorIp(c));
  return c.json({ produce });
});

commerce.delete("/produce/:id", requireRole("farm_admin"), async (c) => {
  const actor = currentActor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor);
  const id = pathUuid(c.req.param("id"));
  const rows = await sql`
    UPDATE farm_produce
    SET active = FALSE, updated_at = NOW()
    WHERE id = ${id} AND organization_id = ${scope.organizationId} AND active IS TRUE
    RETURNING id, name
  `;
  const produce = rows[0] as { id?: string; name?: string } | undefined;
  if (!produce) fail(404, "PRODUCE_NOT_FOUND", "Active produce was not found.");
  await auditMutation(sql, actor, scope.organizationId, "farm.produce.deactivated", "farm_produce",
    id, { name: produce.name, soft_delete: true }, actorIp(c));
  return c.json({ ok: true });
});

async function adjustProduce(
  c: Context<AppEnv>,
  options: { workerHarvestOnly: boolean },
): Promise<Response> {
  const actor = currentActor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor);
  const id = pathUuid(c.req.param("id") || "");
  const body = await readJson(c);
  const movementType = options.workerHarvestOnly ? "harvest" : body.movement_type;
  if (typeof movementType !== "string" || !PRODUCE_MOVEMENT_TYPES.has(movementType)) {
    fail(400, "VALIDATION_ERROR", "movement_type must be harvest, purchase, adjustment, loss, or return.");
  }
  if (options.workerHarvestOnly && body.movement_type !== undefined && body.movement_type !== "harvest") {
    fail(400, "VALIDATION_ERROR", "Farm workers can only record harvest movements here.");
  }
  let quantityChange = quantityValue(body.quantity_change, "quantity_change", { allowNegative: true });
  if (movementType === "loss" && quantityChange > 0) quantityChange *= -1;
  if (movementType !== "loss" && movementType !== "adjustment" && quantityChange <= 0) {
    fail(400, "VALIDATION_ERROR", `${movementType} quantity_change must be greater than zero.`);
  }
  if (quantityChange === 0) fail(400, "VALIDATION_ERROR", "quantity_change cannot be zero.");
  const unitCost = moneyValue(body.unit_cost, "unit_cost", true);
  const notes = optionalText(body, "notes", 1000);
  const product = await validateProductLocation(
    sql,
    scope.organizationId,
    id,
    scope.locationId,
    options.workerHarvestOnly && actor.role === "farm_worker",
  );
  const rows = await sql`
    WITH changed AS (
      UPDATE farm_produce
      SET current_stock = current_stock + ${quantityChange}::numeric,
          updated_at = NOW()
      WHERE id = ${id}
        AND organization_id = ${scope.organizationId}
        AND active IS TRUE
        AND current_stock + ${quantityChange}::numeric >= 0
        AND (${!options.workerHarvestOnly || actor.role !== "farm_worker"} OR location_id IS NULL OR location_id = ${scope.locationId})
      RETURNING id, organization_id, current_stock
    ),
    inserted_movement AS (
      INSERT INTO farm_produce_movements
        (organization_id, produce_id, movement_type, quantity, balance_after,
         unit_cost, notes, recorded_by)
      SELECT organization_id, id, ${movementType}, ${quantityChange}::numeric,
        current_stock, ${unitCost}, ${notes}, ${actor.id}
      FROM changed
      RETURNING id
    )
    SELECT changed.id, changed.current_stock, inserted_movement.id AS movement_id
    FROM changed CROSS JOIN inserted_movement
  `;
  const changed = rows[0] as { id?: string; current_stock?: number | string; movement_id?: string } | undefined;
  if (!changed) {
    const current = await sql`
      SELECT current_stock
      FROM farm_produce
      WHERE id = ${id} AND organization_id = ${scope.organizationId}
        AND active IS TRUE
        AND (${!options.workerHarvestOnly || actor.role !== "farm_worker"} OR location_id IS NULL OR location_id = ${scope.locationId})
      LIMIT 1
    `;
    if (!current.length) fail(404, "PRODUCE_NOT_FOUND", "Active produce was not found.");
    fail(400, "INSUFFICIENT_STOCK", "This adjustment would make stock negative.");
  }
  await auditMutation(sql, actor, scope.organizationId, "farm.produce.stock_adjusted", "farm_produce",
    id, { name: product.name, movement_type: movementType, quantity_change: quantityChange,
      balance_after: changed.current_stock, notes }, actorIp(c));
  return c.json({ produce: { ...product, current_stock: changed.current_stock }, movement_id: changed.movement_id });
}

commerce.post("/produce/:id/adjust", requireRole(...ADMIN_MANAGER), (c) =>
  adjustProduce(c, { workerHarvestOnly: false }));
commerce.post("/produce/:id/harvest", requireRole(...FARM_ROLES), (c) =>
  adjustProduce(c, { workerHarvestOnly: true }));

commerce.get("/produce/:id/movements", requireRole(...FARM_ROLES), async (c) => {
  const actor = currentActor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor);
  const id = pathUuid(c.req.param("id"));
  const product = await validateProductLocation(
    sql,
    scope.organizationId,
    id,
    scope.locationId,
    actor.role === "farm_worker",
  );
  const [movementRows, saleRows] = await Promise.all([
    sql`
      SELECT id, movement_type, quantity, balance_after, unit_cost, reference, notes,
        recorded_by, created_at
      FROM farm_produce_movements
      WHERE organization_id = ${scope.organizationId} AND produce_id = ${id}
        AND (${actor.role !== "farm_worker"} OR recorded_by = ${actor.id})
      ORDER BY created_at DESC
      LIMIT 100
    `,
    sql`
       SELECT s.id AS sale_id, s.sale_number, s.sale_date, s.buyer_name,
         s.status, i.quantity, i.unit_price, i.total
      FROM farm_sale_items i
      JOIN farm_sales s ON s.id = i.sale_id
      WHERE s.organization_id = ${scope.organizationId} AND i.produce_id = ${id}
         AND (${actor.role !== "farm_worker"} OR s.recorded_by = ${actor.id})
      ORDER BY s.sale_date DESC, s.created_at DESC
      LIMIT 20
    `,
  ]);
  const { cost_price: _costPrice, ...visibleProduct } = actor.role === "farm_worker" ? product : { ...product };
  return c.json({
    produce: visibleProduct,
    movements: movementRows,
    recent_sales: saleRows,
  });
});

// A sale is a workflow record: inventory remains unchanged until release.
commerce.get("/sales", requireRole(...FARM_ROLES), async (c) => {
  const actor = currentActor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor);
  const from = dateValue(c.req.query("from"), "from", true);
  const to = dateValue(c.req.query("to"), "to", true);
  if (from && to && from > to) fail(400, "VALIDATION_ERROR", "from must be on or before to.");
  const status = textQuery(c.req.query("status"), "status", 20);
  if (status && !SALE_STATUSES.has(status)) {
    fail(400, "VALIDATION_ERROR", "status is not a valid sale workflow state.");
  }
  const requestedLocation = c.req.query("location_id");
  const locationId = requestedLocation ? pathUuid(requestedLocation, "location_id") : null;
  if (locationId) await assertLocationInOrganization(sql, scope.organizationId, locationId);
  const effectiveLocation = actor.role === "farm_worker" ? workerLocation(actor, scope, locationId) : locationId;
  const rows = await sql`
    SELECT s.id, s.sale_number, s.location_id, l.name AS location_name, s.buyer_name,
      s.buyer_phone, s.sale_date, s.status, s.payment_channel,
      s.external_payment_reference, s.payment_confirmed_by, s.payment_confirmed_at,
      s.release_authorized_by, s.release_authorized_at, s.released_by, s.released_at,
      s.rejection_reason, s.rejected_by, s.rejected_at, s.total, s.amount_paid,
      s.balance_due, s.notes, s.recorded_by,
      COALESCE(NULLIF(BTRIM(u.name), ''), 'Farm team') AS recorded_by_name,
      COALESCE(NULLIF(BTRIM(owner_user.name), ''), 'Farm owner') AS release_authorized_by_name,
      COUNT(i.id)::int AS item_count,
      COALESCE(jsonb_agg(jsonb_build_object('produce_name', i.produce_name,
        'quantity', i.quantity, 'unit_price', i.unit_price, 'total', i.total))
        FILTER (WHERE i.id IS NOT NULL), '[]'::jsonb) AS items
    FROM farm_sales s
    LEFT JOIN farm_locations l ON l.id = s.location_id
    LEFT JOIN users u ON u.id = s.recorded_by
    LEFT JOIN users owner_user ON owner_user.id = s.release_authorized_by
    LEFT JOIN farm_sale_items i ON i.sale_id = s.id
    WHERE s.organization_id = ${scope.organizationId}
      AND (${from}::date IS NULL OR s.sale_date >= ${from}::date)
      AND (${to}::date IS NULL OR s.sale_date <= ${to}::date)
      AND (${status}::text IS NULL OR s.status = ${status})
      AND (${effectiveLocation}::uuid IS NULL OR s.location_id = ${effectiveLocation})
      AND (${actor.role !== "farm_worker"} OR s.recorded_by = ${actor.id})
    GROUP BY s.id, l.name, u.name, owner_user.name
    ORDER BY s.sale_date DESC, s.created_at DESC
    LIMIT 500
  `;
  return c.json({ sales: rows });
});

commerce.get("/sales/:id", requireRole(...FARM_ROLES), async (c) => {
  const actor = currentActor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor);
  const id = pathUuid(c.req.param("id"));
  const sales = await sql`
    SELECT s.*, l.name AS location_name,
      COALESCE(NULLIF(BTRIM(owner_user.name), ''), 'Farm owner') AS release_authorized_by_name
    FROM farm_sales s
    LEFT JOIN farm_locations l ON l.id = s.location_id
    LEFT JOIN users owner_user ON owner_user.id = s.release_authorized_by
    WHERE s.id = ${id} AND s.organization_id = ${scope.organizationId}
      AND (${actor.role !== "farm_worker"} OR s.recorded_by = ${actor.id})
    LIMIT 1
  `;
  const sale = sales[0] as Record<string, unknown> | undefined;
  if (!sale) fail(404, "SALE_NOT_FOUND", "Sale was not found.");
  const items = await sql`
    SELECT i.id, i.produce_id, i.produce_name, i.quantity, i.unit_price, i.total, i.created_at
    FROM farm_sale_items i
    WHERE i.sale_id = ${id}
    ORDER BY i.created_at, i.id
  `;
  return c.json({ sale, items });
});

async function nextSaleNumber(
  sql: ReturnType<typeof getDb>,
  organizationId: string,
  yearMonth: string,
): Promise<string> {
  const pattern = `^SAL-${yearMonth}-[0-9]{4}$`;
  const rows = await sql`
    SELECT COALESCE(MAX(SUBSTRING(s.sale_number FROM 12)::integer), 0)::int AS last_sequence
    FROM farm_sales s
    WHERE s.organization_id = ${organizationId}
      AND s.sale_number ~ ${pattern}
  `;
  const last = Number((rows[0] as { last_sequence?: number | string } | undefined)?.last_sequence || 0);
  try {
    return nextMonthlySaleNumber(yearMonth, last);
  } catch (error) {
    fail(409, "SALE_NUMBER_LIMIT", error instanceof Error ? error.message : "The monthly sale-number limit has been reached.");
  }
}

async function insertSaleAtomically(
  c: Context<AppEnv>,
  input: {
    organizationId: string;
    actor: AuthenticatedUser;
    locationId: string | null;
    saleNumber: string;
    saleDate: string;
    buyerName: string | null;
    buyerPhone: string | null;
    status: "pending_owner_review" | "payment_confirmed";
    paymentChannel: string | null;
    externalPaymentReference: string | null;
    totals: ReturnType<typeof calculateSaleTotals>;
    amountPaid: number;
    notes: string | null;
    items: Array<{ produce_id: string; quantity: number; unit_price: number }>;
  },
): Promise<Record<string, unknown>> {
  const sql = getDb(c.env);
  const itemsJson = JSON.stringify(input.items);
  const metadata = JSON.stringify({
    sale_number: input.saleNumber,
    total: input.totals.total,
    status: input.status,
    amount_paid: input.amountPaid,
    balance_due: input.totals.total - input.amountPaid,
    item_count: input.items.length,
  });
  const rows = await sql`
    WITH requested AS MATERIALIZED (
      SELECT item.produce_id, item.quantity, item.unit_price
      FROM jsonb_to_recordset(${itemsJson}::jsonb)
        AS item(produce_id uuid, quantity numeric, unit_price numeric)
    ),
    requested_products AS MATERIALIZED (
      SELECT DISTINCT produce_id FROM requested
    ),
    locked_products AS MATERIALIZED (
      SELECT p.id, p.name, p.current_stock, p.cost_price
      FROM farm_produce p
      JOIN requested_products r ON r.produce_id = p.id
      WHERE p.organization_id = ${input.organizationId}
        AND p.active IS TRUE
        AND (${input.locationId}::uuid IS NULL OR p.location_id IS NULL OR p.location_id = ${input.locationId})
      ORDER BY p.id
      FOR UPDATE OF p
    ),
    stock_check AS (
      SELECT
        (SELECT COUNT(*) FROM requested_products r LEFT JOIN locked_products p ON p.id = r.produce_id
          WHERE p.id IS NULL)::int AS missing_count
    ),
    inserted_sale AS (
      INSERT INTO farm_sales
        (organization_id, location_id, sale_number, buyer_name, buyer_phone, sale_date,
         status, payment_channel, external_payment_reference, payment_confirmed_by,
         payment_confirmed_at, subtotal, discount, total, amount_paid, balance_due,
         notes, recorded_by)
      SELECT ${input.organizationId}, ${input.locationId}, ${input.saleNumber},
        ${input.buyerName}, ${input.buyerPhone}, ${input.saleDate}, ${input.status},
        ${input.paymentChannel}, ${input.externalPaymentReference},
        CASE WHEN ${input.status} = 'payment_confirmed' THEN ${input.actor.id}::uuid ELSE NULL END,
        CASE WHEN ${input.status} = 'payment_confirmed' THEN NOW() ELSE NULL END,
        ${input.totals.subtotal}, ${input.totals.discount},
        ${input.totals.total}, ${input.amountPaid}, ${input.totals.total - input.amountPaid},
        ${input.notes}, ${input.actor.id}
      FROM stock_check
      WHERE missing_count = 0
      RETURNING *
    ),
    inserted_items AS (
      INSERT INTO farm_sale_items (sale_id, produce_id, produce_name, quantity, unit_price, total)
      SELECT s.id, r.produce_id, p.name, r.quantity, r.unit_price,
        ROUND(r.quantity * r.unit_price)::numeric
      FROM inserted_sale s
      CROSS JOIN requested r
      JOIN locked_products p ON p.id = r.produce_id
      RETURNING id
    ),
    farm_entry AS (
      INSERT INTO farm_audit
        (organization_id, actor_id, action, target_table, target_id, metadata)
      SELECT ${input.organizationId}, ${input.actor.id}, 'farm.sale.created', 'farm_sales',
        s.id, ${metadata}::jsonb
      FROM inserted_sale s
      RETURNING id
    ),
    audit_entry AS (
      INSERT INTO audit_log
        (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT ${input.actor.id}, 'farm', 'farm.sale.created', 'farm_sales',
        s.id, ${metadata}::jsonb, ${actorIp(c)}
      FROM inserted_sale s
      RETURNING id
    )
    SELECT s.*, stock_check.missing_count
    FROM stock_check
    LEFT JOIN inserted_sale s ON TRUE
  `;
  const result = rows[0] as Record<string, unknown> | undefined;
  if (!result || Number(result.missing_count) > 0) {
    fail(404, "PRODUCE_NOT_FOUND", "One or more sale products are unavailable at this farm location.");
  }
  if (!result.id) fail(409, "SALE_NOT_CREATED", "The sale could not be saved.");
  return result;
}

commerce.post("/sales", requireRole("farm_worker"), async (c) => {
  const actor = currentActor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor);
  const body = await readJson(c);
  if ("payment_channel" in body || "external_payment_reference" in body || "amount_paid" in body) {
    fail(403, "WORKER_PAYMENT_FORBIDDEN", "Farm workers cannot record or handle buyer payments.");
  }
  if ("discount" in body) {
    fail(403, "WORKER_DISCOUNT_FORBIDDEN", "Farm workers cannot apply sale discounts.");
  }
  const bodyLocationId = optionalUuid(body, "location_id") ?? null;
  const locationId = workerLocation(actor, scope, bodyLocationId);
  await assertLocationInOrganization(sql, scope.organizationId, locationId);
  const saleDate = dateValue(body.sale_date, "sale_date", true) || await (async () => {
    const rows = await sql`
      SELECT to_char(NOW() AT TIME ZONE COALESCE(
        (SELECT timezone FROM farm_settings WHERE organization_id = ${scope.organizationId} LIMIT 1),
        'Africa/Kampala'
      ), 'YYYY-MM-DD') AS today
    `;
    return String((rows[0] as { today?: string } | undefined)?.today || new Date().toISOString().slice(0, 10));
  })();
  const buyerName = optionalText(body, "buyer_name", 200) ?? null;
  const buyerPhone = optionalText(body, "buyer_phone", 40) ?? null;
  const notes = optionalText(body, "notes", 2000) ?? null;
  const status = "pending_owner_review";
  const paymentChannelValue = null;
  const externalPaymentReference = null;
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) {
    fail(400, "VALIDATION_ERROR", "A sale must contain between 1 and 100 items.");
  }
  const submittedItems = body.items as Array<Record<string, unknown>>;
  const ids = submittedItems.map((item) => {
    if (typeof item?.produce_id !== "string") fail(400, "VALIDATION_ERROR", "Each sale item needs a produce_id.");
    return pathUuid(item.produce_id, "produce_id");
  });
  if (new Set(ids).size !== ids.length) {
    fail(400, "VALIDATION_ERROR", "Each produce item may appear only once per sale.");
  }
  const products = await sql`
    SELECT id, name, location_id, selling_price, current_stock
    FROM farm_produce
    WHERE organization_id = ${scope.organizationId}
      AND id = ANY(${ids}::uuid[])
      AND active IS TRUE
      AND (${locationId}::uuid IS NULL OR location_id IS NULL OR location_id = ${locationId})
      AND (location_id IS NULL OR location_id = ${scope.locationId})
  `;
  const productMap = new Map((products as Array<Record<string, unknown>>).map((product) => [String(product.id), product]));
  if (productMap.size !== ids.length) {
    fail(404, "PRODUCE_NOT_FOUND", "One or more sale products are unavailable at this farm location.");
  }
  const items = submittedItems.map((item, index) => {
    const product = productMap.get(ids[index])!;
    const quantity = quantityValue(item.quantity, `items[${index}].quantity`);
    const unitPrice = item.unit_price === undefined
      ? moneyValue(product.selling_price, `items[${index}].unit_price`)
      : moneyValue(item.unit_price, `items[${index}].unit_price`);
    if (unitPrice === null) fail(400, "VALIDATION_ERROR", `Set a selling price for ${String(product.name)} before recording the sale.`);
    return { produce_id: ids[index], quantity, unit_price: unitPrice };
  });
  const discount = 0;
  let totals: ReturnType<typeof calculateSaleTotals>;
  try {
    totals = calculateSaleTotals(items, discount);
  } catch (error) {
    fail(400, "VALIDATION_ERROR", error instanceof Error ? error.message : "Sale totals are invalid.");
  }
  const amountPaid = 0;
  const yearMonth = saleDate.slice(0, 4) + saleDate.slice(5, 7);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const saleNumber = await nextSaleNumber(sql, scope.organizationId, yearMonth);
    try {
      const sale = await insertSaleAtomically(c, {
        organizationId: scope.organizationId,
        actor,
        locationId,
        saleNumber,
        saleDate,
        buyerName,
        buyerPhone,
        status,
        paymentChannel: paymentChannelValue,
        externalPaymentReference,
        totals,
        amountPaid,
        notes,
        items,
      });
      return c.json({ sale }, 201);
    } catch (error) {
      if (!isUniqueViolation(error) || attempt === 2) throw error;
    }
  }
  fail(409, "SALE_NUMBER_CONFLICT", "Could not allocate a sale number. Try again.");
});

commerce.post("/sales/:id/confirm-payment", requireRole(...ADMIN_MANAGER), async (c) => {
  const actor = currentActor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor);
  const id = pathUuid(c.req.param("id"));
  const body = await readJson(c);
  const channel = paymentChannel(body.payment_channel);
  const reference = optionalText(body, "external_payment_reference", 200) ?? null;
  const notes = optionalText(body, "notes", 2000) ?? null;
  const metadata = JSON.stringify({ payment_channel: channel, external_payment_reference: reference, notes });
  const rows = await sql`
    WITH updated AS (
      UPDATE farm_sales
      SET status = 'payment_confirmed',
          payment_channel = ${channel},
          external_payment_reference = ${reference},
          payment_confirmation_notes = ${notes},
          payment_confirmed_by = ${actor.id},
          payment_confirmed_at = NOW(),
          amount_paid = total,
          balance_due = 0
      WHERE id = ${id} AND organization_id = ${scope.organizationId}
        AND status = 'pending_owner_review'
      RETURNING *
    ),
    farm_entry AS (
      INSERT INTO farm_audit (organization_id, actor_id, action, target_table, target_id, metadata)
      SELECT ${scope.organizationId}, ${actor.id}, 'farm.sale.payment_confirmed',
        'farm_sales', id, ${metadata}::jsonb FROM updated RETURNING id
    ),
    audit_entry AS (
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT ${actor.id}, 'farm', 'farm.sale.payment_confirmed',
        'farm_sales', id, ${metadata}::jsonb, ${actorIp(c)} FROM updated RETURNING id
    )
    SELECT * FROM updated
  `;
  const sale = rows[0] as Record<string, unknown> | undefined;
  if (!sale) fail(409, "SALE_STATE_CONFLICT", "Only a sale awaiting owner review can be confirmed. Reload the sale.");
  return c.json({ sale });
});

commerce.post("/sales/:id/authorize-release", requireRole(...ADMIN_MANAGER), async (c) => {
  const actor = currentActor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor);
  const id = pathUuid(c.req.param("id"));
  const body = await readJson(c);
  const audio = authorizationAudio(body.verbal_authorization_audio);
  const notes = optionalText(body, "notes", 2000) ?? null;
  const metadata = JSON.stringify({ has_verbal_authorization_audio: Boolean(audio), notes });
  const rows = await sql`
    WITH updated AS (
      UPDATE farm_sales
      SET status = 'release_authorized',
          verbal_authorization_audio = ${audio},
          release_authorization_notes = ${notes},
          release_authorized_by = ${actor.id},
          release_authorized_at = NOW()
      WHERE id = ${id} AND organization_id = ${scope.organizationId}
        AND status = 'payment_confirmed'
      RETURNING *
    ),
    farm_entry AS (
      INSERT INTO farm_audit (organization_id, actor_id, action, target_table, target_id, metadata)
      SELECT ${scope.organizationId}, ${actor.id}, 'farm.sale.release_authorized',
        'farm_sales', id, ${metadata}::jsonb FROM updated RETURNING id
    ),
    audit_entry AS (
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT ${actor.id}, 'farm', 'farm.sale.release_authorized',
        'farm_sales', id, ${metadata}::jsonb, ${actorIp(c)} FROM updated RETURNING id
    )
    SELECT * FROM updated
  `;
  const sale = rows[0] as Record<string, unknown> | undefined;
  if (!sale) fail(409, "SALE_STATE_CONFLICT", "Only a sale with confirmed payment can be authorized for release.");
  return c.json({ sale });
});

commerce.post("/sales/:id/mark-released", requireRole("farm_worker"), async (c) => {
  const actor = currentActor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor);
  const id = pathUuid(c.req.param("id"));
  const releaseLocation = workerLocation(actor, scope);
  const metadata = JSON.stringify({ released_at: "server time" });
  const rows = await sql`
    WITH selected_sale AS MATERIALIZED (
      SELECT s.id, s.organization_id, s.sale_number, s.location_id
      FROM farm_sales s
      WHERE s.id = ${id}
        AND s.organization_id = ${scope.organizationId}
        AND s.status = 'release_authorized'
        AND s.recorded_by = ${actor.id}
        AND s.location_id = ${releaseLocation}
      FOR UPDATE OF s
    ),
    requested AS MATERIALIZED (
      SELECT i.produce_id, SUM(i.quantity)::numeric AS quantity
      FROM farm_sale_items i
      JOIN selected_sale s ON s.id = i.sale_id
      GROUP BY i.produce_id
    ),
    locked_products AS MATERIALIZED (
      SELECT p.id, p.organization_id, p.current_stock, p.cost_price
      FROM farm_produce p
      JOIN requested r ON r.produce_id = p.id
      JOIN selected_sale s ON s.organization_id = p.organization_id
      WHERE p.active IS TRUE
        AND (s.location_id IS NULL OR p.location_id IS NULL OR p.location_id = s.location_id)
      ORDER BY p.id
      FOR UPDATE OF p
    ),
    stock_check AS (
      SELECT
        (SELECT COUNT(*) FROM requested r LEFT JOIN locked_products p ON p.id = r.produce_id
          WHERE p.id IS NULL)::int AS missing_count,
        (SELECT COUNT(*) FROM requested r JOIN locked_products p ON p.id = r.produce_id
          WHERE p.current_stock < r.quantity)::int AS shortage_count
    ),
    deducted AS (
      UPDATE farm_produce p
      SET current_stock = p.current_stock - r.quantity,
          updated_at = NOW()
      FROM requested r
      JOIN locked_products lp ON lp.id = r.produce_id
      CROSS JOIN stock_check check_result
      WHERE p.id = r.produce_id
        AND p.current_stock >= r.quantity
        AND check_result.missing_count = 0
        AND check_result.shortage_count = 0
      RETURNING p.id, p.organization_id, p.current_stock, p.cost_price
    ),
    released_sale AS (
      UPDATE farm_sales s
      SET status = 'released', released_by = ${actor.id}, released_at = NOW()
      FROM selected_sale selected
      WHERE s.id = selected.id
        AND (SELECT COUNT(*) FROM deducted) = (SELECT COUNT(*) FROM requested)
      RETURNING s.*
    ),
    inserted_movements AS (
      INSERT INTO farm_produce_movements
        (organization_id, produce_id, movement_type, quantity, balance_after,
         unit_cost, reference, recorded_by)
      SELECT d.organization_id, d.id, 'sale', -r.quantity, d.current_stock,
        d.cost_price, selected.sale_number, ${actor.id}
      FROM deducted d
      JOIN requested r ON r.produce_id = d.id
      CROSS JOIN selected_sale selected
      RETURNING id
    ),
    farm_entry AS (
      INSERT INTO farm_audit (organization_id, actor_id, action, target_table, target_id, metadata)
      SELECT ${scope.organizationId}, ${actor.id}, 'farm.sale.released',
        'farm_sales', id, ${metadata}::jsonb FROM released_sale RETURNING id
    ),
    audit_entry AS (
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT ${actor.id}, 'farm', 'farm.sale.released',
        'farm_sales', id, ${metadata}::jsonb, ${actorIp(c)} FROM released_sale RETURNING id
    )
    SELECT stock_check.missing_count, stock_check.shortage_count, released_sale.*
    FROM stock_check LEFT JOIN released_sale ON TRUE
  `;
  const result = rows[0] as Record<string, unknown> | undefined;
  if (Number(result?.missing_count) > 0) {
    fail(409, "SALE_PRODUCT_UNAVAILABLE", "A sale item is no longer active or available at this farm location.");
  }
  if (Number(result?.shortage_count) > 0) {
    fail(409, "INSUFFICIENT_STOCK", "Stock changed before release. No items were released; adjust stock and retry.");
  }
  if (!result?.id) {
    fail(409, "SALE_STATE_CONFLICT", "Only your own release-authorized sale can be marked released.");
  }
  return c.json({ sale: result });
});

commerce.post("/sales/:id/close", requireRole(...ADMIN_MANAGER), async (c) => {
  const actor = currentActor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor);
  const id = pathUuid(c.req.param("id"));
  const metadata = JSON.stringify({ closed_at: "server time" });
  const rows = await sql`
    WITH updated AS (
      UPDATE farm_sales
      SET status = 'closed', closed_by = ${actor.id}, closed_at = NOW()
      WHERE id = ${id} AND organization_id = ${scope.organizationId} AND status = 'released'
      RETURNING *
    ),
    farm_entry AS (
      INSERT INTO farm_audit (organization_id, actor_id, action, target_table, target_id, metadata)
      SELECT ${scope.organizationId}, ${actor.id}, 'farm.sale.closed',
        'farm_sales', id, ${metadata}::jsonb FROM updated RETURNING id
    ),
    audit_entry AS (
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT ${actor.id}, 'farm', 'farm.sale.closed',
        'farm_sales', id, ${metadata}::jsonb, ${actorIp(c)} FROM updated RETURNING id
    )
    SELECT * FROM updated
  `;
  const sale = rows[0] as Record<string, unknown> | undefined;
  if (!sale) fail(409, "SALE_STATE_CONFLICT", "Only a released sale can be closed.");
  return c.json({ sale });
});

commerce.post("/sales/:id/reject", requireRole(...ADMIN_MANAGER), async (c) => {
  const actor = currentActor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor);
  const id = pathUuid(c.req.param("id"));
  const body = await readJson(c);
  const reason = requiredText(body, "reason", 1000);
  const metadata = JSON.stringify({ reason });
  const rows = await sql`
    WITH updated AS (
      UPDATE farm_sales
      SET status = 'rejected', rejection_reason = ${reason},
          rejected_by = ${actor.id}, rejected_at = NOW()
      WHERE id = ${id} AND organization_id = ${scope.organizationId} AND status <> 'closed'
      RETURNING *
    ),
    farm_entry AS (
      INSERT INTO farm_audit (organization_id, actor_id, action, target_table, target_id, metadata)
      SELECT ${scope.organizationId}, ${actor.id}, 'farm.sale.rejected',
        'farm_sales', id, ${metadata}::jsonb FROM updated RETURNING id
    ),
    audit_entry AS (
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT ${actor.id}, 'farm', 'farm.sale.rejected',
        'farm_sales', id, ${metadata}::jsonb, ${actorIp(c)} FROM updated RETURNING id
    )
    SELECT * FROM updated
  `;
  const sale = rows[0] as Record<string, unknown> | undefined;
  if (!sale) fail(409, "SALE_STATE_CONFLICT", "A closed sale cannot be rejected.");
  return c.json({ sale });
});

commerce.post("/sales/:id/cancel", requireRole(...ADMIN_MANAGER), async (c) => {
  const actor = currentActor(c);
  const sql = getDb(c.env);
  const scope = await farmScope(sql, actor);
  const id = pathUuid(c.req.param("id"));
  const metadata = JSON.stringify({ reason: "Cancelled before goods were released." });
  const rows = await sql`
    WITH updated AS (
      UPDATE farm_sales
      SET status = 'cancelled', cancelled_by = ${actor.id}, cancelled_at = NOW()
      WHERE id = ${id} AND organization_id = ${scope.organizationId}
        AND status IN ('pending_owner_review', 'payment_confirmed', 'release_authorized')
      RETURNING *
    ),
    farm_entry AS (
      INSERT INTO farm_audit (organization_id, actor_id, action, target_table, target_id, metadata)
      SELECT ${scope.organizationId}, ${actor.id}, 'farm.sale.cancelled',
        'farm_sales', id, ${metadata}::jsonb FROM updated RETURNING id
    ),
    audit_entry AS (
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT ${actor.id}, 'farm', 'farm.sale.cancelled',
        'farm_sales', id, ${metadata}::jsonb, ${actorIp(c)} FROM updated RETURNING id
    )
    SELECT * FROM updated
  `;
  const sale = rows[0] as Record<string, unknown> | undefined;
  if (!sale) fail(409, "SALE_STATE_CONFLICT", "Only an unreleased, open sale can be cancelled.");
  return c.json({ sale });
});

export default commerce;
