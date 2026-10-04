import { Hono, type Context } from "hono";
import { ApiError, getDb, isUniqueViolation, requireEnv } from "../db.js";
import { authMiddleware } from "../auth.js";
import { readJson, requiredString } from "../http.js";
import {
  checkStatus,
  findYoField,
  initiateDeposit,
  normalizedYoStatus,
  normalizePhone,
  parseIpnPayload,
  type YoFields,
  type YoApiResponse,
} from "../yopayments.js";
import type { AppEnv } from "../types.js";

const payments = new Hono<AppEnv>();

interface PaymentRow {
  id: string;
  user_id: string | null;
  plan: string;
  plan_code: string;
  amount: string | number;
  currency: string;
  reference: string;
  yo_transaction_ref: string | null;
  status: string;
  subscription_end: string | null;
}

function requestIp(c: Context<AppEnv>): string | null {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    null
  )?.slice(0, 255) ?? null;
}

function isSuccessfulStatus(status: string): boolean {
  return status === "success" || status === "completed";
}

function responseStatus(status: string): string {
  return status === "completed" ? "success" : status;
}

function yoResponseRejected(fields: YoFields): boolean {
  const status = findYoField(fields, "status", "result", "transactionstatus")?.toLowerCase();
  const error = findYoField(fields, "error", "errormessage", "errorcode");
  return Boolean(
    (status && /^(error|failed|failure|rejected|invalid|denied)$/u.test(status)) ||
      (error && !/^(0|ok|none)$/iu.test(error)),
  );
}

function trustedPaymentMatches(fields: YoFields, payment: PaymentRow): boolean {
  const providerReference = findYoField(
    fields,
    "externalreference",
    "reference",
    "clientreference",
    "privatetransactionreference",
    "transactionreference",
    "transactionref",
  );
  const providerAmount = findYoField(fields, "amount", "transactionamount", "amountreceived");
  const currency = findYoField(fields, "currency", "transactioncurrency");
  const knownReferences = new Set(
    [payment.reference, payment.yo_transaction_ref].filter(
      (reference): reference is string => Boolean(reference),
    ),
  );
  return Boolean(
    providerReference &&
      knownReferences.has(providerReference) &&
      providerAmount !== undefined &&
      Number.isFinite(Number(providerAmount)) &&
      Number(providerAmount) === Number(payment.amount) &&
      (!currency || currency.toUpperCase() === payment.currency.toUpperCase()),
  );
}

