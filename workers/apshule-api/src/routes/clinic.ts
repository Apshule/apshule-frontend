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
import { sendEmail, welcomeEmailTemplate } from "../email.js";
import {
  CLINIC_STAFF_ROLES,
  isClinicDate,
  isClinicImageDataUrl,
  isClinicStaffRole,
} from "../clinic-domain.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";
import { createClinicWorkflowRoutes } from "./clinic-workflows.js";

const clinic = new Hono<AppEnv>();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DAY_NAMES = new Set([
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
]);
const ALL_CLINIC_ROLES = new Set(["clinic_admin", ...CLINIC_STAFF_ROLES]);

const requireClinicSector = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user.role !== "superadmin") {
    if (user.sector !== "clinic") {
      throw new ApiError(403, "CLINIC_SECTOR_REQUIRED", "This endpoint is for Clinic accounts.");
    }
    if (!ALL_CLINIC_ROLES.has(user.role)) {
      throw new ApiError(403, "CLINIC_ROLE_REQUIRED", "This account does not have a Clinic role.");
    }
  }
  await next();
});

clinic.use("/clinic/*", authMiddleware, requireClinicSector);

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

function optionalUuid(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = nullableText(body, key, 36);
  if (value === undefined || value === null) return value;
  return pathUuid(value, key);
}

function optionalDate(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = nullableText(body, key, 10);
  if (value === undefined || value === null) return value;
  if (!isClinicDate(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a valid YYYY-MM-DD date.`);
  }
  return value;
}

function optionalImage(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = nullableText(body, key, 280_000);
  if (value === undefined || value === null) return value;
  if (!isClinicImageDataUrl(value)) {
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
): string | undefined {
  const value = optionalString(body, key, { max: 7 });
  if (value === undefined) return undefined;
  if (value === null || !/^#[0-9a-f]{6}$/iu.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a six-digit hex color.`);
  }
  return value.toUpperCase();
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

function requiredOptionalString(
  body: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const value = optionalString(body, key, { max });
  if (value !== undefined && !value) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must not be empty.`);
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

async function organizationForUser(
  sql: ReturnType<typeof getDb>,
  user: AuthenticatedUser,
): Promise<string> {
  const rows = user.role === "clinic_admin"
    ? await sql`
        SELECT id FROM clinic_organizations
        WHERE created_by = ${user.id}
        LIMIT 1
      `
    : await sql`
        SELECT organization_id AS id FROM clinic_staff
        WHERE user_id = ${user.id} AND active IS TRUE
        LIMIT 1
      `;
  const row = rows[0] as { id?: string } | undefined;
  if (!row?.id) {
    throw new ApiError(
      403,
      "CLINIC_ORGANIZATION_REQUIRED",
      "Your Clinic account is inactive or is not linked to an organization.",
    );
  }
  return row.id;
}

async function organizationForRequest(
  sql: ReturnType<typeof getDb>,
  user: AuthenticatedUser,
  requestedId?: string,
): Promise<string> {
  if (user.role === "superadmin") {
    if (!requestedId) {
      throw new ApiError(400, "ORGANIZATION_REQUIRED", "Super Admin requests must include an organization_id.");
    }
    const organizationId = pathUuid(requestedId, "organization_id");
    const rows = await sql`SELECT id FROM clinic_organizations WHERE id = ${organizationId} LIMIT 1`;
    if (!rows[0]) {
      throw new ApiError(404, "CLINIC_ORGANIZATION_NOT_FOUND", "Clinic organization was not found.");
    }
    return organizationId;
  }
  const ownOrganizationId = await organizationForUser(sql, user);
  if (requestedId && pathUuid(requestedId, "organization_id") !== ownOrganizationId) {
    throw new ApiError(403, "CLINIC_ORGANIZATION_FORBIDDEN", "You cannot access another Clinic organization.");
  }
  return ownOrganizationId;
}

async function assertOrganizationOwner(
  sql: ReturnType<typeof getDb>,
  user: AuthenticatedUser,
  organizationId: string,
): Promise<void> {
  if (user.role === "superadmin") return;
  const rows = await sql`
    SELECT id FROM clinic_organizations
    WHERE id = ${organizationId} AND created_by = ${user.id}
    LIMIT 1
  `;
  if (!rows[0]) {
    throw new ApiError(404, "CLINIC_ORGANIZATION_NOT_FOUND", "Clinic organization was not found.");
  }
}

async function assertBranchInOrganization(
  sql: ReturnType<typeof getDb>,
  branchId: string | null | undefined,
  organizationId: string,
): Promise<void> {
  if (!branchId) return;
  const rows = await sql`
    SELECT id FROM clinic_branches
    WHERE id = ${branchId} AND organization_id = ${organizationId} AND active IS TRUE
    LIMIT 1
  `;
  if (!rows[0]) {
    throw new ApiError(400, "BRANCH_NOT_FOUND", "The selected branch is not active in this organization.");
  }
}

const ORGANIZATION_FIELDS = [
  "name", "registration_number", "license_number", "address", "phone", "email",
  "website", "logo_base64", "brand_color", "city", "district", "country",
] as const;

clinic.get(
  "/clinic/organizations",
  requireRole("superadmin", "clinic_admin", ...CLINIC_STAFF_ROLES),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = user.role === "superadmin" ? null : await organizationForUser(sql, user);
    const rows = await sql`
      SELECT o.id, o.name, o.sector, o.registration_number, o.license_number,
        o.address, o.phone, o.email, o.website, o.logo_base64, o.brand_color,
        o.city, o.district, o.country, o.created_by, o.created_at,
        admin.name AS admin_name, admin.email AS admin_email,
        (SELECT COUNT(*)::int FROM clinic_branches b
          WHERE b.organization_id = o.id AND b.active IS TRUE) AS branch_count,
        (SELECT COUNT(*)::int FROM clinic_staff s
          WHERE s.organization_id = o.id AND s.active IS TRUE) AS staff_count,
        (SELECT COUNT(*)::int FROM clinic_patients p
          WHERE p.organization_id = o.id) AS patient_count
      FROM clinic_organizations o
      LEFT JOIN users admin ON admin.id = o.created_by
      WHERE ${organizationId === null} OR o.id = ${organizationId}
      ORDER BY o.created_at DESC
    `;
    return c.json({ organizations: rows });
  },
);

clinic.get(
  "/clinic/stats",
  requireRole("superadmin", "clinic_admin", ...CLINIC_STAFF_ROLES),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = user.role === "superadmin" ? null : await organizationForUser(sql, user);
    const isGlobal = organizationId === null;
    const countRows = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM clinic_organizations o
          WHERE ${isGlobal} OR o.id = ${organizationId}) AS organizations,
        (SELECT COUNT(*)::int FROM clinic_branches b
          WHERE b.active IS TRUE AND (${isGlobal} OR b.organization_id = ${organizationId})) AS branches,
        (SELECT COUNT(*)::int FROM clinic_staff s
          WHERE s.active IS TRUE AND (${isGlobal} OR s.organization_id = ${organizationId})) AS staff,
        (SELECT COUNT(*)::int FROM clinic_patients p
          WHERE ${isGlobal} OR p.organization_id = ${organizationId}) AS patients,
        (SELECT COUNT(*)::int FROM clinic_patients p
          WHERE p.status = 'active' AND (${isGlobal} OR p.organization_id = ${organizationId})) AS active_patients
    `;
    const roleRows = await sql`
      SELECT role, COUNT(*)::int AS count
      FROM clinic_staff
      WHERE active IS TRUE AND (${isGlobal} OR organization_id = ${organizationId})
      GROUP BY role
    `;
    const byRole: Record<string, number> = Object.fromEntries(CLINIC_STAFF_ROLES.map((role) => [role, 0]));
    for (const row of roleRows as Array<{ role: string; count: number | string }>) {
      if (isClinicStaffRole(row.role)) byRole[row.role] = Number(row.count);
    }
    const counts = (countRows[0] ?? {}) as Record<string, number | string>;
    return c.json({
      stats: {
        organizations: Number(counts.organizations ?? 0),
        branches: Number(counts.branches ?? 0),
        staff: Number(counts.staff ?? 0),
        patients: Number(counts.patients ?? 0),
        active_patients: Number(counts.active_patients ?? 0),
        by_role: byRole,
      },
    });
  },
);

