import assert from "node:assert/strict";
import test from "node:test";
import payments from "../src/routes/payments.ts";

function createPaymentState() {
  return {
    payment: {
      id: "00000000-0000-4000-8000-000000000001",
      user_id: "00000000-0000-4000-8000-000000000002",
      plan: "Daily",
      plan_code: "daily",
      amount: "500",
      currency: "UGX",
      reference: "SUB-TEST-1",
      yo_transaction_ref: "YO-PRIVATE-1",
      status: "pending",
      subscription_end: null,
    },
    subscriptionsCreated: 0,
    completionSql: "",
    ipnUpdates: 0,
    auditEvents: 0,
  };
}

function createMockSql(state) {
  return async (parts, ...values) => {
    const query = parts.join(" ");
    if (query.includes("FROM platform_settings")) return [];
    if (query.includes("SELECT id, user_id") && query.includes("FROM payments")) {
      return [{ ...state.payment }];
    }
    if (query.includes("ipn_payload =")) {
      state.ipnUpdates++;
      return [];
    }
    if (query.includes("WITH completed AS")) {
      state.completionSql = query;
      if (state.payment.status === "pending" || state.payment.status === "failed") {
        state.payment.status = "success";
        state.subscriptionsCreated++;
        state.auditEvents++;
      }
      return [{ status: state.payment.status }];
    }
    if (query.includes("INSERT INTO audit_log")) {
      state.auditEvents++;
      return [];
    }
    throw new Error(`Unexpected test SQL: ${query}; values=${values.length}`);
  };
}

async function sendIpn(state, env) {
  return payments.request(
    "/ipn",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "ExternalReference=SUB-TEST-1&TransactionStatus=SUCCESS&Amount=500",
    },
    env,
  );
}

test("repeated success IPNs confirm once and create only one subscription", async () => {
  const originalFetch = globalThis.fetch;
  const state = createPaymentState();
  let providerChecks = 0;
  globalThis.fetch = async (_input, init) => {
    providerChecks++;
    assert.match(init.body, /<PrivateTransactionReference>YO-PRIVATE-1<\/PrivateTransactionReference>/u);
    return new Response(
      "<AutoCreate><Response><Status>OK</Status><TransactionStatus>Success</TransactionStatus><Reference>SUB-TEST-1</Reference><Amount>500</Amount></Response></AutoCreate>",
      { status: 200 },
    );
  };

  try {
    const env = {
      __sql: createMockSql(state),
      YO_API_USERNAME: "test-user",
      YO_API_PASSWORD: "test-password",
      YO_BASE_URL: "https://payments.yo.co.ug",
    };
    const first = await sendIpn(state, env);
    assert.equal(first.status, 200);
    assert.equal(await first.text(), "OK");
    assert.match(first.headers.get("content-type") || "", /^text\/plain/u);

    const retry = await sendIpn(state, env);
    assert.equal(retry.status, 200);
    assert.equal(await retry.text(), "OK");
    assert.equal(providerChecks, 1);
    assert.equal(state.ipnUpdates, 2);
    assert.equal(state.subscriptionsCreated, 1);
    assert.equal(state.payment.status, "success");
    assert.equal(state.auditEvents, 3);
    assert.match(state.completionSql, /ON CONFLICT \(payment_id\)/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a trusted status amount mismatch leaves payment pending", async () => {
  const originalFetch = globalThis.fetch;
  const state = createPaymentState();
  globalThis.fetch = async () =>
    new Response(
      "<AutoCreate><Response><Status>OK</Status><TransactionStatus>Success</TransactionStatus><Reference>SUB-TEST-1</Reference><Amount>499</Amount></Response></AutoCreate>",
      { status: 200 },
    );

  try {
    const response = await sendIpn(state, {
      __sql: createMockSql(state),
      YO_API_USERNAME: "test-user",
      YO_API_PASSWORD: "test-password",
      YO_BASE_URL: "https://payments.yo.co.ug",
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "OK");
    assert.equal(state.payment.status, "pending");
    assert.equal(state.subscriptionsCreated, 0);
    assert.equal(state.auditEvents, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});