import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import farmCommerce from "../src/routes/farm-commerce.ts";
import farmFacilities from "../src/routes/farm-facilities.ts";

const USER_ID = "00000000-0000-4000-8000-000000000123";
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000201";
const LOCATION_ID = "00000000-0000-4000-8000-000000000202";
const PRODUCT_ID = "00000000-0000-4000-8000-000000000203";
const PRODUCT_2_ID = "00000000-0000-4000-8000-000000000206";
const SALE_ID = "00000000-0000-4000-8000-000000000204";
const app = new Hono();
app.use("*", async (c, next) => {
  c.set("user", {
    id: USER_ID,
    name: "Farm test user",
    role: c.req.header("x-test-role") || "farm_admin",
    sector: "farm",
  });
  await next();
});
app.route("/api/farm", farmCommerce);
app.route("/api/farm", farmFacilities);
app.onError((error, c) => c.json({ error: error?.code || "INTERNAL_ERROR" }, error?.status || 500));

function request(path, { role = "farm_admin", method = "GET", body, sql = async () => [] } = {}) {
  const headers = new Headers({ "x-test-role": role });
  if (body !== undefined) headers.set("content-type", "application/json");
  return app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }, { __sql: sql });
}

function farmScopeRows(text) {
  if (text.includes("SELECT organization_id AS id") && text.includes("FROM farm_workers")) {
    return [{ id: ORGANIZATION_ID, worker_id: "00000000-0000-4000-8000-000000000205", location_id: LOCATION_ID }];
  }
  return null;
}

test("farm workers cannot confirm payments or authorize releases", async () => {
  let calls = 0;
  const sql = async () => { calls += 1; return []; };
  const payment = await request(`/api/farm/sales/${SALE_ID}/confirm-payment`, {
    role: "farm_worker", method: "POST", body: { payment_channel: "mobile_money" }, sql,
  });
  const authorization = await request(`/api/farm/sales/${SALE_ID}/authorize-release`, {
    role: "farm_worker", method: "POST", body: {}, sql,
  });
  assert.equal(payment.status, 403);
  assert.equal(authorization.status, 403);
  assert.equal(calls, 0);
});

test("worker sale creation cannot contain payment or discount fields", async () => {
  const calls = [];
  const sql = async (strings, ...values) => {
    calls.push({ text: strings.join(" "), values });
    return farmScopeRows(strings.join(" ")) || [];
  };
  const response = await request("/api/farm/sales", {
    role: "farm_worker",
    method: "POST",
    sql,
    body: {
      payment_channel: "mobile_money",
      items: [{ produce_id: PRODUCT_ID, quantity: 1 }],
    },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "WORKER_PAYMENT_FORBIDDEN");
  const discount = await request("/api/farm/sales", {
    role: "farm_worker", method: "POST", sql,
    body: { discount: 100, items: [{ produce_id: PRODUCT_ID, quantity: 1 }] },
  });
  assert.equal(discount.status, 403);
  assert.equal((await discount.json()).error, "WORKER_DISCOUNT_FORBIDDEN");
  assert.equal(calls.length, 2);
});

test("worker sale lists are filtered to the authenticated worker", async () => {
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join(" ");
    calls.push({ text, values });
    return farmScopeRows(text) || (text.includes("FROM farm_sales s") ? [{
      id: SALE_ID,
      sale_number: "SAL-202610-0001",
      status: "pending_owner_review",
      recorded_by: USER_ID,
      recorded_by_name: "Farm test user",
      items: [],
    }] : []);
  };
  const response = await request("/api/farm/sales", { role: "farm_worker", sql });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.sales.length, 1);
  assert.equal(payload.sales[0].recorded_by, USER_ID);
  const query = calls.find((call) => call.text.includes("FROM farm_sales s"));
  assert.ok(query.text.includes("s.recorded_by ="));
  assert.ok(query.values.includes(USER_ID));
});

test("only workers can create sales; manager and admin sale creation is denied", async () => {
  let calls = 0;
  const sql = async () => { calls += 1; return []; };
  for (const role of ["farm_manager", "farm_admin"]) {
    const response = await request("/api/farm/sales", {
      role,
      method: "POST",
      sql,
      body: { items: [{ produce_id: PRODUCT_ID, quantity: 1 }] },
    });
    assert.equal(response.status, 403);
  }
  assert.equal(calls, 0);
});

