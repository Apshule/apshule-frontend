import assert from "node:assert/strict";
import test from "node:test";
import {
  checkStatus,
  findYoField,
  initiateDeposit,
  normalizedYoStatus,
  normalizePhone,
  parseIpnPayload,
  parseXmlFields,
  xmlEscape,
} from "../src/yopayments.ts";

test("normalizes Ugandan mobile numbers and rejects invalid lengths", () => {
  assert.equal(normalizePhone("0705 732 540"), "256705732540");
  assert.equal(normalizePhone("+256 705 732 540"), "256705732540");
  assert.throws(() => normalizePhone("0705 123"), { code: "INVALID_PHONE" });
});

test("XML escaping covers XML metacharacters", () => {
  assert.equal(xmlEscape(`<tag a="b">&'`), "&lt;tag a=&quot;b&quot;&gt;&amp;&apos;");
});

test("parses JSON and form-encoded IPN fields without trusting their status", () => {
  const jsonFields = parseIpnPayload(
    JSON.stringify({ ExternalReference: "SUB-1", Status: "OK", Amount: 500 }),
    "application/json",
  );
  assert.equal(findYoField(jsonFields, "externalreference"), "SUB-1");
  assert.equal(findYoField(jsonFields, "amount"), "500");
  assert.equal(normalizedYoStatus(jsonFields), "success");

  const formFields = parseIpnPayload(
    "ExternalReference=SUB-2&TransactionStatus=Pending&Amount=500",
    "application/x-www-form-urlencoded",
  );
  assert.equal(findYoField(formFields, "reference"), undefined);
  assert.equal(findYoField(formFields, "externalreference"), "SUB-2");
  assert.equal(normalizedYoStatus(formFields), "pending");
});

test("maps provider success and failure states", () => {
  assert.equal(normalizedYoStatus({ transactionstatus: "Successful" }), "success");
  assert.equal(normalizedYoStatus({ PaymentStatus: "declined" }), "failed");
  assert.equal(normalizedYoStatus({ TransactionState: "processing" }), "pending");
});

test("extracts nested XML leaf fields without dropping the first response field", () => {
  const fields = parseXmlFields(
    "<AutoCreate><Response><Status>OK</Status><TransactionStatus>Success</TransactionStatus><Amount>500</Amount></Response></AutoCreate>",
  );
  assert.equal(findYoField(fields, "status"), "OK");
  assert.equal(findYoField(fields, "transactionstatus"), "Success");
  assert.equal(findYoField(fields, "amount"), "500");
});

test("initiation sends the specified XML request to the production base URL", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl;
  let capturedInit;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(
      "<AutoCreate><Response><Status>OK</Status><TransactionReference>YO-REF</TransactionReference></Response></AutoCreate>",
      { status: 200, headers: { "content-type": "text/xml" } },
    );
  };

  try {
    const result = await initiateDeposit(
      {
        YO_API_USERNAME: "test-user",
        YO_API_PASSWORD: "test-password",
        YO_BASE_URL: "https://payments.yo.co.ug",
      },
      {
        amount: 500,
        account: "256705732540",
        narrative: "APSHULE Daily <Subscription>",
        phone: "256705732540",
        reference: "SUB-TEST",
        ipnUrl: "https://appshule.com/api/yopayments/ipn",
      },
    );

    assert.equal(result.ok, true);
    assert.equal(capturedUrl, "https://payments.yo.co.ug/acdepositfunds");
    assert.equal(capturedInit.method, "POST");
    assert.equal(capturedInit.headers.Authorization, `Basic ${btoa("test-user:test-password")}`);
    assert.equal(capturedInit.headers["Content-Type"], "text/xml");
    assert.match(capturedInit.body, /<Method>acdepositfunds<\/Method>/u);
    assert.match(capturedInit.body, /<NonBlocking>FALSE<\/NonBlocking>/u);
    assert.match(capturedInit.body, /<Amount>500<\/Amount>/u);
    assert.match(capturedInit.body, /<ExternalReference>SUB-TEST<\/ExternalReference>/u);
    assert.match(capturedInit.body, /APSHULE Daily &lt;Subscription&gt;/u);
    assert.equal(findYoField(result.parsed, "status"), "OK");
    assert.equal(findYoField(result.parsed, "transactionreference"), "YO-REF");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("status checks use PrivateTransactionReference and support YO_API_URL alias", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl;
  let capturedBody;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedBody = init.body;
    return new Response(
      "<AutoCreate><Response><Status>OK</Status><TransactionStatus>Pending</TransactionStatus></Response></AutoCreate>",
      { status: 200 },
    );
  };

  try {
    const result = await checkStatus(
      {
        YO_API_USERNAME: "test-user",
        YO_API_PASSWORD: "test-password",
        YO_API_URL: "https://payments.yo.co.ug/",
      },
      { transactionRef: "YO-PRIVATE-REF" },
    );
    assert.equal(result.ok, true);
    assert.equal(capturedUrl, "https://payments.yo.co.ug/actransactioncheckstatus");
    assert.match(capturedBody, /<Method>actransactioncheckstatus<\/Method>/u);
    assert.match(capturedBody, /<PrivateTransactionReference>YO-PRIVATE-REF<\/PrivateTransactionReference>/u);
    assert.equal(normalizedYoStatus(result.parsed), "pending");
  } finally {
    globalThis.fetch = originalFetch;
  }
});