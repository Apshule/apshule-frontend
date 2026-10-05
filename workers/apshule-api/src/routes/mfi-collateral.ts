import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { ApiError, getDb, isUniqueViolation } from "../db.js";
import { authMiddleware, requireRole } from "../auth.js";
import { optionalString, readJson, requiredString, validEmail } from "../http.js";
import {
  calculateMfiCollateralScore,
  isMfiCollateralPhoto,
  MFI_COLLATERAL_DEFAULTS,
  MFI_COLLATERAL_STATUSES,
} from "../mfi-collateral-domain.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";

const collateral = new Hono<AppEnv>();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MANAGER_ROLES = ["loan_manager", "mfi_admin", "superadmin"] as const;
const ACCESS_ROLES = ["mfi_admin", "loan_officer", "loan_manager", "loan_director", "superadmin"] as const;
const REGISTRIES = [
  {
    path: "valuers",
    table: "mfi_valuers",
    actionName: "valuer",
  },
  {
    path: "legal-officers",
    table: "mfi_legal_officers",
    actionName: "legal_officer",
  },
] as const;

const requireMfiSector = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user.role !== "superadmin" && user.sector !== "mfi") {
    throw new ApiError(403, "MFI_SECTOR_REQUIRED", "This endpoint is for MFI accounts.");
  }
  await next();
});

collateral.use("/mfi/*", authMiddleware, requireMfiSector);

function uuid(value: string, field = "id"): string {
  if (!UUID_PATTERN.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a valid UUID.`);
  }
  return value;
}

function optionalText(
  body: Record<string, unknown>,
  key: string,
  max = 500,
): string | null | undefined {
  const value = optionalString(body, key, { max, allowNull: true });
  if (value === undefined || value === null) return value;
  return value.length ? value : null;
}

function optionalNumber(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  integer = false,
): number | null | undefined {
  if (!(key in body)) return undefined;
  const raw = body[key];
  if (raw === null || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} is outside the allowed range.`);
  }
  return value;
}

function optionalBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  if (!(key in body)) return undefined;
  if (typeof body[key] === "boolean") return body[key];
  if (body[key] === "true") return true;
  if (body[key] === "false") return false;
  throw new ApiError(400, "VALIDATION_ERROR", `${key} must be true or false.`);
}

function parsePhotos(
  body: Record<string, unknown>,
  key = "photos",
): string[] | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (!Array.isArray(value) || value.length > 10 || !value.every(isMfiCollateralPhoto)) {
    throw new ApiError(
      400,
      "PHOTO_INVALID",
      `${key} must contain up to 10 JPEG, PNG, or WebP images, each no larger than 200 KB.`,
    );
  }
  return value;
}

function parseDocuments(
  body: Record<string, unknown>,
  key = "documents",
): unknown[] | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some((item) => {
      if (typeof item === "string") return item.trim().length === 0 || item.length > 500;
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      return JSON.stringify(item).length > 2_000;
    }) ||
    JSON.stringify(value).length > 30_000
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", "documents must contain up to 20 short document descriptions.");
  }
  return value;
}

function requestIp(c: { req: { header(name: string): string | undefined } }): string | null {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    null
  )?.slice(0, 255) ?? null;
}

function requestedOrganizationId(
  c: { req: { query(name: string): string | undefined } },
  body?: Record<string, unknown>,
): string | undefined {
  const fromBody = typeof body?.organization_id === "string" ? body.organization_id : undefined;
  const fromQuery = c.req.query("organization_id");
  if (fromBody && fromQuery && fromBody !== fromQuery) {
    throw new ApiError(400, "VALIDATION_ERROR", "organization_id values do not match.");
  }
  const value = fromBody ?? fromQuery;
  return value ? uuid(value, "organization_id") : undefined;
}

async function organizationForUser(
  sql: ReturnType<typeof getDb>,
  user: AuthenticatedUser,
  requested?: string,
): Promise<string> {
  if (user.role === "superadmin") {
    if (!requested) {
      throw new ApiError(400, "ORGANIZATION_REQUIRED", "Pass organization_id to access collateral for an organization.");
    }
    const rows = await sql`
      SELECT id FROM mfi_organizations WHERE id = ${requested} LIMIT 1
    `;
    if (!rows[0]) throw new ApiError(404, "MFI_ORGANIZATION_NOT_FOUND", "MFI organization was not found.");
    return requested;
  }
  const rows = user.role === "mfi_admin"
    ? await sql`
        SELECT id FROM mfi_organizations WHERE created_by = ${user.id} LIMIT 1
      `
    : await sql`
        SELECT organization_id AS id
        FROM mfi_officers
        WHERE user_id = ${user.id} AND active IS TRUE
        LIMIT 1
      `;
  const id = (rows[0] as { id?: string } | undefined)?.id;
  if (!id) {
    throw new ApiError(403, "MFI_ORGANIZATION_REQUIRED", "Your MFI account is not linked to an organization.");
  }
  if (requested && requested !== id) {
    throw new ApiError(403, "MFI_ORGANIZATION_FORBIDDEN", "You cannot access collateral for another organization.");
  }
  return id;
}