clinic.post("/clinic/organizations", requireRealSuperAdmin(), async (c) => {
  const body = await readJson(c);
  const name = requiredString(body, "name", { max: 200 });
  const adminName = nullableText(body, "admin_name", 120) || name;
  const adminEmail = requiredString(body, "admin_email", { max: 254 }).toLowerCase();
  const adminPassword = requiredString(body, "admin_password", { min: 8, max: 128 });
  if (!validEmail(adminEmail)) {
    throw new ApiError(400, "VALIDATION_ERROR", "admin_email must be a valid email address.");
  }
  const adminPhone = nullableText(body, "admin_phone", 40) ?? null;
  const registrationNumber = nullableText(body, "registration_number", 120) ?? null;
  const licenseNumber = nullableText(body, "license_number", 120) ?? null;
  const address = nullableText(body, "address", 500) ?? null;
  const phone = nullableText(body, "phone", 40) ?? null;
  const email = optionalEmail(body, "email") ?? null;
  const website = nullableText(body, "website", 300) ?? null;
  const logo = optionalImage(body, "logo_base64") ?? null;
  const brandColor = optionalBrandColor(body, "brand_color") ?? "#00897B";
  const city = nullableText(body, "city", 120) ?? null;
  const district = nullableText(body, "district", 120) ?? null;
  const country = nullableText(body, "country", 80) || "Uganda";
  const passwordHash = await hashPassword(adminPassword);
  const actor = c.get("user");
  const ip = requestIp(c);
  const metadata = JSON.stringify({ admin_email: adminEmail });
  const sql = getDb(c.env);

  try {
    const rows = await sql`
      WITH new_user AS (
        INSERT INTO users (name, email, phone, password_hash, role, sector, waitlist)
        VALUES (${adminName}, ${adminEmail}, ${adminPhone}, ${passwordHash}, 'clinic_admin', 'clinic', FALSE)
        RETURNING id, name, email, phone
      ),
      new_organization AS (
        INSERT INTO clinic_organizations (
          name, sector, registration_number, license_number, address, phone,
          email, website, logo_base64, brand_color, city, district, country, created_by
        )
        SELECT ${name}, 'clinic', ${registrationNumber}, ${licenseNumber},
          ${address}, ${phone}, ${email}, ${website}, ${logo}, ${brandColor},
          ${city}, ${district}, ${country}, id
        FROM new_user
        RETURNING *
      ),
      new_settings AS (
        INSERT INTO clinic_settings (organization_id)
        SELECT id FROM new_organization
        RETURNING id
      ),
      local_audit AS (
        INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT o.id, ${actor.id}, 'clinic.organization_created',
          'clinic_organizations', o.id, ${metadata}::jsonb
        FROM new_organization o RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${actor.id}, 'clinic', 'clinic.organization_created',
          'clinic_organizations', o.id, ${metadata}::jsonb, ${ip}
        FROM new_organization o RETURNING id
      )
      SELECT o.id, o.name, o.sector, o.registration_number, o.license_number,
        o.address, o.phone, o.email, o.website, o.logo_base64, o.brand_color,
        o.city, o.district, o.country, o.created_by, o.created_at,
        u.id AS admin_id, u.name AS admin_name, u.email AS admin_email, u.phone AS admin_phone
      FROM new_organization o JOIN new_user u ON u.id = o.created_by
    `;
    const emailSent = await sendEmail(c.env, {
      to: adminEmail,
      subject: "Welcome to APSHULE Clinic",
      html: welcomeEmailTemplate(adminName, "Clinic Administrator", null, c.env.APP_URL),
    });
    return c.json({ organization: rows[0], email_sent: emailSent }, 201);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "EMAIL_IN_USE", "A user or Clinic organization already uses this email or administrator.");
    }
    throw error;
  }
});

