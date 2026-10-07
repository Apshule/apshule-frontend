import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { ApiError, getDb, isUniqueViolation } from "../db.js";
import {
  authMiddleware,
  hashPassword,
  requireRealSuperAdmin,
  requireRole,
} from "../auth.js";
import {
  optionalString,
  readJson,
  requiredString,
  validEmail,
} from "../http.js";
import { sendEmail, welcomeEmailTemplate } from "../email.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";

const farm = new Hono<AppEnv>();
const FARM_ROLES = new Set(["farm_admin", "farm_manager", "farm_worker"]);
const FARM_STAFF = ["farm_admin", "farm_manager", "farm_worker"] as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const requireFarmSector = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (
    user.role !== "superadmin" &&
    (user.sector !== "farm" || !FARM_ROLES.has(user.role))
  ) {
    throw new ApiError(
      403,
      "FARM_SECTOR_REQUIRED",
      "This endpoint is for provisioned Farm accounts.",
    );
  }
  await next();
});

farm.use(authMiddleware, requireFarmSector);

function pathUuid(value: string, field = "id"): string {
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

function requiredNonemptyText(
  body: Record<string, unknown>,
  key: string,
  max = 200,
): string {
  return requiredString(body, key, { max });
}

function optionalNumber(
  body: Record<string, unknown>,
  key: string,
  options: { min?: number; integer?: boolean } = {},
): number | null | undefined {
  if (!(key in body)) return undefined;
  if (body[key] === null || body[key] === "") return null;
  const value =
    typeof body[key] === "number" ? body[key] : Number(body[key]);
  if (
    !Number.isFinite(value) ||
    (options.min !== undefined && value < options.min) ||
    (options.integer && !Number.isInteger(value))
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} is not a valid number.`);
  }
  return value;
}

function optionalBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  if (!(key in body)) return undefined;
  if (typeof body[key] !== "boolean") {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a boolean.`);
  }
  return body[key] as boolean;
}

function optionalDate(body: Record<string, unknown>, key: string): string | null | undefined {
  const value = optionalText(body, key, 10);
  if (value === undefined || value === null) return value;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a valid YYYY-MM-DD date.`);
  }
  return value;
}

function optionalEmail(body: Record<string, unknown>, key: string): string | null | undefined {
  const value = optionalText(body, key, 254);
  if (value === undefined || value === null) return value;
  const normalized = value.toLowerCase();
  if (!validEmail(normalized)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a valid email address.`);
  }
  return normalized;
}

function optionalImage(body: Record<string, unknown>, key: string): string | null | undefined {
  const value = optionalText(body, key, 280_000);
  if (value === undefined || value === null) return value;
  const match = value.match(/^data:image\/(jpeg|png|webp);base64,([a-z0-9+/]*={0,2})$/iu);
  if (!match) {
    throw new ApiError(400, "IMAGE_INVALID", `${key} must be a JPEG, PNG, or WebP data URL.`);
  }
  const encoded = match[2] || "";
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedBytes = Math.floor((encoded.length * 3) / 4) - padding;
  if (decodedBytes > 200 * 1024) {
    throw new ApiError(400, "IMAGE_TOO_LARGE", `${key} must be no larger than 200 KB.`);
  }
  return value;
}

function optionalBrandColor(body: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(body, key, { max: 7 });
  if (value === undefined) return undefined;
  if (!value || !/^#[0-9a-f]{6}$/iu.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a six-digit hex color.`);
  }
  return value.toUpperCase();
}

function optionalUuid(body: Record<string, unknown>, key: string): string | null | undefined {
  const value = optionalText(body, key, 36);
  if (value === undefined || value === null) return value;
  return pathUuid(value, key);
}

function requestIp(c: { req: { header(name: string): string | undefined } }): string | null {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    null
  )?.slice(0, 255) ?? null;
}

async function organizationForUser(
  sql: ReturnType<typeof getDb>,
  user: AuthenticatedUser,
  requestedId?: string,
): Promise<string> {
  if (user.role === "superadmin") {
    if (!requestedId) {
      throw new ApiError(400, "ORGANIZATION_REQUIRED", "Super Admin requests must include organization_id.");
    }
    const organizationId = pathUuid(requestedId, "organization_id");
    const rows = await sql`SELECT id FROM farm_organizations WHERE id = ${organizationId} LIMIT 1`;
    if (!rows[0]) throw new ApiError(404, "FARM_ORGANIZATION_NOT_FOUND", "Farm organization was not found.");
    return organizationId;
  }

  const rows = user.role === "farm_admin"
    ? await sql`
        SELECT id FROM farm_organizations WHERE created_by = ${user.id} LIMIT 1
      `
    : await sql`
        SELECT organization_id AS id FROM farm_workers
        WHERE user_id = ${user.id} AND active IS TRUE LIMIT 1
      `;
  const organizationId = (rows[0] as { id?: string } | undefined)?.id;
  if (!organizationId) {
    throw new ApiError(
      403,
      "FARM_ACCESS_NOT_PROVISIONED",
      "This Farm account is inactive or is not linked to an organization.",
    );
  }
  if (requestedId && pathUuid(requestedId, "organization_id") !== organizationId) {
    throw new ApiError(403, "FARM_ORGANIZATION_FORBIDDEN", "You cannot access another farm organization.");
  }
  return organizationId;
}

async function assertLocation(
  sql: ReturnType<typeof getDb>,
  organizationId: string,
  locationId: string | null | undefined,
): Promise<void> {
  if (!locationId) return;
  const rows = await sql`
    SELECT id FROM farm_locations
    WHERE id = ${locationId} AND organization_id = ${organizationId} AND active IS TRUE
    LIMIT 1
  `;
  if (!rows[0]) {
    throw new ApiError(400, "LOCATION_NOT_FOUND", "The selected location is not active in this farm.");
  }
}

async function assertFarmManager(
  sql: ReturnType<typeof getDb>,
  organizationId: string,
  managerId: string | null | undefined,
): Promise<void> {
  if (!managerId) return;
  const rows = await sql`
    SELECT w.user_id
    FROM farm_workers w
    JOIN users u ON u.id = w.user_id
    WHERE w.user_id = ${managerId}
      AND w.organization_id = ${organizationId}
      AND w.role = 'farm_manager'
      AND w.active IS TRUE
      AND u.role = 'farm_manager'
      AND u.sector = 'farm'
    LIMIT 1
  `;
  if (!rows[0]) {
    throw new ApiError(400, "FARM_MANAGER_NOT_FOUND", "The selected manager must be an active Farm manager in this organization.");
  }
}