async function loadCollateralType(
  sql: ReturnType<typeof getDb>,
  organizationId: string,
  typeId: string,
) {
  const rows = await sql`
    SELECT id, organization_id, code, name, category, base_score,
      requires_valuation, requires_legal, active
    FROM mfi_collateral_types
    WHERE id = ${typeId}
      AND (organization_id = ${organizationId} OR organization_id IS NULL)
      AND active IS TRUE
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(400, "COLLATERAL_TYPE_NOT_FOUND", "The selected collateral type is not active in this organization.");
  return rows[0] as {
    id: string;
    base_score: number | string;
    requires_valuation: boolean;
    requires_legal: boolean;
  };
}

async function loadCustomer(
  sql: ReturnType<typeof getDb>,
  organizationId: string,
  customerId: string,
) {
  const rows = await sql`
    SELECT id, organization_id, branch_id
    FROM mfi_customers
    WHERE id = ${customerId} AND organization_id = ${organizationId}
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(400, "MFI_CUSTOMER_NOT_FOUND", "The selected customer was not found in this organization.");
  return rows[0] as { id: string; branch_id: string | null };
}

function isManager(user: AuthenticatedUser): boolean {
  return user.role === "mfi_admin" || user.role === "loan_manager" || user.role === "superadmin";
}

async function requireCollateralOwner(
  sql: ReturnType<typeof getDb>,
  organizationId: string,
  id: string,
  user: AuthenticatedUser,
  statuses?: readonly string[],
) {
  const rows = await sql`
    SELECT id, organization_id, created_by, status, collateral_type_id,
      estimated_value, condition, documents, title
    FROM mfi_collateral
    WHERE id = ${id} AND organization_id = ${organizationId}
    LIMIT 1
  `;
  const row = rows[0] as {
    id: string;
    organization_id: string;
    created_by: string | null;
    status: string;
    collateral_type_id: string | null;
    estimated_value: number | string;
    condition: string | null;
    documents: unknown;
    title: string;
  } | undefined;
  if (!row) throw new ApiError(404, "MFI_COLLATERAL_NOT_FOUND", "Collateral was not found.");
  if (statuses && !statuses.includes(row.status)) {
    throw new ApiError(409, "COLLATERAL_STATUS_CONFLICT", `This action is not available while status is ${row.status}.`);
  }
  if (!isManager(user) && row.created_by !== user.id) {
    throw new ApiError(403, "COLLATERAL_OWNER_REQUIRED", "Only the staff member who created this draft can change it.");
  }
  return row;
}

type Db = ReturnType<typeof getDb>;

async function auditedUpdate(
  sql: Db,
  input: {
    table: "mfi_collateral_types" | "mfi_collateral" | "mfi_valuers" | "mfi_legal_officers";
    id: string;
    organizationId: string;
    actorId: string;
    ip: string | null;
    action: string;
    metadata: Record<string, unknown>;
    updates: Record<string, unknown>;
    conditions?: { clause: string; values: unknown[] };
  },
) {
  const entries = Object.entries(input.updates);
  if (!entries.length) throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one field to update.");
  const values = entries.map(([, value]) => value);
  const assignments = entries.map(([column], index) => `${column} = $${index + 1}`).join(", ");
  const idParam = values.length + 1;
  const organizationParam = values.length + 2;
  const conditionValues = input.conditions?.values ?? [];
  const conditionStart = organizationParam + 1;
  const condition = input.conditions
    ? ` AND (${input.conditions.clause.replace(/\$(\d+)/gu, (_, index: string) => `$${Number(index) + conditionStart - 1}`)})`
    : "";
  values.push(input.id, input.organizationId, ...conditionValues);
  const actorParam = values.length + 1;
  values.push(input.actorId, input.action, input.table, JSON.stringify(input.metadata), input.ip);
  const actionParam = actorParam + 1;
  const tableParam = actorParam + 2;
  const metadataParam = actorParam + 3;
  const ipParam = actorParam + 4;
  const touchUpdatedAt = input.table === "mfi_collateral" ? ", updated_at = NOW()" : "";
  const query = `
    WITH changed AS (
      UPDATE ${input.table}
      SET ${assignments}${touchUpdatedAt}
      WHERE id = $${idParam} AND organization_id = $${organizationParam}${condition}
      RETURNING *
    ),
    local_audit AS (
      INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
      SELECT organization_id, $${actorParam}, $${actionParam}, $${tableParam}, id, $${metadataParam}::jsonb
      FROM changed RETURNING id
    ),
    platform_audit AS (
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT $${actorParam}, 'mfi', $${actionParam}, $${tableParam}, id, $${metadataParam}::jsonb, $${ipParam}
      FROM changed RETURNING id
    )
    SELECT * FROM changed
  `;
  return await sql.query(query, values) as Array<Record<string, unknown>>;
}

async function auditedDelete(
  sql: Db,
  input: {
    table: "mfi_collateral" | "mfi_collateral_types" | "mfi_valuers" | "mfi_legal_officers";
    id: string;
    organizationId: string;
    actorId: string;
    ip: string | null;
    action: string;
    metadata?: Record<string, unknown>;
  },
): Promise<boolean> {
  const values = [
    input.id,
    input.organizationId,
    input.actorId,
    input.action,
    input.table,
    JSON.stringify(input.metadata ?? {}),
    input.ip,
  ];
  const rows = await sql.query(
    `WITH removed AS (
       DELETE FROM ${input.table} WHERE id = $1 AND organization_id = $2
       RETURNING id, organization_id
     ),
     local_audit AS (
       INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
       SELECT organization_id, $3, $4, $5, id, $6::jsonb FROM removed RETURNING id
     ),
     platform_audit AS (
       INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
       SELECT $3, 'mfi', $4, $5, id, $6::jsonb, $7 FROM removed RETURNING id
     )
     SELECT id FROM removed`,
    values,
  ) as Array<{ id: string }>;
  return Boolean(rows[0]);
}

