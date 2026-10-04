import { Hono, type Context } from "hono";
import { ApiError, getDb } from "../db.js";
import { authMiddleware, requireRole } from "../auth.js";
import { emptyToNull, optionalDate, optionalImageBase64 } from "../profile-validation.js";
import { optionalString, readJson, validEmail } from "../http.js";
import type { AppEnv } from "../types.js";

const schoolBranding = new Hono<AppEnv>();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requestIp(c: Context<AppEnv>): string | null {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    null
  )?.slice(0, 255) ?? null;
}

function schoolIdFor(c: Context<AppEnv>): string {
  const user = c.get("user");
  if (!user.schoolId) {
    throw new ApiError(403, "SCHOOL_ACCOUNT_REQUIRED", "This account is not linked to a school.");
  }
  return user.schoolId;
}

function assertNotImpersonated(c: Context<AppEnv>): void {
  if (c.get("user").impersonatedBy) {
    throw new ApiError(
      403,
      "IMPERSONATION_FORBIDDEN",
      "School branding cannot be changed during an impersonation session.",
    );
  }
}

function optionalFees(body: Record<string, unknown>): number | null | undefined {
  if (!("next_term_fees" in body)) return undefined;
  const value = body.next_term_fees;
  if (value === null || value === "") return null;
  const amount = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) {
    throw new ApiError(400, "VALIDATION_ERROR", "next_term_fees must be a non-negative amount.");
  }
  return amount;
}

function optionalWebsite(body: Record<string, unknown>): string | null | undefined {
  const value = emptyToNull(optionalString(body, "website", { max: 500, allowNull: true }));
  if (value === undefined || value === null) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
    return url.toString();
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", "website must be a valid HTTP or HTTPS URL.");
  }
}

function optionalBrandColor(body: Record<string, unknown>): string | null | undefined {
  const value = optionalString(body, "brand_color", { max: 7, allowNull: true });
  if (value === undefined) return undefined;
  if (value === null || value === "") return "#4B2E9E";
  if (!/^#[0-9a-f]{6}$/iu.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", "brand_color must be a hex color in #RRGGBB format.");
  }
  return value.toUpperCase();
}

schoolBranding.get("/branding", async (c) => {
  const schoolId = c.req.query("school_id");
  if (!schoolId || !uuidPattern.test(schoolId)) {
    throw new ApiError(400, "VALIDATION_ERROR", "school_id must be a valid UUID.");
  }
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT name, logo_base64, COALESCE(brand_color, '#4B2E9E') AS brand_color,
      motto, phone, email, website
    FROM schools
    WHERE id = ${schoolId}
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(404, "SCHOOL_NOT_FOUND", "School was not found.");
  return c.json({ branding: rows[0] }, 200, {
    "Cache-Control": "no-store",
  });
});

schoolBranding.get("/me", authMiddleware, requireRole("school"), async (c) => {
  const schoolId = schoolIdFor(c);
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, name, contact, location, logo, brand_color, motto, address, phone,
      email, website, term_ended_on, next_term_begins_on, next_term_fees,
      logo_base64, login_email, login_count, created_at
    FROM schools
    WHERE id = ${schoolId}
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(404, "SCHOOL_NOT_FOUND", "School was not found.");
  return c.json({ school: rows[0] });
});

schoolBranding.patch("/me", authMiddleware, requireRole("school"), async (c) => {
  assertNotImpersonated(c);
  const schoolId = schoolIdFor(c);
  const body = await readJson(c);
  const name = optionalString(body, "name", { max: 160 });
  const motto = emptyToNull(optionalString(body, "motto", { max: 200, allowNull: true }));
  const address = emptyToNull(optionalString(body, "address", { max: 300, allowNull: true }));
  const phone = emptyToNull(optionalString(body, "phone", { max: 40, allowNull: true }));
  const emailInput = emptyToNull(optionalString(body, "email", { max: 254, allowNull: true }));
  const website = optionalWebsite(body);
  const brandColor = optionalBrandColor(body);
  const termEndedOn = optionalDate(body, "term_ended_on");
  const nextTermBeginsOn = optionalDate(body, "next_term_begins_on");
  const nextTermFees = optionalFees(body);
  const logoBase64 = optionalImageBase64(body, "logo_base64", 300 * 1024);

  if (typeof name === "string" && !name.trim()) {
    throw new ApiError(400, "VALIDATION_ERROR", "name cannot be empty.");
  }
  const email = emailInput?.toLowerCase();
  if (email && !validEmail(email)) {
    throw new ApiError(400, "VALIDATION_ERROR", "email must be a valid email address.");
  }

  const changedFields = [
    ["name", name],
    ["motto", motto],
    ["address", address],
    ["phone", phone],
    ["email", emailInput],
    ["website", website],
    ["brand_color", brandColor],
    ["term_ended_on", termEndedOn],
    ["next_term_begins_on", nextTermBeginsOn],
    ["next_term_fees", nextTermFees],
    ["logo_base64", logoBase64],
  ].filter(([, value]) => value !== undefined).map(([key]) => key);
  if (changedFields.length === 0) {
    throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one school field to update.");
  }

  const sql = getDb(c.env);
  const rows = await sql`
    WITH updated_school AS (
      UPDATE schools
      SET
        name = CASE WHEN ${name !== undefined} THEN ${name ?? null} ELSE name END,
        motto = CASE WHEN ${motto !== undefined} THEN ${motto ?? null} ELSE motto END,
        address = CASE WHEN ${address !== undefined} THEN ${address ?? null} ELSE address END,
        phone = CASE WHEN ${phone !== undefined} THEN ${phone ?? null} ELSE phone END,
        email = CASE WHEN ${emailInput !== undefined} THEN ${email ?? null} ELSE email END,
        website = CASE WHEN ${website !== undefined} THEN ${website ?? null} ELSE website END,
        brand_color = CASE WHEN ${brandColor !== undefined} THEN ${brandColor ?? '#4B2E9E'} ELSE COALESCE(brand_color, '#4B2E9E') END,
        term_ended_on = CASE WHEN ${termEndedOn !== undefined} THEN ${termEndedOn ?? null} ELSE term_ended_on END,
        next_term_begins_on = CASE WHEN ${nextTermBeginsOn !== undefined} THEN ${nextTermBeginsOn ?? null} ELSE next_term_begins_on END,
        next_term_fees = CASE WHEN ${nextTermFees !== undefined} THEN ${nextTermFees ?? null} ELSE next_term_fees END,
        logo_base64 = CASE WHEN ${logoBase64 !== undefined} THEN ${logoBase64 ?? null} ELSE logo_base64 END
      WHERE id = ${schoolId}
      RETURNING id, name, contact, location, logo, brand_color, motto, address, phone,
        email, website, term_ended_on, next_term_begins_on, next_term_fees,
        logo_base64, login_email, login_count, created_at
    ),
    audit_event AS (
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT
        ${c.get("user").id}, ${c.get("user").sector}, 'school_branding_updated',
        'schools', s.id,
        ${JSON.stringify({ changed_fields: changedFields })}::jsonb,
        ${requestIp(c)}
      FROM updated_school s
      RETURNING id
    )
    SELECT * FROM updated_school
  `;
  if (!rows[0]) throw new ApiError(404, "SCHOOL_NOT_FOUND", "School was not found.");
  return c.json({ school: rows[0] });
});

export default schoolBranding;