async function auditMutation(
  sql: ReturnType<typeof getDb>,
  user: AuthenticatedUser,
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
        (${organizationId}, ${user.id}, ${action}, ${targetTable},
         ${targetId}, ${metadataJson}::jsonb)
      RETURNING id
    )
    INSERT INTO audit_log
      (actor_id, sector, action, target_table, target_id, metadata, ip)
    VALUES
      (${user.id}, 'farm', ${action}, ${targetTable},
       ${targetId}, ${metadataJson}::jsonb, ${ip})
  `;
}

async function loadOrganization(
  sql: ReturnType<typeof getDb>,
  user: AuthenticatedUser,
  queryOrganizationId?: string,
): Promise<string> {
  return organizationForUser(sql, user, queryOrganizationId);
}

function roleChoice(value: unknown): "farm_worker" | "farm_manager" {
  if (value === "farm_worker" || value === "farm_manager") return value;
  throw new ApiError(400, "VALIDATION_ERROR", "role must be farm_worker or farm_manager.");
}

farm.get(
  "/organizations",
  requireRole("superadmin", "farm_admin"),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const ownOrganizationId =
      user.role === "superadmin" ? null : await organizationForUser(sql, user);
    const organizations = await sql`
      SELECT o.id, o.name, o.sector, o.registration_number, o.tin, o.farm_type,
        o.address, o.city, o.district, o.country, o.phone, o.email, o.website,
        o.logo_base64, o.brand_color, o.size_acres, o.created_by, o.created_at,
        (SELECT COUNT(*)::int FROM farm_locations l
          WHERE l.organization_id = o.id AND l.active IS TRUE) AS locations_count,
        (SELECT COUNT(*)::int FROM farm_workers w
          WHERE w.organization_id = o.id AND w.active IS TRUE) AS workers_count,
        (SELECT COALESCE(SUM(a.quantity), 0)::int FROM farm_animals a
          WHERE a.organization_id = o.id AND a.status <> 'deleted') AS animals_count
      FROM farm_organizations o
      WHERE ${ownOrganizationId === null} OR o.id = ${ownOrganizationId}
      ORDER BY o.created_at DESC
    `;
    return c.json({
      organizations: (organizations as Array<Record<string, unknown>>).map((org) => ({
        ...org,
        counts: {
          locations: Number(org.locations_count || 0),
          workers: Number(org.workers_count || 0),
          animals: Number(org.animals_count || 0),
        },
      })),
    });
  },
);

farm.post("/organizations", requireRealSuperAdmin(), async (c) => {
  const body = await readJson(c);
  const name = requiredNonemptyText(body, "name");
  const farmType = requiredNonemptyText(body, "farm_type", 100);
  const adminName = requiredNonemptyText(body, "admin_name", 120);
  const adminEmail = requiredNonemptyText(body, "admin_email", 254).toLowerCase();
  const adminPassword = requiredString(body, "admin_password", { min: 8, max: 128 });
  if (!validEmail(adminEmail)) {
    throw new ApiError(400, "VALIDATION_ERROR", "admin_email must be a valid email address.");
  }
  const phone = optionalText(body, "phone", 40) ?? null;
  const tin = optionalText(body, "tin", 80) ?? null;
  const address = optionalText(body, "address", 500) ?? null;
  const city = optionalText(body, "city", 120) ?? null;
  const district = optionalText(body, "district", 120) ?? null;
  const passwordHash = await hashPassword(adminPassword);
  const actor = c.get("user");
  const sql = getDb(c.env);
  const ip = requestIp(c);
  const metadata = JSON.stringify({ admin_email: adminEmail, farm_type: farmType });
  try {
    const created = await sql`
      WITH new_user AS (
        INSERT INTO users (name, email, phone, password_hash, role, sector, waitlist)
        VALUES (${adminName}, ${adminEmail}, ${phone}, ${passwordHash},
          'farm_admin', 'farm', FALSE)
        RETURNING id, name, email, phone
      ),
      new_organization AS (
        INSERT INTO farm_organizations
          (name, farm_type, tin, address, city, district, phone, created_by)
        SELECT ${name}, ${farmType}, ${tin}, ${address}, ${city}, ${district},
          ${phone}, id FROM new_user
        RETURNING *
      ),
      new_settings AS (
        INSERT INTO farm_settings (organization_id)
        SELECT id FROM new_organization
        RETURNING id
      ),
      seeded_types AS (
        INSERT INTO farm_animal_types
          (organization_id, code, name, category, unit, tracking_mode)
        SELECT o.id, defaults.code, defaults.name, defaults.category,
          defaults.unit, defaults.tracking_mode
        FROM new_organization o
        CROSS JOIN (VALUES
          ('CATTLE', 'Cattle', 'Livestock', 'head', 'individual'),
          ('GOAT', 'Goats', 'Livestock', 'head', 'individual'),
          ('SHEEP', 'Sheep', 'Livestock', 'head', 'individual'),
          ('PIG', 'Pigs', 'Livestock', 'head', 'individual'),
          ('CHICKEN', 'Chickens', 'Poultry', 'bird', 'batch'),
          ('DUCK', 'Ducks', 'Poultry', 'bird', 'batch'),
          ('TURKEY', 'Turkeys', 'Poultry', 'bird', 'batch'),
          ('RABBIT', 'Rabbits', 'Small Stock', 'head', 'individual'),
          ('FISH', 'Fish (Tilapia/Catfish)', 'Aquaculture', 'kg', 'batch'),
          ('BEE', 'Bees', 'Apiculture', 'hive', 'batch')
        ) AS defaults(code, name, category, unit, tracking_mode)
        RETURNING id
      ),
      local_audit AS (
        INSERT INTO farm_audit
          (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT o.id, ${actor.id}, 'farm.organization_created',
          'farm_organizations', o.id, ${metadata}::jsonb
        FROM new_organization o
        RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log
          (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${actor.id}, 'farm', 'farm.organization_created',
          'farm_organizations', o.id, ${metadata}::jsonb, ${ip}
        FROM new_organization o
        RETURNING id
      )
      SELECT o.id, o.name, o.sector, o.registration_number, o.tin, o.farm_type,
        o.address, o.city, o.district, o.country, o.phone, o.email, o.website,
        o.logo_base64, o.brand_color, o.size_acres, o.created_by, o.created_at,
        u.id AS admin_id, u.name AS admin_name, u.email AS admin_email,
        u.phone AS admin_phone
      FROM new_organization o
      JOIN new_user u ON u.id = o.created_by
    `;
    const organization = created[0];
    const emailSent = await sendEmail(c.env, {
      to: adminEmail,
      subject: "Welcome to APSHULE Farm",
      html: welcomeEmailTemplate(adminName, "Farm Administrator", null, c.env.APP_URL),
    });
    return c.json({ organization, email_sent: emailSent }, 201);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "EMAIL_IN_USE", "A user with this administrator email already exists.");
    }
    throw error;
  }
});

farm.patch(
  "/organizations/:id",
  requireRole("superadmin", "farm_admin"),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const body = await readJson(c);
    const sql = getDb(c.env);
    const actor = c.get("user");
    const organizationId = await organizationForUser(sql, actor, id);
    const fields = {
      name: optionalText(body, "name", 200),
      registration_number: optionalText(body, "registration_number", 120),
      tin: optionalText(body, "tin", 80),
      farm_type: optionalText(body, "farm_type", 100),
      address: optionalText(body, "address", 500),
      city: optionalText(body, "city", 120),
      district: optionalText(body, "district", 120),
      country: optionalText(body, "country", 80),
      phone: optionalText(body, "phone", 40),
      email: optionalEmail(body, "email"),
      website: optionalText(body, "website", 300),
      logo_base64: optionalImage(body, "logo_base64"),
      brand_color: optionalBrandColor(body, "brand_color"),
      size_acres: optionalNumber(body, "size_acres", { min: 0 }),
    };
    if (!Object.values(fields).some((value) => value !== undefined)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one organization field to update.");
    }
    const rows = await sql`
      UPDATE farm_organizations SET
        name = CASE WHEN ${fields.name !== undefined} THEN ${fields.name ?? null} ELSE name END,
        registration_number = CASE WHEN ${fields.registration_number !== undefined} THEN ${fields.registration_number ?? null} ELSE registration_number END,
        tin = CASE WHEN ${fields.tin !== undefined} THEN ${fields.tin ?? null} ELSE tin END,
        farm_type = CASE WHEN ${fields.farm_type !== undefined} THEN ${fields.farm_type ?? null} ELSE farm_type END,
        address = CASE WHEN ${fields.address !== undefined} THEN ${fields.address ?? null} ELSE address END,
        city = CASE WHEN ${fields.city !== undefined} THEN ${fields.city ?? null} ELSE city END,
        district = CASE WHEN ${fields.district !== undefined} THEN ${fields.district ?? null} ELSE district END,
        country = CASE WHEN ${fields.country !== undefined} THEN ${fields.country ?? null} ELSE country END,
        phone = CASE WHEN ${fields.phone !== undefined} THEN ${fields.phone ?? null} ELSE phone END,
        email = CASE WHEN ${fields.email !== undefined} THEN ${fields.email ?? null} ELSE email END,
        website = CASE WHEN ${fields.website !== undefined} THEN ${fields.website ?? null} ELSE website END,
        logo_base64 = CASE WHEN ${fields.logo_base64 !== undefined} THEN ${fields.logo_base64 ?? null} ELSE logo_base64 END,
        brand_color = CASE WHEN ${fields.brand_color !== undefined} THEN ${fields.brand_color} ELSE brand_color END,
        size_acres = CASE WHEN ${fields.size_acres !== undefined} THEN ${fields.size_acres ?? null} ELSE size_acres END,
        updated_at = NOW()
      WHERE id = ${organizationId}
      RETURNING *
    `;
    const organization = rows[0] as { id: string } | undefined;
    if (!organization) throw new ApiError(404, "FARM_ORGANIZATION_NOT_FOUND", "Farm organization was not found.");
    await auditMutation(sql, actor, organizationId, "farm.organization_updated", "farm_organizations", organization.id, { fields: Object.keys(body) }, requestIp(c));
    return c.json({ organization });
  },
);

farm.get(
  "/locations",
  requireRole("superadmin", ...FARM_STAFF),
  async (c) => {
    const sql = getDb(c.env);
    const organizationId = await loadOrganization(sql, c.get("user"), c.req.query("organization_id"));
    const locations = await sql`
      SELECT l.*, u.name AS manager_name
      FROM farm_locations l
      LEFT JOIN users u ON u.id = l.manager_id
      WHERE l.organization_id = ${organizationId}
      ORDER BY l.active DESC, l.name
    `;
    return c.json({ locations });
  },
);

farm.post(
  "/locations",
  requireRole("superadmin", "farm_admin", "farm_manager"),
  async (c) => {
    const body = await readJson(c);
    const sql = getDb(c.env);
    const actor = c.get("user");
    const organizationId = await loadOrganization(sql, actor, optionalText(body, "organization_id", 36) || undefined);
    const name = requiredNonemptyText(body, "name");
    const code = optionalText(body, "code", 60) ?? null;
    const address = optionalText(body, "address", 500) ?? null;
    const district = optionalText(body, "district", 120) ?? null;
    const sizeAcres = optionalNumber(body, "size_acres", { min: 0 }) ?? null;
    const managerId = optionalUuid(body, "manager_id") ?? null;
    await assertFarmManager(sql, organizationId, managerId);
    const created = await sql`
      INSERT INTO farm_locations
        (organization_id, name, code, address, district, size_acres, manager_id, created_by)
      VALUES
        (${organizationId}, ${name}, ${code}, ${address}, ${district}, ${sizeAcres},
         ${managerId}, ${actor.id})
      RETURNING *
    `;
    const location = created[0] as { id: string } | undefined;
    if (!location) throw new ApiError(500, "LOCATION_CREATE_FAILED", "Location could not be created.");
    await auditMutation(sql, actor, organizationId, "farm.location_created", "farm_locations", location.id, { name }, requestIp(c));
    return c.json({ location }, 201);
  },
);

farm.patch(
  "/locations/:id",
  requireRole("superadmin", "farm_admin", "farm_manager"),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const body = await readJson(c);
    const sql = getDb(c.env);
    const actor = c.get("user");
    const organizationId = await loadOrganization(sql, actor, optionalText(body, "organization_id", 36) || undefined);
    const fields = {
      name: optionalText(body, "name", 200),
      code: optionalText(body, "code", 60),
      address: optionalText(body, "address", 500),
      district: optionalText(body, "district", 120),
      size_acres: optionalNumber(body, "size_acres", { min: 0 }),
      manager_id: optionalUuid(body, "manager_id"),
      active: optionalBoolean(body, "active"),
    };
    if (fields.manager_id !== undefined) {
      await assertFarmManager(sql, organizationId, fields.manager_id);
    }
    if (!Object.values(fields).some((value) => value !== undefined)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one location field to update.");
    }
    if (fields.name === "") throw new ApiError(400, "VALIDATION_ERROR", "name must not be empty.");
    const rows = await sql`
      UPDATE farm_locations SET
        name = CASE WHEN ${fields.name !== undefined} THEN ${fields.name ?? null} ELSE name END,
        code = CASE WHEN ${fields.code !== undefined} THEN ${fields.code ?? null} ELSE code END,
        address = CASE WHEN ${fields.address !== undefined} THEN ${fields.address ?? null} ELSE address END,
        district = CASE WHEN ${fields.district !== undefined} THEN ${fields.district ?? null} ELSE district END,
        size_acres = CASE WHEN ${fields.size_acres !== undefined} THEN ${fields.size_acres ?? null} ELSE size_acres END,
        manager_id = CASE WHEN ${fields.manager_id !== undefined} THEN ${fields.manager_id ?? null} ELSE manager_id END,
        active = CASE WHEN ${fields.active !== undefined} THEN ${fields.active ?? true} ELSE active END,
        updated_at = NOW()
      WHERE id = ${id} AND organization_id = ${organizationId}
      RETURNING *
    `;
    const location = rows[0] as { id: string } | undefined;
    if (!location) throw new ApiError(404, "LOCATION_NOT_FOUND", "Location was not found in this farm.");
    await auditMutation(sql, actor, organizationId, "farm.location_updated", "farm_locations", location.id, { fields: Object.keys(body) }, requestIp(c));
    return c.json({ location });
  },
);

farm.delete(
  "/locations/:id",
  requireRole("superadmin", "farm_admin"),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const sql = getDb(c.env);
    const actor = c.get("user");
    const organizationId = await loadOrganization(sql, actor, c.req.query("organization_id"));
    const rows = await sql`
      UPDATE farm_locations SET active = FALSE, updated_at = NOW()
      WHERE id = ${id} AND organization_id = ${organizationId} AND active IS TRUE
      RETURNING id
    `;
    const location = rows[0] as { id: string } | undefined;
    if (!location) throw new ApiError(404, "LOCATION_NOT_FOUND", "Active location was not found in this farm.");
    await auditMutation(sql, actor, organizationId, "farm.location_deactivated", "farm_locations", location.id, {}, requestIp(c));
    return c.json({ ok: true });
  },
);

farm.get(
  "/workers",
  requireRole("superadmin", ...FARM_STAFF),
  async (c) => {
    const sql = getDb(c.env);
    const organizationId = await loadOrganization(sql, c.get("user"), c.req.query("organization_id"));
    const workers = await sql`
      SELECT w.*, u.name, u.email,
        split_part(u.name, ' ', 1) AS first_name,
        CASE WHEN position(' ' IN u.name) > 0
          THEN substring(u.name FROM position(' ' IN u.name) + 1) ELSE '' END AS last_name,
        COALESCE(w.phone, u.phone) AS display_phone
      FROM farm_workers w
      JOIN users u ON u.id = w.user_id
      WHERE w.organization_id = ${organizationId}
      ORDER BY w.active DESC, u.name
    `;
    return c.json({ workers });
  },
);

farm.post(
  "/workers",
  requireRole("superadmin", "farm_admin"),
  async (c) => {
    const body = await readJson(c);
    const actor = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await loadOrganization(sql, actor, optionalText(body, "organization_id", 36) || undefined);
    const firstName = requiredNonemptyText(body, "first_name", 120);
    const lastName = requiredNonemptyText(body, "last_name", 120);
    const email = requiredNonemptyText(body, "email", 254).toLowerCase();
    if (!validEmail(email)) throw new ApiError(400, "VALIDATION_ERROR", "email must be a valid email address.");
    const password = requiredString(body, "password", { min: 8, max: 128 });
    const role = roleChoice(body.role ?? "farm_worker");
    const phone = optionalText(body, "phone", 40) ?? null;
    const locationId = optionalUuid(body, "location_id") ?? null;
    await assertLocation(sql, organizationId, locationId);
    const employeeCode = optionalText(body, "employee_code", 80) ?? null;
    const wageType = optionalText(body, "wage_type", 80) ?? "daily";
    const wageRate = optionalNumber(body, "wage_rate", { min: 0 }) ?? null;
    const passwordHash = await hashPassword(password);
    const name = `${firstName} ${lastName}`.trim();
    const metadata = JSON.stringify({ role, employee_code: employeeCode });
    try {
      const created = await sql`
        WITH new_user AS (
          INSERT INTO users (name, email, phone, password_hash, role, sector, waitlist)
          VALUES (${name}, ${email}, ${phone}, ${passwordHash}, ${role}, 'farm', FALSE)
          RETURNING id, name, email, phone
        ),
        new_worker AS (
          INSERT INTO farm_workers
            (organization_id, location_id, user_id, role, employee_code,
             phone, wage_type, wage_rate)
          SELECT ${organizationId}, ${locationId}, u.id, ${role}, ${employeeCode},
            ${phone}, ${wageType}, ${wageRate}
          FROM new_user u
          RETURNING *
        ),
        local_audit AS (
          INSERT INTO farm_audit
            (organization_id, actor_id, action, target_table, target_id, metadata)
          SELECT ${organizationId}, ${actor.id}, 'farm.worker_created',
            'farm_workers', w.id, ${metadata}::jsonb
          FROM new_worker w RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log
            (actor_id, sector, action, target_table, target_id, metadata, ip)
          SELECT ${actor.id}, 'farm', 'farm.worker_created',
            'farm_workers', w.id, ${metadata}::jsonb, ${requestIp(c)}
          FROM new_worker w RETURNING id
        )
        SELECT w.*, u.name, u.email,
          split_part(u.name, ' ', 1) AS first_name,
          CASE WHEN position(' ' IN u.name) > 0
            THEN substring(u.name FROM position(' ' IN u.name) + 1) ELSE '' END AS last_name
        FROM new_worker w JOIN new_user u ON u.id = w.user_id
      `;
      const worker = created[0] as Record<string, unknown> | undefined;
      if (!worker) throw new ApiError(500, "WORKER_CREATE_FAILED", "Worker account could not be created.");
      const emailSent = await sendEmail(c.env, {
        to: email,
        subject: "Welcome to APSHULE Farm",
        html: welcomeEmailTemplate(name, role === "farm_manager" ? "Farm Manager" : "Farm Worker", null, c.env.APP_URL),
      });
      return c.json({ worker, email_sent: emailSent }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "EMAIL_OR_CODE_IN_USE", "The email or employee code is already in use.");
      }
      throw error;
    }
  },
);

farm.patch(
  "/workers/:id",
  requireRole("superadmin", "farm_admin"),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const body = await readJson(c);
    const sql = getDb(c.env);
    const actor = c.get("user");
    const organizationId = await loadOrganization(sql, actor, optionalText(body, "organization_id", 36) || undefined);
    const existingRows = await sql`
      SELECT w.*, u.name, u.email, u.phone AS user_phone
      FROM farm_workers w JOIN users u ON u.id = w.user_id
      WHERE w.id = ${id} AND w.organization_id = ${organizationId}
      LIMIT 1
    `;
    const existing = existingRows[0] as {
      id: string; user_id: string; name: string; email: string;
      phone: string | null; user_phone: string | null; role: string;
    } | undefined;
    if (!existing) throw new ApiError(404, "WORKER_NOT_FOUND", "Worker was not found in this farm.");
    const firstName = optionalText(body, "first_name", 120);
    const lastName = optionalText(body, "last_name", 120);
    const nameParts = existing.name.split(/\s+/u);
    const name = `${firstName ?? nameParts[0] ?? ""} ${lastName ?? nameParts.slice(1).join(" ")}`.trim();
    const email = optionalEmail(body, "email");
    const phone = optionalText(body, "phone", 40);
    const role = body.role === undefined ? undefined : roleChoice(body.role);
    const locationId = optionalUuid(body, "location_id");
    const employeeCode = optionalText(body, "employee_code", 80);
    const wageType = optionalText(body, "wage_type", 80);
    const wageRate = optionalNumber(body, "wage_rate", { min: 0 });
    const active = optionalBoolean(body, "active");
    if (![
      firstName, lastName, email, phone, role, locationId, employeeCode,
      wageType, wageRate, active,
    ].some((value) => value !== undefined)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one worker field to update.");
    }
    if (locationId !== undefined) await assertLocation(sql, organizationId, locationId);
    try {
      await sql`
        UPDATE users SET
          name = ${name},
          email = CASE WHEN ${email !== undefined} THEN ${email ?? null} ELSE email END,
          phone = CASE WHEN ${phone !== undefined} THEN ${phone ?? null} ELSE phone END
        WHERE id = ${existing.user_id}
      `;
      const rows = await sql`
        UPDATE farm_workers SET
          role = CASE WHEN ${role !== undefined} THEN ${role ?? existing.role} ELSE role END,
          location_id = CASE WHEN ${locationId !== undefined} THEN ${locationId ?? null} ELSE location_id END,
          employee_code = CASE WHEN ${employeeCode !== undefined} THEN ${employeeCode ?? null} ELSE employee_code END,
          phone = CASE WHEN ${phone !== undefined} THEN ${phone ?? null} ELSE phone END,
          wage_type = CASE WHEN ${wageType !== undefined} THEN ${wageType ?? null} ELSE wage_type END,
          wage_rate = CASE WHEN ${wageRate !== undefined} THEN ${wageRate ?? null} ELSE wage_rate END,
          active = CASE WHEN ${active !== undefined} THEN ${active ?? true} ELSE active END,
          updated_at = NOW()
        WHERE id = ${id} AND organization_id = ${organizationId}
        RETURNING *
      `;
      const worker = rows[0] as Record<string, unknown> | undefined;
      if (!worker) throw new ApiError(404, "WORKER_NOT_FOUND", "Worker was not found in this farm.");
      await auditMutation(sql, actor, organizationId, "farm.worker_updated", "farm_workers", id, { fields: Object.keys(body) }, requestIp(c));
      return c.json({ worker });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "EMAIL_OR_CODE_IN_USE", "The email or employee code is already in use.");
      }
      throw error;
    }
  },
);

farm.delete(
  "/workers/:id",
  requireRole("superadmin", "farm_admin"),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const sql = getDb(c.env);
    const actor = c.get("user");
    const organizationId = await loadOrganization(sql, actor, c.req.query("organization_id"));
    const rows = await sql`
      UPDATE farm_workers SET active = FALSE, updated_at = NOW()
      WHERE id = ${id} AND organization_id = ${organizationId} AND active IS TRUE
      RETURNING id
    `;
    if (!rows[0]) throw new ApiError(404, "WORKER_NOT_FOUND", "Active worker was not found in this farm.");
    await auditMutation(sql, actor, organizationId, "farm.worker_deactivated", "farm_workers", id, {}, requestIp(c));
    return c.json({ ok: true });
  },
);

farm.get(
  "/animal-types",
  requireRole("superadmin", ...FARM_STAFF),
  async (c) => {
    const sql = getDb(c.env);
    const organizationId = await loadOrganization(sql, c.get("user"), c.req.query("organization_id"));
    const animalTypes = await sql`
      SELECT * FROM farm_animal_types
      WHERE organization_id = ${organizationId}
      ORDER BY active DESC, name
    `;
    return c.json({ animalTypes });
  },
);

farm.post(
  "/animal-types",
  requireRole("superadmin", "farm_admin"),
  async (c) => {
    const body = await readJson(c);
    const sql = getDb(c.env);
    const actor = c.get("user");
    const organizationId = await loadOrganization(sql, actor, optionalText(body, "organization_id", 36) || undefined);
    const code = requiredNonemptyText(body, "code", 60).toUpperCase();
    const name = requiredNonemptyText(body, "name");
    const category = optionalText(body, "category", 100) ?? null;
    const unit = optionalText(body, "unit", 40) ?? "head";
    const trackingMode = body.tracking_mode ?? "individual";
    if (trackingMode !== "individual" && trackingMode !== "batch") {
      throw new ApiError(400, "VALIDATION_ERROR", "tracking_mode must be individual or batch.");
    }
    try {
      const rows = await sql`
        INSERT INTO farm_animal_types
          (organization_id, code, name, category, unit, tracking_mode)
        VALUES (${organizationId}, ${code}, ${name}, ${category}, ${unit}, ${trackingMode})
        RETURNING *
      `;
      const animalType = rows[0] as { id: string } | undefined;
      if (!animalType) throw new ApiError(500, "ANIMAL_TYPE_CREATE_FAILED", "Animal type could not be created.");
      await auditMutation(sql, actor, organizationId, "farm.animal_type_created", "farm_animal_types", animalType.id, { code, name }, requestIp(c));
      return c.json({ animalType }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, "ANIMAL_TYPE_CODE_IN_USE", "An animal type with this code already exists.");
      throw error;
    }
  },
);

farm.patch(
  "/animal-types/:id",
  requireRole("superadmin", "farm_admin"),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const body = await readJson(c);
    const sql = getDb(c.env);
    const actor = c.get("user");
    const organizationId = await loadOrganization(sql, actor, optionalText(body, "organization_id", 36) || undefined);
    const code = optionalText(body, "code", 60);
    const name = optionalText(body, "name", 200);
    const category = optionalText(body, "category", 100);
    const unit = optionalText(body, "unit", 40);
    const active = optionalBoolean(body, "active");
    const trackingMode = body.tracking_mode as unknown;
    if (trackingMode !== undefined && trackingMode !== "individual" && trackingMode !== "batch") {
      throw new ApiError(400, "VALIDATION_ERROR", "tracking_mode must be individual or batch.");
    }
    if (![code, name, category, unit, active, trackingMode].some((value) => value !== undefined)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one animal type field to update.");
    }
    try {
      const rows = await sql`
        UPDATE farm_animal_types SET
          code = CASE WHEN ${code !== undefined} THEN ${code?.toUpperCase() ?? null} ELSE code END,
          name = CASE WHEN ${name !== undefined} THEN ${name ?? null} ELSE name END,
          category = CASE WHEN ${category !== undefined} THEN ${category ?? null} ELSE category END,
          unit = CASE WHEN ${unit !== undefined} THEN ${unit ?? null} ELSE unit END,
          active = CASE WHEN ${active !== undefined} THEN ${active ?? true} ELSE active END,
          tracking_mode = CASE WHEN ${trackingMode !== undefined} THEN ${trackingMode ?? "individual"} ELSE tracking_mode END,
          updated_at = NOW()
        WHERE id = ${id} AND organization_id = ${organizationId}
        RETURNING *
      `;
      const animalType = rows[0] as { id: string } | undefined;
      if (!animalType) throw new ApiError(404, "ANIMAL_TYPE_NOT_FOUND", "Animal type was not found in this farm.");
      await auditMutation(sql, actor, organizationId, "farm.animal_type_updated", "farm_animal_types", id, { fields: Object.keys(body) }, requestIp(c));
      return c.json({ animalType });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(409, "ANIMAL_TYPE_CODE_IN_USE", "An animal type with this code already exists.");
      throw error;
    }
  },
);

farm.delete(
  "/animal-types/:id",
  requireRole("superadmin", "farm_admin"),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const sql = getDb(c.env);
    const actor = c.get("user");
    const organizationId = await loadOrganization(sql, actor, c.req.query("organization_id"));
    const rows = await sql`
      UPDATE farm_animal_types SET active = FALSE, updated_at = NOW()
      WHERE id = ${id} AND organization_id = ${organizationId} AND active IS TRUE
      RETURNING id
    `;
    if (!rows[0]) throw new ApiError(404, "ANIMAL_TYPE_NOT_FOUND", "Active animal type was not found in this farm.");
    await auditMutation(sql, actor, organizationId, "farm.animal_type_deactivated", "farm_animal_types", id, {}, requestIp(c));
    return c.json({ ok: true });
  },
);

farm.post(
  "/animal-types/seed-defaults",
  requireRole("superadmin", "farm_admin"),
  async (c) => {
    const sql = getDb(c.env);
    const actor = c.get("user");
    const body = await readJson(c);
    const organizationId = await loadOrganization(sql, actor, optionalText(body, "organization_id", 36) || undefined);
    const seeded = await sql`
      INSERT INTO farm_animal_types
        (organization_id, code, name, category, unit, tracking_mode)
      VALUES
        (${organizationId}, 'CATTLE', 'Cattle', 'Livestock', 'head', 'individual'),
        (${organizationId}, 'GOAT', 'Goats', 'Livestock', 'head', 'individual'),
        (${organizationId}, 'SHEEP', 'Sheep', 'Livestock', 'head', 'individual'),
        (${organizationId}, 'PIG', 'Pigs', 'Livestock', 'head', 'individual'),
        (${organizationId}, 'CHICKEN', 'Chickens', 'Poultry', 'bird', 'batch'),
        (${organizationId}, 'DUCK', 'Ducks', 'Poultry', 'bird', 'batch'),
        (${organizationId}, 'TURKEY', 'Turkeys', 'Poultry', 'bird', 'batch'),
        (${organizationId}, 'RABBIT', 'Rabbits', 'Small Stock', 'head', 'individual'),
        (${organizationId}, 'FISH', 'Fish (Tilapia/Catfish)', 'Aquaculture', 'kg', 'batch'),
        (${organizationId}, 'BEE', 'Bees', 'Apiculture', 'hive', 'batch')
      ON CONFLICT (organization_id, code) DO NOTHING
      RETURNING id
    `;
    const animalTypes = await sql`
      SELECT * FROM farm_animal_types
      WHERE organization_id = ${organizationId}
      ORDER BY active DESC, name
    `;
    if (seeded.length) {
      await auditMutation(sql, actor, organizationId, "farm.animal_types_seeded", "farm_animal_types", null, { created_count: seeded.length }, requestIp(c));
    }
    return c.json({ animalTypes, created_count: seeded.length });
  },
);

farm.get(
  "/animals",
  requireRole("superadmin", ...FARM_STAFF),
  async (c) => {
    const sql = getDb(c.env);
    const organizationId = await loadOrganization(sql, c.get("user"), c.req.query("organization_id"));
    const locationId = c.req.query("location_id");
    const typeId = c.req.query("type_id");
    const status = c.req.query("status");
    const healthStatus = c.req.query("health_status");
    const search = c.req.query("search")?.trim() || "";
    const animals = await sql`
      SELECT a.*, t.name AS type_name, t.code AS type_code,
        t.tracking_mode, l.name AS location_name
      FROM farm_animals a
      LEFT JOIN farm_animal_types t ON t.id = a.animal_type_id
      LEFT JOIN farm_locations l ON l.id = a.location_id
      WHERE a.organization_id = ${organizationId}
        AND (${locationId === undefined} OR a.location_id = ${locationId ?? null})
        AND (${typeId === undefined} OR a.animal_type_id = ${typeId ?? null})
        AND (${status === undefined} OR a.status = ${status ?? null})
        AND (${healthStatus === undefined} OR a.health_status = ${healthStatus ?? null})
        AND (${!search} OR a.tag_number ILIKE ${`%${search}%`} OR a.name ILIKE ${`%${search}%`})
      ORDER BY a.created_at DESC
      LIMIT 500
    `;
    return c.json({ animals });
  },
);

farm.post(
  "/animals",
  requireRole("superadmin", "farm_admin", "farm_manager"),
  async (c) => {
    const body = await readJson(c);
    const sql = getDb(c.env);
    const actor = c.get("user");
    const organizationId = await loadOrganization(sql, actor, optionalText(body, "organization_id", 36) || undefined);
    const locationId = optionalUuid(body, "location_id") ?? null;
    await assertLocation(sql, organizationId, locationId);
    const typeId = pathUuid(requiredNonemptyText(body, "animal_type_id", 36), "animal_type_id");
    const typeRows = await sql`
      SELECT id, code, tracking_mode FROM farm_animal_types
      WHERE id = ${typeId} AND organization_id = ${organizationId} AND active IS TRUE
      LIMIT 1
    `;
    const animalType = typeRows[0] as { id: string; code: string; tracking_mode: string } | undefined;
    if (!animalType) throw new ApiError(400, "ANIMAL_TYPE_NOT_FOUND", "The selected animal type is not active in this farm.");
    const tagInput = optionalText(body, "tag_number", 120);
    const name = optionalText(body, "name", 200) ?? null;
    const gender = optionalText(body, "gender", 40) ?? null;
    const dateOfBirth = optionalDate(body, "date_of_birth") ?? null;
    const weightKg = optionalNumber(body, "weight_kg", { min: 0 }) ?? null;
    const quantity = optionalNumber(body, "quantity", { min: 1, integer: true }) ?? 1;
    const healthStatus = optionalText(body, "health_status", 80) ?? "healthy";
    const status = optionalText(body, "status", 80) ?? "active";
    const notes = optionalText(body, "notes", 5000) ?? null;
    const photo = optionalImage(body, "photo_base64") ?? null;
    let tagNumber = tagInput || null;
    if (!tagNumber && animalType.tracking_mode === "individual") {
      const sequenceRows = await sql`
        UPDATE farm_organizations
        SET animal_tag_sequence = animal_tag_sequence + 1, updated_at = NOW()
        WHERE id = ${organizationId}
        RETURNING animal_tag_sequence
      `;
      const sequence = Number((sequenceRows[0] as { animal_tag_sequence?: number } | undefined)?.animal_tag_sequence || 0);
      if (!sequence) throw new ApiError(404, "FARM_ORGANIZATION_NOT_FOUND", "Farm organization was not found.");
      tagNumber = `${animalType.code}-${String(sequence).padStart(3, "0")}`;
    }
    const rows = await sql`
      INSERT INTO farm_animals
        (organization_id, location_id, animal_type_id, tag_number, name, gender,
         date_of_birth, weight_kg, quantity, health_status, photo_base64, notes,
         status, created_by)
      VALUES
        (${organizationId}, ${locationId}, ${animalType.id}, ${tagNumber}, ${name},
         ${gender}, ${dateOfBirth}, ${weightKg}, ${quantity}, ${healthStatus},
         ${photo}, ${notes}, ${status}, ${actor.id})
      RETURNING *
    `;
    const animal = rows[0] as { id: string; tag_number?: string | null } | undefined;
    if (!animal) throw new ApiError(500, "ANIMAL_CREATE_FAILED", "Animal record could not be created.");
    await auditMutation(sql, actor, organizationId, "farm.animal_created", "farm_animals", animal.id, { tag_number: animal.tag_number ?? null, animal_type_id: typeId }, requestIp(c));
    return c.json({ animal }, 201);
  },
);

farm.get(
  "/animals/:id",
  requireRole("superadmin", ...FARM_STAFF),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const sql = getDb(c.env);
    const organizationId = await loadOrganization(sql, c.get("user"), c.req.query("organization_id"));
    const rows = await sql`
      SELECT a.*, t.name AS type_name, t.code AS type_code, t.tracking_mode,
        l.name AS location_name
      FROM farm_animals a
      LEFT JOIN farm_animal_types t ON t.id = a.animal_type_id
      LEFT JOIN farm_locations l ON l.id = a.location_id
      WHERE a.id = ${id} AND a.organization_id = ${organizationId}
      LIMIT 1
    `;
    const animal = rows[0];
    if (!animal) throw new ApiError(404, "ANIMAL_NOT_FOUND", "Animal record was not found in this farm.");
    return c.json({ animal });
  },
);

farm.patch(
  "/animals/:id",
  requireRole("superadmin", "farm_admin", "farm_manager"),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const body = await readJson(c);
    const sql = getDb(c.env);
    const actor = c.get("user");
    const organizationId = await loadOrganization(sql, actor, optionalText(body, "organization_id", 36) || undefined);
    const locationId = optionalUuid(body, "location_id");
    if (locationId !== undefined) await assertLocation(sql, organizationId, locationId);
    const animalTypeId = optionalUuid(body, "animal_type_id");
    if (animalTypeId) {
      const typeRows = await sql`
        SELECT id FROM farm_animal_types
        WHERE id = ${animalTypeId} AND organization_id = ${organizationId} AND active IS TRUE
        LIMIT 1
      `;
      if (!typeRows[0]) throw new ApiError(400, "ANIMAL_TYPE_NOT_FOUND", "The selected animal type is not active in this farm.");
    }
    const fields = {
      location_id: locationId,
      animal_type_id: animalTypeId,
      tag_number: optionalText(body, "tag_number", 120),
      name: optionalText(body, "name", 200),
      gender: optionalText(body, "gender", 40),
      date_of_birth: optionalDate(body, "date_of_birth"),
      weight_kg: optionalNumber(body, "weight_kg", { min: 0 }),
      quantity: optionalNumber(body, "quantity", { min: 1, integer: true }),
      health_status: optionalText(body, "health_status", 80),
      status: optionalText(body, "status", 80),
      notes: optionalText(body, "notes", 5000),
      photo_base64: optionalImage(body, "photo_base64"),
    };
    if (!Object.values(fields).some((value) => value !== undefined)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one animal field to update.");
    }
    const rows = await sql`
      UPDATE farm_animals SET
        location_id = CASE WHEN ${fields.location_id !== undefined} THEN ${fields.location_id ?? null} ELSE location_id END,
        animal_type_id = CASE WHEN ${fields.animal_type_id !== undefined} THEN ${fields.animal_type_id ?? null} ELSE animal_type_id END,
        tag_number = CASE WHEN ${fields.tag_number !== undefined} THEN ${fields.tag_number ?? null} ELSE tag_number END,
        name = CASE WHEN ${fields.name !== undefined} THEN ${fields.name ?? null} ELSE name END,
        gender = CASE WHEN ${fields.gender !== undefined} THEN ${fields.gender ?? null} ELSE gender END,
        date_of_birth = CASE WHEN ${fields.date_of_birth !== undefined} THEN ${fields.date_of_birth ?? null} ELSE date_of_birth END,
        weight_kg = CASE WHEN ${fields.weight_kg !== undefined} THEN ${fields.weight_kg ?? null} ELSE weight_kg END,
        quantity = CASE WHEN ${fields.quantity !== undefined} THEN ${fields.quantity ?? 1} ELSE quantity END,
        health_status = CASE WHEN ${fields.health_status !== undefined} THEN ${fields.health_status ?? null} ELSE health_status END,
        status = CASE WHEN ${fields.status !== undefined} THEN ${fields.status ?? null} ELSE status END,
        notes = CASE WHEN ${fields.notes !== undefined} THEN ${fields.notes ?? null} ELSE notes END,
        photo_base64 = CASE WHEN ${fields.photo_base64 !== undefined} THEN ${fields.photo_base64 ?? null} ELSE photo_base64 END,
        updated_at = NOW()
      WHERE id = ${id} AND organization_id = ${organizationId}
      RETURNING *
    `;
    const animal = rows[0] as { id: string } | undefined;
    if (!animal) throw new ApiError(404, "ANIMAL_NOT_FOUND", "Animal record was not found in this farm.");
    await auditMutation(sql, actor, organizationId, "farm.animal_updated", "farm_animals", id, { fields: Object.keys(body) }, requestIp(c));
    return c.json({ animal });
  },
);

farm.delete(
  "/animals/:id",
  requireRole("superadmin", "farm_admin"),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const sql = getDb(c.env);
    const actor = c.get("user");
    const organizationId = await loadOrganization(sql, actor, c.req.query("organization_id"));
    const rows = await sql`
      UPDATE farm_animals SET status = 'deleted', updated_at = NOW()
      WHERE id = ${id} AND organization_id = ${organizationId} AND status <> 'deleted'
      RETURNING id
    `;
    if (!rows[0]) throw new ApiError(404, "ANIMAL_NOT_FOUND", "Active animal record was not found in this farm.");
    await auditMutation(sql, actor, organizationId, "farm.animal_deleted", "farm_animals", id, { soft_delete: true }, requestIp(c));
    return c.json({ ok: true });
  },
);

farm.get(
  "/stats",
  requireRole("superadmin", ...FARM_STAFF),
  async (c) => {
    const sql = getDb(c.env);
    const organizationId = await loadOrganization(sql, c.get("user"), c.req.query("organization_id"));
    const counts = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM farm_locations
          WHERE organization_id = ${organizationId} AND active IS TRUE) AS locations,
        (SELECT COUNT(*)::int FROM farm_workers
          WHERE organization_id = ${organizationId} AND active IS TRUE) AS workers,
        (SELECT COALESCE(SUM(quantity), 0)::int FROM farm_animals
          WHERE organization_id = ${organizationId} AND status <> 'deleted') AS animals,
        (SELECT COUNT(*)::int FROM farm_animals
          WHERE organization_id = ${organizationId} AND status <> 'deleted'
            AND lower(health_status) NOT IN ('healthy', 'not recorded', 'not_recorded')) AS health_alerts
    `;
    const byType = await sql`
      SELECT t.id, t.code, t.name, t.category,
        COALESCE(SUM(a.quantity) FILTER (WHERE a.status <> 'deleted'), 0)::int AS count
      FROM farm_animal_types t
      LEFT JOIN farm_animals a ON a.animal_type_id = t.id
        AND a.organization_id = ${organizationId}
      WHERE t.organization_id = ${organizationId} AND t.active IS TRUE
      GROUP BY t.id
      ORDER BY t.name
    `;
    const result = counts[0] as Record<string, number | string> | undefined;
    return c.json({
      locations: Number(result?.locations || 0),
      workers: Number(result?.workers || 0),
      animals: Number(result?.animals || 0),
      health_alerts: Number(result?.health_alerts || 0),
      by_type: byType,
    });
  },
);