// Collateral type catalog.
collateral.get(
  "/mfi/collateral-types",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(
      sql,
      c.get("user"),
      requestedOrganizationId(c),
    );
    const rows = await sql`
      SELECT id, organization_id, code, name, category, base_score,
        requires_valuation, requires_legal, active, created_at
      FROM mfi_collateral_types
      WHERE (organization_id = ${organizationId} OR organization_id IS NULL)
        AND active IS TRUE
      ORDER BY organization_id NULLS LAST, name ASC
    `;
    return c.json({ types: rows });
  },
);

collateral.post(
  "/mfi/collateral-types/seed-defaults",
  requireRole("mfi_admin", "superadmin"),
  async (c) => {
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const ip = requestIp(c);
    const defaults = MFI_COLLATERAL_DEFAULTS;
    const rows = await sql`
      WITH seeded AS (
        INSERT INTO mfi_collateral_types (
          organization_id, code, name, category, base_score,
          requires_valuation, requires_legal, active
        )
        SELECT ${organizationId}::uuid, seed.code, seed.name, seed.category,
          seed.base_score, seed.requires_valuation, seed.requires_legal, TRUE
        FROM jsonb_to_recordset(${JSON.stringify(defaults)}::jsonb) AS seed(
          code text, name text, category text, base_score int,
          requires_valuation boolean, requires_legal boolean
        )
        ON CONFLICT (organization_id, upper(code))
          WHERE organization_id IS NOT NULL
        DO NOTHING
        RETURNING *
      ),
      local_audit AS (
        INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${user.id}, 'mfi.collateral_type_seeded',
          'mfi_collateral_types', id, jsonb_build_object('code', code)
        FROM seeded RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'mfi', 'mfi.collateral_type_seeded',
          'mfi_collateral_types', id, jsonb_build_object('code', code), ${ip}
        FROM seeded RETURNING id
      )
      SELECT id, code, name, category, base_score, requires_valuation, requires_legal
      FROM seeded ORDER BY name
    `;
    return c.json({ seeded: rows, created: rows.length });
  },
);

collateral.post(
  "/mfi/collateral-types",
  requireRole("mfi_admin", "superadmin"),
  async (c) => {
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const code = requiredString(body, "code", { max: 40 }).toUpperCase().replaceAll(" ", "_");
    if (!/^[A-Z0-9_-]+$/u.test(code)) {
      throw new ApiError(400, "VALIDATION_ERROR", "code may contain only letters, numbers, underscores, and hyphens.");
    }
    const name = requiredString(body, "name", { max: 120 });
    const category = optionalText(body, "category", 80) ?? null;
    const baseScore = optionalNumber(body, "base_score", 0, 100, true) ?? 50;
    const requiresValuation = optionalBoolean(body, "requires_valuation") ?? true;
    const requiresLegal = optionalBoolean(body, "requires_legal") ?? false;
    const metadata = JSON.stringify({ code });
    const ip = requestIp(c);
    try {
      const rows = await sql`
        WITH created AS (
          INSERT INTO mfi_collateral_types (
            organization_id, code, name, category, base_score,
            requires_valuation, requires_legal, active
          )
          VALUES (${organizationId}, ${code}, ${name}, ${category}, ${baseScore},
            ${requiresValuation}, ${requiresLegal}, TRUE)
          RETURNING *
        ),
        local_audit AS (
          INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
          SELECT organization_id, ${user.id}, 'mfi.collateral_type_created',
            'mfi_collateral_types', id, ${metadata}::jsonb FROM created RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
          SELECT ${user.id}, 'mfi', 'mfi.collateral_type_created',
            'mfi_collateral_types', id, ${metadata}::jsonb, ${ip} FROM created RETURNING id
        )
        SELECT * FROM created
      `;
      return c.json({ type: rows[0] }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "COLLATERAL_TYPE_CODE_EXISTS", "A collateral type already uses this code.");
      }
      throw error;
    }
  },
);

collateral.patch(
  "/mfi/collateral-types/:id",
  requireRole("mfi_admin", "superadmin"),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const updates: Record<string, unknown> = {};
    if ("code" in body) {
      const code = requiredString(body, "code", { max: 40 }).toUpperCase().replaceAll(" ", "_");
      if (!/^[A-Z0-9_-]+$/u.test(code)) throw new ApiError(400, "VALIDATION_ERROR", "code is invalid.");
      updates.code = code;
    }
    if ("name" in body) updates.name = requiredString(body, "name", { max: 120 });
    if ("category" in body) updates.category = optionalText(body, "category", 80) ?? null;
    if ("base_score" in body) updates.base_score = optionalNumber(body, "base_score", 0, 100, true) ?? null;
    if ("requires_valuation" in body) updates.requires_valuation = optionalBoolean(body, "requires_valuation");
    if ("requires_legal" in body) updates.requires_legal = optionalBoolean(body, "requires_legal");
    if (!Object.keys(updates).length) throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one collateral type field to update.");
    const rows = await auditedUpdate(sql, {
      table: "mfi_collateral_types", id, organizationId, actorId: user.id,
      ip: requestIp(c), action: "mfi.collateral_type_updated",
      metadata: { updated_fields: Object.keys(updates) }, updates,
    });
    if (!rows[0]) throw new ApiError(404, "COLLATERAL_TYPE_NOT_FOUND", "Collateral type was not found.");
    return c.json({ type: rows[0] });
  },
);

