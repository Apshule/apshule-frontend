import test from "node:test";
import assert from "node:assert/strict";
import userSettings from "../src/routes/user-settings.ts";

const testUserId = "00000000-0000-4000-8000-000000000123";

function env(sql) {
  return { __sql: sql };
}

function headers(role = "farm_admin", sector = "farm") {
  return {
    "content-type": "application/json",
    "x-test-role": role,
    "x-test-sector": sector,
  };
}

test("GET preferences creates and returns the signed-in user's defaults", async () => {
  const calls = [];
  const sql = async (parts, ...values) => {
    const text = parts.join("?");
    calls.push({ text, values });
    if (text.includes("FROM user_preferences")) {
      return [{
        user_id: testUserId,
        language: "en",
        data_saver: "auto",
        theme: "auto",
        notifications_enabled: true,
        timezone: "Africa/Kampala",
        settings: {},
      }];
    }
    return [];
  };
  const response = await userSettings.request(
    "/user/preferences",
    { headers: headers() },
    env(sql),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.user_id, testUserId);
  assert.equal(body.timezone, "Africa/Kampala");
  assert.equal(calls.length, 2);
  assert.match(calls[0].text, /INSERT INTO user_preferences/u);
  assert.match(calls[1].text, /WHERE user_id = \?/u);
});

test("PATCH preferences validates values and never accepts user identity", async () => {
  const statements = [];
  const sql = async (parts, ...values) => {
    statements.push({ text: parts.join("?"), values });
    return [{
      user_id: testUserId,
      language: "lg",
      data_saver: "wifi_only",
      theme: "dark",
      notifications_enabled: false,
    }];
  };
  const response = await userSettings.request(
    "/user/preferences",
    {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        user_id: "00000000-0000-4000-8000-000000000999",
        language: "lg",
        data_saver: "wifi_only",
        theme: "dark",
        notifications_enabled: false,
      }),
    },
    env(sql),
  );
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error.includes("Only language"), true);
  assert.equal(statements.length, 0);

  const validResponse = await userSettings.request(
    "/user/preferences",
    {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({
        language: "lg",
        data_saver: "wifi_only",
        theme: "dark",
        notifications_enabled: false,
        timezone: "Africa/Kampala",
      }),
    },
    env(sql),
  );
  assert.equal(validResponse.status, 200);
  assert.equal(statements.length, 1);
  assert.equal(statements[0].values.includes(testUserId), true);
  assert.equal(statements[0].values.includes("00000000-0000-4000-8000-000000000999"), false);
  assert.equal(statements[0].values.includes("Africa/Kampala"), true);

  const invalidTimeZone = await userSettings.request(
    "/user/preferences",
    {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ timezone: "Not/A_TimeZone" }),
    },
    env(sql),
  );
  assert.equal(invalidTimeZone.status, 400);
  assert.equal(statements.length, 1);
});

test("bug reports enforce text and screenshot limits before insertion", async () => {
  let queryCount = 0;
  const sql = async () => {
    queryCount++;
    return [];
  };
  const oversized = await userSettings.request(
    "/user/bug-report",
    {
      method: "POST",
      headers: headers("teacher", "education"),
      body: JSON.stringify({
        title: "Large screenshot",
        description: "Screenshot payload should be rejected before database insert.",
        screenshot_base64: "A".repeat(700_000),
      }),
    },
    env(sql),
  );
  assert.equal(oversized.status, 413);
  assert.equal(queryCount, 0);

  const tooShort = await userSettings.request(
    "/user/bug-report",
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ title: "No", description: "Too short" }),
    },
    env(sql),
  );
  assert.equal(tooShort.status, 400);
  assert.equal(queryCount, 0);
});

test("user report list is scoped to the authenticated account and excludes image payloads", async () => {
  let statement;
  const sql = async (parts, ...values) => {
    statement = { text: parts.join("?"), values };
    return [];
  };
  const response = await userSettings.request(
    "/user/bug-reports",
    { headers: headers("teacher", "education") },
    env(sql),
  );
  assert.equal(response.status, 200);
  assert.match(statement.text, /WHERE user_id = \?/u);
  assert.equal(statement.values.includes(testUserId), true);
  assert.equal(statement.text.includes("screenshot_base64"), false);
});

test("sync-history uses the authenticated user and validates counters", async () => {
  let statement;
  const sql = async (parts, ...values) => {
    statement = { text: parts.join("?"), values };
    return [{ id: "event-1", items_synced: 2, items_failed: 1 }];
  };
  const response = await userSettings.request(
    "/user/sync-history",
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        user_id: "spoofed-user",
        sync_type: "offline_queue",
        items_synced: 2,
        items_failed: 1,
        duration_ms: 40,
      }),
    },
    env(sql),
  );
  assert.equal(response.status, 201);
  assert.equal(statement.values.includes(testUserId), true);
  assert.equal(statement.values.includes("spoofed-user"), false);

  const invalid = await userSettings.request(
    "/user/sync-history",
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ sync_type: "offline_queue", items_synced: -1 }),
    },
    env(sql),
  );
  assert.equal(invalid.status, 400);
});

test("role guide returns at least three sections and blocks a different role request", async () => {
  const response = await userSettings.request(
    "/user/guide?role=farm_worker&sector=farm",
    { headers: headers("farm_worker", "farm") },
    env(async () => []),
  );
  const sections = await response.json();
  assert.equal(response.status, 200);
  assert.equal(sections.length >= 3, true);
  assert.equal(sections[1].steps.length >= 2, true);

  const forbidden = await userSettings.request(
    "/user/guide?role=superadmin&sector=education",
    { headers: headers("farm_worker", "farm") },
    env(async () => []),
  );
  assert.equal(forbidden.status, 403);
});

test("bug-report administration requires a real, unimpersonated superadmin", async () => {
  let queryCount = 0;
  const sql = async () => {
    queryCount++;
    return [];
  };
  for (const authHeaders of [
    headers("teacher", "education"),
    { ...headers("superadmin", "education"), "x-test-impersonated": "user-2" },
  ]) {
    const response = await userSettings.request(
      "/admin/bug-reports",
      { headers: authHeaders },
      env(sql),
    );
    assert.equal(response.status, 403);
  }
  assert.equal(queryCount, 0);
});

test("superadmin bug-report list accepts the requested filters", async () => {
  let statement;
  const sql = async (parts, ...values) => {
    statement = { text: parts.join("?"), values };
    return [];
  };
  const response = await userSettings.request(
    "/admin/bug-reports?status=open&severity=high&sector=farm",
    { headers: headers("superadmin", "education") },
    env(sql),
  );
  assert.equal(response.status, 200);
  assert.equal(statement.values.includes("open"), true);
  assert.equal(statement.values.includes("high"), true);
  assert.equal(statement.values.includes("farm"), true);
  assert.match(statement.text, /LEFT JOIN users/u);
});
