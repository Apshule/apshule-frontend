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
  parseLimit,
  readJson,
  requiredString,
  validEmail,
} from "../http.js";
import {
  isMfiDate,
  isMfiImageDataUrl,
  isMfiOfficerRole,
} from "../mfi-domain.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";

const mfi = new Hono<AppEnv>();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MFI_OFFICER_ROLES = [
  "loan_officer",
  "loan_manager",
  "loan_director",
] as const;

const requireMfiSector = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user.role !== "superadmin" && user.sector !== "mfi") {
    throw new ApiError(403, "MFI_SECTOR_REQUIRED", "This endpoint is for MFI accounts.");
  }
  await next();
});

mfi.use("/mfi/*", authMiddleware, requireMfiSector);

function pathUuid(value: string, field = "id"): string {
  if (!UUID_PATTERN.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a valid UUID.`);
  }
  return value;
}

function nullableText(
  body: Record<string, unknown>,
  key: string,
  max = 500,
): string | null | undefined {
  const value = optionalString(body, key, { max, allowNull: true });
  if (value === undefined || value === null) return value;
  return value.length ? value : null;
}

function optionalDate(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = nullableText(body, key, 10);
  if (value === undefined || value === null) return value;
  if (!isMfiDate(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a valid YYYY-MM-DD date.`);
  }
  return value;
}

function optionalNumber(
  body: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number; integer?: boolean } = {},
): number | null | undefined {
  if (!(key in body)) return undefined;
  const raw = body[key];
  if (raw === null || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (
    !Number.isFinite(value) ||
    (options.min !== undefined && value < options.min) ||
    (options.max !== undefined && value > options.max) ||
    (options.integer && !Number.isInteger(value))
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} is outside the allowed range.`);
  }
  return value;
}

function optionalUuid(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = nullableText(body, key, 36);
  if (value === undefined || value === null) return value;
  return pathUuid(value, key);
}

function optionalEmail(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = nullableText(body, key, 254);
  if (value === undefined || value === null) return value;
  const normalized = value.toLowerCase();
  if (!validEmail(normalized)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a valid email address.`);
  }
  return normalized;
}

function optionalPhoto(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = nullableText(body, key, 280_000);
  if (value === undefined || value === null) return value;
  if (!isMfiImageDataUrl(value)) {
    throw new ApiError(
      400,
      "PHOTO_INVALID",
      `${key} must be a JPEG, PNG, or WebP image no larger than 200 KB.`,
    );
  }
  return value;
}

function optionalBrandColor(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = nullableText(body, key, 7);
  if (value === undefined || value === null) return value;
  if (!/^#[0-9a-f]{6}$/iu.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a six-digit hex color.`);
  }
  return value.toUpperCase();
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
): Promise<string> {
  const rows = user.role === "mfi_admin"
    ? await sql`
        SELECT id
        FROM mfi_organizations
        WHERE created_by = ${user.id}
        LIMIT 1
      `
    : await sql`
        SELECT organization_id AS id
        FROM mfi_officers
        WHERE user_id = ${user.id}
          AND active IS TRUE
        LIMIT 1
      `;
  const row = rows[0] as { id?: string } | undefined;
  if (!row?.id) {
    throw new ApiError(403, "MFI_ORGANIZATION_REQUIRED", "Your MFI account is not linked to an organization.");
  }
  return row.id;
}

