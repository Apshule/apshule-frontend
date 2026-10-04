import { Hono } from "hono";
import { ApiError, getDb, isUniqueViolation, requireEnv } from "../db.js";
import { authMiddleware } from "../auth.js";
import { readJson, requiredString, validEmail } from "../http.js";
import {
  checkStatus,
  findYoField,
  initiateDeposit,
  normalizedYoStatus,
  parseXmlFields,
  type YoFields,
} from "../yopayments.js";
import type { AppEnv } from "../types.js";

const payments = new Hono<AppEnv>();

interface PaymentRow {
  id: string;
  user_id: string | null;
  plan: string;
  amount: string | number;
  currency: string;
  reference: string;
  yo_transaction_ref: string | null;
  status: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  raw_response: unknown;
  created_at: string;
  updated_at: string;
}

async function saveVerifiedStatus(
  sql: ReturnType<typeof getDb>,
  payment: PaymentRow,
  yoResult: YoFields,
) {
  const status = normalizedYoStatus(yoResult);
  const serialized = JSON.stringify(yoResult);
  if (status === "completed") {
    await sql`
      UPDATE payments
      SET status = 'completed', raw_response = ${serialized}::jsonb, updated_at = NOW()
      WHERE id = ${payment.id}
    `;
    if (payment.user_id) {
      await sql`
        UPDATE users
        SET subscription = ${payment.plan},
            subscription_active = TRUE,
            subscription_date = NOW()
        WHERE id = ${payment.user_id}
      `;
    }
  } else if (status === "failed") {
    await sql`
      UPDATE payments
      SET status = 'failed', raw_response = ${serialized}::jsonb, updated_at = NOW()
      WHERE id = ${payment.id} AND status = 'pending'
    `;
  } else {
    await sql`
      UPDATE payments
      SET raw_response = ${serialized}::jsonb, updated_at = NOW()
      WHERE id = ${payment.id} AND status = 'pending'
    `;
  }
  return status;
}

payments.post("/initiate", authMiddleware, async (c) => {
  const body = await readJson(c);
  const plan = requiredString(body, "plan", { max: 120 });
  const phone = requiredString(body, "phone", { max: 40 });
  const reference = requiredString(body, "reference", { min: 8, max: 100 });
  const amountValue = body.amount;
  const amount =
    typeof amountValue === "number"
      ? amountValue
      : typeof amountValue === "string"
        ? Number(amountValue)
        : Number.NaN;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) {
    throw new ApiError(400, "VALIDATION_ERROR", "amount must be a positive UGX amount.");
  }
  if (!/^[+0-9() -]{7,40}$/u.test(phone)) {
    throw new ApiError(400, "VALIDATION_ERROR", "phone must be a valid phone number.");
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(reference)) {
    throw new ApiError(400, "VALIDATION_ERROR", "reference may contain only letters, numbers, _ and -.");
  }

  const user = c.get("user");
  const sql = getDb(c.env);
  const profile = await sql`SELECT name, email FROM users WHERE id = ${user.id} LIMIT 1`;
  if (!profile[0]) throw new ApiError(401, "INVALID_TOKEN", "The account is no longer active.");
  const current = profile[0] as { name: string; email: string };
  if (body.email !== undefined) {
    const email = requiredString(body, "email", { max: 254 }).toLowerCase();
    if (!validEmail(email) || email !== current.email.toLowerCase()) {
      throw new ApiError(400, "VALIDATION_ERROR", "email must match the signed-in account.");
    }
  }
  if (body.name !== undefined) {
    const name = requiredString(body, "name", { max: 120 });
    if (name !== current.name) {
      throw new ApiError(400, "VALIDATION_ERROR", "name must match the signed-in account.");
    }
  }
  const ipnUrl = requireEnv(c.env.YO_IPN_URL, "YO_IPN_URL");
  try {
    const parsedIpnUrl = new URL(ipnUrl);
    if (parsedIpnUrl.protocol !== "https:") throw new Error("HTTPS required");
  } catch {
    throw new ApiError(503, "INVALID_CONFIGURATION", "YO_IPN_URL must be an HTTPS URL.");
  }

  let payment: PaymentRow;
  try {
    const rows = await sql`
      INSERT INTO payments (user_id, plan, amount, currency, reference, status, phone, email, name)
      VALUES (${user.id}, ${plan}, ${amount}, 'UGX', ${reference}, 'pending', ${phone}, ${current.email}, ${current.name})
      RETURNING id, user_id, plan, amount, currency, reference, yo_transaction_ref,
        status, phone, email, name, raw_response, created_at, updated_at
    `;
    payment = rows[0] as PaymentRow;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "REFERENCE_IN_USE", "This payment reference has already been used.");
    }
    throw error;
  }

  try {
    const yoResult = await initiateDeposit(c.env, {
      amount,
      account: phone,
      narrative: `Apshule ${plan}`,
      phone,
      reference,
      ipnUrl,
    });
    const transactionRef =
      findYoField(yoResult, "transactionref", "providerreference", "transactionid") ??
      reference;
    const serialized = JSON.stringify(yoResult);
    const updated = await sql`
      UPDATE payments
      SET yo_transaction_ref = ${transactionRef},
          raw_response = ${serialized}::jsonb,
          updated_at = NOW()
      WHERE id = ${payment.id}
      RETURNING id, user_id, plan, amount, currency, reference, yo_transaction_ref,
        status, phone, email, name, raw_response, created_at, updated_at
    `;
    return c.json({ payment: updated[0] }, 201);
  } catch (error) {
    await sql`
      UPDATE payments
      SET status = 'failed',
          raw_response = ${JSON.stringify({ error: "YO_REQUEST_FAILED" })}::jsonb,
          updated_at = NOW()
      WHERE id = ${payment.id} AND status = 'pending'
    `;
    throw error;
  }
});

