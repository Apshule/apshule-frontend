import { ApiError } from "./db.js";
import type { getDb } from "./db.js";
import { decryptPlatformSetting } from "./platform-settings-crypto.js";
import type { Env } from "./types.js";

export const DEFAULT_YO_BASE_URL = "https://payments.yo.co.ug";
export const DEFAULT_YO_IPN_URL =
  "https://apshule-api.apshule-migration.workers.dev/api/yopayments/ipn";

type Sql = ReturnType<typeof getDb>;
type YoSettingField = "api_username" | "api_password" | "base_url" | "ipn_url";
export type YoSettingSource = "worker_secret" | "platform_settings" | "default" | "missing";

export interface ResolvedYoPaymentSettings {
  api_username: string;
  api_password: string;
  base_url: string;
  ipn_url: string;
  sources: Record<YoSettingField, YoSettingSource>;
}

interface PlatformSettingRow {
  key: string;
  value: string;
}

const DATABASE_KEY_BY_FIELD: Record<YoSettingField, string> = {
  api_username: "yo_api_username",
  api_password: "yo_api_password",
  base_url: "yo_base_url",
  ipn_url: "yo_ipn_url",
};

export function createYoPaymentSettingsResolver(env: Env, sql: Sql) {
  let cached: Promise<ResolvedYoPaymentSettings> | undefined;

  return () => {
    cached ??= resolveYoPaymentSettings(env, sql);
    return cached;
  };
}

async function resolveYoPaymentSettings(
  env: Env,
  sql: Sql,
): Promise<ResolvedYoPaymentSettings> {
  const workerSettings: Partial<Record<YoSettingField, string>> = {
    api_username: env.YO_API_USERNAME?.trim() || undefined,
    api_password: env.YO_API_PASSWORD?.trim() || undefined,
    base_url: env.YO_BASE_URL?.trim() || env.YO_API_URL?.trim() || undefined,
    ipn_url: env.YO_IPN_URL?.trim() || undefined,
  };

  const missingFields = (Object.keys(DATABASE_KEY_BY_FIELD) as YoSettingField[])
    .filter((field) => !workerSettings[field]);
  const storedSettings: Partial<Record<YoSettingField, string>> = {};

  if (missingFields.length) {
    const missingKeys = missingFields.map((field) => DATABASE_KEY_BY_FIELD[field]);
    const rows = await sql`
      SELECT key, value
      FROM platform_settings
      WHERE key = ANY(${missingKeys}::text[])
    `;

    for (const row of rows as PlatformSettingRow[]) {
      const field = (Object.keys(DATABASE_KEY_BY_FIELD) as YoSettingField[])
        .find((candidate) => DATABASE_KEY_BY_FIELD[candidate] === row.key);
      if (!field || !row.value) continue;
      storedSettings[field] = await decryptPlatformSetting(
        row.value,
        env.SETTINGS_ENCRYPTION_KEY,
        row.key,
      );
    }
  }

  const setting = (
    field: YoSettingField,
    fallback = "",
  ): { value: string; source: YoSettingSource } => {
    const workerValue = workerSettings[field];
    if (workerValue) return { value: workerValue, source: "worker_secret" };
    const storedValue = storedSettings[field];
    if (storedValue) return { value: storedValue, source: "platform_settings" };
    if (fallback) return { value: fallback, source: "default" };
    return { value: "", source: "missing" };
  };

  const username = setting("api_username");
  const password = setting("api_password");
  const baseUrl = setting("base_url", DEFAULT_YO_BASE_URL);
  const ipnUrl = setting("ipn_url", DEFAULT_YO_IPN_URL);

  if (
    (username.source === "platform_settings" || password.source === "platform_settings" ||
      baseUrl.source === "platform_settings" || ipnUrl.source === "platform_settings") &&
    !env.SETTINGS_ENCRYPTION_KEY
  ) {
    throw new ApiError(
      503,
      "CONFIGURATION_MISSING",
      "The SETTINGS_ENCRYPTION_KEY binding is not configured.",
    );
  }

  return {
    api_username: username.value,
    api_password: password.value,
    base_url: baseUrl.value,
    ipn_url: ipnUrl.value,
    sources: {
      api_username: username.source,
      api_password: password.source,
      base_url: baseUrl.source,
      ipn_url: ipnUrl.source,
    },
  };
}