async function assertBranchInOrganization(
  sql: ReturnType<typeof getDb>,
  branchId: string | null | undefined,
  organizationId: string,
): Promise<void> {
  if (!branchId) return;
  const rows = await sql`
    SELECT id
    FROM mfi_branches
    WHERE id = ${branchId}
      AND organization_id = ${organizationId}
      AND active IS TRUE
    LIMIT 1
  `;
  if (!rows[0]) {
    throw new ApiError(400, "BRANCH_NOT_FOUND", "The selected branch is not active in this organization.");
  }
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/gu, "\\$&")}%`;
}

// Organizations
mfi.get("/mfi/organizations", requireRole("superadmin", "mfi_admin"), async (c) => {
  const sql = getDb(c.env);
  const user = c.get("user");
  const rows = await sql`
    SELECT o.id, o.name, o.sector, o.registration_number, o.tin, o.license_number,
      o.address, o.phone, o.email, o.website, o.logo_base64, o.brand_color,
      o.city, o.district, o.country, o.created_by, o.created_at,
      admin.name AS admin_name, admin.email AS admin_email,
      (SELECT COUNT(*)::int FROM mfi_branches b
        WHERE b.organization_id = o.id AND b.active IS TRUE) AS branch_count,
      (SELECT COUNT(*)::int FROM mfi_customers c
        WHERE c.organization_id = o.id) AS customer_count,
      (SELECT COUNT(*)::int FROM mfi_collateral collateral
        WHERE collateral.organization_id = o.id) AS collateral_count
    FROM mfi_organizations o
    LEFT JOIN users admin ON admin.id = o.created_by
    WHERE ${user.role === "superadmin"} OR o.created_by = ${user.id}
    ORDER BY o.created_at DESC
  `;
  return c.json({ organizations: rows });
});

mfi.post("/mfi/organizations", requireRealSuperAdmin(), async (c) => {
  const body = await readJson(c);
  const name = requiredString(body, "name", { max: 200 });
  const adminName = optionalString(body, "adminName", { max: 120 })?.trim() || name;
  const loginEmail = requiredString(body, "loginEmail", { max: 254 }).toLowerCase();
  const loginPassword = requiredString(body, "loginPassword", { min: 8, max: 128 });
  if (!validEmail(loginEmail)) {
    throw new ApiError(400, "VALIDATION_ERROR", "loginEmail must be a valid email address.");
  }
  const phone = nullableText(body, "phone", 40) ?? null;
  const registrationNumber = nullableText(body, "registration_number", 120) ?? null;
  const tin = nullableText(body, "tin", 100) ?? null;
  const licenseNumber = nullableText(body, "license_number", 120) ?? null;
  const address = nullableText(body, "address", 500) ?? null;
  const email = optionalEmail(body, "email") ?? null;
  const website = nullableText(body, "website", 300) ?? null;
  const logo = optionalPhoto(body, "logo_base64") ?? null;
  const brandColor = optionalBrandColor(body, "brand_color") ?? "#0D47A1";
  const city = nullableText(body, "city", 120) ?? null;
  const district = nullableText(body, "district", 120) ?? null;
  const country = nullableText(body, "country", 80) ?? "Uganda";
  const passwordHash = await hashPassword(loginPassword);
  const actor = c.get("user");
  const ip = requestIp(c);
  const metadata = JSON.stringify({ admin_email: loginEmail });
  const sql = getDb(c.env);
  try {
    const rows = await sql`
      WITH new_user AS (
        INSERT INTO users (name, email, phone, password_hash, role, sector, waitlist)
        VALUES (${adminName}, ${loginEmail}, ${phone}, ${passwordHash}, 'mfi_admin', 'mfi', FALSE)
        RETURNING id, name, email
      ),
      new_organization AS (
        INSERT INTO mfi_organizations (
          name, sector, registration_number, tin, license_number, address, phone,
          email, website, logo_base64, brand_color, city, district, country, created_by
        )
        SELECT ${name}, 'mfi', ${registrationNumber}, ${tin}, ${licenseNumber},
          ${address}, ${phone}, ${email}, ${website}, ${logo}, ${brandColor},
          ${city}, ${district}, ${country}, id
        FROM new_user
        RETURNING *
      ),
      new_settings AS (
        INSERT INTO mfi_settings (organization_id)
        SELECT id FROM new_organization
        RETURNING id
      ),
      default_collateral_types AS (
        INSERT INTO mfi_collateral_types (
          organization_id, code, name, category, base_score,
          requires_valuation, requires_legal, active
        )
        SELECT organization.id, seed.code, seed.name, seed.category,
          seed.base_score, seed.requires_valuation, seed.requires_legal, TRUE
        FROM new_organization organization
        CROSS JOIN (VALUES
          ('LAND', 'Land', 'Immovable', 80, TRUE, TRUE),
          ('BUILDING', 'Building', 'Immovable', 85, TRUE, TRUE),
          ('VEHICLE', 'Vehicle', 'Movable', 65, TRUE, TRUE),
          ('MOTORCYCLE', 'Motorcycle/Boda', 'Movable', 60, TRUE, FALSE),
          ('LIVESTOCK', 'Livestock', 'Livestock', 55, TRUE, FALSE),
          ('CROPS', 'Crops', 'Agriculture', 45, TRUE, FALSE),
          ('HOUSEHOLD', 'Household Items', 'Movable', 35, FALSE, FALSE),
          ('SALARY', 'Salary Assignment', 'Income', 70, FALSE, TRUE),
          ('SAVINGS', 'Savings/Shares', 'Financial', 75, FALSE, FALSE),
          ('GUARANTOR', 'Personal Guarantee', 'Person', 50, FALSE, TRUE)
        ) AS seed(code, name, category, base_score, requires_valuation, requires_legal)
        RETURNING id
      ),
      local_audit AS (
        INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT o.id, ${actor.id}, 'mfi.organization_created', 'mfi_organizations',
          o.id, ${metadata}::jsonb
        FROM new_organization o
        RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${actor.id}, 'mfi', 'mfi.organization_created', 'mfi_organizations',
          o.id, ${metadata}::jsonb, ${ip}
        FROM new_organization o
        RETURNING id
      )
      SELECT o.id, o.name, o.sector, o.registration_number, o.tin, o.license_number,
        o.address, o.phone, o.email, o.website, o.logo_base64, o.brand_color,
        o.city, o.district, o.country, o.created_by, o.created_at,
        u.id AS admin_id, u.name AS admin_name, u.email AS admin_email
      FROM new_organization o
      JOIN new_user u ON u.id = o.created_by
    `;
    return c.json({ organization: rows[0] }, 201);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "EMAIL_IN_USE", "A user or MFI organization already uses this email or administrator.");
    }
    throw error;
  }
});

mfi.patch(
  "/mfi/organizations/:id",
  requireRole("superadmin", "mfi_admin"),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const body = await readJson(c);
    const name = optionalString(body, "name", { max: 200 });
    const registrationNumber = nullableText(body, "registration_number", 120);
    const tin = nullableText(body, "tin", 100);
    const licenseNumber = nullableText(body, "license_number", 120);
    const address = nullableText(body, "address", 500);
    const phone = nullableText(body, "phone", 40);
    const email = optionalEmail(body, "email");
    const website = nullableText(body, "website", 300);
    const logo = optionalPhoto(body, "logo_base64");
    const brandColor = optionalBrandColor(body, "brand_color");
    const city = nullableText(body, "city", 120);
    const district = nullableText(body, "district", 120);
    const country = nullableText(body, "country", 80);
    if (
      ![
        name, registrationNumber, tin, licenseNumber, address, phone, email,
        website, logo, brandColor, city, district, country,
      ].some((value) => value !== undefined)
    ) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one organization field to update.");
    }
    const user = c.get("user");
    const isSuperAdmin = user.role === "superadmin";
    const metadata = JSON.stringify({ updated_fields: Object.keys(body) });
    const ip = requestIp(c);
    const sql = getDb(c.env);
    const rows = await sql`
      WITH updated AS (
        UPDATE mfi_organizations
        SET name = CASE WHEN ${name !== undefined} THEN ${name ?? null} ELSE name END,
          registration_number = CASE WHEN ${registrationNumber !== undefined} THEN ${registrationNumber ?? null} ELSE registration_number END,
          tin = CASE WHEN ${tin !== undefined} THEN ${tin ?? null} ELSE tin END,
          license_number = CASE WHEN ${licenseNumber !== undefined} THEN ${licenseNumber ?? null} ELSE license_number END,
          address = CASE WHEN ${address !== undefined} THEN ${address ?? null} ELSE address END,
          phone = CASE WHEN ${phone !== undefined} THEN ${phone ?? null} ELSE phone END,
          email = CASE WHEN ${email !== undefined} THEN ${email ?? null} ELSE email END,
          website = CASE WHEN ${website !== undefined} THEN ${website ?? null} ELSE website END,
          logo_base64 = CASE WHEN ${logo !== undefined} THEN ${logo ?? null} ELSE logo_base64 END,
          brand_color = CASE WHEN ${brandColor !== undefined} THEN ${brandColor ?? null} ELSE brand_color END,
          city = CASE WHEN ${city !== undefined} THEN ${city ?? null} ELSE city END,
          district = CASE WHEN ${district !== undefined} THEN ${district ?? null} ELSE district END,
          country = CASE WHEN ${country !== undefined} THEN ${country ?? null} ELSE country END
        WHERE id = ${id}
          AND (${isSuperAdmin} OR created_by = ${user.id})
        RETURNING *
      ),
      local_audit AS (
        INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT id, ${user.id}, 'mfi.organization_updated', 'mfi_organizations', id, ${metadata}::jsonb
        FROM updated
        RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'mfi', 'mfi.organization_updated', 'mfi_organizations',
          id, ${metadata}::jsonb, ${ip}
        FROM updated
        RETURNING id
      )
      SELECT * FROM updated
    `;
    if (!rows[0]) throw new ApiError(404, "MFI_ORGANIZATION_NOT_FOUND", "MFI organization was not found.");
    return c.json({ organization: rows[0] });
  },
);

// Organization-wide statistics and activity.
mfi.get("/mfi/stats", requireRole("superadmin", "mfi_admin"), async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const organizationId = user.role === "superadmin"
    ? null
    : await organizationForUser(sql, user);
  const rows = await sql`
    SELECT
      COUNT(DISTINCT o.id)::int AS organizations,
      COUNT(DISTINCT b.id)::int AS branches,
      COUNT(DISTINCT off.id) FILTER (WHERE off.active IS TRUE)::int AS officers,
      COUNT(DISTINCT customer.id)::int AS customers,
      COUNT(DISTINCT customer.id) FILTER (WHERE customer.status = 'active')::int AS active_customers,
      COUNT(DISTINCT collateral.id)::int AS collateral
    FROM mfi_organizations o
    LEFT JOIN mfi_branches b ON b.organization_id = o.id
    LEFT JOIN mfi_officers off ON off.organization_id = o.id
    LEFT JOIN mfi_customers customer ON customer.organization_id = o.id
    LEFT JOIN mfi_collateral collateral ON collateral.organization_id = o.id
    WHERE ${organizationId === null} OR o.id = ${organizationId}
  `;
  return c.json({ stats: rows[0] ?? {
    organizations: 0,
    branches: 0,
    officers: 0,
    customers: 0,
    active_customers: 0,
    collateral: 0,
  } });
});

mfi.get("/mfi/audit-log", requireRole("mfi_admin"), async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, user);
  const limit = parseLimit(c.req.query("limit"), 25);
  const rows = await sql`
    SELECT a.id, a.action, a.target_table, a.target_id, a.metadata, a.created_at,
      actor.name AS actor_name, actor.email AS actor_email
    FROM mfi_audit a
    LEFT JOIN users actor ON actor.id = a.actor_id
    WHERE a.organization_id = ${organizationId}
    ORDER BY a.created_at DESC
    LIMIT ${limit}
  `;
  return c.json({ audit: rows });
});

// Branches
mfi.get("/mfi/branches", requireRole("mfi_admin"), async (c) => {
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, c.get("user"));
  const rows = await sql`
    SELECT b.id, b.organization_id, b.name, b.code, b.address, b.city, b.district,
      b.phone, b.manager_id, b.active, b.created_at,
      manager.name AS manager_name
    FROM mfi_branches b
    LEFT JOIN users manager ON manager.id = b.manager_id
    WHERE b.organization_id = ${organizationId}
    ORDER BY b.active DESC, b.name ASC
  `;
  return c.json({ branches: rows });
});

mfi.post("/mfi/branches", requireRole("mfi_admin"), async (c) => {
  const body = await readJson(c);
  const name = requiredString(body, "name", { max: 160 });
  const code = nullableText(body, "code", 80) ?? null;
  const address = nullableText(body, "address", 500) ?? null;
  const city = nullableText(body, "city", 120) ?? null;
  const district = nullableText(body, "district", 120) ?? null;
  const phone = nullableText(body, "phone", 40) ?? null;
  const managerId = optionalUuid(body, "manager_id") ?? null;
  const user = c.get("user");
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, user);
  if (managerId) {
    const managers = await sql`
      SELECT o.id FROM mfi_officers o
      WHERE o.user_id = ${managerId}
        AND o.organization_id = ${organizationId}
        AND o.role IN ('loan_manager', 'loan_director')
        AND o.active IS TRUE
      LIMIT 1
    `;
    if (!managers[0]) throw new ApiError(400, "MANAGER_NOT_FOUND", "The branch manager must be an active MFI manager in your organization.");
  }
  const metadata = JSON.stringify({ branch_name: name });
  const ip = requestIp(c);
  try {
    const rows = await sql`
      WITH created AS (
        INSERT INTO mfi_branches (
          organization_id, name, code, address, city, district, phone, manager_id
        )
        VALUES (
          ${organizationId}, ${name}, ${code}, ${address}, ${city}, ${district}, ${phone}, ${managerId}
        )
        RETURNING *
      ),
      local_audit AS (
        INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${user.id}, 'mfi.branch_created', 'mfi_branches', id, ${metadata}::jsonb
        FROM created RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'mfi', 'mfi.branch_created', 'mfi_branches', id, ${metadata}::jsonb, ${ip}
        FROM created RETURNING id
      )
      SELECT * FROM created
    `;
    return c.json({ branch: rows[0] }, 201);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "BRANCH_CODE_IN_USE", "A branch with this code already exists in your organization.");
    }
    throw error;
  }
});

mfi.patch("/mfi/branches/:id", requireRole("mfi_admin"), async (c) => {
  const id = pathUuid(c.req.param("id"));
  const body = await readJson(c);
  const name = optionalString(body, "name", { max: 160 });
  const code = nullableText(body, "code", 80);
  const address = nullableText(body, "address", 500);
  const city = nullableText(body, "city", 120);
  const district = nullableText(body, "district", 120);
  const phone = nullableText(body, "phone", 40);
  const managerId = optionalUuid(body, "manager_id");
  const active = body.active;
  if (active !== undefined && typeof active !== "boolean") {
    throw new ApiError(400, "VALIDATION_ERROR", "active must be true or false.");
  }
  if (![name, code, address, city, district, phone, managerId, active].some((v) => v !== undefined)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one branch field to update.");
  }
  const user = c.get("user");
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, user);
  if (managerId) {
    const managers = await sql`
      SELECT id FROM mfi_officers
      WHERE user_id = ${managerId}
        AND organization_id = ${organizationId}
        AND role IN ('loan_manager', 'loan_director')
        AND active IS TRUE
      LIMIT 1
    `;
    if (!managers[0]) throw new ApiError(400, "MANAGER_NOT_FOUND", "The branch manager must be an active MFI manager in your organization.");
  }
  const metadata = JSON.stringify({ updated_fields: Object.keys(body) });
  const ip = requestIp(c);
  try {
    const rows = await sql`
      WITH updated AS (
        UPDATE mfi_branches
        SET name = CASE WHEN ${name !== undefined} THEN ${name ?? null} ELSE name END,
          code = CASE WHEN ${code !== undefined} THEN ${code ?? null} ELSE code END,
          address = CASE WHEN ${address !== undefined} THEN ${address ?? null} ELSE address END,
          city = CASE WHEN ${city !== undefined} THEN ${city ?? null} ELSE city END,
          district = CASE WHEN ${district !== undefined} THEN ${district ?? null} ELSE district END,
          phone = CASE WHEN ${phone !== undefined} THEN ${phone ?? null} ELSE phone END,
          manager_id = CASE WHEN ${managerId !== undefined} THEN ${managerId ?? null} ELSE manager_id END,
          active = CASE WHEN ${active !== undefined} THEN ${active ?? null} ELSE active END
        WHERE id = ${id} AND organization_id = ${organizationId}
        RETURNING *
      ),
      local_audit AS (
        INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${user.id}, 'mfi.branch_updated', 'mfi_branches', id, ${metadata}::jsonb
        FROM updated RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'mfi', 'mfi.branch_updated', 'mfi_branches', id, ${metadata}::jsonb, ${ip}
        FROM updated RETURNING id
      )
      SELECT * FROM updated
    `;
    if (!rows[0]) throw new ApiError(404, "MFI_BRANCH_NOT_FOUND", "Branch was not found.");
    return c.json({ branch: rows[0] });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "BRANCH_CODE_IN_USE", "A branch with this code already exists in your organization.");
    }
    throw error;
  }
});

mfi.delete("/mfi/branches/:id", requireRole("mfi_admin"), async (c) => {
  const id = pathUuid(c.req.param("id"));
  const user = c.get("user");
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, user);
  const metadata = JSON.stringify({ effect: "customer_and_officer_branch_links_set_null" });
  const ip = requestIp(c);
  const rows = await sql`
    WITH deleted AS (
      DELETE FROM mfi_branches
      WHERE id = ${id} AND organization_id = ${organizationId}
      RETURNING id, organization_id
    ),
    local_audit AS (
      INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
      SELECT organization_id, ${user.id}, 'mfi.branch_deleted', 'mfi_branches', id, ${metadata}::jsonb
      FROM deleted RETURNING id
    ),
    platform_audit AS (
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT ${user.id}, 'mfi', 'mfi.branch_deleted', 'mfi_branches', id, ${metadata}::jsonb, ${ip}
      FROM deleted RETURNING id
    )
    SELECT id FROM deleted
  `;
  if (!rows[0]) throw new ApiError(404, "MFI_BRANCH_NOT_FOUND", "Branch was not found.");
  return c.json({ deleted: true, id });
});

// Officers and their linked user accounts.
mfi.get("/mfi/officers", requireRole("mfi_admin"), async (c) => {
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, c.get("user"));
  const rows = await sql`
    SELECT o.id, o.organization_id, o.branch_id, o.user_id, o.role, o.employee_code,
      o.hired_on, o.active, o.created_at, u.name, u.email, u.phone,
      b.name AS branch_name
    FROM mfi_officers o
    JOIN users u ON u.id = o.user_id
    LEFT JOIN mfi_branches b ON b.id = o.branch_id
    WHERE o.organization_id = ${organizationId}
    ORDER BY o.active DESC, u.name ASC
  `;
  return c.json({ officers: rows });
});

mfi.post("/mfi/officers", requireRole("mfi_admin"), async (c) => {
  const body = await readJson(c);
  const firstName = requiredString(body, "first_name", { max: 80 });
  const lastName = requiredString(body, "last_name", { max: 80 });
  const email = requiredString(body, "email", { max: 254 }).toLowerCase();
  const password = requiredString(body, "password", { min: 8, max: 128 });
  const phone = nullableText(body, "phone", 40) ?? null;
  const role = requiredString(body, "role", { max: 30 });
  if (!isMfiOfficerRole(role)) {
    throw new ApiError(400, "VALIDATION_ERROR", "role must be loan_officer, loan_manager, or loan_director.");
  }
  if (!validEmail(email)) {
    throw new ApiError(400, "VALIDATION_ERROR", "email must be a valid email address.");
  }
  const branchId = optionalUuid(body, "branch_id") ?? null;
  const employeeCode = nullableText(body, "employee_code", 80) ?? null;
  const hiredOn = optionalDate(body, "hired_on") ?? null;
  const passwordHash = await hashPassword(password);
  const user = c.get("user");
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, user);
  await assertBranchInOrganization(sql, branchId, organizationId);
  const fullName = `${firstName} ${lastName}`.trim();
  const metadata = JSON.stringify({ role, branch_id: branchId });
  const ip = requestIp(c);
  try {
    const rows = await sql`
      WITH new_user AS (
        INSERT INTO users (name, email, phone, password_hash, role, sector, waitlist)
        VALUES (${fullName}, ${email}, ${phone}, ${passwordHash}, ${role}, 'mfi', FALSE)
        RETURNING id, name, email, phone, role
      ),
      created AS (
        INSERT INTO mfi_officers (
          organization_id, branch_id, user_id, role, employee_code, hired_on
        )
        SELECT ${organizationId}, ${branchId}, id, ${role}, ${employeeCode}, ${hiredOn}
        FROM new_user
        RETURNING *
      ),
      local_audit AS (
        INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${user.id}, 'mfi.officer_created', 'mfi_officers', id, ${metadata}::jsonb
        FROM created RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'mfi', 'mfi.officer_created', 'mfi_officers', id, ${metadata}::jsonb, ${ip}
        FROM created RETURNING id
      )
      SELECT o.id, o.organization_id, o.branch_id, o.user_id, o.role,
        o.employee_code, o.hired_on, o.active, o.created_at,
        u.name, u.email, u.phone
      FROM created o JOIN new_user u ON u.id = o.user_id
    `;
    return c.json({ officer: rows[0] }, 201);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "EMAIL_IN_USE", "A user with this email or employee code already exists.");
    }
    throw error;
  }
});

mfi.patch("/mfi/officers/:id", requireRole("mfi_admin"), async (c) => {
  const id = pathUuid(c.req.param("id"));
  const body = await readJson(c);
  const firstName = nullableText(body, "first_name", 80);
  const lastName = nullableText(body, "last_name", 80);
  const email = optionalEmail(body, "email");
  const phone = nullableText(body, "phone", 40);
  const role = optionalString(body, "role", { max: 30 });
  if (role !== undefined && role !== null && !isMfiOfficerRole(role)) {
    throw new ApiError(400, "VALIDATION_ERROR", "role must be loan_officer, loan_manager, or loan_director.");
  }
  const branchId = optionalUuid(body, "branch_id");
  const employeeCode = nullableText(body, "employee_code", 80);
  const hiredOn = optionalDate(body, "hired_on");
  const active = body.active;
  if (active !== undefined && typeof active !== "boolean") {
    throw new ApiError(400, "VALIDATION_ERROR", "active must be true or false.");
  }
  if (
    ![firstName, lastName, email, phone, role, branchId, employeeCode, hiredOn, active]
      .some((value) => value !== undefined)
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one officer field to update.");
  }
  const user = c.get("user");
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, user);
  await assertBranchInOrganization(sql, branchId, organizationId);
  const fullName = firstName === undefined && lastName === undefined
    ? undefined
    : `${firstName ?? ""} ${lastName ?? ""}`.trim();
  const metadata = JSON.stringify({ updated_fields: Object.keys(body) });
  const ip = requestIp(c);
  try {
    const rows = await sql`
      WITH updated AS (
        UPDATE mfi_officers
        SET branch_id = CASE WHEN ${branchId !== undefined} THEN ${branchId ?? null} ELSE branch_id END,
          role = CASE WHEN ${role !== undefined} THEN ${role ?? null} ELSE role END,
          employee_code = CASE WHEN ${employeeCode !== undefined} THEN ${employeeCode ?? null} ELSE employee_code END,
          hired_on = CASE WHEN ${hiredOn !== undefined} THEN ${hiredOn ?? null}::date ELSE hired_on END,
          active = CASE WHEN ${active !== undefined} THEN ${active ?? null} ELSE active END
        WHERE id = ${id} AND organization_id = ${organizationId}
        RETURNING *
      ),
      updated_user AS (
        UPDATE users u
        SET name = CASE WHEN ${fullName !== undefined} THEN ${fullName ?? null} ELSE u.name END,
          email = CASE WHEN ${email !== undefined} THEN ${email ?? null} ELSE u.email END,
          phone = CASE WHEN ${phone !== undefined} THEN ${phone ?? null} ELSE u.phone END,
          role = CASE WHEN ${role !== undefined} THEN ${role ?? null} ELSE u.role END,
          session_version = CASE WHEN ${role !== undefined} OR ${active === false}
            THEN COALESCE(u.session_version, 0) + 1 ELSE COALESCE(u.session_version, 0) END
        FROM updated o
        WHERE u.id = o.user_id
        RETURNING u.id
      ),
      local_audit AS (
        INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${user.id}, 'mfi.officer_updated', 'mfi_officers', id, ${metadata}::jsonb
        FROM updated RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'mfi', 'mfi.officer_updated', 'mfi_officers', id, ${metadata}::jsonb, ${ip}
        FROM updated RETURNING id
      )
      SELECT o.id, o.organization_id, o.branch_id, o.user_id, o.role,
        o.employee_code, o.hired_on, o.active, o.created_at,
        u.name, u.email, u.phone
      FROM updated o JOIN users u ON u.id = o.user_id
    `;
    if (!rows[0]) throw new ApiError(404, "MFI_OFFICER_NOT_FOUND", "Officer was not found.");
    return c.json({ officer: rows[0] });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "EMAIL_IN_USE", "A user with this email already exists.");
    }
    throw error;
  }
});

mfi.delete("/mfi/officers/:id", requireRole("mfi_admin"), async (c) => {
  const id = pathUuid(c.req.param("id"));
  const user = c.get("user");
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, user);
  const metadata = JSON.stringify({ status: "inactive", sessions_revoked: true });
  const ip = requestIp(c);
  const rows = await sql`
    WITH deactivated AS (
      UPDATE mfi_officers
      SET active = FALSE
      WHERE id = ${id}
        AND organization_id = ${organizationId}
        AND active IS TRUE
      RETURNING *
    ),
    revoked_user AS (
      UPDATE users u
      SET session_version = COALESCE(u.session_version, 0) + 1
      FROM deactivated o
      WHERE u.id = o.user_id
      RETURNING u.id
    ),
    local_audit AS (
      INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
      SELECT organization_id, ${user.id}, 'mfi.officer_deactivated', 'mfi_officers', id, ${metadata}::jsonb
      FROM deactivated RETURNING id
    ),
    platform_audit AS (
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT ${user.id}, 'mfi', 'mfi.officer_deactivated', 'mfi_officers', id, ${metadata}::jsonb, ${ip}
      FROM deactivated RETURNING id
    )
    SELECT id FROM deactivated
  `;
  if (!rows[0]) throw new ApiError(404, "MFI_OFFICER_NOT_FOUND", "Active officer was not found.");
  return c.json({ deactivated: true, id });
});

// Customers
mfi.get(
  "/mfi/customers",
  requireRole("mfi_admin", ...MFI_OFFICER_ROLES),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user);
    const branchIdValue = c.req.query("branch_id");
    const branchId = branchIdValue ? pathUuid(branchIdValue, "branch_id") : null;
    const searchText = c.req.query("search")?.trim() ?? "";
    if (searchText.length > 120) {
      throw new ApiError(400, "VALIDATION_ERROR", "search must be no longer than 120 characters.");
    }
    const pattern = searchText ? likePattern(searchText) : null;
    const rows = await sql`
      SELECT c.id, c.organization_id, c.branch_id, c.first_name, c.last_name,
        c.gender, c.date_of_birth, c.national_id, c.tin, c.phone, c.email,
        c.address, c.village, c.district, c.occupation, c.monthly_income,
        c.spouse_name, c.spouse_phone, c.nok_name, c.nok_relationship,
        c.nok_phone, c.status, c.created_by, c.created_at, c.updated_at,
        b.name AS branch_name
      FROM mfi_customers c
      LEFT JOIN mfi_branches b ON b.id = c.branch_id
      WHERE c.organization_id = ${organizationId}
        AND (${branchId === null} OR c.branch_id = ${branchId})
        AND (${pattern === null} OR
          concat_ws(' ', c.first_name, c.last_name, c.phone, c.national_id) ILIKE ${pattern} ESCAPE '\\')
      ORDER BY c.created_at DESC
      LIMIT 200
    `;
    return c.json({ customers: rows });
  },
);

function parseCustomerFields(body: Record<string, unknown>) {
  const firstName = optionalString(body, "first_name", { max: 80 });
  const lastName = optionalString(body, "last_name", { max: 80 });
  const gender = nullableText(body, "gender", 30);
  if (
    gender !== undefined &&
    gender !== null &&
    !["female", "male", "other", "prefer_not_to_say"].includes(gender.toLowerCase())
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", "gender must be female, male, other, or prefer_not_to_say.");
  }
  const dateOfBirth = optionalDate(body, "date_of_birth");
  const nationalId = nullableText(body, "national_id", 100);
  const tin = nullableText(body, "tin", 100);
  const phone = nullableText(body, "phone", 40);
  const email = optionalEmail(body, "email");
  const address = nullableText(body, "address", 500);
  const village = nullableText(body, "village", 120);
  const district = nullableText(body, "district", 120);
  const occupation = nullableText(body, "occupation", 120);
  const monthlyIncome = optionalNumber(body, "monthly_income", { min: 0, max: 1_000_000_000_000 });
  const photo = optionalPhoto(body, "photo_base64");
  const spouseName = nullableText(body, "spouse_name", 160);
  const spousePhone = nullableText(body, "spouse_phone", 40);
  const nokName = nullableText(body, "nok_name", 160);
  const nokRelationship = nullableText(body, "nok_relationship", 100);
  const nokPhone = nullableText(body, "nok_phone", 40);
  const status = nullableText(body, "status", 20);
  if (status !== undefined && status !== null && !["active", "inactive"].includes(status)) {
    throw new ApiError(400, "VALIDATION_ERROR", "status must be active or inactive.");
  }
  return {
    firstName,
    lastName,
    gender: gender?.toLowerCase(),
    dateOfBirth,
    nationalId,
    tin,
    phone,
    email,
    address,
    village,
    district,
    occupation,
    monthlyIncome,
    photo,
    spouseName,
    spousePhone,
    nokName,
    nokRelationship,
    nokPhone,
    status,
  };
}

mfi.post(
  "/mfi/customers",
  requireRole("mfi_admin", ...MFI_OFFICER_ROLES),
  async (c) => {
    const body = await readJson(c);
    const fields = parseCustomerFields(body);
    const firstName = fields.firstName ?? requiredString(body, "first_name", { max: 80 });
    const lastName = fields.lastName ?? requiredString(body, "last_name", { max: 80 });
    const branchId = optionalUuid(body, "branch_id") ?? null;
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user);
    await assertBranchInOrganization(sql, branchId, organizationId);
    const metadata = JSON.stringify({ branch_id: branchId });
    const ip = requestIp(c);
    const rows = await sql`
      WITH created AS (
        INSERT INTO mfi_customers (
          organization_id, branch_id, first_name, last_name, gender, date_of_birth,
          national_id, tin, phone, email, address, village, district, occupation,
          monthly_income, photo_base64, spouse_name, spouse_phone, nok_name,
          nok_relationship, nok_phone, status, created_by
        )
        VALUES (
          ${organizationId}, ${branchId}, ${firstName}, ${lastName},
          ${fields.gender ?? null}, ${fields.dateOfBirth ?? null}::date,
          ${fields.nationalId ?? null}, ${fields.tin ?? null}, ${fields.phone ?? null},
          ${fields.email ?? null}, ${fields.address ?? null}, ${fields.village ?? null},
          ${fields.district ?? null}, ${fields.occupation ?? null}, ${fields.monthlyIncome ?? null},
          ${fields.photo ?? null}, ${fields.spouseName ?? null}, ${fields.spousePhone ?? null},
          ${fields.nokName ?? null}, ${fields.nokRelationship ?? null}, ${fields.nokPhone ?? null},
          ${fields.status ?? "active"}, ${user.id}
        )
        RETURNING *
      ),
      local_audit AS (
        INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${user.id}, 'mfi.customer_created', 'mfi_customers', id, ${metadata}::jsonb
        FROM created RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'mfi', 'mfi.customer_created', 'mfi_customers', id, ${metadata}::jsonb, ${ip}
        FROM created RETURNING id
      )
      SELECT id, organization_id, branch_id, first_name, last_name, gender,
        date_of_birth, national_id, tin, phone, email, address, village, district,
        occupation, monthly_income, spouse_name, spouse_phone, nok_name,
        nok_relationship, nok_phone, status, created_by, created_at, updated_at
      FROM created
    `;
    return c.json({ customer: rows[0] }, 201);
  },
);

mfi.get(
  "/mfi/customers/:id/guarantors",
  requireRole("mfi_admin", ...MFI_OFFICER_ROLES),
  async (c) => {
    const customerId = pathUuid(c.req.param("id"));
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user);
    const rows = await sql`
      SELECT g.id, g.customer_id, g.full_name, g.relationship, g.phone, g.national_id,
        g.address, g.occupation, g.monthly_income, g.photo_base64, g.signature_base64, g.created_at
      FROM mfi_guarantors g
      JOIN mfi_customers customer ON customer.id = g.customer_id
      WHERE g.customer_id = ${customerId}
        AND customer.organization_id = ${organizationId}
      ORDER BY g.created_at ASC
    `;
    const customerRows = await sql`
      SELECT id FROM mfi_customers
      WHERE id = ${customerId} AND organization_id = ${organizationId}
      LIMIT 1
    `;
    if (!customerRows[0]) throw new ApiError(404, "MFI_CUSTOMER_NOT_FOUND", "Customer was not found.");
    return c.json({ guarantors: rows });
  },
);

mfi.post(
  "/mfi/customers/:id/guarantors",
  requireRole("mfi_admin", ...MFI_OFFICER_ROLES),
  async (c) => {
    const customerId = pathUuid(c.req.param("id"));
    const body = await readJson(c);
    const fullName = requiredString(body, "full_name", { max: 160 });
    const relationship = nullableText(body, "relationship", 100) ?? null;
    const phone = nullableText(body, "phone", 40) ?? null;
    const nationalId = nullableText(body, "national_id", 100) ?? null;
    const address = nullableText(body, "address", 500) ?? null;
    const occupation = nullableText(body, "occupation", 120) ?? null;
    const monthlyIncome = optionalNumber(body, "monthly_income", { min: 0, max: 1_000_000_000_000 }) ?? null;
    const photo = optionalPhoto(body, "photo_base64") ?? null;
    const signature = optionalPhoto(body, "signature_base64") ?? null;
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user);
    const metadata = JSON.stringify({ customer_id: customerId });
    const ip = requestIp(c);
    const rows = await sql`
      WITH target AS (
        SELECT id FROM mfi_customers
        WHERE id = ${customerId} AND organization_id = ${organizationId}
      ),
      created AS (
        INSERT INTO mfi_guarantors (
          customer_id, full_name, relationship, phone, national_id, address,
          occupation, monthly_income, photo_base64, signature_base64
        )
        SELECT id, ${fullName}, ${relationship}, ${phone}, ${nationalId}, ${address},
          ${occupation}, ${monthlyIncome}, ${photo}, ${signature}
        FROM target
        RETURNING *
      ),
      local_audit AS (
        INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT ${organizationId}, ${user.id}, 'mfi.guarantor_created', 'mfi_guarantors', id, ${metadata}::jsonb
        FROM created RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'mfi', 'mfi.guarantor_created', 'mfi_guarantors', id, ${metadata}::jsonb, ${ip}
        FROM created RETURNING id
      )
      SELECT * FROM created
    `;
    if (!rows[0]) throw new ApiError(404, "MFI_CUSTOMER_NOT_FOUND", "Customer was not found.");
    return c.json({ guarantor: rows[0] }, 201);
  },
);

mfi.get(
  "/mfi/customers/:id",
  requireRole("mfi_admin", ...MFI_OFFICER_ROLES),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user);
    const rows = await sql`
      SELECT c.id, c.organization_id, c.branch_id, c.first_name, c.last_name,
        c.gender, c.date_of_birth, c.national_id, c.tin, c.phone, c.email,
        c.address, c.village, c.district, c.occupation, c.monthly_income,
        c.photo_base64, c.spouse_name, c.spouse_phone, c.nok_name,
        c.nok_relationship, c.nok_phone, c.status, c.created_by, c.created_at,
        c.updated_at, b.name AS branch_name
      FROM mfi_customers c
      LEFT JOIN mfi_branches b ON b.id = c.branch_id
      WHERE c.id = ${id} AND c.organization_id = ${organizationId}
      LIMIT 1
    `;
    if (!rows[0]) throw new ApiError(404, "MFI_CUSTOMER_NOT_FOUND", "Customer was not found.");
    return c.json({ customer: rows[0] });
  },
);

mfi.patch(
  "/mfi/customers/:id",
  requireRole("mfi_admin", ...MFI_OFFICER_ROLES),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const body = await readJson(c);
    const fields = parseCustomerFields(body);
    const branchId = optionalUuid(body, "branch_id");
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user);
    await assertBranchInOrganization(sql, branchId, organizationId);
    if (
      ![
        fields.firstName, fields.lastName, fields.gender, fields.dateOfBirth,
        fields.nationalId, fields.tin, fields.phone, fields.email, fields.address,
        fields.village, fields.district, fields.occupation, fields.monthlyIncome,
        fields.photo, fields.spouseName, fields.spousePhone, fields.nokName,
        fields.nokRelationship, fields.nokPhone, fields.status, branchId,
      ].some((value) => value !== undefined)
    ) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one customer field to update.");
    }
    const metadata = JSON.stringify({ updated_fields: Object.keys(body) });
    const ip = requestIp(c);
    const rows = await sql`
      WITH updated AS (
        UPDATE mfi_customers
        SET branch_id = CASE WHEN ${branchId !== undefined} THEN ${branchId ?? null} ELSE branch_id END,
          first_name = CASE WHEN ${fields.firstName !== undefined} THEN ${fields.firstName ?? null} ELSE first_name END,
          last_name = CASE WHEN ${fields.lastName !== undefined} THEN ${fields.lastName ?? null} ELSE last_name END,
          gender = CASE WHEN ${fields.gender !== undefined} THEN ${fields.gender ?? null} ELSE gender END,
          date_of_birth = CASE WHEN ${fields.dateOfBirth !== undefined} THEN ${fields.dateOfBirth ?? null}::date ELSE date_of_birth END,
          national_id = CASE WHEN ${fields.nationalId !== undefined} THEN ${fields.nationalId ?? null} ELSE national_id END,
          tin = CASE WHEN ${fields.tin !== undefined} THEN ${fields.tin ?? null} ELSE tin END,
          phone = CASE WHEN ${fields.phone !== undefined} THEN ${fields.phone ?? null} ELSE phone END,
          email = CASE WHEN ${fields.email !== undefined} THEN ${fields.email ?? null} ELSE email END,
          address = CASE WHEN ${fields.address !== undefined} THEN ${fields.address ?? null} ELSE address END,
          village = CASE WHEN ${fields.village !== undefined} THEN ${fields.village ?? null} ELSE village END,
          district = CASE WHEN ${fields.district !== undefined} THEN ${fields.district ?? null} ELSE district END,
          occupation = CASE WHEN ${fields.occupation !== undefined} THEN ${fields.occupation ?? null} ELSE occupation END,
          monthly_income = CASE WHEN ${fields.monthlyIncome !== undefined} THEN ${fields.monthlyIncome ?? null} ELSE monthly_income END,
          photo_base64 = CASE WHEN ${fields.photo !== undefined} THEN ${fields.photo ?? null} ELSE photo_base64 END,
          spouse_name = CASE WHEN ${fields.spouseName !== undefined} THEN ${fields.spouseName ?? null} ELSE spouse_name END,
          spouse_phone = CASE WHEN ${fields.spousePhone !== undefined} THEN ${fields.spousePhone ?? null} ELSE spouse_phone END,
          nok_name = CASE WHEN ${fields.nokName !== undefined} THEN ${fields.nokName ?? null} ELSE nok_name END,
          nok_relationship = CASE WHEN ${fields.nokRelationship !== undefined} THEN ${fields.nokRelationship ?? null} ELSE nok_relationship END,
          nok_phone = CASE WHEN ${fields.nokPhone !== undefined} THEN ${fields.nokPhone ?? null} ELSE nok_phone END,
          status = CASE WHEN ${fields.status !== undefined} THEN ${fields.status ?? null} ELSE status END,
          updated_at = NOW()
        WHERE id = ${id} AND organization_id = ${organizationId}
        RETURNING *
      ),
      local_audit AS (
        INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${user.id}, 'mfi.customer_updated', 'mfi_customers', id, ${metadata}::jsonb
        FROM updated RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'mfi', 'mfi.customer_updated', 'mfi_customers', id, ${metadata}::jsonb, ${ip}
        FROM updated RETURNING id
      )
      SELECT id, organization_id, branch_id, first_name, last_name, gender,
        date_of_birth, national_id, tin, phone, email, address, village, district,
        occupation, monthly_income, spouse_name, spouse_phone, nok_name,
        nok_relationship, nok_phone, status, created_by, created_at, updated_at
      FROM updated
    `;
    if (!rows[0]) throw new ApiError(404, "MFI_CUSTOMER_NOT_FOUND", "Customer was not found.");
    return c.json({ customer: rows[0] });
  },
);

mfi.delete("/mfi/customers/:id", requireRole("mfi_admin"), async (c) => {
  const id = pathUuid(c.req.param("id"));
  const user = c.get("user");
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, user);
  const metadata = JSON.stringify({ related_guarantors_cascaded: true });
  const ip = requestIp(c);
  const rows = await sql`
    WITH deleted AS (
      DELETE FROM mfi_customers
      WHERE id = ${id} AND organization_id = ${organizationId}
      RETURNING id, organization_id
    ),
    local_audit AS (
      INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
      SELECT organization_id, ${user.id}, 'mfi.customer_deleted', 'mfi_customers', id, ${metadata}::jsonb
      FROM deleted RETURNING id
    ),
    platform_audit AS (
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT ${user.id}, 'mfi', 'mfi.customer_deleted', 'mfi_customers', id, ${metadata}::jsonb, ${ip}
      FROM deleted RETURNING id
    )
    SELECT id FROM deleted
  `;
  if (!rows[0]) throw new ApiError(404, "MFI_CUSTOMER_NOT_FOUND", "Customer was not found.");
  return c.json({ deleted: true, id });
});

// Guarantors
mfi.patch(
  "/mfi/guarantors/:id",
  requireRole("mfi_admin", ...MFI_OFFICER_ROLES),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const body = await readJson(c);
    const fullName = optionalString(body, "full_name", { max: 160 });
    const relationship = nullableText(body, "relationship", 100);
    const phone = nullableText(body, "phone", 40);
    const nationalId = nullableText(body, "national_id", 100);
    const address = nullableText(body, "address", 500);
    const occupation = nullableText(body, "occupation", 120);
    const monthlyIncome = optionalNumber(body, "monthly_income", { min: 0, max: 1_000_000_000_000 });
    const photo = optionalPhoto(body, "photo_base64");
    const signature = optionalPhoto(body, "signature_base64");
    if (
      ![fullName, relationship, phone, nationalId, address, occupation,
        monthlyIncome, photo, signature].some((value) => value !== undefined)
    ) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one guarantor field to update.");
    }
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user);
    const metadata = JSON.stringify({ updated_fields: Object.keys(body) });
    const ip = requestIp(c);
    const rows = await sql`
      WITH updated AS (
        UPDATE mfi_guarantors g
        SET full_name = CASE WHEN ${fullName !== undefined} THEN ${fullName ?? null} ELSE g.full_name END,
          relationship = CASE WHEN ${relationship !== undefined} THEN ${relationship ?? null} ELSE g.relationship END,
          phone = CASE WHEN ${phone !== undefined} THEN ${phone ?? null} ELSE g.phone END,
          national_id = CASE WHEN ${nationalId !== undefined} THEN ${nationalId ?? null} ELSE g.national_id END,
          address = CASE WHEN ${address !== undefined} THEN ${address ?? null} ELSE g.address END,
          occupation = CASE WHEN ${occupation !== undefined} THEN ${occupation ?? null} ELSE g.occupation END,
          monthly_income = CASE WHEN ${monthlyIncome !== undefined} THEN ${monthlyIncome ?? null} ELSE g.monthly_income END,
          photo_base64 = CASE WHEN ${photo !== undefined} THEN ${photo ?? null} ELSE g.photo_base64 END,
          signature_base64 = CASE WHEN ${signature !== undefined} THEN ${signature ?? null} ELSE g.signature_base64 END
        FROM mfi_customers customer
        WHERE g.id = ${id}
          AND customer.id = g.customer_id
          AND customer.organization_id = ${organizationId}
        RETURNING g.*
      ),
      local_audit AS (
        INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT ${organizationId}, ${user.id}, 'mfi.guarantor_updated', 'mfi_guarantors', id, ${metadata}::jsonb
        FROM updated RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'mfi', 'mfi.guarantor_updated', 'mfi_guarantors', id, ${metadata}::jsonb, ${ip}
        FROM updated RETURNING id
      )
      SELECT * FROM updated
    `;
    if (!rows[0]) throw new ApiError(404, "MFI_GUARANTOR_NOT_FOUND", "Guarantor was not found.");
    return c.json({ guarantor: rows[0] });
  },
);

mfi.delete("/mfi/guarantors/:id", requireRole("mfi_admin"), async (c) => {
  const id = pathUuid(c.req.param("id"));
  const user = c.get("user");
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, user);
  const metadata = JSON.stringify({});
  const ip = requestIp(c);
  const rows = await sql`
    WITH deleted AS (
      DELETE FROM mfi_guarantors g
      USING mfi_customers customer
      WHERE g.id = ${id}
        AND customer.id = g.customer_id
        AND customer.organization_id = ${organizationId}
      RETURNING g.id
    ),
    local_audit AS (
      INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
      SELECT ${organizationId}, ${user.id}, 'mfi.guarantor_deleted', 'mfi_guarantors', id, ${metadata}::jsonb
      FROM deleted RETURNING id
    ),
    platform_audit AS (
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT ${user.id}, 'mfi', 'mfi.guarantor_deleted', 'mfi_guarantors', id, ${metadata}::jsonb, ${ip}
      FROM deleted RETURNING id
    )
    SELECT id FROM deleted
  `;
  if (!rows[0]) throw new ApiError(404, "MFI_GUARANTOR_NOT_FOUND", "Guarantor was not found.");
  return c.json({ deleted: true, id });
});

// Organization settings
mfi.get("/mfi/settings", requireRole("mfi_admin"), async (c) => {
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, c.get("user"));
  const rows = await sql`
    SELECT s.id, s.organization_id, s.currency, s.default_interest_rate,
      s.default_term_months, s.default_repayment_frequency, s.late_fee_percent,
      s.grace_period_days, s.settings, s.updated_at,
      o.name AS organization_name, o.registration_number, o.tin, o.license_number,
      o.address, o.phone, o.email, o.website, o.logo_base64, o.brand_color,
      o.city, o.district, o.country
    FROM mfi_settings s
    JOIN mfi_organizations o ON o.id = s.organization_id
    WHERE s.organization_id = ${organizationId}
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(404, "MFI_SETTINGS_NOT_FOUND", "MFI settings were not found.");
  return c.json({ settings: rows[0] });
});

