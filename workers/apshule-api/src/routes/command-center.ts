import { Hono, type Context } from "hono";
import { authMiddleware, createAccessToken, hashPassword, requireRealSuperAdmin } from "../auth.js";
import { ApiError, getDb } from "../db.js";
import { readJson, requiredString, optionalString, validEmail } from "../http.js";
import { sendEmail } from "../email.js";
import type { AppEnv } from "../types.js";

const cc = new Hono<AppEnv>();
const publicAnnouncements = new Hono<AppEnv>();
const userCompliance = new Hono<AppEnv>();
const TOS_VERSION = "v1.0 (2026-10-08)";
const PRIVACY_VERSION = "v1.0 (2026-10-08)";
const roles = [
  "individual", "teacher", "school", "superadmin", "mfi_admin",
  "loan_officer", "loan_manager", "loan_director", "borrower",
  "clinic_admin", "doctor", "nurse", "receptionist", "pharmacist", "patient",
  "farm_admin", "farm_manager", "farm_worker",
] as const;
const sectors = ["education", "mfi", "clinic", "farm"] as const;
const permissionNames = new Set(["cc.read", "cc.manage"]);
const institutionTables = {
  education: "schools",
  mfi: "mfi_organizations",
  clinic: "clinic_organizations",
  farm: "farm_organizations",
} as const;
type Sector = keyof typeof institutionTables;

function ipFrom(c: Context<AppEnv>): string | null {
  return (c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? null)?.slice(0, 255) ?? null;
}

async function audit(
  c: Context<AppEnv>,
  action: string,
  targetTable: string | null = null,
  targetId: string | null = null,
  metadata: Record<string, unknown> = {},
  result = "success",
) {
  const actor = c.get("user");
  await getDb(c.env)`
    INSERT INTO audit_log (
      actor_id, actor_email, actor_role, sector, action, target_table,
      target_id, metadata, ip, device_info, result
    ) VALUES (
      ${actor.id}, ${actor.email}, ${actor.role}, ${actor.sector}, ${action},
      ${targetTable}, ${targetId}, ${JSON.stringify(metadata)}::jsonb, ${ipFrom(c)},
      ${JSON.stringify({ user_agent: c.req.header("User-Agent") ?? null })}::jsonb,
      ${result}
    )
  `;
}

