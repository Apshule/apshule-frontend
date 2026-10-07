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

test("Farm workers cannot create animal movements or submit manual attendance for others", async () => {
  const movement = await request("/api/farm/movements", {
    role: "farm_worker",
    method: "POST",
    body: {},
  });
  const manualAttendance = await request("/api/farm/attendance/manual", {
    role: "farm_worker",
    method: "POST",
    body: {},
  });
  const editAttendance = await request("/api/farm/attendance/00000000-0000-4000-8000-000000000204", {
    role: "farm_worker",
    method: "PATCH",
    body: { status: "absent" },
  });
  assert.equal(movement.status, 403);
  assert.equal(manualAttendance.status, 403);
  assert.equal(editAttendance.status, 403);
});

test("Farm managers can record an incoming animal movement from outside the farm", async () => {
  const organizationId = "00000000-0000-4000-8000-000000000201";
  const oldLocationId = "00000000-0000-4000-8000-000000000202";
  const newLocationId = "00000000-0000-4000-8000-000000000205";
  const animalId = "00000000-0000-4000-8000-000000000206";
  const movementId = "00000000-0000-4000-8000-000000000207";
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join(" ");
    calls.push({ text, values });
    if (text.includes("SELECT organization_id AS id") && text.includes("FROM farm_workers")) {
      return [{ id: organizationId }];
    }
    if (text.includes("SELECT a.id, a.location_id, a.quantity, a.status, t.tracking_mode")) {
      return [{ id: animalId, location_id: oldLocationId, quantity: 1, status: "active", tracking_mode: "individual" }];
    }
    if (text.includes("SELECT id FROM farm_locations")) return [{ id: newLocationId }];
    if (text.includes("INSERT INTO farm_movements")) {
      return [{ id: movementId, direction: "in", count: 1 }];
    }
    if (text.includes("INSERT INTO farm_audit") && text.includes("INSERT INTO audit_log")) return [];
    throw new Error("Unexpected mocked Farm movement SQL statement.");
  };

  const response = await request("/api/farm/movements", {
    role: "farm_manager",
    method: "POST",
    sql,
    body: {
      animal_id: animalId,
      direction: "in",
      to_location_id: newLocationId,
      count: 1,
    },
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).movement.id, movementId);
  const movementInsert = calls.find(({ text }) => text.includes("INSERT INTO farm_movements"));
  assert.ok(movementInsert);
  assert.ok(movementInsert.values.includes(null));
  assert.ok(movementInsert.values.includes(newLocationId));
  assert.ok(calls.some(({ text }) => text.includes("INSERT INTO farm_audit") && text.includes("INSERT INTO audit_log")));
});

test("Farm operations routes reject non-Farm roles before database access", async () => {
  const response = await request("/api/farm/eggs", {
    role: "clinic_admin",
  });
  assert.equal(response.status, 403);
});

test("Farm egg records validate calendar dates before database access", async () => {
  const response = await request("/api/farm/eggs", {
    role: "farm_worker",
    method: "POST",
    body: {
      location_id: "00000000-0000-4000-8000-000000000202",
      record_date: "2026-02-30",
      shift: "Morning",
      eggs_collected: 5,
      eggs_broken: 1,
    },
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "VALIDATION_ERROR");
});

test("Farm face check-in returns the specified no-match response when no image is supplied", async () => {
  const response = await request("/api/farm/attendance/check-in", {
    role: "farm_worker",
    method: "POST",
    body: {},
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Face not recognized", score: null });
});

test("Farm workers can upsert assigned-location egg counts and the operation writes both audit records", async () => {
  const organizationId = "00000000-0000-4000-8000-000000000201";
  const locationId = "00000000-0000-4000-8000-000000000202";
  const workerId = "00000000-0000-4000-8000-000000000203";
  const eggId = "00000000-0000-4000-8000-000000000204";
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join(" ");
    calls.push({ text, values });
    if (text.includes("SELECT organization_id AS id") && text.includes("FROM farm_workers")) {
      return [{ id: organizationId }];
    }
    if (text.includes("SELECT id, user_id, organization_id, location_id, role, active, face_hash")) {
      return [{ id: workerId, user_id: "00000000-0000-4000-8000-000000000123", location_id: locationId, role: "farm_worker", active: true }];
    }
    if (text.includes("SELECT id FROM farm_locations")) return [{ id: locationId }];
    if (text.includes("INSERT INTO farm_egg_records")) {
      return [{ id: eggId, eggs_collected: 12, eggs_broken: 2, eggs_good: 10 }];
    }
    if (text.includes("INSERT INTO farm_audit") && text.includes("INSERT INTO audit_log")) return [];
    throw new Error("Unexpected mocked Farm operations SQL statement.");
  };

  const response = await request("/api/farm/eggs", {
    role: "farm_worker",
    method: "POST",
    sql,
    body: {
      location_id: locationId,
      record_date: "2026-10-07",
      shift: "morning",
      eggs_collected: 12,
      eggs_broken: 2,
    },
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.eggs_good, 10);
  assert.equal(payload.egg.id, eggId);
  assert.ok(calls.some(({ text, values }) =>
    text.includes("INSERT INTO farm_egg_records") && values.includes(10)));
  assert.ok(calls.some(({ text }) =>
    text.includes("INSERT INTO farm_audit") && text.includes("INSERT INTO audit_log")));
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
