import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import farmRoutes from "../src/routes/farm.ts";

const app = new Hono();
app.route("/api/farm", farmRoutes);
app.onError((error, c) => c.json({ error: error?.code || "INTERNAL_ERROR" }, error?.status || 500));
const unavailableDb = async () => {
  throw new Error("The database must not be accessed for a rejected request.");
};

function request(path, {
  role,
  sector = "farm",
  token = "test-token",
  method = "GET",
  body,
  sql: sqlHandler = unavailableDb,
} = {}) {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (role) headers.set("x-test-role", role);
  if (sector) headers.set("x-test-sector", sector);
  if (body !== undefined) headers.set("content-type", "application/json");
  return app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }, { __sql: sqlHandler });
}

test("Farm API routes require authentication", async () => {
  const response = await request("/api/farm/animals", { token: "missing" });
  assert.equal(response.status, 401);
});

test("Farm API rejects users outside the Farm sector before database access", async () => {
  const response = await request("/api/farm/animals", {
    role: "farm_admin",
    sector: "clinic",
  });
  assert.equal(response.status, 403);
});

test("Farm workers cannot create animal records", async () => {
  const response = await request("/api/farm/animals", {
    role: "farm_worker",
    method: "POST",
    body: {},
  });
  assert.equal(response.status, 403);
});

test("Farm managers cannot create organizations or administrator accounts", async () => {
  const response = await request("/api/farm/organizations", {
    role: "farm_manager",
    method: "POST",
    body: { name: "Test farm" },
  });
  assert.equal(response.status, 403);
});

test("Farm admin individual-animal creation allocates a sequential organization tag and audits it", async () => {
  const organizationId = "00000000-0000-4000-8000-000000000201";
  const locationId = "00000000-0000-4000-8000-000000000202";
  const animalTypeId = "00000000-0000-4000-8000-000000000203";
  const animalId = "00000000-0000-4000-8000-000000000204";
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join(" ");
    calls.push({ text, values });
    if (text.includes("SELECT id FROM farm_organizations WHERE created_by")) return [{ id: organizationId }];
    if (text.includes("SELECT id FROM farm_locations")) return [{ id: locationId }];
    if (text.includes("SELECT id, code, tracking_mode FROM farm_animal_types")) {
      return [{ id: animalTypeId, code: "CATTLE", tracking_mode: "individual" }];
    }
    if (text.includes("UPDATE farm_organizations") && text.includes("animal_tag_sequence")) {
      return [{ animal_tag_sequence: 7 }];
    }
    if (text.includes("INSERT INTO farm_animals")) {
      return [{ id: animalId, tag_number: values[3] }];
    }
    if (text.includes("INSERT INTO farm_audit") && text.includes("INSERT INTO audit_log")) return [];
    throw new Error("Unexpected mocked Farm SQL statement.");
  };

  const response = await request("/api/farm/animals", {
    role: "farm_admin",
    method: "POST",
    sql,
    body: {
      location_id: locationId,
      animal_type_id: animalTypeId,
      name: "Daisy",
      date_of_birth: "2022-01-01",
      weight_kg: 350,
    },
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.animal.tag_number, "CATTLE-007");
  assert.ok(calls.some(({ text }) => text.includes("UPDATE farm_organizations") && text.includes("animal_tag_sequence")));
  assert.ok(calls.some(({ text }) => text.includes("INSERT INTO farm_audit") && text.includes("INSERT INTO audit_log")));
});
