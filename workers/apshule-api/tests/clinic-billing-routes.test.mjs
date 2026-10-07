import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createClinicBillingRoutes } from "../src/routes/clinic-billing.ts";
import { createClinicSettlementRoutes } from "../src/routes/clinic-settlements.ts";
import patientPortalRoutes from "../src/routes/clinic-patient-portal.ts";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000234";
const ENTITY_ID = "00000000-0000-4000-8000-000000000456";
const ACTOR_ID = "00000000-0000-4000-8000-000000000123";
const roles = [
  "clinic_admin",
  "doctor",
  "nurse",
  "pharmacist",
  "receptionist",
  "patient",
];

function createApp() {
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
  const helpers = {
    organizationForRequest: async () => ORGANIZATION_ID,
    requestIp: () => "127.0.0.1",
  };
  app.route("/", createClinicBillingRoutes(helpers));
  app.route("/", createClinicSettlementRoutes(helpers));
  app.route("/", patientPortalRoutes);
  return app;
}

async function call(app, role, path, method = "GET", body) {
  const headers = { "x-test-role": role };
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return app.request(path, init, { __sql: async () => [] });
}

test("clinic billing read and write role guards match the approved role matrix", async () => {
  const app = createApp();
  const cases = [
    { method: "GET", path: "/clinic/services", allowed: ["clinic_admin", "doctor", "nurse", "receptionist", "pharmacist"] },
    { method: "POST", path: "/clinic/services", allowed: ["clinic_admin"] },
    { method: "GET", path: "/clinic/insurance-providers", allowed: ["clinic_admin", "nurse", "receptionist"] },
    { method: "POST", path: "/clinic/insurance-providers", allowed: ["clinic_admin"] },
    { method: "PATCH", path: `/clinic/patients/${ENTITY_ID}/insurance`, allowed: ["clinic_admin", "nurse", "receptionist"] },
    { method: "POST", path: `/clinic/patients/${ENTITY_ID}/create-portal-access`, allowed: ["clinic_admin", "receptionist"] },
    { method: "POST", path: "/clinic/invoices", allowed: ["clinic_admin", "receptionist", "nurse"] },
    { method: "GET", path: "/clinic/invoices", allowed: ["clinic_admin", "receptionist", "nurse"] },
    { method: "PATCH", path: `/clinic/invoices/${ENTITY_ID}`, allowed: ["clinic_admin"] },
    { method: "POST", path: `/clinic/invoices/${ENTITY_ID}/payments`, allowed: ["clinic_admin", "receptionist"] },
    { method: "POST", path: `/clinic/payments/${ENTITY_ID}/reverse`, allowed: ["clinic_admin"] },
    { method: "POST", path: `/clinic/invoices/${ENTITY_ID}/claim`, allowed: ["clinic_admin"] },
    { method: "GET", path: "/clinic/claims", allowed: ["clinic_admin", "nurse", "receptionist"] },
    { method: "PATCH", path: `/clinic/claims/${ENTITY_ID}`, allowed: ["clinic_admin"] },
  ];

  for (const route of cases) {
    for (const role of roles) {
      const body = ["GET", "HEAD"].includes(route.method) ? undefined : {};
      const response = await call(app, role, route.path, route.method, body);
      if (route.allowed.includes(role)) {
        assert.notEqual(response.status, 403, `${role} should pass ${route.method} ${route.path}`);
      } else {
        assert.equal(response.status, 403, `${role} must be blocked from ${route.method} ${route.path}`);
      }
    }
  }
});

test("patient portal routes accept patient accounts and reject clinic staff", async () => {
  const app = createApp();
  const patientResponse = await call(app, "patient", "/clinic-patient/me");
  const staffResponse = await call(app, "clinic_admin", "/clinic-patient/me");

  assert.notEqual(patientResponse.status, 403, "patient account should pass the portal role guard");
  assert.equal(staffResponse.status, 403, "clinic staff must not use the patient-owned portal route");
});