collateral.delete(
  "/mfi/collateral-types/:id",
  requireRole("mfi_admin", "superadmin"),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const sql = getDb(c.env);
    const user = c.get("user");
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c));
    const rows = await auditedUpdate(sql, {
      table: "mfi_collateral_types", id, organizationId, actorId: user.id,
      ip: requestIp(c), action: "mfi.collateral_type_deactivated",
      metadata: { active: false }, updates: { active: false },
    });
    if (!rows[0]) throw new ApiError(404, "COLLATERAL_TYPE_NOT_FOUND", "Collateral type was not found.");
    return c.json({ deleted: true, id });
  },
);

// Organization-owned external service registries.
for (const registry of REGISTRIES) {
  const table = registry.table;
  const path = `/mfi/${registry.path}`;
  const auditPrefix = registry.actionName;

  collateral.get(path, requireRole("mfi_admin", "superadmin"), async (c) => {
    const sql = getDb(c.env);
    const user = c.get("user");
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c));
    const rows = await sql.query(
      `SELECT * FROM ${table} WHERE organization_id = $1 AND active IS TRUE ORDER BY full_name`,
      [organizationId],
    );
    return c.json({ [registry.path]: rows });
  });

  collateral.post(path, requireRole("mfi_admin", "superadmin"), async (c) => {
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const fullName = requiredString(body, "full_name", { max: 160 });
    const phone = optionalText(body, "phone", 40) ?? null;
    const email = optionalText(body, "email", 254)?.toLowerCase() ?? null;
    if (email && !validEmail(email)) throw new ApiError(400, "VALIDATION_ERROR", "email must be valid.");
    const licenseNumber = optionalText(body, "license_number", 120) ?? null;
    const specializations = registry.path === "valuers"
      ? (() => {
          const raw = body.specializations;
          if (raw === undefined || raw === null || raw === "") return null;
          const values = Array.isArray(raw)
            ? raw
            : typeof raw === "string"
              ? raw.split(",")
              : [];
          if (values.length > 20 || values.some((value) => typeof value !== "string" || value.trim().length > 80)) {
            throw new ApiError(400, "VALIDATION_ERROR", "specializations must be a comma-separated list of up to 20 short values.");
          }
          return values.map((value) => String(value).trim()).filter(Boolean);
        })()
      : null;
    const extra = registry.path === "valuers"
      ? optionalText(body, "address", 500) ?? null
      : optionalText(body, "law_firm", 180) ?? null;
    const metadata = JSON.stringify({ full_name: fullName });
    const ip = requestIp(c);
    const result = registry.path === "valuers"
      ? await sql`
          WITH created AS (
            INSERT INTO mfi_valuers (
              organization_id, full_name, phone, email, license_number, specializations, address, active
            )
            VALUES (${organizationId}, ${fullName}, ${phone}, ${email}, ${licenseNumber},
              ${specializations}, ${extra}, TRUE)
            RETURNING *
          ),
          local_audit AS (
            INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
            SELECT organization_id, ${user.id}, ${`mfi.${auditPrefix}_created`},
              ${table}, id, ${metadata}::jsonb FROM created RETURNING id
          ),
          platform_audit AS (
            INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
            SELECT ${user.id}, 'mfi', ${`mfi.${auditPrefix}_created`},
              ${table}, id, ${metadata}::jsonb, ${ip} FROM created RETURNING id
          )
          SELECT * FROM created
        `
      : await sql`
          WITH created AS (
            INSERT INTO mfi_legal_officers (
              organization_id, full_name, phone, email, law_firm, license_number, active
            )
            VALUES (${organizationId}, ${fullName}, ${phone}, ${email}, ${extra}, ${licenseNumber}, TRUE)
            RETURNING *
          ),
          local_audit AS (
            INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
            SELECT organization_id, ${user.id}, ${`mfi.${auditPrefix}_created`},
              ${table}, id, ${metadata}::jsonb FROM created RETURNING id
          ),
          platform_audit AS (
            INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
            SELECT ${user.id}, 'mfi', ${`mfi.${auditPrefix}_created`},
              ${table}, id, ${metadata}::jsonb, ${ip} FROM created RETURNING id
          )
          SELECT * FROM created
        `;
    return c.json({ [registry.actionName]: result[0] }, 201);
  });

  collateral.patch(`${path}/:id`, requireRole("mfi_admin", "superadmin"), async (c) => {
    const id = uuid(c.req.param("id"));
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const updates: Record<string, unknown> = {};
    if ("full_name" in body) updates.full_name = requiredString(body, "full_name", { max: 160 });
    if ("phone" in body) updates.phone = optionalText(body, "phone", 40) ?? null;
    if ("email" in body) {
      const email = optionalText(body, "email", 254)?.toLowerCase() ?? null;
      if (email && !validEmail(email)) throw new ApiError(400, "VALIDATION_ERROR", "email must be valid.");
      updates.email = email;
    }
    if ("license_number" in body) updates.license_number = optionalText(body, "license_number", 120) ?? null;
    if (registry.path === "valuers") {
      if ("address" in body) updates.address = optionalText(body, "address", 500) ?? null;
      if ("specializations" in body) {
        const raw = body.specializations;
        const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
        if (values.length > 20 || values.some((value) => typeof value !== "string" || value.trim().length > 80)) {
          throw new ApiError(400, "VALIDATION_ERROR", "specializations must be a comma-separated list of up to 20 short values.");
        }
        updates.specializations = values.map((value) => String(value).trim()).filter(Boolean);
      }
    } else if ("law_firm" in body) {
      updates.law_firm = optionalText(body, "law_firm", 180) ?? null;
    }
    if (!Object.keys(updates).length) throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one registry field to update.");
    const rows = await auditedUpdate(sql, {
      table, id, organizationId, actorId: user.id, ip: requestIp(c),
      action: `mfi.${auditPrefix}_updated`,
      metadata: { updated_fields: Object.keys(updates) }, updates,
    });
    if (!rows[0]) throw new ApiError(404, "MFI_REGISTRY_RECORD_NOT_FOUND", "The selected record was not found.");
    return c.json({ [registry.actionName]: rows[0] });
  });

  collateral.delete(`${path}/:id`, requireRole("mfi_admin", "superadmin"), async (c) => {
    const id = uuid(c.req.param("id"));
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c));
    const rows = await auditedUpdate(sql, {
      table, id, organizationId, actorId: user.id, ip: requestIp(c),
      action: `mfi.${auditPrefix}_deactivated`,
      metadata: { active: false }, updates: { active: false },
    });
    if (!rows[0]) throw new ApiError(404, "MFI_REGISTRY_RECORD_NOT_FOUND", "The selected record was not found.");
    return c.json({ deleted: true, id });
  });
}