function secureRedirectUrl(fields: YoFields): string | undefined {
  const raw = findYoField(fields, "redirecturl", "approvalurl");
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function recordAudit(
  sql: ReturnType<typeof getDb>,
  input: {
    action: string;
    targetId: string | null;
    metadata: Record<string, unknown>;
    actorId?: string | null;
    sector?: string | null;
    ip?: string | null;
  },
) {
  await sql`
    INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
    VALUES (
      ${input.actorId ?? null},
      ${input.sector ?? null},
      ${input.action},
      'payments',
      ${input.targetId},
      ${JSON.stringify(input.metadata)}::jsonb,
      ${input.ip ?? null}
    )
  `;
}

async function recordIgnoredIpn(c: Context<AppEnv>, reason: string) {
  try {
    await recordAudit(getDb(c.env), {
      action: "payment_ipn",
      targetId: null,
      metadata: { result: "ignored", reason },
      ip: requestIp(c),
    });
  } catch (error) {
    const code = error instanceof Error ? error.name : "UNKNOWN_ERROR";
    console.error("Yo IPN audit write failed.", { code });
  }
}

async function saveVerifiedStatus(
  sql: ReturnType<typeof getDb>,
  payment: PaymentRow,
  yoResult: YoFields,
): Promise<string> {
  const status = normalizedYoStatus(yoResult);
  const serialized = JSON.stringify(yoResult);

  if (status === "success") {
    if (!trustedPaymentMatches(yoResult, payment)) {
      await recordAudit(sql, {
        action: "payment_verification_mismatch",
        targetId: payment.id,
        metadata: { reference: payment.reference, result: "pending" },
      });
      return "pending";
    }

    const rows = await sql`
      WITH completed AS (
        UPDATE payments p
        SET status = 'success',
            raw_response = ${serialized}::jsonb,
            subscription_start = COALESCE(p.subscription_start, NOW()),
            subscription_end = COALESCE(
              p.subscription_end,
              NOW() + (plan.duration_days * INTERVAL '1 day')
            ),
            updated_at = NOW()
        FROM subscription_plans plan
        WHERE p.id = ${payment.id}
          AND p.plan_code = plan.code
          AND p.status IN ('pending', 'failed')
        RETURNING
          p.id, p.user_id, p.plan_code, p.plan, p.amount, p.reference,
          p.subscription_start, p.subscription_end
      ),
      created_subscription AS (
        INSERT INTO user_subscriptions (
          user_id, plan_code, payment_id, start_date, end_date, active
        )
        SELECT
          user_id, plan_code, id, subscription_start, subscription_end, TRUE
        FROM completed
        WHERE user_id IS NOT NULL
        ON CONFLICT (payment_id) WHERE payment_id IS NOT NULL DO NOTHING
        RETURNING id
      ),
      activated_user AS (
        UPDATE users u
        SET subscription = completed.plan,
            subscription_active = TRUE,
            subscription_date = completed.subscription_start
        FROM completed
        WHERE u.id = completed.user_id
        RETURNING u.id
      ),
      audit_event AS (
        INSERT INTO audit_log (actor_id, action, target_table, target_id, metadata)
        SELECT
          user_id,
          'payment_success',
          'payments',
          id,
          jsonb_build_object(
            'reference', reference,
            'plan_code', plan_code,
            'amount', amount,
            'subscription_end', subscription_end
          )
        FROM completed
        RETURNING id
      )
      SELECT p.status
      FROM payments p
      WHERE p.id = ${payment.id}
    `;
    return String(rows[0]?.status ?? "pending");
  }

  if (status === "failed") {
    const rows = await sql`
      WITH changed AS (
        UPDATE payments
        SET status = 'failed',
            raw_response = ${serialized}::jsonb,
            updated_at = NOW()
        WHERE id = ${payment.id} AND status = 'pending'
        RETURNING id, user_id, reference, plan_code, amount
      ),
      audit_event AS (
        INSERT INTO audit_log (actor_id, action, target_table, target_id, metadata)
        SELECT
          user_id,
          'payment_failed',
          'payments',
          id,
          jsonb_build_object(
            'reference', reference,
            'plan_code', plan_code,
            'amount', amount
          )
        FROM changed
        RETURNING id
      )
      SELECT status FROM payments WHERE id = ${payment.id}
    `;
    return String(rows[0]?.status ?? "failed");
  }

  const rows = await sql`
    UPDATE payments
    SET raw_response = ${serialized}::jsonb, updated_at = NOW()
    WHERE id = ${payment.id} AND status = 'pending'
    RETURNING status
  `;
  return String(rows[0]?.status ?? payment.status);
}

payments.post("/initiate", authMiddleware, async (c) => {
  const body = await readJson(c);
  const planCode = requiredString(body, "plan_code", { max: 40 }).toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/u.test(planCode)) {
    throw new ApiError(400, "VALIDATION_ERROR", "plan_code is invalid.");
  }

  const user = c.get("user");
  if (user.impersonatedBy) {
    throw new ApiError(403, "IMPERSONATION_FORBIDDEN", "Payments are unavailable during impersonation.");
  }

  const sql = getDb(c.env);
  const profileRows = await sql`
    SELECT name, email, phone FROM users WHERE id = ${user.id} LIMIT 1
  `;
  const profile = profileRows[0] as
    | { name: string; email: string; phone: string | null }
    | undefined;
  if (!profile) throw new ApiError(401, "INVALID_TOKEN", "The account is no longer active.");
  if (!profile.phone?.trim()) {
    throw new ApiError(400, "PHONE_REQUIRED", "Add a phone number to your profile before paying.");
  }
  const phone = normalizePhone(profile.phone);

  const planRows = await sql`
    SELECT code, name, price, currency
    FROM subscription_plans
    WHERE code = ${planCode} AND active = TRUE
    LIMIT 1
  `;
  const plan = planRows[0] as
    | { code: string; name: string; price: string | number; currency: string }
    | undefined;
  if (!plan) throw new ApiError(404, "PLAN_NOT_FOUND", "This subscription plan is unavailable.");
  const amount = Number(plan.price);
  if (!Number.isSafeInteger(amount) || amount <= 0 || plan.currency !== "UGX") {
    throw new ApiError(503, "INVALID_PLAN", "The subscription plan is not configured as a valid UGX price.");
  }

  const ipnUrl = requireEnv(c.env.YO_IPN_URL, "YO_IPN_URL");
  try {
    if (new URL(ipnUrl).protocol !== "https:") throw new Error("HTTPS required");
  } catch {
    throw new ApiError(503, "INVALID_CONFIGURATION", "YO_IPN_URL must be an HTTPS URL.");
  }

  const reference = `SUB_${Date.now()}_${crypto.randomUUID()}`;
  let payment: PaymentRow;
  try {
    const rows = await sql`
      INSERT INTO payments (
        user_id, plan, plan_code, amount, currency, reference, status, phone, email, name
      )
      VALUES (
        ${user.id}, ${plan.name}, ${plan.code}, ${amount}, 'UGX',
        ${reference}, 'pending', ${phone}, ${profile.email}, ${profile.name}
      )
      RETURNING
        id, user_id, plan, plan_code, amount, currency, reference,
        yo_transaction_ref, status, subscription_end
    `;
    payment = rows[0] as PaymentRow;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "REFERENCE_IN_USE", "A payment with this reference already exists.");
    }
    throw error;
  }

  await recordAudit(sql, {
    actorId: user.id,
    sector: user.sector,
    action: "payment_initiated",
    targetId: payment.id,
    metadata: { reference, plan_code: plan.code, amount, currency: "UGX" },
    ip: requestIp(c),
  });

  let yoResult: YoApiResponse;
  try {
    yoResult = await initiateDeposit(c.env, {
      amount,
      account: phone,
      narrative: `APSHULE ${plan.name} Subscription`,
      phone,
      reference,
      ipnUrl,
    });
  } catch (error) {
    await recordAudit(sql, {
      actorId: user.id,
      sector: user.sector,
      action: "payment_provider_error",
      targetId: payment.id,
      metadata: { reference, code: error instanceof ApiError ? error.code : "YO_REQUEST_FAILED" },
      ip: requestIp(c),
    });
    throw error;
  }

  const rejected = !yoResult.ok || yoResponseRejected(yoResult.parsed);
  if (rejected) {
    const definiteFailure =
      yoResponseRejected(yoResult.parsed) ||
      (yoResult.status >= 400 && yoResult.status < 500);
    await sql`
      UPDATE payments
      SET status = CASE WHEN ${definiteFailure} THEN 'failed' ELSE status END,
          raw_response = ${JSON.stringify(yoResult.parsed)}::jsonb,
          updated_at = NOW()
      WHERE id = ${payment.id} AND status = 'pending'
    `;
    await recordAudit(sql, {
      actorId: user.id,
      sector: user.sector,
      action: "payment_provider_rejected",
      targetId: payment.id,
      metadata: { reference, http_status: yoResult.status, definite_failure: definiteFailure },
      ip: requestIp(c),
    });
    throw new ApiError(502, "YO_REQUEST_REJECTED", "Yo! Payments could not start this payment.");
  }

  const transactionRef =
    findYoField(
      yoResult.parsed,
      "privatetransactionreference",
      "transactionreference",
      "transactionref",
      "transactionid",
    ) ?? reference;
  await sql`
    UPDATE payments
    SET yo_transaction_ref = ${transactionRef},
        raw_response = ${JSON.stringify(yoResult.parsed)}::jsonb,
        updated_at = NOW()
    WHERE id = ${payment.id}
  `;
  await recordAudit(sql, {
    actorId: user.id,
    sector: user.sector,
    action: "payment_provider_response",
    targetId: payment.id,
    metadata: { reference, provider_status: findYoField(yoResult.parsed, "status") ?? "unknown" },
    ip: requestIp(c),
  });

  const redirectUrl = secureRedirectUrl(yoResult.parsed);
  return c.json({
    reference,
    status: "pending",
    yo_response: yoResult.parsed,
    ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
  }, 201);
});

