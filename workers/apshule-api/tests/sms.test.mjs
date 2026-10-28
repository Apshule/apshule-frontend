import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatUgandanPhoneNumber,
  sendSmsOtp,
} from "../src/sms.ts";

const env = {
  AFRICASTALKING_API_KEY: "test-api-key",
  AFRICASTALKING_USERNAME: "test-user",
};

test("formats Ugandan local numbers as +256 international numbers", () => {
  assert.equal(formatUgandanPhoneNumber("0755546291"), "+256755546291");
  assert.equal(formatUgandanPhoneNumber("755546291"), "+256755546291");
  assert.equal(formatUgandanPhoneNumber("256755546291"), "+256755546291");
  assert.equal(formatUgandanPhoneNumber("+256 755 546 291"), "+256755546291");
  assert.equal(formatUgandanPhoneNumber("+254712345678"), "+254712345678");
});

test("sends SMS to the live endpoint with the formatted number", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({
      SMSMessageData: {
        Recipients: [{ statusCode: 101, status: "Success" }],
      },
    }), { status: 201 });
  };

  try {
    await sendSmsOtp(env, "0755546291", "123456");
    assert.equal(request.url, "https://api.africastalking.com/version1/messaging");
    assert.equal(request.options.headers.apiKey, "test-api-key");
    assert.equal(new URLSearchParams(request.options.body).get("to"), "+256755546291");
    assert.equal(new URLSearchParams(request.options.body).get("message"), "Your Apshule OTP is: 123456");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("logs the provider error while redacting the API key, phone, and OTP", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  let logged = "";
  globalThis.fetch = async () => new Response(
    JSON.stringify({ errorMessage: "Invalid API Key for 0755546291, OTP 123456" }),
    { status: 401 },
  );
  console.error = (...args) => { logged = args.join(" "); };

  try {
    await assert.rejects(sendSmsOtp(env, "0755546291", "123456"), /SMS delivery failed/);
    assert.match(logged, /Invalid API Key/);
    assert.doesNotMatch(logged, /test-api-key|0755546291|123456/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("logs recipient-level errors returned with an HTTP success status", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  let logged = "";
  globalThis.fetch = async () => new Response(JSON.stringify({
    SMSMessageData: {
      Recipients: [{
        statusCode: 403,
        status: "Failed",
        message: "InvalidPhoneNumber",
        number: "+256755546291",
      }],
    },
  }), { status: 201 });
  console.error = (...args) => { logged = args.join(" "); };

  try {
    await assert.rejects(sendSmsOtp(env, "0755546291", "123456"), /SMS delivery failed/);
    assert.match(logged, /InvalidPhoneNumber/);
    assert.doesNotMatch(logged, /0755546291|\+256755546291|123456/);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});