// Collateral list and summary.
collateral.get(
  "/mfi/collateral/summary",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, c.get("user"), requestedOrganizationId(c));
    const rows = await sql`
      SELECT COUNT(*)::int AS total_collateral,
        COALESCE(SUM(estimated_value), 0)::numeric AS total_value,
        COUNT(*) FILTER (WHERE status = 'pending_review')::int AS pending_review,
        COUNT(*) FILTER (WHERE status = 'approved')::int AS approved
      FROM mfi_collateral WHERE organization_id = ${organizationId}
    `;
    return c.json({ summary: rows[0] ?? {
      total_collateral: 0, total_value: 0, pending_review: 0, approved: 0,
    } });
  },
);

collateral.get(
  "/mfi/collateral",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, c.get("user"), requestedOrganizationId(c));
    const customerId = c.req.query("customer_id");
    const branchId = c.req.query("branch_id");
    const status = c.req.query("status");
    const typeId = c.req.query("type_id");
    if (customerId) uuid(customerId, "customer_id");
    if (branchId) uuid(branchId, "branch_id");
    if (typeId) uuid(typeId, "type_id");
    if (status && !MFI_COLLATERAL_STATUSES.includes(status as (typeof MFI_COLLATERAL_STATUSES)[number])) {
      throw new ApiError(400, "VALIDATION_ERROR", "status is not a supported collateral status.");
    }
    const rows = await sql`
      SELECT c.id, c.organization_id, c.branch_id, c.customer_id, c.collateral_type_id,
        c.title, c.description, c.estimated_value, c.currency, c.condition, c.location,
        c.photos, c.documents, c.score, c.score_breakdown, c.status, c.review_notes,
        c.valuer_name, c.valuation_report, c.valuation_date, c.legal_officer_name,
        c.legal_status, c.legal_notes, c.created_by, c.created_at, c.updated_at,
        customer.first_name AS customer_first_name, customer.last_name AS customer_last_name,
        customer.phone AS customer_phone, branch.name AS branch_name,
        type.name AS collateral_type_name, type.code AS collateral_type_code,
        type.requires_valuation, type.requires_legal
      FROM mfi_collateral c
      JOIN mfi_customers customer ON customer.id = c.customer_id
      LEFT JOIN mfi_branches branch ON branch.id = c.branch_id
      LEFT JOIN mfi_collateral_types type ON type.id = c.collateral_type_id
      WHERE c.organization_id = ${organizationId}
        AND (${customerId ?? null}::uuid IS NULL OR c.customer_id = ${customerId ?? null}::uuid)
        AND (${branchId ?? null}::uuid IS NULL OR c.branch_id = ${branchId ?? null}::uuid)
        AND (${status ?? null}::text IS NULL OR c.status = ${status ?? null})
        AND (${typeId ?? null}::uuid IS NULL OR c.collateral_type_id = ${typeId ?? null}::uuid)
      ORDER BY c.updated_at DESC, c.created_at DESC
      LIMIT 300
    `;
    return c.json({ collateral: rows });
  },
);

collateral.post(
  "/mfi/collateral",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const customerId = uuid(requiredString(body, "customer_id", { max: 36 }), "customer_id");
    const typeId = uuid(requiredString(body, "collateral_type_id", { max: 36 }), "collateral_type_id");
    const title = requiredString(body, "title", { max: 200 });
    const description = optionalText(body, "description", 2000) ?? null;
    const estimatedValue = optionalNumber(body, "estimated_value", 0, 1_000_000_000_000);
    if (estimatedValue === undefined || estimatedValue === null) {
      throw new ApiError(400, "VALIDATION_ERROR", "estimated_value is required.");
    }
    const condition = requiredString(body, "condition", { max: 20 }).toLowerCase();
    if (!["excellent", "good", "fair", "poor"].includes(condition)) {
      throw new ApiError(400, "VALIDATION_ERROR", "condition must be excellent, good, fair, or poor.");
    }
    const location = optionalText(body, "location", 500) ?? null;
    const photos = parsePhotos(body) ?? [];
    const documents = parseDocuments(body) ?? [];
    const customer = await loadCustomer(sql, organizationId, customerId);
    const type = await loadCollateralType(sql, organizationId, typeId);
    const score = calculateMfiCollateralScore({
      typeBaseScore: Number(type.base_score),
      estimatedValue,
      condition: condition as "excellent" | "good" | "fair" | "poor",
      documentCount: documents.length,
    });
    const scoreJson = JSON.stringify(score);
    const metadata = JSON.stringify({
      customer_id: customerId,
      title,
      status_from: null,
      status_to: "draft",
      score: score.total,
    });
    const ip = requestIp(c);
    const rows = await sql`
      WITH created AS (
        INSERT INTO mfi_collateral (
          organization_id, branch_id, customer_id, collateral_type_id, title, description,
          estimated_value, condition, location, photos, documents, score, score_breakdown,
          status, currency, created_by
        )
        VALUES (
          ${organizationId}, ${customer.branch_id}, ${customerId}, ${typeId}, ${title},
          ${description}, ${estimatedValue}, ${condition}, ${location}, ${JSON.stringify(photos)}::jsonb,
          ${JSON.stringify(documents)}::jsonb, ${score.total}, ${scoreJson}::jsonb,
          'draft', 'UGX', ${user.id}
        )
        RETURNING *
      ),
      local_audit AS (
        INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${user.id}, 'mfi.collateral_created',
          'mfi_collateral', id, ${metadata}::jsonb FROM created RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'mfi', 'mfi.collateral_created',
          'mfi_collateral', id, ${metadata}::jsonb, ${ip} FROM created RETURNING id
      )
      SELECT * FROM created
    `;
    return c.json({ collateral: rows[0] }, 201);
  },
);