mfi.patch("/mfi/settings", requireRole("mfi_admin"), async (c) => {
  const body = await readJson(c);
  const currency = nullableText(body, "currency", 3);
  if (currency !== undefined && currency !== null && !/^[A-Z]{3}$/u.test(currency.toUpperCase())) {
    throw new ApiError(400, "VALIDATION_ERROR", "currency must be a three-letter code.");
  }
  const interestRate = optionalNumber(body, "default_interest_rate", { min: 0, max: 1000 });
  const termMonths = optionalNumber(body, "default_term_months", { min: 1, max: 600, integer: true });
  const frequency = nullableText(body, "default_repayment_frequency", 30);
  const lateFee = optionalNumber(body, "late_fee_percent", { min: 0, max: 1000 });
  const graceDays = optionalNumber(body, "grace_period_days", { min: 0, max: 3650, integer: true });
  let settings: string | undefined;
  if ("settings" in body) {
    if (body.settings === null) settings = "{}";
    else if (
      !body.settings ||
      typeof body.settings !== "object" ||
      Array.isArray(body.settings) ||
      JSON.stringify(body.settings).length > 10_000
    ) {
      throw new ApiError(400, "VALIDATION_ERROR", "settings must be a JSON object of at most 10 KB.");
    } else {
      settings = JSON.stringify(body.settings);
    }
  }
  if (![currency, interestRate, termMonths, frequency, lateFee, graceDays, settings]
    .some((value) => value !== undefined)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one MFI setting to update.");
  }
  const user = c.get("user");
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, user);
  const metadata = JSON.stringify({ updated_fields: Object.keys(body) });
  const ip = requestIp(c);
  const rows = await sql`
    WITH updated AS (
      INSERT INTO mfi_settings (
        organization_id, currency, default_interest_rate, default_term_months,
        default_repayment_frequency, late_fee_percent, grace_period_days, settings, updated_at
      )
      VALUES (
        ${organizationId},
        COALESCE(${currency === undefined ? null : currency?.toUpperCase() ?? null}, 'UGX'),
        COALESCE(${interestRate === undefined ? null : interestRate}, 24),
        COALESCE(${termMonths === undefined ? null : termMonths}, 12),
        COALESCE(${frequency === undefined ? null : frequency ?? null}, 'monthly'),
        COALESCE(${lateFee === undefined ? null : lateFee}, 2),
        COALESCE(${graceDays === undefined ? null : graceDays}, 7),
        COALESCE(${settings === undefined ? null : settings}::jsonb, '{}'::jsonb),
        NOW()
      )
      ON CONFLICT (organization_id) DO UPDATE
      SET currency = CASE WHEN ${currency !== undefined} THEN ${currency?.toUpperCase() ?? null} ELSE mfi_settings.currency END,
        default_interest_rate = CASE WHEN ${interestRate !== undefined} THEN ${interestRate ?? null} ELSE mfi_settings.default_interest_rate END,
        default_term_months = CASE WHEN ${termMonths !== undefined} THEN ${termMonths ?? null} ELSE mfi_settings.default_term_months END,
        default_repayment_frequency = CASE WHEN ${frequency !== undefined} THEN ${frequency ?? null} ELSE mfi_settings.default_repayment_frequency END,
        late_fee_percent = CASE WHEN ${lateFee !== undefined} THEN ${lateFee ?? null} ELSE mfi_settings.late_fee_percent END,
        grace_period_days = CASE WHEN ${graceDays !== undefined} THEN ${graceDays ?? null} ELSE mfi_settings.grace_period_days END,
        settings = CASE WHEN ${settings !== undefined} THEN ${settings ?? null}::jsonb ELSE mfi_settings.settings END,
        updated_at = NOW()
      RETURNING *
    ),
    local_audit AS (
      INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
      SELECT organization_id, ${user.id}, 'mfi.settings_updated', 'mfi_settings', id, ${metadata}::jsonb
      FROM updated RETURNING id
    ),
    platform_audit AS (
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT ${user.id}, 'mfi', 'mfi.settings_updated', 'mfi_settings', id, ${metadata}::jsonb, ${ip}
      FROM updated RETURNING id
    )
    SELECT * FROM updated
  `;
  return c.json({ settings: rows[0] });
});

export default mfi;