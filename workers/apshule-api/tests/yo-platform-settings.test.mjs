import test from "node:test";
import assert from "node:assert/strict";
import { encryptPlatformSetting } from "../src/platform-settings-crypto.ts";
import {
  createYoPaymentSettingsResolver,
  DEFAULT_YO_BASE_URL,
  DEFAULT_YO_IPN_URL,
} from "../src/yo-platform-settings.ts";

const encryptionKey = "0123456789abcdef".repeat(4);

test("Worker secrets take precedence and database fallbacks are cached per request", async () => {
  const rows = await Promise.all([
    ["yo_api_username", "database-user"],
    ["yo_api_password", "database-password"],
    ["yo_base_url", "https://stored.example/api"],
    ["yo_ipn_url", "https://stored.example/ipn"],
  ].map(async ([key, value]) => ({
    key,
    value: await encryptPlatformSetting(value, encryptionKey, key),
  })));
  let queryCount = 0;
  const sql = async (_query, requestedKeys) => {
    queryCount++;
    return rows.filter((row) => requestedKeys.includes(row.key));
  };
  const resolve = createYoPaymentSettingsResolver(
    { YO_API_USERNAME: "worker-user", SETTINGS_ENCRYPTION_KEY: encryptionKey },
    sql,
  );

  const first = await resolve();
  const second = await resolve();

  assert.equal(queryCount, 1);
  assert.equal(first, second);
  assert.equal(first.api_username, "worker-user");
  assert.equal(first.api_password, "database-password");
  assert.equal(first.base_url, "https://stored.example/api");
  assert.equal(first.ipn_url, "https://stored.example/ipn");
  assert.deepEqual(first.sources, {
    api_username: "worker_secret",
    api_password: "platform_settings",
    base_url: "platform_settings",
    ipn_url: "platform_settings",
  });
});

test("missing database settings use the documented Yo! defaults without an encryption key", async () => {
  let queryCount = 0;
  const resolve = createYoPaymentSettingsResolver({}, async () => {
    queryCount++;
    return [];
  });

  const settings = await resolve();

  assert.equal(queryCount, 1);
  assert.equal(settings.api_username, "");
  assert.equal(settings.api_password, "");
  assert.equal(settings.base_url, DEFAULT_YO_BASE_URL);
  assert.equal(settings.ipn_url, DEFAULT_YO_IPN_URL);
  assert.equal(settings.sources.base_url, "default");
  assert.equal(settings.sources.ipn_url, "default");
});