payments.post("/status", authMiddleware, async (c) => {
  const body = await readJson(c);
  const reference = requiredString(body, "reference", { min: 8, max: 100 });
  const user = c.get("user");
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, user_id, plan, amount, currency, reference, yo_transaction_ref,
      status, phone, email, name, raw_response, created_at, updated_at
    FROM payments
    WHERE reference = ${reference}
      AND (${user.role === "superadmin"} OR user_id = ${user.id})
    LIMIT 1
  `;
  const payment = rows[0] as PaymentRow | undefined;
  if (!payment) throw new ApiError(404, "PAYMENT_NOT_FOUND", "Payment was not found.");

  if (payment.status === "pending") {
    const yoResult = await checkStatus(c.env, {
      transactionRef: payment.yo_transaction_ref ?? payment.reference,
    });
    await saveVerifiedStatus(sql, payment, yoResult);
  }

  const updated = await sql`
    SELECT id, user_id, plan, amount, currency, reference, yo_transaction_ref,
      status, phone, email, name, created_at, updated_at
    FROM payments WHERE id = ${payment.id} LIMIT 1
  `;
  return c.json({ payment: updated[0] });
});

payments.post("/ipn", async (c) => {
  const rawBody = await c.req.text();
  try {
    let fields: YoFields;
    if (c.req.header("Content-Type")?.includes("application/json")) {
      const parsed: unknown = JSON.parse(rawBody);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return c.text("OK");
      }
      fields = Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [key.toLowerCase(), String(value)]),
      );
    } else {
      fields = parseXmlFields(rawBody);
    }

    const reference = findYoField(
      fields,
      "reference",
      "externalreference",
      "clientreference",
      "providerreference",
    );
    if (!reference) return c.text("OK");

    const sql = getDb(c.env);
    const rows = await sql`
      SELECT id, user_id, plan, amount, currency, reference, yo_transaction_ref,
        status, phone, email, name, raw_response, created_at, updated_at
      FROM payments
      WHERE reference = ${reference} AND status = 'pending'
      LIMIT 1
    `;
    const payment = rows[0] as PaymentRow | undefined;
    if (payment) {
      const transactionRef =
        findYoField(fields, "transactionref", "transactionreference", "transactionid") ??
        payment.yo_transaction_ref ??
        payment.reference;
      const yoResult = await checkStatus(c.env, { transactionRef });
      await saveVerifiedStatus(sql, payment, yoResult);
    }
  } catch (error) {
    const code =
      error instanceof ApiError
        ? error.code
        : error instanceof Error
          ? error.name
          : "UNKNOWN_ERROR";
    console.error("Yo IPN verification failed.", { code });
    // Payment state is only changed after a successful server-side status check.
  }
  return c.text("OK");
});

export default payments;