clinic.patch(
  "/clinic/organizations/:id",
  requireRole("superadmin", "clinic_admin"),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const body = await readJson(c);
    const name = requiredOptionalString(body, "name", 200);
    const registrationNumber = nullableText(body, "registration_number", 120);
    const licenseNumber = nullableText(body, "license_number", 120);
    const address = nullableText(body, "address", 500);
    const phone = nullableText(body, "phone", 40);
    const email = optionalEmail(body, "email");
    const website = nullableText(body, "website", 300);
    const logo = optionalImage(body, "logo_base64");
    const brandColor = optionalBrandColor(body, "brand_color");
    const city = nullableText(body, "city", 120);
    const district = nullableText(body, "district", 120);
    const country = requiredOptionalString(body, "country", 80);
    if (![
      name, registrationNumber, licenseNumber, address, phone, email,
      website, logo, brandColor, city, district, country,
    ].some((value) => value !== undefined)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one organization field to update.");
    }
    const actor = c.get("user");
    const sql = getDb(c.env);
    await assertOrganizationOwner(sql, actor, id);
    const ip = requestIp(c);
    const metadata = JSON.stringify({ fields: ORGANIZATION_FIELDS.filter((field) => field in body) });
    const rows = await sql`
      WITH updated AS (
        UPDATE clinic_organizations
        SET name = CASE WHEN ${name !== undefined} THEN ${name ?? null} ELSE name END,
          registration_number = CASE WHEN ${registrationNumber !== undefined} THEN ${registrationNumber ?? null} ELSE registration_number END,
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
        RETURNING *
      ),
      local_audit AS (
        INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT id, ${actor.id}, 'clinic.organization_updated',
          'clinic_organizations', id, ${metadata}::jsonb
        FROM updated RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${actor.id}, 'clinic', 'clinic.organization_updated',
          'clinic_organizations', id, ${metadata}::jsonb, ${ip}
        FROM updated RETURNING id
      )
      SELECT * FROM updated
    `;
    if (!rows[0]) {
      throw new ApiError(404, "CLINIC_ORGANIZATION_NOT_FOUND", "Clinic organization was not found.");
    }
    return c.json({ organization: rows[0] });
  },
);

clinic.get(
  "/clinic/branches",
  requireRole("superadmin", "clinic_admin", "doctor", "nurse", "receptionist"),
  async (c) => {
    const sql = getDb(c.env);
    const organizationId = await organizationForRequest(
      sql,
      c.get("user"),
      c.req.query("organization_id"),
    );
    const rows = await sql`
      SELECT id, organization_id, name, code, address, city, district, phone, active, created_at
      FROM clinic_branches
      WHERE organization_id = ${organizationId}
      ORDER BY active DESC, name ASC
    `;
    return c.json({ branches: rows });
  },
);

