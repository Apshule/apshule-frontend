import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import clinicRoutes from "../src/routes/clinic.ts";

function createApp() {
  const app = new Hono();
  app.onError((error, c) => {
    return c.json(
      { error: error.code ?? "INTERNAL_ERROR" },
      error.status ?? 500,
    );
  });
  app.route("/", clinicRoutes);
  return app;
}

function testEnv() {
  return {
    __sql: async () => {
      throw new Error("Database access is not expected for rejected requests.");
    },
  };
}

const testToken = { authorization: "Bearer test-token" };

test("Clinic routes require authentication", async () => {
  const response = await createApp().request("/clinic/patients", {}, testEnv());

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "UNAUTHORIZED" });
});

test("Clinic routes reject wrong-sector and non-Clinic roles before database access", async () => {
  for (const headers of [
    { ...testToken, "x-test-role": "doctor", "x-test-sector": "education" },
    { ...testToken, "x-test-role": "teacher", "x-test-sector": "clinic" },
  ]) {
    const response = await createApp().request("/clinic/patients", { headers }, testEnv());
    assert.equal(response.status, 403);
  }
});

test("Clinic staff cannot provision organizations or delete patient records", async () => {
  const requests = [
    {
      path: "/clinic/organizations",
      init: {
        method: "POST",
        headers: { ...testToken, "x-test-role": "clinic_admin" },
        body: "{}",
      },
    },
    {
      path: "/clinic/patients/00000000-0000-4000-8000-000000000456",
      init: {
        method: "DELETE",
        headers: { ...testToken, "x-test-role": "nurse" },
      },
    },
  ];

  for (const request of requests) {
    const response = await createApp().request(request.path, request.init, testEnv());
    assert.equal(response.status, 403);
  }
});

test("Pharmacists cannot browse the patient directory", async () => {
  const response = await createApp().request(
    "/clinic/patients",
    { headers: { ...testToken, "x-test-role": "pharmacist" } },
    testEnv(),
  );

  assert.equal(response.status, 403);
});

test("patient creation allocates a tenant-scoped number and writes both audit records", async () => {
  const statements = [];
  const sql = async (parts, ...values) => {
    const text = parts.join("?");
    statements.push({ text, values });
    if (text.includes("FROM clinic_organizations") && text.includes("created_by")) {
      return [{ id: "00000000-0000-4000-8000-000000000234" }];
    }
    if (text.includes("UPDATE clinic_organizations org") && text.includes("INSERT INTO clinic_patients")) {
      return [{
        id: "00000000-0000-4000-8000-000000000345",
        patient_number: "PAT-202610-0001",
        first_name: "Amina",
        last_name: "Test",
      }];
    }
    throw new Error("Unexpected Clinic SQL statement.");
  };
  const response = await createApp().request(
    "/clinic/patients",
    {
      method: "POST",
      headers: {
        ...testToken,
        "content-type": "application/json",
        "x-test-role": "clinic_admin",
      },
      body: JSON.stringify({
        first_name: "Amina",
        last_name: "Test",
        allergies: "Test-only value",
      }),
    },
    { __sql: sql },
  );
  const body = await response.json();
  const createStatement = statements.find(({ text }) =>
    text.includes("INSERT INTO clinic_patients"),
  );

  assert.equal(response.status, 201);
  assert.equal(body.patient.patient_number, "PAT-202610-0001");
  assert.match(createStatement.text, /UPDATE clinic_organizations org/u);
  assert.match(createStatement.text, /Africa\/Kampala/u);
  assert.match(createStatement.text, /INSERT INTO clinic_audit/u);
  assert.match(createStatement.text, /INSERT INTO audit_log/u);
  assert.match(
    createStatement.text,
    /jsonb_build_object\('patient_number', patient_number\)/u,
  );
  assert.doesNotMatch(
    createStatement.text,
    /jsonb_build_object\([^)]*allergies/iu,
  );
});