collateral.get(
  "/mfi/collateral/:id",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, c.get("user"), requestedOrganizationId(c));
    const rows = await sql`
      SELECT c.*, customer.first_name AS customer_first_name, customer.last_name AS customer_last_name,
        customer.phone AS customer_phone, branch.name AS branch_name,
        type.name AS collateral_type_name, type.code AS collateral_type_code,
        type.requires_valuation, type.requires_legal,
        reviewer.name AS reviewer_name
      FROM mfi_collateral c
      JOIN mfi_customers customer ON customer.id = c.customer_id
      LEFT JOIN mfi_branches branch ON branch.id = c.branch_id
      LEFT JOIN mfi_collateral_types type ON type.id = c.collateral_type_id
      LEFT JOIN users reviewer ON reviewer.id = c.reviewed_by
      WHERE c.id = ${id} AND c.organization_id = ${organizationId}
      LIMIT 1
    `;
    if (!rows[0]) throw new ApiError(404, "MFI_COLLATERAL_NOT_FOUND", "Collateral was not found.");
    const timeline = await sql`
      SELECT a.id, a.action, a.metadata, a.created_at, actor.name AS actor_name
      FROM mfi_audit a
      LEFT JOIN users actor ON actor.id = a.actor_id
      WHERE a.organization_id = ${organizationId}
        AND a.target_table = 'mfi_collateral'
        AND a.target_id = ${id}
      ORDER BY a.created_at ASC
      LIMIT 200
    `;
    return c.json({ collateral: rows[0], timeline });
  },
);

collateral.patch(
  "/mfi/collateral/:id",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const existing = await requireCollateralOwner(sql, organizationId, id, user, ["draft", "rejected"]);
    const updates: Record<string, unknown> = {};
    if ("customer_id" in body) {
      const customerId = uuid(requiredString(body, "customer_id", { max: 36 }), "customer_id");
      const customer = await loadCustomer(sql, organizationId, customerId);
      updates.customer_id = customerId;
      updates.branch_id = customer.branch_id;
    }
    if ("collateral_type_id" in body) {
      const typeId = uuid(requiredString(body, "collateral_type_id", { max: 36 }), "collateral_type_id");
      await loadCollateralType(sql, organizationId, typeId);
      updates.collateral_type_id = typeId;
    }
    if ("title" in body) updates.title = requiredString(body, "title", { max: 200 });
    if ("description" in body) updates.description = optionalText(body, "description", 2000) ?? null;
    if ("estimated_value" in body) updates.estimated_value = optionalNumber(body, "estimated_value", 0, 1_000_000_000_000) ?? null;
    if ("condition" in body) {
      const condition = requiredString(body, "condition", { max: 20 }).toLowerCase();
      if (!["excellent", "good", "fair", "poor"].includes(condition)) throw new ApiError(400, "VALIDATION_ERROR", "condition is invalid.");
      updates.condition = condition;
    }
    if ("location" in body) updates.location = optionalText(body, "location", 500) ?? null;
    const photos = parsePhotos(body);
    if (photos !== undefined) updates.photos = JSON.stringify(photos);
    const documents = parseDocuments(body);
    if (documents !== undefined) updates.documents = JSON.stringify(documents);
    if (!Object.keys(updates).length) throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one collateral field to update.");
    const nextTypeId = String(updates.collateral_type_id ?? (existing as Record<string, unknown>).collateral_type_id ?? "");
    const type = await loadCollateralType(sql, organizationId, nextTypeId);
    const record = existing as Record<string, unknown>;
    const score = calculateMfiCollateralScore({
      typeBaseScore: Number(type.base_score),
      estimatedValue: Number(updates.estimated_value ?? record.estimated_value),
      condition: String(updates.condition ?? record.condition) as "excellent" | "good" | "fair" | "poor",
      documentCount: documents?.length ?? (Array.isArray(record.documents) ? record.documents.length : 0),
    });
    updates.score = score.total;
    updates.score_breakdown = JSON.stringify(score);
    const rows = await auditedUpdate(sql, {
      table: "mfi_collateral", id, organizationId, actorId: user.id, ip: requestIp(c),
      action: "mfi.collateral_updated",
      metadata: { updated_fields: Object.keys(updates), status: existing.status, score: score.total },
      updates,
      conditions: { clause: "status = ANY($1::text[])", values: [["draft", "rejected"]] },
    });
    if (!rows[0]) throw new ApiError(409, "COLLATERAL_STATUS_CONFLICT", "Collateral status changed before the update was saved.");
    return c.json({ collateral: rows[0] });
  },
);

