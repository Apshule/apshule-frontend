import { Hono } from "hono";
import type { Context } from "hono";
import { getDb } from "../db.js";
import { authMiddleware, requireRealSuperAdmin } from "../auth.js";
import { readJson } from "../http.js";
import { getRoleGuide } from "../user-guide.js";
import type { AppEnv } from "../types.js";

type AuthenticatedUser = {
  id: string;
  name?: string;
  email?: string;
  role: string;
  sector?: string | null;
  impersonatedBy?: string | null;
};

type JsonRecord = Record<string, unknown>;
const routes = new Hono<AppEnv>();
const languages = new Set(["en", "lg", "xog", "nyn", "nyo", "ach", "sw"]);
const dataSaverModes = new Set(["auto", "always", "wifi_only", "off"]);
const themes = new Set(["auto", "light", "dark"]);
const reportStatuses = new Set(["open", "in_progress", "resolved", "wont_fix"]);
const severities = new Set(["low", "medium", "high", "critical"]);

function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
const sectors = new Set(["education", "mfi", "clinic", "farm"]);
const categories = new Set(["bug", "suggestion", "account", "sync", "other"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const maxScreenshotBytes = 500 * 1024;

function actor(c: Context<AppEnv>): AuthenticatedUser {
  return c.get("user") as AuthenticatedUser;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function parseJson(c: Context<AppEnv>): Promise<JsonRecord | null> {
  try {
    const value = await readJson(c);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function base64Bytes(value: string): number | null {
  const dataUrlMatch = value.match(/^data:image\/(?:png|jpe?g|webp);base64,([a-z0-9+/]*={0,2})$/iu);
  const encoded = dataUrlMatch ? dataUrlMatch[1] : value;
  if (!encoded || !/^[a-z0-9+/]*={0,2}$/iu.test(encoded) || encoded.length % 4 !== 0) return null;
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  return Math.max(0, (encoded.length * 3) / 4 - padding);
}

function safePageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function safeDeviceInfo(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const allowedKeys = ["userAgent", "platform", "language", "screen", "connection"];
  const result: Record<string, string> = {};
  for (const key of allowedKeys) {
    const item = value[key];
    if (typeof item === "string") result[key] = item.slice(0, 500);
  }
  return JSON.stringify(result).length <= 5000 ? result : null;
}

function positiveInteger(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) return null;
  return value as number;
}

routes.get("/user/preferences", authMiddleware, async (c) => {
  const user = actor(c);
  const sql = getDb(c.env);
  await sql`
    INSERT INTO user_preferences (user_id)
    VALUES (${user.id})
    ON CONFLICT (user_id) DO NOTHING
  `;
  const rows = await sql`
    SELECT id, user_id, language, data_saver, theme, notifications_enabled,
      timezone, settings, updated_at
    FROM user_preferences
    WHERE user_id = ${user.id}
    LIMIT 1
  `;
  return c.json(rows[0] ?? null);
});

routes.patch("/user/preferences", authMiddleware, async (c) => {
  const body = await parseJson(c);
  if (!body) return c.json({ error: "A JSON object is required." }, 400);
  const allowed = new Set(["language", "data_saver", "theme", "notifications_enabled", "timezone"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return c.json({ error: "Only language, data_saver, theme, notifications_enabled, and timezone can be updated." }, 400);
  }
  if (!Object.keys(body).length) return c.json({ error: "At least one preference is required." }, 400);
  if (body.language !== undefined && (typeof body.language !== "string" || !languages.has(body.language))) {
    return c.json({ error: "Unsupported language." }, 400);
  }
  if (body.data_saver !== undefined && (typeof body.data_saver !== "string" || !dataSaverModes.has(body.data_saver))) {
    return c.json({ error: "Unsupported data saver mode." }, 400);
  }
  if (body.theme !== undefined && (typeof body.theme !== "string" || !themes.has(body.theme))) {
    return c.json({ error: "Unsupported theme." }, 400);
  }
  if (body.notifications_enabled !== undefined && typeof body.notifications_enabled !== "boolean") {
    return c.json({ error: "notifications_enabled must be a boolean." }, 400);
  }
  if (body.timezone !== undefined && !isValidTimeZone(body.timezone)) {
    return c.json({ error: "timezone must be a valid IANA time zone." }, 400);
  }

  const user = actor(c);
  const language = (body.language as string | undefined) ?? null;
  const dataSaver = (body.data_saver as string | undefined) ?? null;
  const theme = (body.theme as string | undefined) ?? null;
  const notificationsEnabled = (body.notifications_enabled as boolean | undefined) ?? null;
  const timezone = (body.timezone as string | undefined) ?? null;
  const sql = getDb(c.env);
  const rows = await sql`
    INSERT INTO user_preferences (
      user_id, language, data_saver, theme, notifications_enabled, timezone, settings, updated_at
    )
    VALUES (
      ${user.id}, ${language ?? "en"}, ${dataSaver ?? "auto"}, ${theme ?? "auto"},
      ${notificationsEnabled ?? true}, ${timezone ?? "Africa/Kampala"}, '{}'::jsonb, NOW()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      language = COALESCE(${language}, user_preferences.language),
      data_saver = COALESCE(${dataSaver}, user_preferences.data_saver),
      theme = COALESCE(${theme}, user_preferences.theme),
      notifications_enabled = COALESCE(${notificationsEnabled}, user_preferences.notifications_enabled),
      timezone = COALESCE(${timezone}, user_preferences.timezone),
      updated_at = NOW()
    RETURNING id, user_id, language, data_saver, theme, notifications_enabled,
      timezone, settings, updated_at
  `;
  return c.json(rows[0] ?? null);
});

routes.post("/user/bug-report", authMiddleware, async (c) => {
  const body = await parseJson(c);
  if (!body) return c.json({ error: "A JSON object is required." }, 400);
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (title.length < 5 || title.length > 100) {
    return c.json({ error: "Title must contain 5 to 100 characters." }, 400);
  }
  if (description.length < 10 || description.length > 2000) {
    return c.json({ error: "Description must contain 10 to 2000 characters." }, 400);
  }
  const category = body.category === undefined ? "bug" : body.category;
  if (typeof category !== "string" || !categories.has(category)) {
    return c.json({ error: "Unsupported report category." }, 400);
  }
  const severity = body.severity === undefined ? "medium" : body.severity;
  if (typeof severity !== "string" || !severities.has(severity)) {
    return c.json({ error: "Unsupported severity." }, 400);
  }
  let screenshot: string | null = null;
  if (body.screenshot_base64 !== undefined && body.screenshot_base64 !== null && body.screenshot_base64 !== "") {
    if (typeof body.screenshot_base64 !== "string" || body.screenshot_base64.length > 700_000) {
      return c.json({ error: "Screenshot must be no larger than 500 KB." }, 413);
    }
    const byteLength = base64Bytes(body.screenshot_base64);
    if (byteLength === null) return c.json({ error: "Screenshot must be a base64 PNG, JPEG, or WebP image." }, 400);
    if (byteLength > maxScreenshotBytes) return c.json({ error: "Screenshot must be no larger than 500 KB." }, 413);
    screenshot = body.screenshot_base64;
  }
  const deviceInfo = safeDeviceInfo(body.device_info);
  if (body.device_info !== undefined && body.device_info !== null && deviceInfo === null) {
    return c.json({ error: "Device context is invalid or too large." }, 400);
  }
  const url = body.url === undefined || body.url === null ? null : safePageUrl(body.url);
  if (body.url !== undefined && body.url !== null && url === null) {
    return c.json({ error: "A valid HTTP or HTTPS page URL is required." }, 400);
  }

  const user = actor(c);
  const sql = getDb(c.env);
  const rows = await sql`
    INSERT INTO bug_reports (
      user_id, user_role, sector, title, description, category, severity,
      screenshot_base64, device_info, url
    )
    VALUES (
      ${user.id}, ${user.role}, ${user.sector ?? null}, ${title}, ${description},
      ${category}, ${severity}, ${screenshot},
      ${deviceInfo ? JSON.stringify(deviceInfo) : null}::jsonb, ${url}
    )
    RETURNING id, user_role, sector, title, description, category, severity,
      device_info, url, status, created_at
  `;
  return c.json(rows[0] ?? null, 201);
});

routes.get("/user/bug-reports", authMiddleware, async (c) => {
  const user = actor(c);
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, title, description, category, severity, status, url, created_at
    FROM bug_reports
    WHERE user_id = ${user.id}
    ORDER BY created_at DESC
    LIMIT 100
  `;
  return c.json(rows);
});

routes.post("/user/sync-history", authMiddleware, async (c) => {
  const body = await parseJson(c);
  if (!body) return c.json({ error: "A JSON object is required." }, 400);
  const syncType = typeof body.sync_type === "string" ? body.sync_type.trim() : "";
  if (syncType.length < 1 || syncType.length > 60) {
    return c.json({ error: "sync_type must contain 1 to 60 characters." }, 400);
  }
  const synced = positiveInteger(body.items_synced ?? 0, 100_000);
  const failed = positiveInteger(body.items_failed ?? 0, 100_000);
  const duration = body.duration_ms === undefined || body.duration_ms === null
    ? null
    : positiveInteger(body.duration_ms, 2_147_483_647);
  if (synced === null || failed === null || (body.duration_ms !== undefined && body.duration_ms !== null && duration === null)) {
    return c.json({ error: "Sync counts and duration must be non-negative integers." }, 400);
  }
  const triggeredBy = body.triggered_by === undefined || body.triggered_by === null
    ? null
    : typeof body.triggered_by === "string" && body.triggered_by.length <= 50
      ? body.triggered_by
      : null;
  if (body.triggered_by !== undefined && body.triggered_by !== null && triggeredBy === null) {
    return c.json({ error: "triggered_by must be at most 50 characters." }, 400);
  }
  const errorSummary = body.error_summary === undefined || body.error_summary === null
    ? null
    : typeof body.error_summary === "string" && body.error_summary.length <= 500
      ? body.error_summary
      : null;
  if (body.error_summary !== undefined && body.error_summary !== null && errorSummary === null) {
    return c.json({ error: "error_summary must be at most 500 characters." }, 400);
  }
  const user = actor(c);
  const sql = getDb(c.env);
  const rows = await sql`
    INSERT INTO sync_history (
      user_id, sync_type, items_synced, items_failed, duration_ms, triggered_by, error_summary
    )
    VALUES (${user.id}, ${syncType}, ${synced}, ${failed}, ${duration}, ${triggeredBy}, ${errorSummary})
    RETURNING id, sync_type, items_synced, items_failed, duration_ms, triggered_by, error_summary, created_at
  `;
  return c.json(rows[0] ?? null, 201);
});

routes.get("/user/sync-history", authMiddleware, async (c) => {
  const parsedLimit = Number.parseInt(c.req.query("limit") || "50", 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(50, Math.max(1, parsedLimit)) : 50;
  const user = actor(c);
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, sync_type, items_synced, items_failed, duration_ms, triggered_by, error_summary, created_at
    FROM sync_history
    WHERE user_id = ${user.id}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return c.json(rows);
});

routes.get("/user/guide", authMiddleware, async (c) => {
  const user = actor(c);
  const requestedRole = c.req.query("role");
  const requestedSector = c.req.query("sector");
  if (requestedRole && requestedRole !== user.role) {
    return c.json({ error: "Guide role must match the signed-in account." }, 403);
  }
  if (requestedSector && requestedSector !== (user.sector ?? "")) {
    return c.json({ error: "Guide sector must match the signed-in account." }, 403);
  }
  return c.json(getRoleGuide(user.role));
});

routes.get("/admin/bug-reports", authMiddleware, requireRealSuperAdmin(), async (c) => {
  const status = c.req.query("status") || null;
  const severity = c.req.query("severity") || null;
  const sector = c.req.query("sector") || null;
  if (status && !reportStatuses.has(status)) return c.json({ error: "Unsupported report status." }, 400);
  if (severity && !severities.has(severity)) return c.json({ error: "Unsupported severity." }, 400);
  if (sector && !sectors.has(sector)) return c.json({ error: "Unsupported sector." }, 400);
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT b.id, b.user_id, u.name AS reporter_name, u.email AS reporter_email,
      b.user_role, b.sector, b.title, b.description, b.category, b.severity,
      b.device_info, b.url, b.status, b.admin_notes, b.resolved_at, b.created_at,
      (b.screenshot_base64 IS NOT NULL AND b.screenshot_base64 <> '') AS has_screenshot
    FROM bug_reports b
    LEFT JOIN users u ON u.id = b.user_id
    WHERE (${status}::text IS NULL OR b.status = ${status})
      AND (${severity}::text IS NULL OR b.severity = ${severity})
      AND (${sector}::text IS NULL OR b.sector = ${sector})
    ORDER BY b.created_at DESC
    LIMIT 200
  `;
  return c.json(rows);
});

routes.get("/admin/bug-reports/:id", authMiddleware, requireRealSuperAdmin(), async (c) => {
  const id = c.req.param("id");
  if (!uuidPattern.test(id)) return c.json({ error: "Invalid report ID." }, 400);
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT b.id, b.user_id, u.name AS reporter_name, u.email AS reporter_email,
      b.user_role, b.sector, b.title, b.description, b.category, b.severity,
      b.screenshot_base64, b.device_info, b.url, b.status, b.admin_notes,
      b.resolved_at, b.created_at
    FROM bug_reports b
    LEFT JOIN users u ON u.id = b.user_id
    WHERE b.id = ${id}::uuid
    LIMIT 1
  `;
  if (!rows[0]) return c.json({ error: "Report not found." }, 404);
  return c.json(rows[0]);
});

routes.patch("/admin/bug-reports/:id", authMiddleware, requireRealSuperAdmin(), async (c) => {
  const id = c.req.param("id");
  if (!uuidPattern.test(id)) return c.json({ error: "Invalid report ID." }, 400);
  const body = await parseJson(c);
  if (!body) return c.json({ error: "A JSON object is required." }, 400);
  if (Object.keys(body).some((key) => key !== "status" && key !== "admin_notes")) {
    return c.json({ error: "Only status and admin_notes can be updated." }, 400);
  }
  const status = body.status === undefined ? null : body.status;
  if (status !== null && (typeof status !== "string" || !reportStatuses.has(status))) {
    return c.json({ error: "Unsupported report status." }, 400);
  }
  const hasAdminNotes = Object.hasOwn(body, "admin_notes");
  const adminNotes = !hasAdminNotes || body.admin_notes === null
    ? null
    : typeof body.admin_notes === "string" && body.admin_notes.length <= 5000
      ? body.admin_notes.trim() || null
      : undefined;
  if (adminNotes === undefined) return c.json({ error: "admin_notes must be at most 5000 characters." }, 400);
  if (status === null && !hasAdminNotes) {
    return c.json({ error: "Provide a status or admin_notes update." }, 400);
  }
  const sql = getDb(c.env);
  const rows = await sql`
    UPDATE bug_reports SET
      status = COALESCE(${status}, status),
      admin_notes = CASE WHEN ${hasAdminNotes} THEN ${adminNotes} ELSE admin_notes END,
      resolved_at = CASE
        WHEN ${status} IS NULL THEN resolved_at
        WHEN ${status} IN ('resolved', 'wont_fix') THEN COALESCE(resolved_at, NOW())
        ELSE NULL
      END
    WHERE id = ${id}::uuid
    RETURNING id, user_role, sector, title, category, severity, device_info, url,
      status, admin_notes, resolved_at, created_at
  `;
  if (!rows[0]) return c.json({ error: "Report not found." }, 404);
  return c.json(rows[0]);
});

export default routes;