farm.get(
  "/settings",
  requireRole("superadmin", ...FARM_STAFF),
  async (c) => {
    const sql = getDb(c.env);
    const organizationId = await loadOrganization(sql, c.get("user"), c.req.query("organization_id"));
    const organizations = await sql`
      SELECT * FROM farm_organizations WHERE id = ${organizationId} LIMIT 1
    `;
    const settingsRows = await sql`
      SELECT * FROM farm_settings WHERE organization_id = ${organizationId} LIMIT 1
    `;
    if (!organizations[0]) throw new ApiError(404, "FARM_ORGANIZATION_NOT_FOUND", "Farm organization was not found.");
    return c.json({ organization: organizations[0], settings: settingsRows[0] ?? null });
  },
);

farm.patch(
  "/settings",
  requireRole("superadmin", "farm_admin"),
  async (c) => {
    const body = await readJson(c);
    const sql = getDb(c.env);
    const actor = c.get("user");
    const organizationId = await loadOrganization(sql, actor, optionalText(body, "organization_id", 36) || undefined);
    const fields = {
      name: optionalText(body, "name", 200),
      registration_number: optionalText(body, "registration_number", 120),
      tin: optionalText(body, "tin", 80),
      farm_type: optionalText(body, "farm_type", 100),
      address: optionalText(body, "address", 500),
      city: optionalText(body, "city", 120),
      district: optionalText(body, "district", 120),
      country: optionalText(body, "country", 80),
      phone: optionalText(body, "phone", 40),
      email: optionalEmail(body, "email"),
      website: optionalText(body, "website", 300),
      logo_base64: optionalImage(body, "logo_base64"),
      brand_color: optionalBrandColor(body, "brand_color"),
      size_acres: optionalNumber(body, "size_acres", { min: 0 }),
      currency: optionalText(body, "currency", 12),
      timezone: optionalText(body, "timezone", 80),
    };
    if (!Object.values(fields).some((value) => value !== undefined)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one settings field to update.");
    }
    const updatedOrganizations = await sql`
      UPDATE farm_organizations SET
        name = CASE WHEN ${fields.name !== undefined} THEN ${fields.name ?? null} ELSE name END,
        registration_number = CASE WHEN ${fields.registration_number !== undefined} THEN ${fields.registration_number ?? null} ELSE registration_number END,
        tin = CASE WHEN ${fields.tin !== undefined} THEN ${fields.tin ?? null} ELSE tin END,
        farm_type = CASE WHEN ${fields.farm_type !== undefined} THEN ${fields.farm_type ?? null} ELSE farm_type END,
        address = CASE WHEN ${fields.address !== undefined} THEN ${fields.address ?? null} ELSE address END,
        city = CASE WHEN ${fields.city !== undefined} THEN ${fields.city ?? null} ELSE city END,
        district = CASE WHEN ${fields.district !== undefined} THEN ${fields.district ?? null} ELSE district END,
        country = CASE WHEN ${fields.country !== undefined} THEN ${fields.country ?? null} ELSE country END,
        phone = CASE WHEN ${fields.phone !== undefined} THEN ${fields.phone ?? null} ELSE phone END,
        email = CASE WHEN ${fields.email !== undefined} THEN ${fields.email ?? null} ELSE email END,
        website = CASE WHEN ${fields.website !== undefined} THEN ${fields.website ?? null} ELSE website END,
        logo_base64 = CASE WHEN ${fields.logo_base64 !== undefined} THEN ${fields.logo_base64 ?? null} ELSE logo_base64 END,
        brand_color = CASE WHEN ${fields.brand_color !== undefined} THEN ${fields.brand_color} ELSE brand_color END,
        size_acres = CASE WHEN ${fields.size_acres !== undefined} THEN ${fields.size_acres ?? null} ELSE size_acres END,
        updated_at = NOW()
      WHERE id = ${organizationId}
      RETURNING *
    `;
    const settingsRows = await sql`
      INSERT INTO farm_settings (organization_id, currency, timezone)
      VALUES (${organizationId}, ${fields.currency ?? "UGX"}, ${fields.timezone ?? "Africa/Kampala"})
      ON CONFLICT (organization_id) DO UPDATE SET
        currency = CASE WHEN ${fields.currency !== undefined} THEN ${fields.currency ?? null} ELSE farm_settings.currency END,
        timezone = CASE WHEN ${fields.timezone !== undefined} THEN ${fields.timezone ?? null} ELSE farm_settings.timezone END,
        updated_at = NOW()
      RETURNING *
    `;
    await auditMutation(sql, actor, organizationId, "farm.organization_settings_updated", "farm_organizations", organizationId, { fields: Object.keys(body) }, requestIp(c));
    if (fields.currency !== undefined || fields.timezone !== undefined) {
      await auditMutation(sql, actor, organizationId, "farm.settings_updated", "farm_settings", (settingsRows[0] as { id?: string } | undefined)?.id || null, { currency_updated: fields.currency !== undefined, timezone_updated: fields.timezone !== undefined }, requestIp(c));
    }
    return c.json({ organization: updatedOrganizations[0], settings: settingsRows[0] });
  },
);

export default farm;