function isSector(value: string): value is Sector {
  return Object.hasOwn(institutionTables, value);
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" :
    typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[\s]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csvResponse(rows: Record<string, unknown>[], filename: string): Response {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const csv = [columns.map(csvCell).join(","), ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(","))].join("\r\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

function parseDate(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new ApiError(400, "VALIDATION_ERROR", "Date filter is invalid.");
  return date.toISOString();
}

async function institutionList(sql: ReturnType<typeof getDb>) {
  return sql`
    SELECT i.id, i.name, i.sector, i.email, i.phone, i.address, i.logo_base64,
      i.created_at, COALESCE(s.status, 'active') AS status,
      COALESCE(m.user_count, 0)::int AS user_count
    FROM (
      SELECT id, name, 'education'::text AS sector, email, phone, address, logo_base64, created_at
      FROM schools
      UNION ALL
      SELECT id, name, 'mfi', email, phone, address, logo_base64, created_at FROM mfi_organizations
      UNION ALL
      SELECT id, name, 'clinic', email, phone, address, logo_base64, created_at FROM clinic_organizations
      UNION ALL
      SELECT id, name, 'farm', email, phone, address, logo_base64, created_at FROM farm_organizations
    ) i
    LEFT JOIN institution_control_state s ON s.institution_id = i.id AND s.sector = i.sector
    LEFT JOIN LATERAL (
      SELECT CASE i.sector
        WHEN 'education' THEN (SELECT COUNT(*) FROM users u WHERE u.school_id = i.id)
        WHEN 'mfi' THEN (SELECT COUNT(*) FROM mfi_officers o WHERE o.organization_id = i.id)
        WHEN 'clinic' THEN (SELECT COUNT(*) FROM clinic_staff st WHERE st.organization_id = i.id)
        WHEN 'farm' THEN (SELECT COUNT(*) FROM farm_workers w WHERE w.organization_id = i.id)
        ELSE 0
      END AS user_count
    ) m ON TRUE
    ORDER BY i.created_at DESC
  `;
}

cc.use("*", authMiddleware, requireRealSuperAdmin());
cc.use("*", async (c, next) => {
  const permission = c.req.method === "GET" ? "cc.read" : "cc.manage";
  const rows = await getDb(c.env)`
    SELECT granted FROM role_permissions
    WHERE role = ${c.get("user").role} AND permission IN ('*', ${permission})
  `;
  if (!(rows as { granted: boolean }[]).some((row) => row.granted)) {
    throw new ApiError(403, "FORBIDDEN", "Your Command Center permission is not enabled.");
  }
  await next();
});

cc.get("/overview", async (c) => {
  const sql = getDb(c.env);
  const [users, schools, mfi, clinics, farms, revenue, pending, activity, snapshots, bugReports, newInstitutions] = await Promise.all([
    sql`SELECT COUNT(*)::int AS count FROM users`,
    sql`SELECT COUNT(*)::int AS count FROM schools`,
    sql`SELECT COUNT(*)::int AS count FROM mfi_organizations`,
    sql`SELECT COUNT(*)::int AS count FROM clinic_organizations`,
    sql`SELECT COUNT(*)::int AS count FROM farm_organizations`,
    sql`SELECT COALESCE(SUM(amount), 0)::numeric AS amount FROM payments WHERE status IN ('completed', 'success') AND updated_at >= NOW() - INTERVAL '30 days'`,
    sql`SELECT COUNT(*)::int AS count FROM data_deletion_requests WHERE status = 'pending'`,
    sql`SELECT a.id, a.actor_id, a.actor_email, a.actor_role, a.sector, a.action,
      a.target_table, a.target_id, a.result, a.created_at
      FROM audit_log a ORDER BY a.created_at DESC LIMIT 20`,
    sql`SELECT
      (SELECT COUNT(*) FROM users WHERE sector = 'education' AND role = 'individual') AS students,
      (SELECT COUNT(*) FROM users WHERE sector = 'education' AND role = 'teacher') AS teachers,
      (SELECT COUNT(*) FROM mfi_customers) AS customers,
      (SELECT COUNT(*) FROM mfi_loans) AS loans,
      (SELECT COUNT(*) FROM clinic_patients) AS patients,
      (SELECT COUNT(*) FROM clinic_visits) AS visits,
      (SELECT COUNT(*) FROM farm_animals WHERE status <> 'deleted') AS animals,
      (SELECT COUNT(*) FROM farm_workers WHERE active IS TRUE) AS workers`,
    sql`SELECT COUNT(*)::int AS count FROM bug_reports WHERE status IN ('open', 'in_progress')`,
    sql`SELECT COUNT(*)::int AS count FROM (
      SELECT created_at FROM schools WHERE created_at >= NOW() - INTERVAL '7 days'
      UNION ALL SELECT created_at FROM mfi_organizations WHERE created_at >= NOW() - INTERVAL '7 days'
      UNION ALL SELECT created_at FROM clinic_organizations WHERE created_at >= NOW() - INTERVAL '7 days'
      UNION ALL SELECT created_at FROM farm_organizations WHERE created_at >= NOW() - INTERVAL '7 days'
    ) recent`,
  ]);
  const snap = (snapshots[0] ?? {}) as Record<string, number>;
  const institutionCount = Number(schools[0]?.count ?? 0) + Number(mfi[0]?.count ?? 0) +
    Number(clinics[0]?.count ?? 0) + Number(farms[0]?.count ?? 0);
  const alerts = [
    ...(Number(pending[0]?.count ?? 0) > 0 ? [{ type: "warning", message: "Pending data deletion requests", count: Number(pending[0]?.count) }] : []),
    ...(Number(bugReports[0]?.count ?? 0) > 0 ? [{ type: "warning", message: "Unhandled bug reports", count: Number(bugReports[0]?.count) }] : []),
    ...(Number(newInstitutions[0]?.count ?? 0) > 0 ? [{ type: "info", message: "New institution registrations in the last 7 days", count: Number(newInstitutions[0]?.count) }] : []),
  ];
  return c.json({
    totals: {
      users: Number(users[0]?.count ?? 0),
      institutions: institutionCount,
      by_sector: {
        education: Number(schools[0]?.count ?? 0),
        mfi: Number(mfi[0]?.count ?? 0),
        clinic: Number(clinics[0]?.count ?? 0),
        farm: Number(farms[0]?.count ?? 0),
      },
      revenue_30d: Number(revenue[0]?.amount ?? 0),
      active_sessions: "Not tracked",
    },
    health: { worker_ok: true, db_ok: true, r2_ok: false, deployment_status: "not_tracked", error_rate: "not_tracked" },
    alerts,
    recent_activity: activity,
    snapshots: {
      education: { institutions: Number(schools[0]?.count ?? 0), students: Number(snap.students ?? 0), teachers: Number(snap.teachers ?? 0) },
      mfi: { institutions: Number(mfi[0]?.count ?? 0), customers: Number(snap.customers ?? 0), loans: Number(snap.loans ?? 0) },
      clinic: { institutions: Number(clinics[0]?.count ?? 0), patients: Number(snap.patients ?? 0), visits: Number(snap.visits ?? 0) },
      farm: { institutions: Number(farms[0]?.count ?? 0), animals: Number(snap.animals ?? 0), workers: Number(snap.workers ?? 0) },
    },
  });
});

cc.get("/users", async (c) => {
  const sql = getDb(c.env);
  const search = (c.req.query("search") ?? "").trim().slice(0, 120);
  const role = c.req.query("role") ?? "";
  const sector = c.req.query("sector") ?? "";
  const status = c.req.query("status") ?? "";
  if (role && !(roles as readonly string[]).includes(role)) throw new ApiError(400, "VALIDATION_ERROR", "Unknown role filter.");
  if (sector && !(sectors as readonly string[]).includes(sector)) throw new ApiError(400, "VALIDATION_ERROR", "Unknown sector filter.");
  if (status && !["active", "inactive"].includes(status)) throw new ApiError(400, "VALIDATION_ERROR", "Status must be active or inactive.");
  const page = Math.max(1, Math.min(10000, Number(c.req.query("page") ?? 1) || 1));
  const limit = Math.max(1, Math.min(100, Number(c.req.query("limit") ?? 50) || 50));
  const offset = (page - 1) * limit;
  const [rows, counts, byRole] = await Promise.all([
    sql`SELECT u.id, u.name, u.email, u.phone, u.role, u.sector, u.school_id,
      u.last_login, u.created_at, u.is_active,
      COALESCE(s.name, m.name, cl.name, f.name) AS institution_name
      FROM users u
      LEFT JOIN schools s ON s.id = u.school_id
      LEFT JOIN mfi_organizations m ON m.created_by = u.id
      LEFT JOIN clinic_organizations cl ON cl.created_by = u.id
      LEFT JOIN farm_organizations f ON f.created_by = u.id
      WHERE (${search} = '' OR u.name ILIKE ${`%${search}%`} OR u.email ILIKE ${`%${search}%`})
        AND (${role} = '' OR u.role = ${role})
        AND (${sector} = '' OR u.sector = ${sector})
        AND (${status} = '' OR u.is_active = (${status} = 'active'))
      ORDER BY u.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    sql`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE is_active IS TRUE)::int AS active,
      COUNT(*) FILTER (WHERE is_active IS NOT TRUE)::int AS inactive
      FROM users
      WHERE (${search} = '' OR name ILIKE ${`%${search}%`} OR email ILIKE ${`%${search}%`})
        AND (${role} = '' OR users.role = ${role})
        AND (${sector} = '' OR users.sector = ${sector})
        AND (${status} = '' OR users.is_active = (${status} = 'active'))`,
    sql`SELECT role, COUNT(*)::int AS count FROM users
      WHERE (${search} = '' OR name ILIKE ${`%${search}%`} OR email ILIKE ${`%${search}%`})
        AND (${sector} = '' OR users.sector = ${sector})
        AND (${status} = '' OR users.is_active = (${status} = 'active'))
      GROUP BY role ORDER BY count DESC`,
  ]);
  return c.json({ users: rows, stats: { ...counts[0], by_role: byRole }, page, limit });
});

cc.post("/users", async (c) => {
  const body = await readJson(c);
  const name = requiredString(body, "name", { max: 120 });
  const email = requiredString(body, "email", { max: 254 }).toLowerCase();
  const role = requiredString(body, "role", { max: 30 });
  const sector = requiredString(body, "sector", { max: 30 });
  const phone = optionalString(body, "phone", { max: 40 }) ?? null;
  if (!validEmail(email) || !(roles as readonly string[]).includes(role) || !(sectors as readonly string[]).includes(sector)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Provide a valid email, role, and sector.");
  }
  const passwordHash = await hashPassword(crypto.randomUUID());
  const rows = await getDb(c.env)`
    INSERT INTO users (name, email, phone, password_hash, role, sector, is_active, waitlist)
    VALUES (${name}, ${email}, ${phone}, ${passwordHash}, ${role}, ${sector}, TRUE, FALSE)
    RETURNING id, name, email, phone, role, sector, is_active, created_at
  `;
  const user = rows[0] as Record<string, unknown>;
  await audit(c, "cc.user.create", "users", String(user.id), { role, sector });
  c.executionCtx.waitUntil(sendEmail(c.env, {
    to: email,
    subject: "Your APSHULE account is ready",
    html: `<p>Hello ${name.replace(/[&<>"']/gu, "")},</p><p>Your APSHULE account was created by an administrator. Use the Forgot Password option on the sign-in page to set your password.</p>`,
  }));
  return c.json({ user }, 201);
});

cc.patch("/users/:id", async (c) => {
  const body = await readJson(c);
  const userId = c.req.param("id");
  const hasName = typeof body.name === "string";
  const hasEmail = typeof body.email === "string";
  const hasPhone = Object.hasOwn(body, "phone");
  const hasRole = typeof body.role === "string";
  const hasSector = typeof body.sector === "string";
  const hasActive = typeof body.is_active === "boolean";
  const resetRequested = body.reset_password === true;
  const name = hasName ? requiredString(body, "name", { max: 120 }) : null;
  const email = hasEmail ? requiredString(body, "email", { max: 254 }).toLowerCase() : null;
  const phone = hasPhone ? optionalString(body, "phone", { max: 40, allowNull: true }) ?? null : null;
  const role = hasRole ? String(body.role) : null;
  const sector = hasSector ? String(body.sector) : null;
  if (![hasName, hasEmail, hasPhone, hasRole, hasSector, hasActive, resetRequested].some(Boolean)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one editable user field.");
  }
  if ((email && !validEmail(email)) || (role && !(roles as readonly string[]).includes(role)) ||
      (sector && !(sectors as readonly string[]).includes(sector))) {
    throw new ApiError(400, "VALIDATION_ERROR", "Invalid email, role, or sector.");
  }
  const rows = await getDb(c.env)`
    UPDATE users SET
      name = CASE WHEN ${hasName} THEN ${name} ELSE name END,
      email = CASE WHEN ${hasEmail} THEN ${email} ELSE email END,
      phone = CASE WHEN ${hasPhone} THEN ${phone} ELSE phone END,
      role = CASE WHEN ${hasRole} THEN ${role} ELSE role END,
      sector = CASE WHEN ${hasSector} THEN ${sector} ELSE sector END,
      is_active = CASE WHEN ${hasActive} THEN ${body.is_active === true} ELSE is_active END,
      session_version = CASE WHEN ${hasActive} AND ${body.is_active === false} THEN session_version + 1 ELSE session_version END,
      updated_at = NOW()
    WHERE id = ${userId}
    RETURNING id, name, email, phone, role, sector, is_active, last_login
  `;
  if (!rows[0]) throw new ApiError(404, "USER_NOT_FOUND", "User was not found.");
  await audit(c, "cc.user.update", "users", userId, {
    changed: [hasName && "name", hasEmail && "email", hasPhone && "phone", hasRole && "role", hasSector && "sector", hasActive && "is_active"].filter(Boolean),
  });
  if (resetRequested) {
    await getDb(c.env)`UPDATE users SET session_version = session_version + 1 WHERE id = ${userId}`;
    c.executionCtx.waitUntil(sendEmail(c.env, {
      to: String((rows[0] as Record<string, unknown>).email),
      subject: "Reset your APSHULE password",
      html: "<p>An administrator requested a password reset for your APSHULE account. Use the Forgot Password option on the sign-in page to set a new password.</p>",
    }));
    await audit(c, "cc.user.password_reset_requested", "users", userId);
  }
  return c.json({ user: rows[0] });
});

cc.post("/users/:id/impersonate", async (c) => {
  const userId = c.req.param("id");
  const rows = await getDb(c.env)`
    SELECT id, name, email, role, school_id, sector,
      COALESCE(session_version, 0) AS session_version
    FROM users WHERE id = ${userId} AND is_active IS TRUE LIMIT 1
  `;
  const target = rows[0] as {
    id: string; name: string; email: string; role: typeof roles[number];
    school_id: string | null; sector: string | null; session_version: number;
  } | undefined;
  if (!target) throw new ApiError(404, "USER_NOT_FOUND", "Active user was not found.");
  if (target.role === "superadmin") throw new ApiError(403, "IMPERSONATION_FORBIDDEN", "Super Admin accounts cannot be impersonated.");
  const sector = target.sector ?? "education";
  const issued = await createAccessToken(c.env, {
    id: target.id, email: target.email, role: target.role,
    schoolId: target.school_id, sector, sessionVersion: target.session_version,
  }, { expiresInSeconds: 3600, impersonatedBy: c.get("user").id });
  await audit(c, "impersonate_start", "users", userId, { target_email: target.email, via: "command_center" });
  return c.json({
    token: issued.token,
    user: { id: target.id, name: target.name, email: target.email, role: target.role, sector },
    expiresIn: 3600,
  });
});

async function setUserActive(c: Context<AppEnv>, active: boolean) {
  const id = c.req.param("id");
  if (id === c.get("user").id && !active) throw new ApiError(400, "SELF_DEACTIVATION_NOT_ALLOWED", "You cannot deactivate your own account.");
  const rows = await getDb(c.env)`
    UPDATE users SET is_active = ${active},
      session_version = session_version + CASE WHEN ${active} THEN 0 ELSE 1 END,
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING id, name, is_active
  `;
  if (!rows[0]) throw new ApiError(404, "USER_NOT_FOUND", "User was not found.");
  await audit(c, active ? "cc.user.activate" : "cc.user.deactivate", "users", id);
  return c.json({ user: rows[0] });
}
cc.post("/users/:id/deactivate", (c) => setUserActive(c, false));
cc.post("/users/:id/activate", (c) => setUserActive(c, true));

cc.get("/users/:id/activity", async (c) => {
  const id = c.req.param("id");
  const rows = await getDb(c.env)`
    SELECT id, actor_id, actor_email, actor_role, sector, action, target_table,
      target_id, result, ip, device_info, created_at
    FROM audit_log WHERE actor_id = ${id} OR target_id = ${id}::uuid
    ORDER BY created_at DESC LIMIT 200
  `;
  return c.json({ activity: rows });
});

cc.get("/institutions", async (c) => {
  const sector = c.req.query("sector") ?? "";
  if (sector && !isSector(sector)) throw new ApiError(400, "VALIDATION_ERROR", "Unknown sector.");
  const search = (c.req.query("search") ?? "").trim().slice(0, 120);
  const rows = await institutionList(getDb(c.env));
  const filtered = (rows as Record<string, unknown>[]).filter((item) =>
    (!sector || item.sector === sector) &&
    (!search || String(item.name ?? "").toLowerCase().includes(search.toLowerCase())),
  );
  return c.json({ institutions: filtered });
});

async function getInstitution(sql: ReturnType<typeof getDb>, sector: Sector, id: string) {
  switch (sector) {
    case "education": return sql`SELECT id, name, email, phone, address, website, brand_color, logo_base64, created_at FROM schools WHERE id = ${id}`;
    case "mfi": return sql`SELECT id, name, email, phone, address, website, brand_color, logo_base64, created_at FROM mfi_organizations WHERE id = ${id}`;
    case "clinic": return sql`SELECT id, name, email, phone, address, website, brand_color, logo_base64, created_at FROM clinic_organizations WHERE id = ${id}`;
    case "farm": return sql`SELECT id, name, email, phone, address, website, brand_color, logo_base64, created_at FROM farm_organizations WHERE id = ${id}`;
  }
}

cc.get("/institutions/:sector/:id", async (c) => {
  const sector = c.req.param("sector");
  if (!isSector(sector)) throw new ApiError(400, "VALIDATION_ERROR", "Unknown sector.");
  const [rows, branding, state, members] = await Promise.all([
    getInstitution(getDb(c.env), sector, c.req.param("id")),
    getDb(c.env)`SELECT * FROM institution_branding WHERE sector = ${sector} AND institution_id = ${c.req.param("id")}`,
    getDb(c.env)`SELECT status FROM institution_control_state WHERE sector = ${sector} AND institution_id = ${c.req.param("id")}`,
    sector === "education"
      ? getDb(c.env)`SELECT id, name, email, role, sector, is_active FROM users WHERE school_id = ${c.req.param("id")} ORDER BY name LIMIT 200`
      : sector === "mfi"
        ? getDb(c.env)`SELECT u.id, u.name, u.email, u.role, u.sector, u.is_active FROM mfi_officers o JOIN users u ON u.id = o.user_id WHERE o.organization_id = ${c.req.param("id")} ORDER BY u.name LIMIT 200`
        : sector === "clinic"
          ? getDb(c.env)`SELECT u.id, u.name, u.email, u.role, u.sector, u.is_active FROM clinic_staff s JOIN users u ON u.id = s.user_id WHERE s.organization_id = ${c.req.param("id")} ORDER BY u.name LIMIT 200`
          : getDb(c.env)`SELECT u.id, u.name, u.email, u.role, u.sector, u.is_active FROM farm_workers w JOIN users u ON u.id = w.user_id WHERE w.organization_id = ${c.req.param("id")} ORDER BY u.name LIMIT 200`,
  ]);
  if (!rows[0]) throw new ApiError(404, "INSTITUTION_NOT_FOUND", "Institution was not found.");
  return c.json({ institution: rows[0], branding: branding[0] ?? null, status: state[0]?.status ?? "active", members });
});

cc.patch("/institutions/:sector/:id", async (c) => {
  const sector = c.req.param("sector");
  if (!isSector(sector)) throw new ApiError(400, "VALIDATION_ERROR", "Unknown sector.");
  const body = await readJson(c);
  const hasName = typeof body.name === "string";
  const hasEmail = typeof body.email === "string";
  const hasPhone = Object.hasOwn(body, "phone");
  const hasAddress = Object.hasOwn(body, "address");
  const hasWebsite = Object.hasOwn(body, "website");
  const hasColor = typeof body.brand_color === "string";
  const hasLogo = Object.hasOwn(body, "logo_base64");
  const name = hasName ? requiredString(body, "name", { max: 160 }) : null;
  const email = hasEmail ? requiredString(body, "email", { max: 254 }).toLowerCase() : null;
  const phone = hasPhone ? optionalString(body, "phone", { max: 80, allowNull: true }) ?? null : null;
  const address = hasAddress ? optionalString(body, "address", { max: 500, allowNull: true }) ?? null : null;
  const website = hasWebsite ? optionalString(body, "website", { max: 2048, allowNull: true }) ?? null : null;
  const color = hasColor ? requiredString(body, "brand_color", { max: 7 }) : null;
  const logoBase64 = hasLogo ? optionalString(body, "logo_base64", { max: 500000, allowNull: true }) ?? null : null;
  if (![hasName, hasEmail, hasPhone, hasAddress, hasWebsite, hasColor, hasLogo].some(Boolean)) throw new ApiError(400, "VALIDATION_ERROR", "No editable institution fields were provided.");
  if (email && !validEmail(email)) throw new ApiError(400, "VALIDATION_ERROR", "email is invalid.");
  if (color && !/^#[0-9a-f]{6}$/iu.test(color)) throw new ApiError(400, "VALIDATION_ERROR", "brand_color must be a six-digit hex color.");
  if (logoBase64 && !/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\r\n]+$/iu.test(logoBase64)) {
    throw new ApiError(400, "VALIDATION_ERROR", "logo_base64 must be a PNG, JPEG, or WebP data URL.");
  }
  const id = c.req.param("id");
  let rows: Record<string, unknown>[];
  switch (sector) {
    case "education": rows = await getDb(c.env)`UPDATE schools SET name = CASE WHEN ${hasName} THEN ${name} ELSE name END, email = CASE WHEN ${hasEmail} THEN ${email} ELSE email END, phone = CASE WHEN ${hasPhone} THEN ${phone} ELSE phone END, address = CASE WHEN ${hasAddress} THEN ${address} ELSE address END, website = CASE WHEN ${hasWebsite} THEN ${website} ELSE website END, brand_color = CASE WHEN ${hasColor} THEN ${color} ELSE brand_color END WHERE id = ${id} RETURNING id, name`; break;
    case "mfi": rows = await getDb(c.env)`UPDATE mfi_organizations SET name = CASE WHEN ${hasName} THEN ${name} ELSE name END, email = CASE WHEN ${hasEmail} THEN ${email} ELSE email END, phone = CASE WHEN ${hasPhone} THEN ${phone} ELSE phone END, address = CASE WHEN ${hasAddress} THEN ${address} ELSE address END, website = CASE WHEN ${hasWebsite} THEN ${website} ELSE website END, brand_color = CASE WHEN ${hasColor} THEN ${color} ELSE brand_color END WHERE id = ${id} RETURNING id, name`; break;
    case "clinic": rows = await getDb(c.env)`UPDATE clinic_organizations SET name = CASE WHEN ${hasName} THEN ${name} ELSE name END, email = CASE WHEN ${hasEmail} THEN ${email} ELSE email END, phone = CASE WHEN ${hasPhone} THEN ${phone} ELSE phone END, address = CASE WHEN ${hasAddress} THEN ${address} ELSE address END, website = CASE WHEN ${hasWebsite} THEN ${website} ELSE website END, brand_color = CASE WHEN ${hasColor} THEN ${color} ELSE brand_color END WHERE id = ${id} RETURNING id, name`; break;
    case "farm": rows = await getDb(c.env)`UPDATE farm_organizations SET name = CASE WHEN ${hasName} THEN ${name} ELSE name END, email = CASE WHEN ${hasEmail} THEN ${email} ELSE email END, phone = CASE WHEN ${hasPhone} THEN ${phone} ELSE phone END, address = CASE WHEN ${hasAddress} THEN ${address} ELSE address END, website = CASE WHEN ${hasWebsite} THEN ${website} ELSE website END, brand_color = CASE WHEN ${hasColor} THEN ${color} ELSE brand_color END WHERE id = ${id} RETURNING id, name`; break;
  }
  if (!rows[0]) throw new ApiError(404, "INSTITUTION_NOT_FOUND", "Institution was not found.");
  if (hasLogo) {
    switch (sector) {
      case "education": await getDb(c.env)`UPDATE schools SET logo_base64 = ${logoBase64} WHERE id = ${id}`; break;
      case "mfi": await getDb(c.env)`UPDATE mfi_organizations SET logo_base64 = ${logoBase64} WHERE id = ${id}`; break;
      case "clinic": await getDb(c.env)`UPDATE clinic_organizations SET logo_base64 = ${logoBase64} WHERE id = ${id}`; break;
      case "farm": await getDb(c.env)`UPDATE farm_organizations SET logo_base64 = ${logoBase64} WHERE id = ${id}`; break;
    }
  }
  await audit(c, "cc.institution.update", `${sector}_institutions`, id);
  return c.json({ institution: rows[0] });
});

async function setInstitutionStatus(c: Context<AppEnv>, status: "active" | "suspended") {
  const sector = c.req.param("sector") ?? "";
  if (!isSector(sector)) throw new ApiError(400, "VALIDATION_ERROR", "Unknown sector.");
  const id = c.req.param("id") ?? "";
  const institution = await getInstitution(getDb(c.env), sector, id);
  if (!institution[0]) throw new ApiError(404, "INSTITUTION_NOT_FOUND", "Institution was not found.");
  await getDb(c.env)`
    INSERT INTO institution_control_state (sector, institution_id, status, updated_by, updated_at)
    VALUES (${sector}, ${id}, ${status}, ${c.get("user").id}, NOW())
    ON CONFLICT (sector, institution_id) DO UPDATE
    SET status = EXCLUDED.status, updated_by = EXCLUDED.updated_by, updated_at = NOW()
  `;
  await audit(c, `cc.institution.${status}`, `${sector}_institutions`, id);
  return c.json({ id, sector, status });
}
cc.post("/institutions/:sector/:id/suspend", (c) => setInstitutionStatus(c, "suspended"));
cc.post("/institutions/:sector/:id/reactivate", (c) => setInstitutionStatus(c, "active"));

cc.get("/institutions/:sector/:id/stats", async (c) => {
  const sector = c.req.param("sector");
  if (!isSector(sector)) throw new ApiError(400, "VALIDATION_ERROR", "Unknown sector.");
  const id = c.req.param("id");
  const institution = await getInstitution(getDb(c.env), sector, id);
  if (!institution[0]) throw new ApiError(404, "INSTITUTION_NOT_FOUND", "Institution was not found.");
  let stats: Record<string, unknown>;
  switch (sector) {
    case "education": stats = (await getDb(c.env)`SELECT COUNT(*)::int AS users FROM users WHERE school_id = ${id}`)[0] as Record<string, unknown>; break;
    case "mfi": stats = (await getDb(c.env)`SELECT (SELECT COUNT(*) FROM mfi_customers WHERE organization_id = ${id})::int AS customers, (SELECT COUNT(*) FROM mfi_loans WHERE organization_id = ${id})::int AS loans, (SELECT COUNT(*) FROM mfi_officers WHERE organization_id = ${id})::int AS staff`)[0] as Record<string, unknown>; break;
    case "clinic": stats = (await getDb(c.env)`SELECT (SELECT COUNT(*) FROM clinic_patients WHERE organization_id = ${id})::int AS patients, (SELECT COUNT(*) FROM clinic_visits WHERE organization_id = ${id})::int AS visits, (SELECT COUNT(*) FROM clinic_staff WHERE organization_id = ${id})::int AS staff`)[0] as Record<string, unknown>; break;
    case "farm": stats = (await getDb(c.env)`SELECT (SELECT COUNT(*) FROM farm_animals WHERE organization_id = ${id} AND status <> 'deleted')::int AS animals, (SELECT COUNT(*) FROM farm_workers WHERE organization_id = ${id})::int AS workers, (SELECT COUNT(*) FROM farm_sales WHERE organization_id = ${id} AND status IN ('released','closed'))::int AS released_sales`)[0] as Record<string, unknown>; break;
  }
  return c.json({ stats });
});

cc.get("/analytics", async (c) => {
  const from = parseDate(c.req.query("from"), new Date(Date.now() - 29 * 86400000).toISOString());
  const to = parseDate(c.req.query("to"), new Date().toISOString());
  if (new Date(from) > new Date(to)) throw new ApiError(400, "VALIDATION_ERROR", "from must be before to.");
  const sql = getDb(c.env);
  const [users, revenue, revenueBySector, actions, sectors, trends, activity] = await Promise.all([
    sql`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at >= ${from} AND created_at <= ${to})::int AS added FROM users`,
    sql`SELECT COALESCE(SUM(amount), 0)::numeric AS total, currency FROM payments WHERE status IN ('completed','success') AND updated_at >= ${from} AND updated_at <= ${to} GROUP BY currency`,
    sql`SELECT COALESCE(u.sector, 'unassigned') AS sector, COALESCE(SUM(p.amount), 0)::numeric AS total
      FROM payments p LEFT JOIN users u ON u.id = p.user_id
      WHERE p.status IN ('completed','success') AND p.updated_at >= ${from} AND p.updated_at <= ${to}
      GROUP BY COALESCE(u.sector, 'unassigned') ORDER BY total DESC`,
    sql`SELECT action, COUNT(*)::int AS count FROM audit_log WHERE created_at >= ${from} AND created_at <= ${to} GROUP BY action ORDER BY count DESC LIMIT 12`,
    sql`SELECT sector, COUNT(*)::int AS users FROM users GROUP BY sector ORDER BY users DESC`,
    sql`SELECT created_at::date AS day, COUNT(*)::int AS users FROM users WHERE created_at >= ${from} AND created_at <= ${to} GROUP BY day ORDER BY day`,
    sql`SELECT EXTRACT(HOUR FROM created_at)::int AS hour, COUNT(*)::int AS count FROM audit_log WHERE created_at >= ${from} AND created_at <= ${to} GROUP BY hour ORDER BY hour`,
  ]);
  return c.json({ users: users[0], revenue, revenue_by_sector: revenueBySector, top_actions: actions, by_sector: sectors, trends, activity });
});

cc.get("/analytics/export", async (c) => {
  const from = parseDate(c.req.query("from"), new Date(Date.now() - 29 * 86400000).toISOString());
  const to = parseDate(c.req.query("to"), new Date().toISOString());
  const rows = await getDb(c.env)`
    SELECT id, name, email, role, sector, is_active, created_at, last_login
    FROM users WHERE created_at >= ${from} AND created_at <= ${to}
    ORDER BY created_at
  `;
  await audit(c, "cc.analytics.export", "users", null, { from, to, rows: rows.length });
  return csvResponse(rows as Record<string, unknown>[], "apshule-analytics.csv");
});

cc.get("/settings", async (c) => {
  const rows = await getDb(c.env)`SELECT settings, updated_at FROM command_center_settings WHERE id = 1`;
  return c.json({ settings: rows[0]?.settings ?? {
    default_language: "en", timezone: "Africa/Kampala", session_timeout_minutes: 60,
    password_min_length: 8, require_two_factor: false, backup_reminder_days: 30,
  }, active_sessions: "Not tracked" });
});

cc.patch("/settings", async (c) => {
  const body = await readJson(c);
  const allowed = ["default_language", "timezone", "session_timeout_minutes", "password_min_length", "require_two_factor", "backup_reminder_days"];
  const patch: Record<string, unknown> = {};
  for (const key of allowed) if (Object.hasOwn(body, key)) patch[key] = body[key];
  if (!Object.keys(patch).length) throw new ApiError(400, "VALIDATION_ERROR", "No supported settings were provided.");
  if (patch.default_language !== undefined && !["en", "lg", "nyn", "nyo", "ach", "xog", "sw"].includes(String(patch.default_language))) throw new ApiError(400, "VALIDATION_ERROR", "Unsupported default language.");
  if (patch.timezone !== undefined && (typeof patch.timezone !== "string" || patch.timezone.length > 80)) throw new ApiError(400, "VALIDATION_ERROR", "Invalid timezone.");
  for (const [key, min, max] of [["session_timeout_minutes", 5, 1440], ["password_min_length", 8, 128], ["backup_reminder_days", 1, 365]] as const) {
    if (patch[key] !== undefined && (!Number.isInteger(patch[key]) || Number(patch[key]) < min || Number(patch[key]) > max)) throw new ApiError(400, "VALIDATION_ERROR", `Invalid ${key}.`);
  }
  if (patch.require_two_factor !== undefined && typeof patch.require_two_factor !== "boolean") throw new ApiError(400, "VALIDATION_ERROR", "require_two_factor must be boolean.");
  const rows = await getDb(c.env)`
    INSERT INTO command_center_settings (id, settings, updated_by, updated_at)
    VALUES (1, ${JSON.stringify(patch)}::jsonb, ${c.get("user").id}, NOW())
    ON CONFLICT (id) DO UPDATE
    SET settings = command_center_settings.settings || EXCLUDED.settings,
        updated_by = EXCLUDED.updated_by, updated_at = NOW()
    RETURNING settings, updated_at
  `;
  await audit(c, "cc.settings.update", "command_center_settings", null, { changed: Object.keys(patch) });
  return c.json({ settings: rows[0]?.settings });
});

cc.get("/branding/:sector/:institution_id", async (c) => {
  const sector = c.req.param("sector");
  if (!isSector(sector)) throw new ApiError(400, "VALIDATION_ERROR", "Unknown sector.");
  const id = c.req.param("institution_id");
  const rows = await getDb(c.env)`SELECT * FROM institution_branding WHERE sector = ${sector} AND institution_id = ${id}`;
  return c.json({ branding: rows[0] ?? null });
});

cc.patch("/branding/:sector/:institution_id", async (c) => {
  const sector = c.req.param("sector");
  if (!isSector(sector)) throw new ApiError(400, "VALIDATION_ERROR", "Unknown sector.");
  const id = c.req.param("institution_id");
  const body = await readJson(c);
  const fields = ["display_name", "dual_logo_enabled", "appshule_logo_position", "appshule_logo_size", "institution_logo_size", "show_appshule_name", "show_institution_name", "header_bg_color", "header_text_color"] as const;
  const values: Record<string, unknown> = {};
  for (const field of fields) if (Object.hasOwn(body, field)) values[field] = body[field];
  if (!Object.keys(values).length) throw new ApiError(400, "VALIDATION_ERROR", "No branding fields were provided.");
  for (const field of ["dual_logo_enabled", "show_appshule_name", "show_institution_name"] as const) if (values[field] !== undefined && typeof values[field] !== "boolean") throw new ApiError(400, "VALIDATION_ERROR", `${field} must be boolean.`);
  for (const field of ["appshule_logo_size", "institution_logo_size"] as const) if (values[field] !== undefined && (!Number.isInteger(values[field]) || Number(values[field]) < 16 || Number(values[field]) > 120)) throw new ApiError(400, "VALIDATION_ERROR", `Invalid ${field}.`);
  if (values.appshule_logo_position !== undefined && !["left", "right"].includes(String(values.appshule_logo_position))) throw new ApiError(400, "VALIDATION_ERROR", "appshule_logo_position must be left or right.");
  for (const field of ["header_bg_color", "header_text_color"] as const) if (values[field] && !/^#[0-9a-f]{6}$/iu.test(String(values[field]))) throw new ApiError(400, "VALIDATION_ERROR", `Invalid ${field}.`);
  const rows = await getDb(c.env)`
    INSERT INTO institution_branding (
      institution_id, sector, display_name, dual_logo_enabled, appshule_logo_position,
      appshule_logo_size, institution_logo_size, show_appshule_name,
      show_institution_name, header_bg_color, header_text_color, updated_at
    ) VALUES (
      ${id}, ${sector}, ${values.display_name ?? null}, ${values.dual_logo_enabled ?? true},
      ${values.appshule_logo_position ?? "right"}, ${values.appshule_logo_size ?? 32},
      ${values.institution_logo_size ?? 40}, ${values.show_appshule_name ?? true},
      ${values.show_institution_name ?? true}, ${values.header_bg_color ?? null},
      ${values.header_text_color ?? "#FFFFFF"}, NOW()
    )
    ON CONFLICT (institution_id, sector) DO UPDATE SET
      display_name = CASE WHEN ${Object.hasOwn(values, "display_name")} THEN EXCLUDED.display_name ELSE institution_branding.display_name END,
      dual_logo_enabled = CASE WHEN ${Object.hasOwn(values, "dual_logo_enabled")} THEN EXCLUDED.dual_logo_enabled ELSE institution_branding.dual_logo_enabled END,
      appshule_logo_position = CASE WHEN ${Object.hasOwn(values, "appshule_logo_position")} THEN EXCLUDED.appshule_logo_position ELSE institution_branding.appshule_logo_position END,
      appshule_logo_size = CASE WHEN ${Object.hasOwn(values, "appshule_logo_size")} THEN EXCLUDED.appshule_logo_size ELSE institution_branding.appshule_logo_size END,
      institution_logo_size = CASE WHEN ${Object.hasOwn(values, "institution_logo_size")} THEN EXCLUDED.institution_logo_size ELSE institution_branding.institution_logo_size END,
      show_appshule_name = CASE WHEN ${Object.hasOwn(values, "show_appshule_name")} THEN EXCLUDED.show_appshule_name ELSE institution_branding.show_appshule_name END,
      show_institution_name = CASE WHEN ${Object.hasOwn(values, "show_institution_name")} THEN EXCLUDED.show_institution_name ELSE institution_branding.show_institution_name END,
      header_bg_color = CASE WHEN ${Object.hasOwn(values, "header_bg_color")} THEN EXCLUDED.header_bg_color ELSE institution_branding.header_bg_color END,
      header_text_color = CASE WHEN ${Object.hasOwn(values, "header_text_color")} THEN EXCLUDED.header_text_color ELSE institution_branding.header_text_color END,
      updated_at = NOW()
    RETURNING *
  `;
  await audit(c, "cc.branding.update", "institution_branding", id, { sector, changed: Object.keys(values) });
  return c.json({ branding: rows[0] });
});

cc.get("/security/roles", async (c) => {
  const rows = await getDb(c.env)`SELECT role, permission, granted, updated_at FROM role_permissions ORDER BY role, permission`;
  const grouped = Object.fromEntries(roles.map((role) => [role, [] as Record<string, unknown>[]]));
  for (const row of rows as Record<string, unknown>[]) (grouped[String(row.role)] ??= []).push(row);
  return c.json({ roles: grouped });
});

cc.patch("/security/roles/:role", async (c) => {
  const role = c.req.param("role");
  if (!(roles as readonly string[]).includes(role)) throw new ApiError(400, "VALIDATION_ERROR", "Unknown role.");
  const body = await readJson(c);
  if (!Array.isArray(body.permissions) || body.permissions.length > 20) throw new ApiError(400, "VALIDATION_ERROR", "permissions must be an array of at most 20 entries.");
  const changes = body.permissions as unknown[];
  for (const item of changes) {
    if (!item || typeof item !== "object" || !("permission" in item) || !("granted" in item)) throw new ApiError(400, "VALIDATION_ERROR", "Each permission needs permission and granted fields.");
    const permission = (item as Record<string, unknown>).permission;
    const granted = (item as Record<string, unknown>).granted;
    if (typeof permission !== "string" || (!permissionNames.has(permission) && permission !== "*") || typeof granted !== "boolean") throw new ApiError(400, "VALIDATION_ERROR", "Unsupported permission entry.");
    if (role === "superadmin" && permission === "*" && granted !== true) throw new ApiError(400, "VALIDATION_ERROR", "The Super Admin wildcard grant cannot be disabled.");
  }
  const sql = getDb(c.env);
  for (const item of changes as { permission: string; granted: boolean }[]) {
    await sql`
      INSERT INTO role_permissions (role, permission, granted, updated_at)
      VALUES (${role}, ${item.permission}, ${item.granted}, NOW())
      ON CONFLICT (role, permission) DO UPDATE SET granted = EXCLUDED.granted, updated_at = NOW()
    `;
  }
  await audit(c, "cc.role_permissions.update", "role_permissions", null, { role, count: changes.length });
  return c.json({ ok: true, role });
});

cc.get("/security/audit", async (c) => {
  const actorId = c.req.query("actor_id") ?? "";
  const sector = c.req.query("sector") ?? "";
  const action = (c.req.query("action") ?? "").slice(0, 100);
  const from = parseDate(c.req.query("from"), "1970-01-01T00:00:00.000Z");
  const to = parseDate(c.req.query("to"), new Date().toISOString());
  const page = Math.max(1, Math.min(10000, Number(c.req.query("page") ?? 1) || 1));
  const limit = Math.max(1, Math.min(200, Number(c.req.query("limit") ?? 50) || 50));
  const rows = await getDb(c.env)`
    SELECT id, actor_id, actor_email, actor_role, sector, action, target_table,
      target_id, metadata, device_info, result, ip, created_at
    FROM audit_log
    WHERE (${actorId} = '' OR actor_id::text = ${actorId})
      AND (${sector} = '' OR sector = ${sector})
      AND (${action} = '' OR action ILIKE ${`%${action}%`})
      AND created_at >= ${from} AND created_at <= ${to}
    ORDER BY created_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}
  `;
  return c.json({ entries: rows, page, limit });
});

cc.get("/security/audit/export", async (c) => {
  const from = parseDate(c.req.query("from"), "1970-01-01T00:00:00.000Z");
  const to = parseDate(c.req.query("to"), new Date().toISOString());
  const rows = await getDb(c.env)`
    SELECT id, actor_id, actor_email, actor_role, sector, action, target_table,
      target_id, result, ip, created_at FROM audit_log
    WHERE created_at >= ${from} AND created_at <= ${to}
    ORDER BY created_at DESC LIMIT 10000
  `;
  await audit(c, "cc.audit.export", "audit_log", null, { from, to, rows: rows.length });
  return csvResponse(rows as Record<string, unknown>[], "apshule-audit.csv");
});

cc.get("/pdpo/consents", async (c) => {
  const userId = c.req.query("user_id") ?? "";
  const type = c.req.query("consent_type") ?? "";
  const rows = await getDb(c.env)`
    SELECT c.id, c.user_id, u.name, u.email, c.consent_type, c.version,
      c.consented, c.consented_at, c.ip, c.user_agent
    FROM user_consent c LEFT JOIN users u ON u.id = c.user_id
    WHERE (${userId} = '' OR c.user_id::text = ${userId})
      AND (${type} = '' OR c.consent_type = ${type})
    ORDER BY c.consented_at DESC LIMIT 1000
  `;
  return c.json({ consents: rows });
});

cc.get("/pdpo/deletion-requests", async (c) => {
  const status = c.req.query("status") ?? "";
  if (status && !["pending", "approved", "rejected", "completed"].includes(status)) throw new ApiError(400, "VALIDATION_ERROR", "Unknown deletion request status.");
  const rows = await getDb(c.env)`
    SELECT d.*, u.name FROM data_deletion_requests d LEFT JOIN users u ON u.id = d.user_id
    WHERE (${status} = '' OR d.status = ${status})
    ORDER BY d.created_at DESC LIMIT 500
  `;
  return c.json({ requests: rows });
});

cc.patch("/pdpo/deletion-requests/:id", async (c) => {
  const id = c.req.param("id");
  const body = await readJson(c);
  const status = requiredString(body, "status", { max: 20 });
  if (!["approved", "rejected", "completed"].includes(status)) throw new ApiError(400, "VALIDATION_ERROR", "status must be approved, rejected, or completed.");
  const notes = optionalString(body, "admin_notes", { max: 2000, allowNull: true }) ?? null;
  let scheduledFor: string | null = null;
  if (body.scheduled_for !== undefined && body.scheduled_for !== null && body.scheduled_for !== "") {
    scheduledFor = parseDate(String(body.scheduled_for), "");
  }
  const sql = getDb(c.env);
  const existing = await sql`SELECT * FROM data_deletion_requests WHERE id = ${id}`;
  const request = existing[0] as Record<string, unknown> | undefined;
  if (!request) throw new ApiError(404, "DELETION_REQUEST_NOT_FOUND", "Deletion request was not found.");
  if (status === "approved" || status === "rejected") {
    if (request.status !== "pending") throw new ApiError(409, "INVALID_TRANSITION", "Only pending requests can be approved or rejected.");
    const updated = await sql`
      UPDATE data_deletion_requests SET status = ${status}, reviewed_by = ${c.get("user").id},
        reviewed_at = NOW(), admin_notes = ${notes},
        scheduled_for = CASE WHEN ${status} = 'approved' THEN ${scheduledFor}::timestamptz ELSE NULL END
      WHERE id = ${id} RETURNING *
    `;
    await audit(c, `cc.pdpo.deletion.${status}`, "data_deletion_requests", id);
    if (status === "approved" && request.user_email) c.executionCtx.waitUntil(sendEmail(c.env, {
      to: String(request.user_email), subject: "Your APSHULE data deletion request",
      html: `<p>Your data deletion request has been approved${scheduledFor ? ` and is scheduled for ${new Date(scheduledFor).toLocaleDateString("en-UG")}` : ""}. Contact legal@appshule.com if you have questions.</p>`,
    }));
    return c.json({ request: updated[0] });
  }
  if (request.status !== "approved") throw new ApiError(409, "INVALID_TRANSITION", "Only approved requests can be completed.");
  if (request.scheduled_for && new Date(String(request.scheduled_for)).getTime() > Date.now()) {
    throw new ApiError(409, "DELETION_NOT_DUE", "This request is scheduled for a future date.");
  }
  if (!request.user_id) throw new ApiError(409, "USER_NOT_AVAILABLE", "The account linked to this request is unavailable.");
  const userId = String(request.user_id);
  const deletedEmail = `deleted+${userId}@appshule.com`;
  const done = await sql`
    WITH anonymized AS (
      UPDATE users SET
        name = 'Deleted User', email = ${deletedEmail}, phone = NULL,
        address = NULL, gender = NULL, date_of_birth = NULL, profile_pic = NULL,
        avatar_base64 = NULL, bio = NULL, lin = NULL, detected_location = NULL,
        is_active = FALSE, session_version = session_version + 1,
        password_hash = 'disabled$account-anonymized', updated_at = NOW()
      WHERE id = ${userId}
      RETURNING id
    )
    UPDATE data_deletion_requests SET status = 'completed', completed_at = NOW(),
      reviewed_by = ${c.get("user").id}, reviewed_at = NOW(),
      user_email = ${deletedEmail}, admin_notes = ${notes}
    WHERE id = ${id} AND status = 'approved' AND EXISTS (SELECT 1 FROM anonymized)
    RETURNING *
  `;
  if (!done[0]) throw new ApiError(409, "ANONYMIZATION_FAILED", "The account could not be anonymized.");
  await audit(c, "cc.pdpo.deletion.completed", "data_deletion_requests", id, { user_id: userId });
  return c.json({ request: done[0], anonymized: true });
});

cc.get("/pdpo/export-all", async (c) => {
  const userId = c.req.query("user_id");
  if (!userId) throw new ApiError(400, "VALIDATION_ERROR", "user_id is required.");
  const sql = getDb(c.env);
  const [profile, consents, requests, activity] = await Promise.all([
    sql`SELECT id, name, email, phone, role, sector, school_id, education_level,
      class_level, subjects_taught, assigned_classes, lin, gender, address,
      profile_pic, avatar_base64, bio, date_of_birth, created_at, last_login,
      detected_location, is_active FROM users WHERE id = ${userId}`,
    sql`SELECT consent_type, version, consented, consented_at, ip, user_agent FROM user_consent WHERE user_id = ${userId} ORDER BY consented_at`,
    sql`SELECT id, reason, status, reviewed_at, scheduled_for, completed_at, created_at FROM data_deletion_requests WHERE user_id = ${userId} ORDER BY created_at`,
    sql`SELECT id, sector, action, target_table, target_id, metadata, result, created_at FROM audit_log WHERE actor_id = ${userId} ORDER BY created_at DESC LIMIT 5000`,
  ]);
  if (!profile[0]) throw new ApiError(404, "USER_NOT_FOUND", "User was not found.");
  await audit(c, "cc.pdpo.export", "users", userId);
  return c.json({ exported_at: new Date().toISOString(), profile: profile[0], consents, deletion_requests: requests, activity });
});

cc.get("/announcements", async (c) => {
  const rows = await getDb(c.env)`SELECT * FROM announcements ORDER BY created_at DESC LIMIT 500`;
  return c.json({ announcements: rows });
});

cc.post("/announcements", async (c) => {
  const body = await readJson(c);
  const targetType = requiredString(body, "target_type", { max: 20 });
  if (!["global", "sector", "institution", "role"].includes(targetType)) throw new ApiError(400, "VALIDATION_ERROR", "Invalid announcement target_type.");
  const targetSector = optionalString(body, "target_sector", { max: 30 }) ?? null;
  const targetRole = optionalString(body, "target_role", { max: 30 }) ?? null;
  const institutionId = optionalString(body, "target_institution_id", { max: 36 }) ?? null;
  const title = requiredString(body, "title", { max: 160 });
  const message = requiredString(body, "body", { max: 5000 });
  const severity = body.severity === undefined ? "info" : requiredString(body, "severity", { max: 12 });
  if (!["info", "warning", "urgent"].includes(severity)) throw new ApiError(400, "VALIDATION_ERROR", "Invalid severity.");
  if (targetType === "sector" && (!targetSector || !(sectors as readonly string[]).includes(targetSector))) throw new ApiError(400, "VALIDATION_ERROR", "A valid target_sector is required.");
  if (targetType === "role" && (!targetRole || !(roles as readonly string[]).includes(targetRole))) throw new ApiError(400, "VALIDATION_ERROR", "A valid target_role is required.");
  if (targetType === "institution" && !institutionId) throw new ApiError(400, "VALIDATION_ERROR", "target_institution_id is required.");
  const startsAt = body.starts_at ? parseDate(String(body.starts_at), "") : new Date().toISOString();
  const endsAt = body.ends_at ? parseDate(String(body.ends_at), "") : null;
  if (endsAt && new Date(endsAt) <= new Date(startsAt)) throw new ApiError(400, "VALIDATION_ERROR", "ends_at must be after starts_at.");
  const rows = await getDb(c.env)`
    INSERT INTO announcements (created_by, target_type, target_sector, target_institution_id,
      target_role, title, body, severity, starts_at, ends_at)
    VALUES (${c.get("user").id}, ${targetType}, ${targetSector}, ${institutionId},
      ${targetRole}, ${title}, ${message}, ${severity}, ${startsAt}, ${endsAt})
    RETURNING *
  `;
  await audit(c, "cc.announcement.create", "announcements", String((rows[0] as Record<string, unknown>).id));
  return c.json({ announcement: rows[0] }, 201);
});

cc.patch("/announcements/:id", async (c) => {
  const id = c.req.param("id");
  const body = await readJson(c);
  const hasTitle = Object.hasOwn(body, "title");
  const hasBody = Object.hasOwn(body, "body");
  const hasSeverity = Object.hasOwn(body, "severity");
  const hasActive = Object.hasOwn(body, "active");
  const title = hasTitle ? requiredString(body, "title", { max: 160 }) : null;
  const message = hasBody ? requiredString(body, "body", { max: 5000 }) : null;
  const severity = hasSeverity ? requiredString(body, "severity", { max: 12 }) : null;
  if (severity && !["info", "warning", "urgent"].includes(severity)) throw new ApiError(400, "VALIDATION_ERROR", "Invalid severity.");
  if (hasActive && typeof body.active !== "boolean") throw new ApiError(400, "VALIDATION_ERROR", "active must be boolean.");
  const rows = await getDb(c.env)`
    UPDATE announcements SET title = CASE WHEN ${hasTitle} THEN ${title} ELSE title END,
      body = CASE WHEN ${hasBody} THEN ${message} ELSE body END,
      severity = CASE WHEN ${hasSeverity} THEN ${severity} ELSE severity END,
      active = CASE WHEN ${hasActive} THEN ${body.active === true} ELSE active END
    WHERE id = ${id} RETURNING *
  `;
  if (!rows[0]) throw new ApiError(404, "ANNOUNCEMENT_NOT_FOUND", "Announcement was not found.");
  await audit(c, "cc.announcement.update", "announcements", id);
  return c.json({ announcement: rows[0] });
});

cc.delete("/announcements/:id", async (c) => {
  const id = c.req.param("id");
  const rows = await getDb(c.env)`UPDATE announcements SET active = FALSE WHERE id = ${id} RETURNING id`;
  if (!rows[0]) throw new ApiError(404, "ANNOUNCEMENT_NOT_FOUND", "Announcement was not found.");
  await audit(c, "cc.announcement.archive", "announcements", id);
  return c.json({ ok: true, id });
});

async function announcementTarget(c: Context<AppEnv>) {
  const user = c.get("user");
  const sql = getDb(c.env);
  let institutionId: string | null = user.schoolId;
  if (!institutionId && user.sector === "mfi") institutionId = ((await sql`SELECT organization_id AS id FROM mfi_officers WHERE user_id = ${user.id} LIMIT 1`)[0] as { id?: string } | undefined)?.id ?? ((await sql`SELECT id FROM mfi_organizations WHERE created_by = ${user.id} LIMIT 1`)[0] as { id?: string } | undefined)?.id ?? null;
  if (!institutionId && user.sector === "clinic") institutionId = ((await sql`SELECT organization_id AS id FROM clinic_staff WHERE user_id = ${user.id} LIMIT 1`)[0] as { id?: string } | undefined)?.id ?? ((await sql`SELECT id FROM clinic_organizations WHERE created_by = ${user.id} LIMIT 1`)[0] as { id?: string } | undefined)?.id ?? null;
  if (!institutionId && user.sector === "farm") institutionId = ((await sql`SELECT organization_id AS id FROM farm_workers WHERE user_id = ${user.id} LIMIT 1`)[0] as { id?: string } | undefined)?.id ?? ((await sql`SELECT id FROM farm_organizations WHERE created_by = ${user.id} LIMIT 1`)[0] as { id?: string } | undefined)?.id ?? null;
  return { user, institutionId };
}

publicAnnouncements.get("/announcements/active", authMiddleware, async (c) => {
  const { user, institutionId } = await announcementTarget(c);
  const rows = await getDb(c.env)`
    SELECT id, target_type, title, body, severity, starts_at, ends_at, created_at
    FROM announcements WHERE active IS TRUE
      AND starts_at <= NOW() AND (ends_at IS NULL OR ends_at > NOW())
      AND NOT (${user.id} = ANY(dismissed_by))
      AND (
        target_type = 'global'
        OR (target_type = 'sector' AND target_sector = ${user.sector})
        OR (target_type = 'role' AND target_role = ${user.role})
        OR (target_type = 'institution' AND target_institution_id = ${institutionId})
      )
    ORDER BY CASE severity WHEN 'urgent' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC
  `;
  return c.json({ announcements: rows });
});

userCompliance.get("/branding/current", authMiddleware, async (c) => {
  const { user, institutionId } = await announcementTarget(c);
  if (!institutionId || !isSector(user.sector)) return c.json({ branding: null });
  const [details, branding] = await Promise.all([
    getInstitution(getDb(c.env), user.sector, institutionId),
    getDb(c.env)`SELECT * FROM institution_branding WHERE sector = ${user.sector} AND institution_id = ${institutionId}`,
  ]);
  if (!details[0] || !branding[0] || branding[0].dual_logo_enabled !== true) return c.json({ branding: null });
  return c.json({
    branding: {
      ...(branding[0] as Record<string, unknown>),
      display_name: branding[0]?.display_name ?? details[0].name,
      logo: details[0].logo_base64 ?? null,
      brand_color: details[0].brand_color ?? null,
      institution_name: details[0].name,
      sector: user.sector,
    },
  });
});

publicAnnouncements.post("/announcements/:id/dismiss", authMiddleware, async (c) => {
  const announcementId = c.req.param("id");
  const rows = await getDb(c.env)`
    UPDATE announcements SET dismissed_by = array_append(dismissed_by, ${c.get("user").id}::uuid)
    WHERE id = ${announcementId} AND active IS TRUE
      AND NOT (${c.get("user").id} = ANY(dismissed_by))
    RETURNING id
  `;
  if (rows[0]) await audit(c, "announcement.dismiss", "announcements", announcementId);
  return c.json({ ok: true, dismissed: Boolean(rows[0]) });
});

userCompliance.get("/status", authMiddleware, async (c) => {
  const rows = await getDb(c.env)`
    SELECT consent_type, version, consented, consented_at
    FROM user_consent WHERE user_id = ${c.get("user").id}
      AND consented IS TRUE
      AND (
        (consent_type = 'tos' AND version = ${TOS_VERSION})
        OR (consent_type IN ('privacy', 'data_processing') AND version = ${PRIVACY_VERSION})
      )
  `;
  const accepted = new Set((rows as { consent_type: string }[]).map((row) => row.consent_type));
  return c.json({
    required: !accepted.has("tos") || !accepted.has("privacy") || !accepted.has("data_processing"),
    tos: accepted.has("tos"),
    privacy: accepted.has("privacy"),
    data_processing: accepted.has("data_processing"),
    versions: { tos: TOS_VERSION, privacy: PRIVACY_VERSION },
  });
});

userCompliance.post("/accept", authMiddleware, async (c) => {
  const body = await readJson(c);
  if (body.tosAccepted !== true || body.privacyAccepted !== true) {
    throw new ApiError(400, "CONSENT_REQUIRED", "Accept both the Terms of Service and Privacy Policy to continue.");
  }
  const user = c.get("user");
  const sql = getDb(c.env);
  await sql`
    INSERT INTO user_consent (user_id, consent_type, version, consented, ip, user_agent)
    VALUES
      (${user.id}, 'tos', ${TOS_VERSION}, TRUE, ${ipFrom(c)}, ${c.req.header("User-Agent") ?? null}),
      (${user.id}, 'privacy', ${PRIVACY_VERSION}, TRUE, ${ipFrom(c)}, ${c.req.header("User-Agent") ?? null}),
      (${user.id}, 'data_processing', ${PRIVACY_VERSION}, TRUE, ${ipFrom(c)}, ${c.req.header("User-Agent") ?? null})
    ON CONFLICT (user_id, consent_type, version) DO UPDATE
    SET consented = TRUE, consented_at = NOW(), ip = EXCLUDED.ip,
        user_agent = EXCLUDED.user_agent
  `;
  await audit(c, "consent.accept", "user_consent", null, { versions: { tos: TOS_VERSION, privacy: PRIVACY_VERSION } });
  return c.json({ ok: true, versions: { tos: TOS_VERSION, privacy: PRIVACY_VERSION } });
});

userCompliance.post("/deletion-requests", authMiddleware, async (c) => {
  const body = await readJson(c);
  const reason = optionalString(body, "reason", { max: 2000, allowNull: true }) ?? null;
  const user = c.get("user");
  const sql = getDb(c.env);
  const rows = await sql`
    INSERT INTO data_deletion_requests (user_id, user_email, reason)
    VALUES (${user.id}, ${user.email}, ${reason})
    ON CONFLICT (user_id) WHERE status IN ('pending', 'approved') DO NOTHING
    RETURNING id, status, created_at
  `;
  if (!rows[0]) {
    const existing = await sql`
      SELECT id, status, created_at FROM data_deletion_requests
      WHERE user_id = ${user.id} AND status IN ('pending', 'approved')
      ORDER BY created_at DESC LIMIT 1
    `;
    return c.json({ request: existing[0], already_open: true }, 200);
  }
  await audit(c, "pdpo.deletion.requested", "data_deletion_requests", String((rows[0] as Record<string, unknown>).id));
  return c.json({ request: rows[0] }, 201);
});

userCompliance.get("/deletion-requests", authMiddleware, async (c) => {
  const rows = await getDb(c.env)`
    SELECT id, reason, status, reviewed_at, scheduled_for, completed_at, created_at
    FROM data_deletion_requests WHERE user_id = ${c.get("user").id}
    ORDER BY created_at DESC LIMIT 50
  `;
  return c.json({ requests: rows });
});

cc.post("/communicate/email", async (c) => {
  const body = await readJson(c);
  if (!body.target || typeof body.target !== "object" || Array.isArray(body.target)) throw new ApiError(400, "VALIDATION_ERROR", "target is required.");
  const target = body.target as Record<string, unknown>;
  const subject = requiredString(body, "subject", { max: 200 });
  const message = requiredString(body, "message", { max: 10000 });
  const type = typeof target.type === "string" ? target.type : "";
  if (!["global", "sector", "role", "institution", "users"].includes(type)) throw new ApiError(400, "VALIDATION_ERROR", "Unsupported target type.");
  let recipients: { email: string; name: string }[] = [];
  const sql = getDb(c.env);
  if (type === "global") recipients = await sql`SELECT email, name FROM users WHERE is_active IS TRUE LIMIT 500` as { email: string; name: string }[];
  else if (type === "sector") {
    const sector = String(target.sector ?? "");
    if (!(sectors as readonly string[]).includes(sector)) throw new ApiError(400, "VALIDATION_ERROR", "Invalid target sector.");
    recipients = await sql`SELECT email, name FROM users WHERE is_active IS TRUE AND sector = ${sector} LIMIT 500` as { email: string; name: string }[];
  } else if (type === "role") {
    const role = String(target.role ?? "");
    if (!(roles as readonly string[]).includes(role)) throw new ApiError(400, "VALIDATION_ERROR", "Invalid target role.");
    recipients = await sql`SELECT email, name FROM users WHERE is_active IS TRUE AND role = ${role} LIMIT 500` as { email: string; name: string }[];
  } else if (type === "institution") {
    const sector = String(target.sector ?? "");
    const id = String(target.institution_id ?? "");
    if (!isSector(sector) || !id) throw new ApiError(400, "VALIDATION_ERROR", "Valid institution_id and sector are required.");
    if (sector === "education") recipients = await sql`SELECT email, name FROM users WHERE school_id = ${id} AND is_active IS TRUE LIMIT 500` as { email: string; name: string }[];
    else if (sector === "mfi") recipients = await sql`SELECT u.email, u.name FROM users u JOIN mfi_officers o ON o.user_id = u.id WHERE o.organization_id = ${id} AND u.is_active IS TRUE LIMIT 500` as { email: string; name: string }[];
    else if (sector === "clinic") recipients = await sql`SELECT u.email, u.name FROM users u JOIN clinic_staff st ON st.user_id = u.id WHERE st.organization_id = ${id} AND u.is_active IS TRUE LIMIT 500` as { email: string; name: string }[];
    else recipients = await sql`SELECT u.email, u.name FROM users u JOIN farm_workers w ON w.user_id = u.id WHERE w.organization_id = ${id} AND u.is_active IS TRUE LIMIT 500` as { email: string; name: string }[];
  } else {
    if (!Array.isArray(target.user_ids) || target.user_ids.length < 1 || target.user_ids.length > 200) throw new ApiError(400, "VALIDATION_ERROR", "user_ids must contain 1–200 IDs.");
    const ids = target.user_ids.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/iu.test(id));
    if (!ids.length) throw new ApiError(400, "VALIDATION_ERROR", "No valid user IDs were supplied.");
    recipients = await sql`SELECT email, name FROM users WHERE id = ANY(${ids}::uuid[]) AND is_active IS TRUE` as { email: string; name: string }[];
  }
  const safe = message.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  let sent = 0;
  for (const recipient of recipients) {
    if (await sendEmail(c.env, { to: recipient.email, subject, html: `<p>Hello ${recipient.name.replace(/[&<>"']/gu, "")},</p><p>${safe.replaceAll("\n", "<br>")}</p>` })) sent += 1;
  }
  await audit(c, "cc.communication.email", "users", null, { type, requested: recipients.length, sent });
  return c.json({ requested: recipients.length, sent, failed: recipients.length - sent });
});

cc.post("/communicate/inapp", async (c) => {
  const body = await readJson(c);
  const target = body.target && typeof body.target === "object" ? body.target as Record<string, unknown> : {};
  const targetType = String(target.type ?? "global");
  if (!["global", "sector", "role", "institution"].includes(targetType)) throw new ApiError(400, "VALIDATION_ERROR", "Unsupported target type.");
  const title = requiredString(body, "title", { max: 160 });
  const message = requiredString(body, "message", { max: 5000 });
  const severity = body.severity === undefined ? "info" : requiredString(body, "severity", { max: 12 });
  if (!["info", "warning", "urgent"].includes(severity)) throw new ApiError(400, "VALIDATION_ERROR", "Invalid severity.");
  const sector = target.sector === undefined ? null : String(target.sector);
  const role = target.role === undefined ? null : String(target.role);
  const institutionId = target.institution_id === undefined ? null : String(target.institution_id);
  const rows = await getDb(c.env)`
    INSERT INTO announcements (created_by, target_type, target_sector, target_role,
      target_institution_id, title, body, severity)
    VALUES (${c.get("user").id}, ${targetType}, ${sector}, ${role}, ${institutionId}, ${title}, ${message}, ${severity})
    RETURNING id, target_type, title, severity, created_at
  `;
  await audit(c, "cc.communication.inapp", "announcements", String((rows[0] as Record<string, unknown>).id));
  return c.json({ announcement: rows[0], push: "not_configured" }, 201);
});

export {
  cc as commandCenterRouter,
  publicAnnouncements as publicAnnouncementsRouter,
  userCompliance as userComplianceRouter,
};
