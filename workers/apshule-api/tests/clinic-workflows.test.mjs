import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import clinicRoutes from "../src/routes/clinic.ts";

const ACTOR_ID = "00000000-0000-4000-8000-000000000123";
const ORG_ID = "00000000-0000-4000-8000-000000000234";
const PATIENT_ID = "00000000-0000-4000-8000-000000000345";
const DOCTOR_ID = "00000000-0000-4000-8000-000000000456";
const APPOINTMENT_ID = "00000000-0000-4000-8000-000000000567";
const VISIT_ID = "00000000-0000-4000-8000-000000000678";

function createApp() {
  const app = new Hono();
  app.onError((error, c) => c.json(
    { error: error.code ?? "INTERNAL_ERROR" },
    error.status ?? 500,
  ));
  app.route("/", clinicRoutes);
  return app;
}

function headers(role = "clinic_admin") {
  return {
    authorization: "Bearer test-token",
    "x-test-role": role,
    "x-test-sector": "clinic",
    "content-type": "application/json",
  };
}

function organizationSql(sql) {
  if (sql.includes("FROM clinic_organizations") && sql.includes("created_by")) {
    return [{ id: ORG_ID }];
  }
  if (sql.includes("SELECT organization_id AS id FROM clinic_staff")) {
    return [{ id: ORG_ID }];
  }
  return undefined;
}

test("Clinic doctors lookup is role-limited and returns user IDs for scheduling", async () => {
  const statements = [];
  const sql = async (parts) => {
    const text = parts.join("?");
    statements.push(text);
    const org = organizationSql(text);
    if (org) return org;
    if (text.includes("FROM clinic_staff s") && text.includes("u.id AS user_id")) {
      return [{ id: DOCTOR_ID, user_id: DOCTOR_ID, staff_id: "staff-row", name: "Dr Test" }];
    }
    throw new Error("Unexpected Clinic SQL statement.");
  };
  const response = await createApp().request(
    "/clinic/doctors",
    { headers: headers("nurse") },
    { __sql: sql },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.doctors[0].user_id, DOCTOR_ID);
  assert.ok(statements.some((statement) => statement.includes("s.role = 'doctor'")));
  assert.ok(statements.some((statement) => statement.includes("s.active IS TRUE")));
});

test("appointment creation validates clinic records, allocates a monthly number, and writes both audits", async () => {
  const statements = [];
  const sql = async (parts, ...values) => {
    const text = parts.join("?");
    statements.push({ text, values });
    const org = organizationSql(text);
    if (org) return org;
    if (text.includes("FROM clinic_patients") && text.includes("status = 'active'")) {
      return [{ id: PATIENT_ID, branch_id: null }];
    }
    if (text.includes("FROM clinic_staff s") && text.includes("s.role = 'doctor'")) {
      return [{ id: DOCTOR_ID, name: "Dr Test", branch_id: null }];
    }
    if (text.includes("INSERT INTO clinic_number_counters")
        && text.includes("INSERT INTO clinic_appointments")) {
      return [{
        id: APPOINTMENT_ID,
        appointment_number: "APT-202610-0001",
        patient_id: PATIENT_ID,
        doctor_id: DOCTOR_ID,
        status: "scheduled",
      }];
    }
    throw new Error("Unexpected Clinic SQL statement.");
  };
  const scheduledFor = new Date(Date.now() + 86_400_000);
  const expectedParts = new Intl.DateTimeFormat("en", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(scheduledFor);
  const expectedPeriod = `${expectedParts.find((part) => part.type === "year")?.value}${expectedParts.find((part) => part.type === "month")?.value}`;
  const response = await createApp().request(
    "/clinic/appointments",
    {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        patient_id: PATIENT_ID,
        doctor_id: DOCTOR_ID,
        scheduled_for: scheduledFor.toISOString(),
        duration_minutes: 30,
        reason: "Routine follow-up",
      }),
    },
    { __sql: sql },
  );

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.appointment.appointment_number, /^APT-\d{6}-\d{4}$/u);
  const createStatement = statements.find(({ text }) =>
    text.includes("INSERT INTO clinic_appointments"),
  );
  assert.ok(createStatement.values.includes(expectedPeriod));
  assert.match(createStatement.text, /clinic_number_counters/u);
  assert.match(createStatement.text, /INSERT INTO clinic_audit/u);
  assert.match(createStatement.text, /INSERT INTO audit_log/u);
});

test("only receptionists and nurses can check patients in", async () => {
  const response = await createApp().request(
    `/clinic/appointments/${APPOINTMENT_ID}/check-in`,
    {
      method: "POST",
      headers: headers("doctor"),
    },
    {
      __sql: async () => {
        throw new Error("A denied role must not access the database.");
      },
    },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "FORBIDDEN" });
});

test("today dashboard includes all assigned in-progress visits, not only visits started today", async () => {
  const statements = [];
  const sql = async (parts) => {
    const text = parts.join("?");
    statements.push(text);
    const org = organizationSql(text);
    if (org) return org;
    if (text.includes("COUNT(*) FILTER")) {
      return [{ scheduled_count: 0, checked_in_count: 0, completed_count: 0 }];
    }
    return [];
  };
  const response = await createApp().request(
    "/clinic/today",
    { headers: headers("doctor") },
    { __sql: sql },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.date);
  assert.deepEqual(body.appointments_today, []);
  assert.deepEqual(body.in_progress_visits, []);
  const visitsQuery = statements.find((statement) => statement.includes("FROM clinic_visits v"));
  assert.ok(visitsQuery);
  assert.match(visitsQuery, /v\.doctor_id = \?/u);
  assert.doesNotMatch(visitsQuery, /v\.visit_started_at >=/u);
});

test("visit edits are limited to the assigned doctor and record dual audits", async () => {
  const statements = [];
  let hideVisit = false;
  const sql = async (parts) => {
    const text = parts.join("?");
    statements.push(text);
    const org = organizationSql(text);
    if (org) return org;
    if (text.includes("UPDATE clinic_visits") && text.includes("clinic.visit_updated")) {
      return hideVisit ? [] : [{
        id: VISIT_ID,
        doctor_id: ACTOR_ID,
        diagnosis: "Acute pharyngitis",
        status: "in_progress",
      }];
    }
    if (text.includes("FROM clinic_visits v") && text.includes("v.doctor_id = ?")) {
      return [];
    }
    throw new Error("Unexpected Clinic SQL statement.");
  };
  const editResponse = await createApp().request(
    `/clinic/visits/${VISIT_ID}`,
    {
      method: "PATCH",
      headers: headers("doctor"),
      body: JSON.stringify({ diagnosis: "Acute pharyngitis" }),
    },
    { __sql: sql },
  );

  assert.equal(editResponse.status, 200);
  const update = statements.find((statement) =>
    statement.includes("UPDATE clinic_visits") && statement.includes("clinic.visit_updated"),
  );
  assert.match(update, /doctor_id = \?/u);
  assert.match(update, /INSERT INTO clinic_audit/u);
  assert.match(update, /INSERT INTO audit_log/u);

  const viewResponse = await createApp().request(
    `/clinic/visits/${VISIT_ID}`,
    { headers: headers("doctor") },
    { __sql: sql },
  );
  assert.equal(viewResponse.status, 404);
});