clinic.post(
  "/clinic/branches",
  requireRole("superadmin", "clinic_admin"),
  async (c) => {
    const body = await readJson(c);
    const name = requiredString(body, "name", { max: 160 });
    const code = nullableText(body, "code", 80) ?? null;
    const address = nullableText(body, "address", 500) ?? null;
    const city = nullableText(body, "city", 120) ?? null;
    const district = nullableText(body, "district", 120) ?? null;
    const phone = nullableText(body, "phone", 40) ?? null;
    const actor = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForRequest(sql, actor, c.req.query("organization_id"));
    const metadata = JSON.stringify({ branch_name: name });
    const ip = requestIp(c);
    try {
      const rows = await sql`
        WITH created AS (
          INSERT INTO clinic_branches (organization_id, name, code, address, city, district, phone)
          VALUES (${organizationId}, ${name}, ${code}, ${address}, ${city}, ${district}, ${phone})
          RETURNING *
        ),
        local_audit AS (
          INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
          SELECT organization_id, ${actor.id}, 'clinic.branch_created',
            'clinic_branches', id, ${metadata}::jsonb
          FROM created RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
          SELECT ${actor.id}, 'clinic', 'clinic.branch_created',
            'clinic_branches', id, ${metadata}::jsonb, ${ip}
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
  },
);

clinic.patch(
  "/clinic/branches/:id",
  requireRole("superadmin", "clinic_admin"),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const body = await readJson(c);
    const name = requiredOptionalString(body, "name", 160);
    const code = nullableText(body, "code", 80);
    const address = nullableText(body, "address", 500);
    const city = nullableText(body, "city", 120);
    const district = nullableText(body, "district", 120);
    const phone = nullableText(body, "phone", 40);
    const active = optionalBoolean(body, "active");
    if (![name, code, address, city, district, phone, active].some((value) => value !== undefined)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one branch field to update.");
    }
    const actor = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForRequest(sql, actor, c.req.query("organization_id"));
    const ip = requestIp(c);
    const metadata = JSON.stringify({
      fields: ["name", "code", "address", "city", "district", "phone", "active"].filter((field) => field in body),
    });
    try {
      const rows = await sql`
        WITH updated AS (
          UPDATE clinic_branches
          SET name = CASE WHEN ${name !== undefined} THEN ${name ?? null} ELSE name END,
            code = CASE WHEN ${code !== undefined} THEN ${code ?? null} ELSE code END,
            address = CASE WHEN ${address !== undefined} THEN ${address ?? null} ELSE address END,
            city = CASE WHEN ${city !== undefined} THEN ${city ?? null} ELSE city END,
            district = CASE WHEN ${district !== undefined} THEN ${district ?? null} ELSE district END,
            phone = CASE WHEN ${phone !== undefined} THEN ${phone ?? null} ELSE phone END,
            active = CASE WHEN ${active !== undefined} THEN ${active ?? null} ELSE active END
          WHERE id = ${id} AND organization_id = ${organizationId}
          RETURNING *
        ),
        local_audit AS (
          INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
          SELECT organization_id, ${actor.id}, 'clinic.branch_updated',
            'clinic_branches', id, ${metadata}::jsonb
          FROM updated RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
          SELECT ${actor.id}, 'clinic', 'clinic.branch_updated',
            'clinic_branches', id, ${metadata}::jsonb, ${ip}
          FROM updated RETURNING id
        )
        SELECT * FROM updated
      `;
      if (!rows[0]) {
        throw new ApiError(404, "CLINIC_BRANCH_NOT_FOUND", "Clinic branch was not found.");
      }
      return c.json({ branch: rows[0] });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "BRANCH_CODE_IN_USE", "A branch with this code already exists in your organization.");
      }
      throw error;
    }
  },
);

clinic.delete(
  "/clinic/branches/:id",
  requireRole("superadmin", "clinic_admin"),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const actor = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForRequest(sql, actor, c.req.query("organization_id"));
    const ip = requestIp(c);
    const metadata = JSON.stringify({ effect: "deactivated; historical records retained" });
    const rows = await sql`
      WITH deactivated AS (
        UPDATE clinic_branches
        SET active = FALSE
        WHERE id = ${id} AND organization_id = ${organizationId} AND active IS TRUE
        RETURNING *
      ),
      local_audit AS (
        INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${actor.id}, 'clinic.branch_deactivated',
          'clinic_branches', id, ${metadata}::jsonb
        FROM deactivated RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${actor.id}, 'clinic', 'clinic.branch_deactivated',
          'clinic_branches', id, ${metadata}::jsonb, ${ip}
        FROM deactivated RETURNING id
      )
      SELECT * FROM deactivated
    `;
    if (!rows[0]) {
      throw new ApiError(404, "CLINIC_BRANCH_NOT_FOUND", "Active Clinic branch was not found.");
    }
    return c.json({ branch: rows[0] });
  },
);

clinic.get(
  "/clinic/staff",
  requireRole("superadmin", "clinic_admin"),
  async (c) => {
    const sql = getDb(c.env);
    const organizationId = await organizationForRequest(
      sql,
      c.get("user"),
      c.req.query("organization_id"),
    );
    const rows = await sql`
      SELECT s.id, s.organization_id, s.branch_id, s.user_id, s.role,
        s.employee_code, s.license_number, s.specialization, s.hired_on,
        s.active, s.created_at, u.name, u.email, u.phone, b.name AS branch_name
      FROM clinic_staff s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN clinic_branches b ON b.id = s.branch_id
      WHERE s.organization_id = ${organizationId}
      ORDER BY s.active DESC, u.name ASC
    `;
    return c.json({ staff: rows });
  },
);

clinic.post(
  "/clinic/staff",
  requireRole("superadmin", "clinic_admin"),
  async (c) => {
    const body = await readJson(c);
    const name = requiredString(body, "name", { max: 120 });
    const email = requiredString(body, "email", { max: 254 }).toLowerCase();
    if (!validEmail(email)) {
      throw new ApiError(400, "VALIDATION_ERROR", "email must be a valid email address.");
    }
    const roleValue = requiredString(body, "role", { max: 30 });
    if (!isClinicStaffRole(roleValue)) {
      throw new ApiError(400, "VALIDATION_ERROR", "role must be doctor, nurse, receptionist, or pharmacist.");
    }
    const phone = nullableText(body, "phone", 40) ?? null;
    const branchId = optionalUuid(body, "branch_id") ?? null;
    const employeeCode = nullableText(body, "employee_code", 80) ?? null;
    const licenseNumber = nullableText(body, "license_number", 120) ?? null;
    const specialization = nullableText(body, "specialization", 160) ?? null;
    const hiredOn = optionalDate(body, "hired_on") ?? null;
    const temporaryPassword = crypto.randomUUID().replaceAll("-", "");
    const passwordHash = await hashPassword(temporaryPassword);
    const actor = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForRequest(sql, actor, c.req.query("organization_id"));
    await assertBranchInOrganization(sql, branchId, organizationId);
    const ip = requestIp(c);
    const metadata = JSON.stringify({ role: roleValue });

    try {
      const rows = await sql`
        WITH new_user AS (
          INSERT INTO users (name, email, phone, password_hash, role, sector, waitlist)
          VALUES (${name}, ${email}, ${phone}, ${passwordHash}, ${roleValue}, 'clinic', FALSE)
          RETURNING id, name, email, phone
        ),
        new_staff AS (
          INSERT INTO clinic_staff (
            organization_id, branch_id, user_id, role, employee_code,
            license_number, specialization, hired_on
          )
          SELECT ${organizationId}, ${branchId}, id, ${roleValue},
            ${employeeCode}, ${licenseNumber}, ${specialization}, ${hiredOn}
          FROM new_user RETURNING *
        ),
        local_audit AS (
          INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
          SELECT organization_id, ${actor.id}, 'clinic.staff_created',
            'clinic_staff', id, ${metadata}::jsonb
          FROM new_staff RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
          SELECT ${actor.id}, 'clinic', 'clinic.staff_created',
            'clinic_staff', id, ${metadata}::jsonb, ${ip}
          FROM new_staff RETURNING id
        )
        SELECT s.id, s.organization_id, s.branch_id, s.user_id, s.role,
          s.employee_code, s.license_number, s.specialization, s.hired_on,
          s.active, s.created_at, u.name, u.email, u.phone, b.name AS branch_name
        FROM new_staff s
        JOIN new_user u ON u.id = s.user_id
        LEFT JOIN clinic_branches b ON b.id = s.branch_id
      `;
      const emailSent = await sendEmail(c.env, {
        to: email,
        subject: "Welcome to APSHULE Clinic",
        html: welcomeEmailTemplate(name, roleValue, temporaryPassword, c.env.APP_URL),
      });
      return c.json({ staff: rows[0], email_sent: emailSent }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "EMAIL_IN_USE", "An account with this email already exists.");
      }
      throw error;
    }
  },
);

clinic.patch(
  "/clinic/staff/:id",
  requireRole("superadmin", "clinic_admin"),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const body = await readJson(c);
    const name = requiredOptionalString(body, "name", 120);
    const emailValue = requiredOptionalString(body, "email", 254);
    const email = emailValue?.toLowerCase();
    if (email && !validEmail(email)) {
      throw new ApiError(400, "VALIDATION_ERROR", "email must be a valid email address.");
    }
    const roleValue = requiredOptionalString(body, "role", 30);
    if (roleValue !== undefined && !isClinicStaffRole(roleValue)) {
      throw new ApiError(400, "VALIDATION_ERROR", "role must be doctor, nurse, receptionist, or pharmacist.");
    }
    const phone = nullableText(body, "phone", 40);
    const branchId = optionalUuid(body, "branch_id");
    const employeeCode = nullableText(body, "employee_code", 80);
    const licenseNumber = nullableText(body, "license_number", 120);
    const specialization = nullableText(body, "specialization", 160);
    const hiredOn = optionalDate(body, "hired_on");
    const active = optionalBoolean(body, "active");
    if (![
      name, email, phone, branchId, roleValue, employeeCode,
      licenseNumber, specialization, hiredOn, active,
    ].some((value) => value !== undefined)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one staff field to update.");
    }
    const actor = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForRequest(sql, actor, c.req.query("organization_id"));
    await assertBranchInOrganization(sql, branchId, organizationId);
    const ip = requestIp(c);
    const metadata = JSON.stringify({
      fields: [
        "name", "email", "phone", "role", "branch_id", "employee_code",
        "license_number", "specialization", "hired_on", "active",
      ].filter((field) => field in body),
    });

    try {
      const rows = await sql`
        WITH target AS (
          SELECT id, user_id FROM clinic_staff
          WHERE id = ${id} AND organization_id = ${organizationId}
          FOR UPDATE
        ),
        updated_user AS (
          UPDATE users u
          SET name = CASE WHEN ${name !== undefined} THEN ${name ?? null} ELSE u.name END,
            email = CASE WHEN ${email !== undefined} THEN ${email ?? null} ELSE u.email END,
            phone = CASE WHEN ${phone !== undefined} THEN ${phone ?? null} ELSE u.phone END,
            role = CASE WHEN ${roleValue !== undefined} THEN ${roleValue ?? null} ELSE u.role END,
            session_version = u.session_version + CASE
              WHEN ${active === false || roleValue !== undefined} THEN 1
              ELSE 0
            END
          FROM target t
          WHERE u.id = t.user_id
          RETURNING u.id
        ),
        updated_staff AS (
          UPDATE clinic_staff s
          SET branch_id = CASE WHEN ${branchId !== undefined} THEN ${branchId ?? null} ELSE s.branch_id END,
            role = CASE WHEN ${roleValue !== undefined} THEN ${roleValue ?? null} ELSE s.role END,
            employee_code = CASE WHEN ${employeeCode !== undefined} THEN ${employeeCode ?? null} ELSE s.employee_code END,
            license_number = CASE WHEN ${licenseNumber !== undefined} THEN ${licenseNumber ?? null} ELSE s.license_number END,
            specialization = CASE WHEN ${specialization !== undefined} THEN ${specialization ?? null} ELSE s.specialization END,
            hired_on = CASE WHEN ${hiredOn !== undefined} THEN ${hiredOn ?? null} ELSE s.hired_on END,
            active = CASE WHEN ${active !== undefined} THEN ${active ?? null} ELSE s.active END
          FROM target t
          WHERE s.id = t.id RETURNING s.*
        ),
        local_audit AS (
          INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
          SELECT organization_id, ${actor.id}, 'clinic.staff_updated',
            'clinic_staff', id, ${metadata}::jsonb
          FROM updated_staff RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
          SELECT ${actor.id}, 'clinic', 'clinic.staff_updated',
            'clinic_staff', id, ${metadata}::jsonb, ${ip}
          FROM updated_staff RETURNING id
        )
        SELECT s.id, s.organization_id, s.branch_id, s.user_id, s.role,
          s.employee_code, s.license_number, s.specialization, s.hired_on,
          s.active, s.created_at, u.name, u.email, u.phone, b.name AS branch_name
        FROM updated_staff s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN clinic_branches b ON b.id = s.branch_id
      `;
      if (!rows[0]) {
        throw new ApiError(404, "CLINIC_STAFF_NOT_FOUND", "Clinic staff member was not found.");
      }
      return c.json({ staff: rows[0] });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "EMAIL_IN_USE", "An account with this email already exists.");
      }
      throw error;
    }
  },
);

clinic.delete(
  "/clinic/staff/:id",
  requireRole("superadmin", "clinic_admin"),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const actor = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForRequest(sql, actor, c.req.query("organization_id"));
    const ip = requestIp(c);
    const metadata = JSON.stringify({ effect: "deactivated; active sessions revoked" });
    const rows = await sql`
      WITH deactivated AS (
        UPDATE clinic_staff
        SET active = FALSE
        WHERE id = ${id} AND organization_id = ${organizationId} AND active IS TRUE
        RETURNING *
      ),
      revoked AS (
        UPDATE users u
        SET session_version = u.session_version + 1
        FROM deactivated s WHERE u.id = s.user_id
        RETURNING u.id
      ),
      local_audit AS (
        INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${actor.id}, 'clinic.staff_deactivated',
          'clinic_staff', id, ${metadata}::jsonb
        FROM deactivated RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${actor.id}, 'clinic', 'clinic.staff_deactivated',
          'clinic_staff', id, ${metadata}::jsonb, ${ip}
        FROM deactivated RETURNING id
      )
      SELECT s.id, s.organization_id, s.branch_id, s.user_id, s.role,
        s.employee_code, s.license_number, s.specialization, s.hired_on,
        s.active, s.created_at, u.name, u.email, u.phone, b.name AS branch_name
      FROM deactivated s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN clinic_branches b ON b.id = s.branch_id
    `;
    if (!rows[0]) {
      throw new ApiError(404, "CLINIC_STAFF_NOT_FOUND", "Active Clinic staff member was not found.");
    }
    return c.json({ staff: rows[0] });
  },
);

function parsePatientFields(
  body: Record<string, unknown>,
  creating: boolean,
): {
  branchId: string | null | undefined;
  firstName: string | undefined;
  lastName: string | undefined;
  gender: string | null | undefined;
  dateOfBirth: string | null | undefined;
  nationalId: string | null | undefined;
  phone: string | null | undefined;
  email: string | null | undefined;
  address: string | null | undefined;
  village: string | null | undefined;
  district: string | null | undefined;
  bloodGroup: string | null | undefined;
  allergies: string | null | undefined;
  chronicConditions: string | null | undefined;
  emergencyContactName: string | null | undefined;
  emergencyContactPhone: string | null | undefined;
  photo: string | null | undefined;
} {
  const firstName = creating
    ? requiredString(body, "first_name", { max: 100 })
    : requiredOptionalString(body, "first_name", 100);
  const lastName = creating
    ? requiredString(body, "last_name", { max: 100 })
    : requiredOptionalString(body, "last_name", 100);
  const dateOfBirth = optionalDate(body, "date_of_birth");
  if (dateOfBirth && dateOfBirth > new Date().toISOString().slice(0, 10)) {
    throw new ApiError(400, "VALIDATION_ERROR", "date_of_birth cannot be in the future.");
  }
  return {
    branchId: optionalUuid(body, "branch_id"),
    firstName,
    lastName,
    gender: nullableText(body, "gender", 30),
    dateOfBirth,
    nationalId: nullableText(body, "national_id", 80),
    phone: nullableText(body, "phone", 40),
    email: optionalEmail(body, "email"),
    address: nullableText(body, "address", 500),
    village: nullableText(body, "village", 120),
    district: nullableText(body, "district", 120),
    bloodGroup: nullableText(body, "blood_group", 20),
    allergies: nullableText(body, "allergies", 4000),
    chronicConditions: nullableText(body, "chronic_conditions", 4000),
    emergencyContactName: nullableText(body, "emergency_contact_name", 120),
    emergencyContactPhone: nullableText(body, "emergency_contact_phone", 40),
    photo: optionalImage(body, "photo_base64"),
  };
}

clinic.get(
  "/clinic/patients",
  requireRole("superadmin", "clinic_admin", "doctor", "nurse", "receptionist"),
  async (c) => {
    const sql = getDb(c.env);
    const organizationId = await organizationForRequest(
      sql,
      c.get("user"),
      c.req.query("organization_id"),
    );
    const search = c.req.query("search")?.trim() || null;
    if (search && search.length > 120) {
      throw new ApiError(400, "VALIDATION_ERROR", "search must be no longer than 120 characters.");
    }
    const searchPattern = search ? `%${search}%` : null;
    const branchValue = c.req.query("branch_id");
    const branchId = branchValue ? pathUuid(branchValue, "branch_id") : null;
    if (branchId) await assertBranchInOrganization(sql, branchId, organizationId);
    const status = c.req.query("status") || "active";
    if (!["active", "inactive", "all"].includes(status)) {
      throw new ApiError(400, "VALIDATION_ERROR", "status must be active, inactive, or all.");
    }
    const limit = parseLimit(c.req.query("limit"), 100);
    const rows = await sql`
      SELECT p.id, p.organization_id, p.branch_id, p.patient_number,
        p.first_name, p.last_name, p.gender, p.date_of_birth, p.phone,
        p.blood_group, p.status, p.created_at, p.updated_at,
        b.name AS branch_name, NULL::date AS last_visit
      FROM clinic_patients p
      LEFT JOIN clinic_branches b ON b.id = p.branch_id
      WHERE p.organization_id = ${organizationId}
        AND (${branchId === null} OR p.branch_id = ${branchId})
        AND (${status === "all"} OR p.status = ${status})
        AND (
          ${searchPattern === null}
          OR p.patient_number ILIKE ${searchPattern}
          OR p.first_name ILIKE ${searchPattern}
          OR p.last_name ILIKE ${searchPattern}
          OR p.phone ILIKE ${searchPattern}
          OR p.national_id ILIKE ${searchPattern}
        )
      ORDER BY p.updated_at DESC, p.created_at DESC
      LIMIT ${limit}
    `;
    return c.json({ patients: rows });
  },
);

clinic.post(
  "/clinic/patients",
  requireRole("superadmin", "clinic_admin", "receptionist"),
  async (c) => {
    const body = await readJson(c);
    const patient = parsePatientFields(body, true);
    const actor = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForRequest(sql, actor, c.req.query("organization_id"));
    await assertBranchInOrganization(sql, patient.branchId, organizationId);
    const ip = requestIp(c);

    const rows = await sql`
      WITH month_value AS (
        SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Kampala', 'YYYYMM') AS yyyymm
      ),
      allocation AS (
        UPDATE clinic_organizations org
        SET patient_number_month = month_value.yyyymm,
          patient_number_sequence = CASE
            WHEN org.patient_number_month = month_value.yyyymm
              THEN org.patient_number_sequence + 1
            ELSE 1
          END
        FROM month_value
        WHERE org.id = ${organizationId}
          AND (
            org.patient_number_month IS DISTINCT FROM month_value.yyyymm
            OR org.patient_number_sequence < 9999
          )
        RETURNING org.id AS organization_id, org.patient_number_sequence
      ),
      created AS (
        INSERT INTO clinic_patients (
          organization_id, branch_id, patient_number, first_name, last_name,
          gender, date_of_birth, national_id, phone, email, address, village,
          district, blood_group, allergies, chronic_conditions,
          emergency_contact_name, emergency_contact_phone, photo_base64, created_by
        )
        SELECT allocation.organization_id, ${patient.branchId ?? null},
          'PAT-' || month_value.yyyymm || '-' || lpad(allocation.patient_number_sequence::text, 4, '0'),
          ${patient.firstName}, ${patient.lastName}, ${patient.gender ?? null},
          ${patient.dateOfBirth ?? null}, ${patient.nationalId ?? null},
          ${patient.phone ?? null}, ${patient.email ?? null}, ${patient.address ?? null},
          ${patient.village ?? null}, ${patient.district ?? null},
          ${patient.bloodGroup ?? null}, ${patient.allergies ?? null},
          ${patient.chronicConditions ?? null},
          ${patient.emergencyContactName ?? null}, ${patient.emergencyContactPhone ?? null},
          ${patient.photo ?? null}, ${actor.id}
        FROM allocation CROSS JOIN month_value
        RETURNING *
      ),
      local_audit AS (
        INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${actor.id}, 'clinic.patient_created',
          'clinic_patients', id, jsonb_build_object('patient_number', patient_number)
        FROM created RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${actor.id}, 'clinic', 'clinic.patient_created',
          'clinic_patients', id, jsonb_build_object('patient_number', patient_number), ${ip}
        FROM created RETURNING id
      )
      SELECT * FROM created
    `;
    if (!rows[0]) {
      throw new ApiError(409, "PATIENT_NUMBER_EXHAUSTED", "This organization has reached its monthly patient-number limit.");
    }
    return c.json({ patient: rows[0] }, 201);
  },
);

clinic.get(
  "/clinic/patients/:id",
  requireRole("superadmin", "clinic_admin", ...CLINIC_STAFF_ROLES),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const sql = getDb(c.env);
    const organizationId = await organizationForRequest(
      sql,
      c.get("user"),
      c.req.query("organization_id"),
    );
    const rows = await sql`
      SELECT p.*, b.name AS branch_name, NULL::date AS last_visit
      FROM clinic_patients p
      LEFT JOIN clinic_branches b ON b.id = p.branch_id
      WHERE p.id = ${id} AND p.organization_id = ${organizationId}
      LIMIT 1
    `;
    if (!rows[0]) {
      throw new ApiError(404, "CLINIC_PATIENT_NOT_FOUND", "Clinic patient was not found.");
    }
    return c.json({ patient: rows[0] });
  },
);

const PATIENT_FIELDS = [
  "branch_id",
  "first_name",
  "last_name",
  "gender",
  "date_of_birth",
  "national_id",
  "phone",
  "email",
  "address",
  "village",
  "district",
  "blood_group",
  "allergies",
  "chronic_conditions",
  "emergency_contact_name",
  "emergency_contact_phone",
  "photo_base64",
] as const;

clinic.patch(
  "/clinic/patients/:id",
  requireRole("superadmin", "clinic_admin", "nurse", "receptionist"),
  async (c) => {
    const id = pathUuid(c.req.param("id"));
    const body = await readJson(c);
    const patient = parsePatientFields(body, false);
    const fields = PATIENT_FIELDS.filter((field) => field in body);
    if (!fields.length) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one patient field to update.");
    }
    const actor = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForRequest(
      sql,
      actor,
      c.req.query("organization_id"),
    );
    await assertBranchInOrganization(sql, patient.branchId, organizationId);
    const ip = requestIp(c);
    const metadata = JSON.stringify({ fields });
    const rows = await sql`
      WITH updated AS (
        UPDATE clinic_patients
        SET branch_id = CASE WHEN ${patient.branchId !== undefined} THEN ${patient.branchId ?? null} ELSE branch_id END,
          first_name = CASE WHEN ${patient.firstName !== undefined} THEN ${patient.firstName ?? null} ELSE first_name END,
          last_name = CASE WHEN ${patient.lastName !== undefined} THEN ${patient.lastName ?? null} ELSE last_name END,
          gender = CASE WHEN ${patient.gender !== undefined} THEN ${patient.gender ?? null} ELSE gender END,
          date_of_birth = CASE WHEN ${patient.dateOfBirth !== undefined} THEN ${patient.dateOfBirth ?? null} ELSE date_of_birth END,
          national_id = CASE WHEN ${patient.nationalId !== undefined} THEN ${patient.nationalId ?? null} ELSE national_id END,
          phone = CASE WHEN ${patient.phone !== undefined} THEN ${patient.phone ?? null} ELSE phone END,
          email = CASE WHEN ${patient.email !== undefined} THEN ${patient.email ?? null} ELSE email END,
          address = CASE WHEN ${patient.address !== undefined} THEN ${patient.address ?? null} ELSE address END,
          village = CASE WHEN ${patient.village !== undefined} THEN ${patient.village ?? null} ELSE village END,
          district = CASE WHEN ${patient.district !== undefined} THEN ${patient.district ?? null} ELSE district END,
          blood_group = CASE WHEN ${patient.bloodGroup !== undefined} THEN ${patient.bloodGroup ?? null} ELSE blood_group END,
          allergies = CASE WHEN ${patient.allergies !== undefined} THEN ${patient.allergies ?? null} ELSE allergies END,
          chronic_conditions = CASE WHEN ${patient.chronicConditions !== undefined} THEN ${patient.chronicConditions ?? null} ELSE chronic_conditions END,
          emergency_contact_name = CASE WHEN ${patient.emergencyContactName !== undefined} THEN ${patient.emergencyContactName ?? null} ELSE emergency_contact_name END,
          emergency_contact_phone = CASE WHEN ${patient.emergencyContactPhone !== undefined} THEN ${patient.emergencyContactPhone ?? null} ELSE emergency_contact_phone END,
          photo_base64 = CASE WHEN ${patient.photo !== undefined} THEN ${patient.photo ?? null} ELSE photo_base64 END,
          updated_at = NOW()
        WHERE id = ${id} AND organization_id = ${organizationId}
        RETURNING *
      ),
      local_audit AS (
        INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${actor.id}, 'clinic.patient_updated',
          'clinic_patients', id, ${metadata}::jsonb
        FROM updated RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${actor.id}, 'clinic', 'clinic.patient_updated',
          'clinic_patients', id, ${metadata}::jsonb, ${ip}
        FROM updated RETURNING id
      )
      SELECT * FROM updated
    `;
    if (!rows[0]) {
      throw new ApiError(404, "CLINIC_PATIENT_NOT_FOUND", "Clinic patient was not found.");
    }
    return c.json({ patient: rows[0] });
  },
);

clinic.delete(
  "/clinic/patients/:id",
  requireRole("superadmin", "clinic_admin"),
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
    const metadata = JSON.stringify({ effect: "soft-deleted; patient record retained" });
    const rows = await sql`
      WITH deactivated AS (
        UPDATE clinic_patients
        SET status = 'inactive', updated_at = NOW()
        WHERE id = ${id} AND organization_id = ${organizationId} AND status = 'active'
        RETURNING *
      ),
      local_audit AS (
        INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${actor.id}, 'clinic.patient_deactivated',
          'clinic_patients', id,
          ${metadata}::jsonb || jsonb_build_object('patient_number', patient_number)
        FROM deactivated RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${actor.id}, 'clinic', 'clinic.patient_deactivated',
          'clinic_patients', id,
          ${metadata}::jsonb || jsonb_build_object('patient_number', patient_number), ${ip}
        FROM deactivated RETURNING id
      )
      SELECT * FROM deactivated
    `;
    if (!rows[0]) {
      throw new ApiError(404, "CLINIC_PATIENT_NOT_FOUND", "Active Clinic patient was not found.");
    }
    return c.json({ patient: rows[0] });
  },
);

function optionalNumber(
  body: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (!(key in body)) return undefined;
  const raw = body[key];
  const value = typeof raw === "number" || typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} is outside the allowed range.`);
  }
  return value;
}