collateral.delete(
  "/mfi/collateral/:id",
  requireRole("mfi_admin", "superadmin"),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c));
    const deleted = await auditedDelete(sql, {
      table: "mfi_collateral", id, organizationId, actorId: user.id, ip: requestIp(c),
      action: "mfi.collateral_deleted",
    });
    if (!deleted) throw new ApiError(404, "MFI_COLLATERAL_NOT_FOUND", "Collateral was not found.");
    return c.json({ deleted: true, id });
  },
);

async function workflowUpdate(
  c: Context<AppEnv>,
  options: {
    id: string;
    organizationId: string;
    expectedStatuses: string[];
    status: string;
    action: string;
    metadata: Record<string, unknown>;
    fields?: Record<string, unknown>;
  },
) {
  const user = c.get("user");
  const sql = getDb(c.env);
  const fields = options.fields ?? {};
  const updates = { ...fields, status: options.status };
  const rows = await auditedUpdate(sql, {
    table: "mfi_collateral", id: options.id, organizationId: options.organizationId,
    actorId: user.id, ip: requestIp(c), action: options.action,
    metadata: { ...options.metadata, status_to: options.status },
    updates,
    conditions: { clause: "status = ANY($1::text[])", values: [options.expectedStatuses] },
  });
  if (!rows[0]) {
    const current = await sql`
      SELECT status FROM mfi_collateral
      WHERE id = ${options.id} AND organization_id = ${options.organizationId}
      LIMIT 1
    `;
    if (!current[0]) throw new ApiError(404, "MFI_COLLATERAL_NOT_FOUND", "Collateral was not found.");
    throw new ApiError(409, "COLLATERAL_STATUS_CONFLICT", `This action is not available while status is ${current[0].status}.`);
  }
  return rows[0];
}

collateral.post(
  "/mfi/collateral/:id/submit",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const existing = await requireCollateralOwner(sql, organizationId, id, user, ["draft", "rejected"]);
    const collateralRow = existing as Record<string, unknown>;
    if (!collateralRow.title || !collateralRow.condition || collateralRow.estimated_value == null) {
      throw new ApiError(400, "COLLATERAL_INCOMPLETE", "Add a title, estimated value, and condition before submitting.");
    }
    const record = await workflowUpdate(c, {
      id, organizationId, expectedStatuses: ["draft", "rejected"], status: "pending_review",
      action: "mfi.collateral_submitted",
      metadata: { status_from: existing.status, status_to: "pending_review" },
    });
    return c.json({ collateral: record });
  },
);

async function reviewCollateral(c: Context<AppEnv>, approve: boolean) {
  const id = uuid(c.req.param("id") ?? "");
  const body = await readJson(c);
  const user = c.get("user");
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
  const note = optionalText(body, approve ? "notes" : "reason", 2000);
  if (!approve && !note) throw new ApiError(400, "VALIDATION_ERROR", "reason is required when rejecting collateral.");
  const rows = await auditedUpdate(sql, {
    table: "mfi_collateral", id, organizationId, actorId: user.id, ip: requestIp(c),
    action: approve ? "mfi.collateral_approved" : "mfi.collateral_rejected",
    metadata: {
      status_from: "pending_review",
      status_to: approve ? "approved" : "rejected",
      ...(note ? { notes: note } : {}),
    },
    updates: {
      status: approve ? "approved" : "rejected",
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
      review_notes: note ?? null,
    },
    conditions: { clause: "status = $1", values: ["pending_review"] },
  });
  if (!rows[0]) {
    const current = await sql`SELECT status FROM mfi_collateral WHERE id = ${id} AND organization_id = ${organizationId} LIMIT 1`;
    if (!current[0]) throw new ApiError(404, "MFI_COLLATERAL_NOT_FOUND", "Collateral was not found.");
    throw new ApiError(409, "COLLATERAL_STATUS_CONFLICT", `Only pending collateral can be reviewed (current status: ${current[0].status}).`);
  }
  return c.json({ collateral: rows[0] });
}

collateral.post(
  "/mfi/collateral/:id/approve",
  requireRole(...MANAGER_ROLES),
  (c) => reviewCollateral(c, true),
);
collateral.post(
  "/mfi/collateral/:id/reject",
  requireRole(...MANAGER_ROLES),
  (c) => reviewCollateral(c, false),
);

collateral.post(
  "/mfi/collateral/:id/assign-valuer",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const current = await requireCollateralOwner(sql, organizationId, id, user, ["approved"]);
    const typeId = String((current as Record<string, unknown>).collateral_type_id ?? "");
    const type = await loadCollateralType(sql, organizationId, typeId);
    if (!type.requires_valuation) throw new ApiError(409, "VALUATION_NOT_REQUIRED", "This collateral type does not require valuation.");
    const valuerIdRaw = optionalText(body, "valuer_id", 36);
    const valuerId = valuerIdRaw ? uuid(valuerIdRaw, "valuer_id") : null;
    let valuerName = optionalText(body, "valuer_name", 160) ?? null;
    let valuerPhone = optionalText(body, "valuer_phone", 40) ?? null;
    if (valuerId) {
      const valuer = await sql`
        SELECT id, full_name, phone FROM mfi_valuers
        WHERE id = ${valuerId} AND organization_id = ${organizationId} AND active IS TRUE
        LIMIT 1
      `;
      if (!valuer[0]) throw new ApiError(400, "VALUER_NOT_FOUND", "The selected valuer is not active in this organization.");
      valuerName = String(valuer[0].full_name);
      valuerPhone = valuer[0].phone == null ? null : String(valuer[0].phone);
    }
    if (!valuerName) throw new ApiError(400, "VALIDATION_ERROR", "Select a registered valuer or provide valuer_name.");
    const record = await workflowUpdate(c, {
      id, organizationId, expectedStatuses: ["approved"], status: "awaiting_valuation",
      action: "mfi.collateral_valuer_assigned",
      metadata: { valuer_id: valuerId, valuer_name: valuerName },
      fields: { valuer_id: valuerId, valuer_name: valuerName, valuer_phone: valuerPhone },
    });
    return c.json({ collateral: record });
  },
);