test("workers create unpaid sales awaiting owner review without deducting inventory", async () => {
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join(" ");
    calls.push({ text, values });
    const scope = farmScopeRows(text);
    if (scope) return scope;
    if (text.includes("FROM farm_locations")) return [{ id: LOCATION_ID }];
    if (text.includes("SELECT id, name, location_id, selling_price, current_stock")) {
      return [
        { id: PRODUCT_ID, name: "Tomatoes", location_id: null, selling_price: 2500, current_stock: 12 },
        { id: PRODUCT_2_ID, name: "Onions", location_id: null, selling_price: 2500, current_stock: 12 },
      ];
    }
    if (text.includes("MAX(SUBSTRING(s.sale_number FROM 12)")) return [{ last_sequence: 0 }];
    if (text.includes("INSERT INTO farm_sales")) {
      return [{
        id: SALE_ID,
        sale_number: "SAL-202610-0001",
        status: "pending_owner_review",
        amount_paid: 0,
        balance_due: 7500,
        missing_count: 0,
      }];
    }
    throw new Error(`Unexpected mocked Farm commerce SQL: ${text}`);
  };
  const response = await request("/api/farm/sales", {
    role: "farm_worker",
    method: "POST",
    sql,
    body: {
      sale_date: "2026-10-07",
      buyer_name: "Buyer",
      items: [
        { produce_id: PRODUCT_ID, quantity: 2 },
        { produce_id: PRODUCT_2_ID, quantity: 1 },
      ],
    },
  });
  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.sale.status, "pending_owner_review");
  assert.equal(payload.sale.amount_paid, 0);
  assert.equal(payload.sale.balance_due, 7500);
  const insert = calls.find((call) => call.text.includes("INSERT INTO farm_sales"));
  assert.ok(insert.values.includes("pending_owner_review"));
  assert.ok(insert.values.includes(0));
  assert.ok(!insert.values.includes("mobile_money"));
  assert.ok(insert.text.includes("requested_products"));
  assert.ok(!insert.text.includes("UPDATE farm_produce"));
  assert.ok(!insert.text.includes("INSERT INTO farm_produce_movements"));
});

test("owner payment confirmation accepts only mobile money, PayPal, bank, or card", async () => {
  for (const channel of ["mobile_money", "paypal", "bank", "card"]) {
    const sql = async (strings, ...values) => {
      const text = strings.join(" ");
      return farmScopeRows(text) || (text.includes("WITH updated AS") ? [{
        id: SALE_ID, status: "payment_confirmed",
      }] : []);
    };
    const response = await request(`/api/farm/sales/${SALE_ID}/confirm-payment`, {
      role: "farm_manager",
      method: "POST",
      sql,
      body: { payment_channel: channel },
    });
    assert.equal(response.status, 200, `${channel} should be accepted`);
  }
  for (const channel of ["cash_owner", "other"]) {
    const calls = [];
    const sql = async (strings, ...values) => {
      const text = strings.join(" ");
      calls.push(text);
      return farmScopeRows(text) || [];
    };
    const response = await request(`/api/farm/sales/${SALE_ID}/confirm-payment`, {
      role: "farm_manager",
      method: "POST",
      sql,
      body: { payment_channel: channel },
    });
    assert.equal(response.status, 400, `${channel} should be rejected`);
    assert.equal((await response.json()).error, "VALIDATION_ERROR");
    assert.equal(calls.filter((text) => text.includes("WITH updated AS")).length, 0);
  }
});

test("workers cannot release another worker's sale", async () => {
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join(" ");
    calls.push({ text, values });
    return farmScopeRows(text) || [];
  };
  const response = await request(`/api/farm/sales/${SALE_ID}/mark-released`, {
    role: "farm_worker", method: "POST", body: {}, sql,
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "SALE_STATE_CONFLICT");
  const transition = calls.find((call) => call.text.includes("WITH selected_sale AS MATERIALIZED"));
  assert.ok(transition.text.includes("s.recorded_by"));
  assert.ok(transition.text.includes("s.location_id"));
  assert.ok(transition.values.includes(USER_ID));
  assert.ok(transition.values.includes(LOCATION_ID));
});

test("farm managers and admins cannot mark goods released", async () => {
  let calls = 0;
  const sql = async () => { calls += 1; return []; };
  for (const role of ["farm_manager", "farm_admin"]) {
    const response = await request(`/api/farm/sales/${SALE_ID}/mark-released`, {
      role, method: "POST", body: {}, sql,
    });
    assert.equal(response.status, 403);
  }
  assert.equal(calls, 0);
});

test("goods release deducts stock, records movement, and audits within one SQL operation", async () => {
  const calls = [];
  const sql = async (strings, ...values) => {
    const text = strings.join(" ");
    calls.push({ text, values });
    return farmScopeRows(text) || (text.includes("WITH selected_sale AS MATERIALIZED") ? [{
      id: SALE_ID,
      sale_number: "SAL-202610-0001",
      status: "released",
      missing_count: 0,
      shortage_count: 0,
    }] : []);
  };
  const response = await request(`/api/farm/sales/${SALE_ID}/mark-released`, {
    role: "farm_worker", method: "POST", body: {}, sql,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sale.status, "released");
  const transition = calls.find((call) => call.text.includes("WITH selected_sale AS MATERIALIZED"));
  assert.ok(transition.text.includes("UPDATE farm_produce p"));
  assert.ok(transition.text.includes("s.recorded_by ="));
  assert.ok(transition.text.includes("s.location_id ="));
  assert.ok(transition.text.includes("INSERT INTO farm_produce_movements"));
  assert.ok(transition.text.includes("farm.sale.released"));
  assert.equal(calls.filter((call) => call.text.includes("WITH selected_sale AS MATERIALIZED")).length, 1);
});

test("farm workers cannot cancel sales or write expense records", async () => {
  let calls = 0;
  const sql = async () => { calls += 1; return []; };
  const cancel = await request(`/api/farm/sales/${SALE_ID}/cancel`, {
    role: "farm_worker", method: "POST", body: {}, sql,
  });
  const expense = await request("/api/farm/expenses", {
    role: "farm_worker", method: "POST", body: {}, sql,
  });
  assert.equal(cancel.status, 403);
  assert.equal(expense.status, 403);
  assert.equal(calls, 0);
});