payments.post("/status", authMiddleware, async (c) => {
  const body = await readJson(c);
  const reference = requiredString(body, "reference", { min: 8, max: 100 });
  const user = c.get("user");
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, user_id, plan, plan_code, amount, currency, reference,
      yo_transaction_ref, status, subscription_end
    FROM payments
    WHERE reference = ${reference} AND user_id = ${user.id}
    LIMIT 1
  `;
  const payment = rows[0] as PaymentRow | undefined;
  if (!payment) throw new ApiError(404, "PAYMENT_NOT_FOUND", "Payment was not found.");

  if (!isSuccessfulStatus(payment.status)) {
    const yoResult = await checkStatus(c.env, {
      transactionRef: payment.yo_transaction_ref ?? payment.reference,
    });
    if (!yoResult.ok) {
      throw new ApiError(502, "YO_STATUS_FAILED", "Yo! Payments could not verify this payment yet.");
    }
    await saveVerifiedStatus(sql, payment, yoResult.parsed);
  }

  const updatedRows = await sql`
    SELECT status, amount, reference, plan_code, subscription_end
    FROM payments WHERE id = ${payment.id} LIMIT 1
  `;
  const updated = updatedRows[0] as
    | {
        status: string;
        amount: string | number;
        reference: string;
        plan_code: string;
        subscription_end: string | null;
      }
    | undefined;
  if (!updated) throw new ApiError(404, "PAYMENT_NOT_FOUND", "Payment was not found.");
  return c.json({ ...updated, status: responseStatus(updated.status) });
});

payments.post("/ipn", async (c) => {
  const rawBody = await c.req.text();
  if (rawBody.length > 32_768) {
    await recordIgnoredIpn(c, "payload_too_large");
    return c.text("OK");
  }

  let fields: YoFields;
  try {
    fields = parseIpnPayload(rawBody, c.req.header("Content-Type"));
  } catch {
    console.error("Yo IPN payload could not be parsed.", { code: "INVALID_IPN" });
    await recordIgnoredIpn(c, "invalid_payload");
    return c.text("OK");
  }

  try {
    const sql = getDb(c.env);
    const reference = findYoField(
      fields,
      "externalreference",
      "reference",
      "clientreference",
    );
    if (!reference) {
      await recordAudit(sql, {
        action: "payment_ipn",
        targetId: null,
        metadata: { result: "ignored", reason: "missing_reference" },
        ip: requestIp(c),
      });
      return c.text("OK");
    }

    const rows = await sql`
      SELECT id, user_id, plan, plan_code, amount, currency, reference,
        yo_transaction_ref, status, subscription_end
      FROM payments
      WHERE reference = ${reference}
      LIMIT 1
    `;
    const payment = rows[0] as PaymentRow | undefined;
    if (!payment) {
      await recordAudit(sql, {
        action: "payment_ipn",
        targetId: null,
        metadata: {
          reference,
          result: "ignored",
          provider_status: findYoField(fields, "transactionstatus", "status") ?? "unknown",
        },
        ip: requestIp(c),
      });
      return c.text("OK");
    }

    await sql`
      UPDATE payments
      SET ipn_payload = ${JSON.stringify(fields)}::jsonb,
          ipn_received_at = NOW(),
          updated_at = NOW()
      WHERE id = ${payment.id}
    `;
    await recordAudit(sql, {
      action: "payment_ipn",
      targetId: payment.id,
      metadata: {
        reference,
        provider_status: findYoField(fields, "transactionstatus", "status") ?? "unknown",
        amount: findYoField(fields, "amount"),
        transaction_reference: findYoField(fields, "transactionreference", "transactionref"),
      },
      ip: requestIp(c),
    });

    if (isSuccessfulStatus(payment.status) || normalizedYoStatus(fields) !== "success") {
      return c.text("OK");
    }

    const yoResult = await checkStatus(c.env, {
      transactionRef: payment.yo_transaction_ref ?? payment.reference,
    });
    if (!yoResult.ok) {
      throw new ApiError(502, "YO_STATUS_FAILED", "Yo! Payments could not verify this IPN.");
    }
    await saveVerifiedStatus(sql, payment, yoResult.parsed);
  } catch (error) {
    const code =
      error instanceof ApiError
        ? error.code
        : error instanceof Error
          ? error.name
          : "UNKNOWN_ERROR";
    console.error("Yo IPN verification failed.", { code });
  }
  return c.text("OK");
});

export default payments;