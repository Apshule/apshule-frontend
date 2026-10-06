import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createClinicPharmacyRoutes } from "../src/routes/clinic-pharmacy.ts";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000234";
const ENTITY_ID = "00000000-0000-4000-8000-000000000456";
const ACTOR_ID = "00000000-0000-4000-8000-000000000123";
const roles = ["clinic_admin", "doctor", "nurse", "pharmacist", "receptionist"];

function createApp(sql = async () => []) {
  const app = new Hono();
  app.onError((error, c) => c.json(
    { error: error.code ?? "INTERNAL_ERROR", message: error.message },
    error.status ?? 500,
  ));
  app.use("*", async (c, next) => {
    c.set("user", {
      id: ACTOR_ID,
      role: c.req.header("x-test-role") || "clinic_admin",
      sector: "clinic",
    });
    await next();
  });
  app.route("/", createClinicPharmacyRoutes({
    organizationForRequest: async () => ORGANIZATION_ID,
    requestIp: () => "127.0.0.1",
  }));
  return app;
}

async function call(app, role, path, method = "GET", body) {
  const headers = { "x-test-role": role };
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return app.request(path, init, { __sql: app.testSql });
}

function appWithSql(sql) {
  const app = createApp(sql);
  app.testSql = sql;
  return app;
}

test("medicine reads are available to all clinic roles; prescription reads exclude nurse and receptionist", async () => {
  const app = appWithSql(async () => []);

  for (const role of roles) {
    const response = await call(app, role, "/clinic/medicines");
    assert.equal(response.status, 200, `${role} should be able to read medicines`);
  }
  for (const role of ["clinic_admin", "doctor", "pharmacist"]) {
    const response = await call(app, role, "/clinic/prescriptions");
    assert.equal(response.status, 200, `${role} should be able to read prescriptions`);
  }
  for (const role of ["nurse", "receptionist"]) {
    const response = await call(app, role, "/clinic/prescriptions");
    assert.equal(response.status, 403, `${role} must not be able to read prescriptions`);
  }
});

test("pharmacy and prescription write guards match the clinic role matrix", async () => {
  const id = encodeURIComponent(ENTITY_ID);
  const emptyApp = appWithSql(async () => []);
  const cases = [
    { method: "POST", path: "/clinic/medicines", allowed: ["clinic_admin", "pharmacist"] },
    { method: "PATCH", path: `/clinic/medicines/${id}`, allowed: ["clinic_admin", "pharmacist"] },
    { method: "DELETE", path: `/clinic/medicines/${id}`, allowed: ["clinic_admin"] },
    { method: "POST", path: `/clinic/medicines/${id}/adjust-stock`, allowed: ["clinic_admin", "pharmacist"] },
    { method: "POST", path: "/clinic/prescriptions", allowed: ["clinic_admin", "doctor"] },
    { method: "PATCH", path: `/clinic/prescriptions/${id}`, allowed: ["doctor"] },
    { method: "POST", path: `/clinic/prescriptions/${id}/cancel`, allowed: ["doctor"] },
    { method: "POST", path: `/clinic/prescriptions/${id}/dispense`, allowed: ["clinic_admin", "pharmacist"] },
  ];

  for (const route of cases) {
    for (const role of roles) {
      const body = route.method === "DELETE" ? undefined : {};
      const response = await call(emptyApp, role, route.path, route.method, body);
      if (route.allowed.includes(role)) {
        assert.notEqual(response.status, 403, `${role} should pass the guard for ${route.method} ${route.path}`);
      } else {
        assert.equal(response.status, 403, `${role} must be blocked from ${route.method} ${route.path}`);
      }
    }
  }
});

test("dispense reports the first stock shortage without partially dispensing", async () => {
  const statements = [];
  const app = appWithSql(async (parts) => {
    const query = parts.join("?");
    statements.push(query);
    return [{
      found: true,
      current_status: "pending",
      prescription: null,
      shortages: [{ medicine_name: "Amoxicillin", required_quantity: 3, available: 2 }],
    }];
  });
  const response = await call(
    app,
    "pharmacist",
    `/clinic/prescriptions/${encodeURIComponent(ENTITY_ID)}/dispense`,
    "POST",
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Insufficient stock for Amoxicillin" });
  assert.equal(statements.length, 1, "dispense stock and audit writes must share one SQL statement");
  assert.match(statements[0], /WITH target AS MATERIALIZED/u);
  assert.match(statements[0], /stock_check AS MATERIALIZED/u);
  assert.match(statements[0], /INSERT INTO clinic_stock_movements/u);
  assert.match(statements[0], /INSERT INTO clinic_audit/u);
  assert.match(statements[0], /INSERT INTO audit_log/u);
});