function optionalTime(body: Record<string, unknown>, key: string): string | undefined {
  const value = requiredOptionalString(body, key, 8);
  if (value === undefined) return undefined;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/u.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a valid 24-hour time.`);
  }
  return value.slice(0, 5);
}

function optionalWorkingDays(body: Record<string, unknown>): string[] | undefined {
  if (!("working_days" in body)) return undefined;
  const value = body.working_days;
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) {
    throw new ApiError(400, "VALIDATION_ERROR", "working_days must contain one to seven days.");
  }
  const days = value.map((day) => typeof day === "string" ? day : "");
  if (
    days.some((day) => !DAY_NAMES.has(day)) ||
    new Set(days).size !== days.length
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", "working_days contains an invalid or repeated day.");
  }
  return days;
}

function timeMinutes(value: string): number {
  const [hour, minute] = value.slice(0, 5).split(":").map(Number);
  return hour! * 60 + minute!;
}

clinic.get(
  "/clinic/settings",
  requireRole("superadmin", "clinic_admin"),
  async (c) => {
    const sql = getDb(c.env);
    const organizationId = await organizationForRequest(
      sql,
      c.get("user"),
      c.req.query("organization_id"),
    );
    const rows = await sql`
      SELECT organization_id, currency, consultation_fee, opening_time,
        closing_time, working_days, updated_at
      FROM clinic_settings
      WHERE organization_id = ${organizationId}
      LIMIT 1
    `;
    if (!rows[0]) {
      throw new ApiError(404, "CLINIC_SETTINGS_NOT_FOUND", "Clinic settings were not found.");
    }
    return c.json({ settings: rows[0] });
  },
);

clinic.patch(
  "/clinic/settings",
  requireRole("superadmin", "clinic_admin"),
  async (c) => {
    const body = await readJson(c);
    const currencyValue = requiredOptionalString(body, "currency", 3);
    const currency = currencyValue?.toUpperCase();
    if (currency && !/^[A-Z]{3}$/u.test(currency)) {
      throw new ApiError(400, "VALIDATION_ERROR", "currency must be a three-letter code.");
    }
    const consultationFee = optionalNumber(body, "consultation_fee", 0, 1_000_000_000);
    const openingTime = optionalTime(body, "opening_time");
    const closingTime = optionalTime(body, "closing_time");
    const workingDays = optionalWorkingDays(body);
    if (![currency, consultationFee, openingTime, closingTime, workingDays].some((value) => value !== undefined)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one setting to update.");
    }

    const actor = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForRequest(
      sql,
      actor,
      c.req.query("organization_id"),
    );
    const currentRows = await sql`
      SELECT opening_time, closing_time
      FROM clinic_settings
      WHERE organization_id = ${organizationId}
      LIMIT 1
    `;
    if (!currentRows[0]) {
      throw new ApiError(404, "CLINIC_SETTINGS_NOT_FOUND", "Clinic settings were not found.");
    }
    const current = currentRows[0] as { opening_time: string; closing_time: string };
    const resolvedOpening = openingTime ?? String(current.opening_time).slice(0, 5);
    const resolvedClosing = closingTime ?? String(current.closing_time).slice(0, 5);
    if (timeMinutes(resolvedOpening) >= timeMinutes(resolvedClosing)) {
      throw new ApiError(400, "VALIDATION_ERROR", "closing_time must be later than opening_time.");
    }

    const fields = ["currency", "consultation_fee", "opening_time", "closing_time", "working_days"]
      .filter((field) => field in body);
    const metadata = JSON.stringify({ fields });
    const ip = requestIp(c);
    const rows = await sql`
      WITH updated AS (
        UPDATE clinic_settings
        SET currency = CASE WHEN ${currency !== undefined} THEN ${currency ?? null} ELSE currency END,
          consultation_fee = CASE WHEN ${consultationFee !== undefined} THEN ${consultationFee ?? null} ELSE consultation_fee END,
          opening_time = CASE WHEN ${openingTime !== undefined} THEN ${openingTime ?? null}::time ELSE opening_time END,
          closing_time = CASE WHEN ${closingTime !== undefined} THEN ${closingTime ?? null}::time ELSE closing_time END,
          working_days = CASE WHEN ${workingDays !== undefined} THEN ${workingDays ?? null}::text[] ELSE working_days END,
          updated_at = NOW()
        WHERE organization_id = ${organizationId}
        RETURNING *
      ),
      local_audit AS (
        INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${actor.id}, 'clinic.settings_updated',
          'clinic_settings', id, ${metadata}::jsonb
        FROM updated RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${actor.id}, 'clinic', 'clinic.settings_updated',
          'clinic_settings', id, ${metadata}::jsonb, ${ip}
        FROM updated RETURNING id
      )
      SELECT organization_id, currency, consultation_fee, opening_time,
        closing_time, working_days, updated_at
      FROM updated
    `;
    if (!rows[0]) {
      throw new ApiError(404, "CLINIC_SETTINGS_NOT_FOUND", "Clinic settings were not found.");
    }
    return c.json({ settings: rows[0] });
  },
);

clinic.route(
  "/",
  createClinicWorkflowRoutes({ organizationForRequest, requestIp }),
);

export default clinic;
