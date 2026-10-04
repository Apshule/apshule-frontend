import { Hono, type Context } from "hono";
import { authMiddleware, requireRealSuperAdmin } from "../auth.js";
import { ApiError, getDb, requireEnv } from "../db.js";
import { optionalString, readJson } from "../http.js";
import { encryptPlatformSetting } from "../platform-settings-crypto.js";
import { createYoPaymentSettingsResolver } from "../yo-platform-settings.js";
import type { AppEnv } from "../types.js";

const platformSettings = new Hono<AppEnv>();

function maskUsername(value: string): string {
  return value ? `${value.slice(0, 2)}***` : "";
}

function requestIp(c: Context<AppEnv>): string | null {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    null
  )?.slice(0, 255) ?? null;
}

function optionalPassword(body: Record<string, unknown>): string | undefined {
  if (!("api_password" in body)) return undefined;
  const value = body.api_password;
  if (typeof value !== "string" || value.length > 1024) {
    throw new ApiError(400, "VALIDATION_ERROR", "api_password must be a string no longer than 1024 characters.");
  }
  return value.trim() ? value : undefined;
}

function httpsUrl(value: string, key: string, allowPath: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a valid HTTPS URL.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!allowPath && url.pathname === "/")
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a valid HTTPS URL.`);
  }
  if (allowPath) {
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString().replace(/\/$/u, "");
  }
  return url.toString();
}

platformSettings.get(
  "/yopayments",
  authMiddleware,
  requireRealSuperAdmin(),
  async (c) => {
    const resolveSettings = createYoPaymentSettingsResolver(c.env, getDb(c.env));
    const settings = await resolveSettings();
    return c.json({
      api_username: maskUsername(settings.api_username),
      api_password: settings.api_password ? "***" : "",
      base_url: settings.base_url,
      ipn_url: settings.ipn_url,
      configured: {
        api_username: Boolean(settings.api_username),
        api_password: Boolean(settings.api_password),
      },
      sources: settings.sources,
    });
  },
);

platformSettings.post(
  "/yopayments",
  authMiddleware,
  requireRealSuperAdmin(),
  async (c) => {
    const body = await readJson(c);
    const sql = getDb(c.env);
    const user = c.get("user");
    const resolveSettings = createYoPaymentSettingsResolver(c.env, sql);
    const current = await resolveSettings();
    const apiUsername = optionalString(body, "api_username", { max: 320 }) || undefined;
    const apiPassword = optionalPassword(body);
    const baseUrlInput = optionalString(body, "base_url", { max: 2048 });
    const ipnUrlInput = optionalString(body, "ipn_url", { max: 2048 });
    const baseUrl = httpsUrl(baseUrlInput || current.base_url, "base_url", true);
    const ipnUrl = httpsUrl(ipnUrlInput || current.ipn_url, "ipn_url", false);
    const nextUsername = apiUsername || current.api_username;
    const nextPassword = apiPassword || current.api_password;

    if (!nextUsername || !nextPassword) {
      throw new ApiError(
        400,
        "YO_CREDENTIALS_REQUIRED",
        "Enter both Yo! API credentials before saving the payment settings.",
      );
    }

    const encryptionKey = requireEnv(
      c.env.SETTINGS_ENCRYPTION_KEY,
      "SETTINGS_ENCRYPTION_KEY",
    );
    const [encryptedUsername, encryptedPassword, encryptedBaseUrl, encryptedIpnUrl] =
      await Promise.all([
        apiUsername
          ? encryptPlatformSetting(apiUsername, encryptionKey, "yo_api_username")
          : Promise.resolve(null),
        apiPassword
          ? encryptPlatformSetting(apiPassword, encryptionKey, "yo_api_password")
          : Promise.resolve(null),
        encryptPlatformSetting(baseUrl, encryptionKey, "yo_base_url"),
        encryptPlatformSetting(ipnUrl, encryptionKey, "yo_ipn_url"),
      ]);

    const rows = await sql`
      WITH incoming(setting_key, setting_value) AS (
        VALUES
          ('yo_api_username', ${encryptedUsername}::text),
          ('yo_api_password', ${encryptedPassword}::text),
          ('yo_base_url', ${encryptedBaseUrl}::text),
          ('yo_ipn_url', ${encryptedIpnUrl}::text)
      ),
      saved AS (
        INSERT INTO platform_settings (key, value, updated_by)
        SELECT setting_key, setting_value, ${user.id}
        FROM incoming
        WHERE setting_value IS NOT NULL
        ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by
        RETURNING key
      ),
      audit AS (
        INSERT INTO audit_log (
          actor_id, sector, action, target_table, target_id, metadata, ip
        )
        SELECT
          ${user.id},
          ${user.sector},
          'platform_settings_updated',
          'platform_settings',
          NULL,
          jsonb_build_object(
            'keys',
            COALESCE(jsonb_agg(key), '[]'::jsonb)
          ),
          ${requestIp(c)}
        FROM saved
        RETURNING id
      )
      SELECT key FROM saved
    `;

    return c.json({
      saved: true,
      updated_keys: rows.map((row) => (row as { key: string }).key),
      environment_overrides: {
        api_username: Boolean(c.env.YO_API_USERNAME?.trim()),
        api_password: Boolean(c.env.YO_API_PASSWORD?.trim()),
        base_url: Boolean(c.env.YO_BASE_URL?.trim() || c.env.YO_API_URL?.trim()),
        ipn_url: Boolean(c.env.YO_IPN_URL?.trim()),
      },
    });
  },
);

export default platformSettings;