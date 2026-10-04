import test from "node:test";
import assert from "node:assert/strict";
import platformSettings from "../src/routes/platform-settings.ts";
import { decryptPlatformSetting } from "../src/platform-settings-crypto.ts";

const encryptionKey = "0123456789abcdef".repeat(4);

function configuredEnv(sql) {
  return {
    __sql: sql,
    SETTINGS_ENCRYPTION_KEY: encryptionKey,
    YO_API_USERNAME: "worker-account",
    YO_API_PASSWORD: "worker-password",
    YO_BASE_URL: "https://payments.yo.co.ug",
    YO_IPN_URL: "https://example.test/api/yopayments/ipn",
  };
}

test("GET returns masked credentials and only exposes non-secret URLs", async () => {
  let queryCount = 0;
  const env = configuredEnv(async () => {
    queryCount++;
    return [];
  });
  const response = await platformSettings.request(
    "/yopayments",
    { headers: { "x-test-role": "superadmin" } },
    env,
  );
  const body = await response.json();
  const serialized = JSON.stringify(body);

  assert.equal(response.status, 200);
  assert.equal(body.api_username, "wo***");
  assert.equal(body.api_password, "***");
  assert.equal(body.configured.api_username, true);
  assert.equal(body.configured.api_password, true);
  assert.equal(body.base_url, "https://payments.yo.co.ug");
  assert.equal(body.ipn_url, "https://example.test/api/yopayments/ipn");
  assert.equal(serialized.includes("worker-account"), false);
  assert.equal(serialized.includes("worker-password"), false);
  assert.equal(queryCount, 0);
});

test("POST encrypts saved values and records an audit entry without credential values", async () => {
  const statements = [];
  const sql = async (parts, ...values) => {
    const text = parts.join("?");
    statements.push({ text, values });
    if (text.includes("INSERT INTO platform_settings")) {
      return [
        { key: "yo_api_username" },
        { key: "yo_api_password" },
        { key: "yo_base_url" },
        { key: "yo_ipn_url" },
      ];
    }
    throw new Error("Unexpected SQL statement.");
  };
  const response = await platformSettings.request(
    "/yopayments",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-test-role": "superadmin",
      },
      body: JSON.stringify({
        api_username: "new-account",
        api_password: "new-password",
        base_url: "https://payments.yo.co.ug",
        ipn_url: "https://example.test/api/yopayments/ipn",
      }),
    },
    configuredEnv(sql),
  );
  const body = await response.json();
  const statement = statements[0];
  const valuesText = JSON.stringify(statement.values);

  assert.equal(response.status, 200);
  assert.equal(body.saved, true);
  assert.deepEqual(body.updated_keys, [
    "yo_api_username",
    "yo_api_password",
    "yo_base_url",
    "yo_ipn_url",
  ]);
  assert.match(statement.text, /INSERT INTO audit_log/u);
  assert.match(statement.text, /platform_settings_updated/u);
  assert.equal(valuesText.includes("new-account"), false);
  assert.equal(valuesText.includes("new-password"), false);
  assert.equal(
    await decryptPlatformSetting(statement.values[0], encryptionKey, "yo_api_username"),
    "new-account",
  );
  assert.equal(
    await decryptPlatformSetting(statement.values[1], encryptionKey, "yo_api_password"),
    "new-password",
  );
});

test("platform settings endpoints reject non-superadmin and impersonated sessions", async () => {
  const env = configuredEnv(async () => {
    throw new Error("Database must not be touched for rejected requests.");
  });
  for (const headers of [
    { "x-test-role": "school" },
    { "x-test-role": "superadmin", "x-test-impersonated": "another-user" },
  ]) {
    const response = await platformSettings.request("/yopayments", { headers }, env);
    assert.equal(response.status, 403);
  }
});