collateral.post(
  "/mfi/collateral/:id/record-valuation",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    await requireCollateralOwner(sql, organizationId, id, user, ["awaiting_valuation"]);
    const amount = optionalNumber(body, "valuation_amount", 0, 1_000_000_000_000);
    if (amount === undefined || amount === null) throw new ApiError(400, "VALIDATION_ERROR", "valuation_amount is required.");
    const notes = optionalText(body, "valuation_notes", 2000) ?? null;
    let valuationDate = new Date().toISOString();
    const dateText = optionalText(body, "valuation_date", 40);
    if (dateText) {
      const parsed = new Date(dateText);
      if (Number.isNaN(parsed.getTime())) throw new ApiError(400, "VALIDATION_ERROR", "valuation_date must be a valid date.");
      valuationDate = parsed.toISOString();
    }
    const report = JSON.stringify({ amount, notes, valuation_date: valuationDate });
    const record = await workflowUpdate(c, {
      id, organizationId, expectedStatuses: ["awaiting_valuation"], status: "valued",
      action: "mfi.collateral_valued",
      metadata: { valuation_amount: amount, notes },
      fields: { valuation_report: report, valuation_date: valuationDate },
    });
    return c.json({ collateral: record });
  },
);

collateral.post(
  "/mfi/collateral/:id/assign-legal",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const current = await requireCollateralOwner(sql, organizationId, id, user, ["valued", "approved"]);
    const type = await loadCollateralType(
      sql,
      organizationId,
      String((current as Record<string, unknown>).collateral_type_id ?? ""),
    );
    if (!type.requires_legal) throw new ApiError(409, "LEGAL_REVIEW_NOT_REQUIRED", "This collateral type does not require legal review.");
    if (current.status === "approved" && type.requires_valuation) {
      throw new ApiError(409, "VALUATION_REQUIRED", "Record the required valuation before assigning legal review.");
    }
    const officerIdRaw = optionalText(body, "legal_officer_id", 36);
    const officerId = officerIdRaw ? uuid(officerIdRaw, "legal_officer_id") : null;
    let officerName = optionalText(body, "legal_officer_name", 160) ?? null;
    if (officerId) {
      const officer = await sql`
        SELECT id, full_name FROM mfi_legal_officers
        WHERE id = ${officerId} AND organization_id = ${organizationId} AND active IS TRUE
        LIMIT 1
      `;
      if (!officer[0]) throw new ApiError(400, "LEGAL_OFFICER_NOT_FOUND", "The selected legal officer is not active in this organization.");
      officerName = String(officer[0].full_name);
    }
    if (!officerName) throw new ApiError(400, "VALIDATION_ERROR", "Select a registered legal officer or provide legal_officer_name.");
    const record = await workflowUpdate(c, {
      id, organizationId, expectedStatuses: [String(current.status)], status: "awaiting_legal",
      action: "mfi.collateral_legal_officer_assigned",
      metadata: { legal_officer_id: officerId, legal_officer_name: officerName },
      fields: { legal_officer_id: officerId, legal_officer_name: officerName },
    });
    return c.json({ collateral: record });
  },
);

collateral.post(
  "/mfi/collateral/:id/record-legal",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    await requireCollateralOwner(sql, organizationId, id, user, ["awaiting_legal"]);
    const legalStatus = requiredString(body, "legal_status", { max: 20 }).toLowerCase();
    if (!["clear", "disputed", "encumbered"].includes(legalStatus)) {
      throw new ApiError(400, "VALIDATION_ERROR", "legal_status must be clear, disputed, or encumbered.");
    }
    const notes = optionalText(body, "notes", 2000) ?? null;
    const status = legalStatus === "clear" ? "legal_cleared" : "legal_issue";
    const record = await workflowUpdate(c, {
      id, organizationId, expectedStatuses: ["awaiting_legal"], status,
      action: "mfi.collateral_legal_recorded",
      metadata: { legal_status: legalStatus, notes },
      fields: { legal_status: legalStatus, legal_notes: notes },
    });
    return c.json({ collateral: record });
  },
);

collateral.post(
  "/mfi/collateral/:id/complete",
  requireRole("mfi_admin", "loan_manager", "superadmin"),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const current = await requireCollateralOwner(sql, organizationId, id, user, ["valued", "legal_cleared"]);
    const type = await loadCollateralType(
      sql,
      organizationId,
      String((current as Record<string, unknown>).collateral_type_id ?? ""),
    );
    if (type.requires_legal && current.status !== "legal_cleared") {
      throw new ApiError(409, "LEGAL_REVIEW_REQUIRED", "Record a clear legal outcome before completing this collateral.");
    }
    const record = await workflowUpdate(c, {
      id, organizationId, expectedStatuses: [String(current.status)], status: "approved",
      action: "mfi.collateral_completed",
      metadata: { status_from: current.status, status_to: "approved", legal_status: current.status === "legal_cleared" ? "clear" : null },
    });
    return c.json({ collateral: record });
  },
);

export default collateral;
