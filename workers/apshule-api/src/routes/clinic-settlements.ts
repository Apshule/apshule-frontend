import { Hono } from "hono";
import { ApiError, getDb, isUniqueViolation } from "../db.js";
import { requireRole } from "../auth.js";
import { readJson, parseLimit } from "../http.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";
import {
  assertAllowedKeys,
  centsDecimal,
  moneyCents,
  optionalText,
  optionalUuid,
  pathUuid,
  requiredText,
} from "./clinic-billing-shared.js";

type Sql = ReturnType<typeof getDb>;
type OrganizationResolver = (
  sql: Sql,
  user: AuthenticatedUser,
  requestedId?: string,
) => Promise<string>;
type RequestIp = (c: { req: { header(name: string): string | undefined } }) => string | null;

interface ClinicSettlementHelpers {
  organizationForRequest: OrganizationResolver;
  requestIp: RequestIp;
}

const CLAIM_READ_ROLES = ["clinic_admin", "receptionist", "nurse"] as const;

export function createClinicSettlementRoutes(helpers: ClinicSettlementHelpers) {
  const settlements = new Hono<AppEnv>();

  settlements.post(
    "/clinic/invoices/:id/payments",
    requireRole("clinic_admin", "receptionist"),
    async (c) => {
      const invoiceId = pathUuid(c.req.param("id"), "invoice_id");
      const body = await readJson(c);
      assertAllowedKeys(body, ["amount", "payment_method", "payment_reference", "notes", "paid_at"]);
      const amountCents = moneyCents(body.amount, "amount", false);
      const paymentMethod = body.payment_method ?? "cash";
      if (!["cash", "momo", "bank", "insurance"].includes(String(paymentMethod))) {
        throw new ApiError(400, "VALIDATION_ERROR", "payment_method must be cash, momo, bank, or insurance.");
      }
      const reference = optionalText(body.payment_reference, "payment_reference", 200) ?? null;
      const notes = optionalText(body.notes, "notes", 2000) ?? null;
      const paidAt = body.paid_at;
      if (
        paidAt !== undefined &&
        (typeof paidAt !== "string" || !Number.isFinite(new Date(paidAt).getTime()))
      ) {
        throw new ApiError(400, "VALIDATION_ERROR", "paid_at must be a valid date-time.");
      }
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        actor,
        c.req.query("organization_id"),
      );
      const ip = helpers.requestIp(c);
      const rows = await sql`
        WITH target_invoice AS MATERIALIZED (
          SELECT invoice.*
          FROM clinic_invoices invoice
          WHERE invoice.id = ${invoiceId}
            AND invoice.organization_id = ${organizationId}
            AND invoice.status NOT IN ('draft', 'cancelled')
            AND CASE
              WHEN ${paymentMethod} = 'insurance'
                THEN invoice.insurance_covered - invoice.insurance_portion_paid >= ${centsDecimal(amountCents)}::numeric
              ELSE invoice.patient_portion - invoice.patient_portion_paid >= ${centsDecimal(amountCents)}::numeric
            END
          FOR UPDATE
        ),
        number_counter AS (
          INSERT INTO clinic_billing_number_counters (
            organization_id, period, number_type, last_value
          )
          VALUES (
            ${organizationId},
            to_char(NOW() AT TIME ZONE 'Africa/Kampala', 'YYYYMM'),
            'receipt',
            1
          )
          ON CONFLICT (organization_id, period, number_type)
          DO UPDATE SET last_value = clinic_billing_number_counters.last_value + 1
          RETURNING period, last_value
        ),
        created_payment AS (
          INSERT INTO clinic_payments (
            organization_id, invoice_id, patient_id, receipt_number,
            amount, applied_amount, payment_method, payment_reference,
            paid_at, received_by, notes
          )
          SELECT invoice.organization_id, invoice.id, invoice.patient_id,
            'RCPT-' || number_counter.period || '-' || lpad(number_counter.last_value::text, 4, '0'),
            ${centsDecimal(amountCents)}::numeric, ${centsDecimal(amountCents)}::numeric,
            ${paymentMethod}, ${reference}, COALESCE(${paidAt ?? null}::timestamptz, NOW()),
            ${actor.id}, ${notes}
          FROM target_invoice invoice
          CROSS JOIN number_counter
          RETURNING *
        ),
        new_portions AS MATERIALIZED (
          SELECT invoice.id,
            CASE WHEN payment.payment_method = 'insurance'
              THEN invoice.patient_portion_paid
              ELSE invoice.patient_portion_paid + payment.applied_amount
            END AS patient_paid,
            CASE WHEN payment.payment_method = 'insurance'
              THEN invoice.insurance_portion_paid + payment.applied_amount
              ELSE invoice.insurance_portion_paid
            END AS insurance_paid
          FROM clinic_invoices invoice
          JOIN created_payment payment ON payment.invoice_id = invoice.id
        ),
        updated_invoice AS (
          UPDATE clinic_invoices invoice
          SET patient_portion_paid = portions.patient_paid,
            insurance_portion_paid = portions.insurance_paid,
            amount_paid = portions.patient_paid + portions.insurance_paid,
            balance_due =
              GREATEST(invoice.patient_portion - portions.patient_paid, 0)
              + GREATEST(invoice.insurance_covered - portions.insurance_paid, 0),
            status = CASE
              WHEN portions.patient_paid >= invoice.patient_portion
                AND portions.insurance_paid >= invoice.insurance_covered THEN 'paid'
              WHEN portions.patient_paid >= invoice.patient_portion THEN 'patient_settled'
              WHEN portions.insurance_paid >= invoice.insurance_covered THEN 'insurance_settled'
              ELSE 'partial'
            END,
            updated_at = NOW()
          FROM new_portions portions
          WHERE invoice.id = portions.id
          RETURNING invoice.*
        ),
        local_audit AS (
          INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
          SELECT payment.organization_id, ${actor.id}, 'clinic.payment_recorded',
            'clinic_payments', payment.id,
            jsonb_build_object(
              'receipt_number', payment.receipt_number,
              'invoice_id', payment.invoice_id,
              'amount', payment.amount,
              'payment_method', payment.payment_method
            )
          FROM created_payment payment RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
          SELECT ${actor.id}, 'clinic', 'clinic.payment_recorded',
            'clinic_payments', payment.id,
            jsonb_build_object(
              'receipt_number', payment.receipt_number,
              'invoice_id', payment.invoice_id,
              'amount', payment.amount,
              'payment_method', payment.payment_method
            ), ${ip}
          FROM created_payment payment RETURNING id
        )
        SELECT payment.*, invoice.status AS invoice_status, invoice.balance_due
        FROM created_payment payment
        JOIN updated_invoice invoice ON invoice.id = payment.invoice_id
      `;
      if (!rows[0]) {
        throw new ApiError(
          409,
          "PAYMENT_EXCEEDS_PORTION_BALANCE",
          paymentMethod === "insurance"
            ? "The payment exceeds the remaining insurance portion."
            : "The payment exceeds the remaining patient portion.",
        );
      }
      return c.json({ payment: rows[0] }, 201);
    },
  );

  settlements.post(
    "/clinic/payments/:id/reverse",
    requireRole("clinic_admin"),
    async (c) => {
      const paymentId = pathUuid(c.req.param("id"), "payment_id");
      const body = await readJson(c);
      assertAllowedKeys(body, ["reason"]);
      const reason = requiredText(body.reason, "reason", 500);
      if (reason.length < 5) {
        throw new ApiError(400, "VALIDATION_ERROR", "reason must contain at least 5 characters.");
      }
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        actor,
        c.req.query("organization_id"),
      );
      const ip = helpers.requestIp(c);
      const rows = await sql`
        WITH target_payment AS MATERIALIZED (
          SELECT payment.*, invoice.patient_portion_paid,
            invoice.insurance_portion_paid, invoice.patient_portion,
            invoice.insurance_covered
          FROM clinic_payments payment
          JOIN clinic_invoices invoice
            ON invoice.id = payment.invoice_id
            AND invoice.organization_id = payment.organization_id
          WHERE payment.id = ${paymentId}
            AND payment.organization_id = ${organizationId}
            AND payment.reversed IS FALSE
          FOR UPDATE OF payment, invoice
        ),
        reversed_payment AS (
          UPDATE clinic_payments payment
          SET reversed = TRUE, reversed_at = NOW(),
            reversed_by = ${actor.id}, reversal_reason = ${reason}
          FROM target_payment target
          WHERE payment.id = target.id
          RETURNING payment.*
        ),
        new_portions AS MATERIALIZED (
          SELECT payment.invoice_id AS id,
            GREATEST(target.patient_portion_paid -
              CASE WHEN payment.payment_method = 'insurance' THEN 0 ELSE payment.applied_amount END, 0)
              AS patient_paid,
            GREATEST(target.insurance_portion_paid -
              CASE WHEN payment.payment_method = 'insurance' THEN payment.applied_amount ELSE 0 END, 0)
              AS insurance_paid,
            target.patient_portion, target.insurance_covered
          FROM reversed_payment payment
          JOIN target_payment target ON target.id = payment.id
        ),
        updated_invoice AS (
          UPDATE clinic_invoices invoice
          SET patient_portion_paid = portions.patient_paid,
            insurance_portion_paid = portions.insurance_paid,
            amount_paid = portions.patient_paid + portions.insurance_paid,
            balance_due =
              GREATEST(portions.patient_portion - portions.patient_paid, 0)
              + GREATEST(portions.insurance_covered - portions.insurance_paid, 0),
            status = CASE
              WHEN portions.patient_paid >= portions.patient_portion
                AND portions.insurance_paid >= portions.insurance_covered THEN 'paid'
              WHEN portions.patient_paid >= portions.patient_portion THEN 'patient_settled'
              WHEN portions.insurance_paid >= portions.insurance_covered THEN 'insurance_settled'
              WHEN portions.patient_paid > 0 OR portions.insurance_paid > 0 THEN 'partial'
              ELSE 'issued'
            END,
            updated_at = NOW()
          FROM new_portions portions
          WHERE invoice.id = portions.id
          RETURNING invoice.*
        ),
        reopened_claim AS (
          UPDATE clinic_insurance_claims claim
          SET status = 'approved', payment_received_at = NULL
          FROM reversed_payment payment
          WHERE payment.payment_method = 'insurance'
            AND payment.payment_reference = 'claim:' || claim.id::text
            AND claim.organization_id = payment.organization_id
            AND claim.status = 'paid'
          RETURNING claim.*
        ),
        local_audit AS (
          INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
          SELECT payment.organization_id, ${actor.id}, 'clinic.payment_reversed',
            'clinic_payments', payment.id,
            jsonb_build_object('reason', ${reason}, 'receipt_number', payment.receipt_number)
          FROM reversed_payment payment
          UNION ALL
          SELECT claim.organization_id, ${actor.id}, 'clinic.claim_reopened_after_reversal',
            'clinic_insurance_claims', claim.id,
            jsonb_build_object('claim_number', claim.claim_number)
          FROM reopened_claim claim
          RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
          SELECT ${actor.id}, 'clinic', 'clinic.payment_reversed',
            'clinic_payments', payment.id,
            jsonb_build_object('reason', ${reason}, 'receipt_number', payment.receipt_number), ${ip}
          FROM reversed_payment payment
          UNION ALL
          SELECT ${actor.id}, 'clinic', 'clinic.claim_reopened_after_reversal',
            'clinic_insurance_claims', claim.id,
            jsonb_build_object('claim_number', claim.claim_number), ${ip}
          FROM reopened_claim claim
          RETURNING id
        )
        SELECT payment.*, invoice.status AS invoice_status, invoice.balance_due
        FROM reversed_payment payment
        JOIN updated_invoice invoice ON invoice.id = payment.invoice_id
      `;
      if (!rows[0]) throw new ApiError(404, "PAYMENT_NOT_REVERSIBLE", "Payment was not found or has already been reversed.");
      return c.json({ payment: rows[0] });
    },
  );

  settlements.post(
    "/clinic/invoices/:id/claim",
    requireRole("clinic_admin"),
    async (c) => {
      const invoiceId = pathUuid(c.req.param("id"), "invoice_id");
      const body = await readJson(c);
      assertAllowedKeys(body, ["notes"]);
      const notes = optionalText(body.notes, "notes", 2000) ?? null;
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        actor,
        c.req.query("organization_id"),
      );
      const ip = helpers.requestIp(c);
      try {
        const rows = await sql`
          WITH target_invoice AS MATERIALIZED (
            SELECT invoice.*
            FROM clinic_invoices invoice
            WHERE invoice.id = ${invoiceId}
              AND invoice.organization_id = ${organizationId}
              AND invoice.status NOT IN ('draft', 'cancelled')
              AND invoice.insurance_provider_id IS NOT NULL
              AND invoice.insurance_covered > invoice.insurance_portion_paid
            FOR UPDATE
          ),
          number_counter AS (
            INSERT INTO clinic_billing_number_counters (
              organization_id, period, number_type, last_value
            )
            VALUES (
              ${organizationId},
              to_char(NOW() AT TIME ZONE 'Africa/Kampala', 'YYYYMM'),
              'claim',
              1
            )
            ON CONFLICT (organization_id, period, number_type)
            DO UPDATE SET last_value = clinic_billing_number_counters.last_value + 1
            RETURNING period, last_value
          ),
          created AS (
            INSERT INTO clinic_insurance_claims (
              organization_id, invoice_id, provider_id, claim_number,
              claim_amount, status, notes, created_by
            )
            SELECT invoice.organization_id, invoice.id, invoice.insurance_provider_id,
              'CLM-' || number_counter.period || '-' || lpad(number_counter.last_value::text, 4, '0'),
              invoice.insurance_covered - invoice.insurance_portion_paid,
              'submitted', ${notes}, ${actor.id}
            FROM target_invoice invoice
            CROSS JOIN number_counter
            RETURNING *
          ),
          local_audit AS (
            INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
            SELECT organization_id, ${actor.id}, 'clinic.insurance_claim_submitted',
              'clinic_insurance_claims', id,
              jsonb_build_object('claim_number', claim_number, 'claim_amount', claim_amount)
            FROM created RETURNING id
          ),
          platform_audit AS (
            INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
            SELECT ${actor.id}, 'clinic', 'clinic.insurance_claim_submitted',
              'clinic_insurance_claims', id,
              jsonb_build_object('claim_number', claim_number, 'claim_amount', claim_amount), ${ip}
            FROM created RETURNING id
          )
          SELECT created.*, provider.name AS provider_name
          FROM created
          LEFT JOIN clinic_insurance_providers provider ON provider.id = created.provider_id
        `;
        if (!rows[0]) {
          throw new ApiError(
            409,
            "CLAIM_NOT_ALLOWED",
            "The invoice has no outstanding insurance portion or is not eligible for a claim.",
          );
        }
        return c.json({ claim: rows[0] }, 201);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(409, "CLAIM_ALREADY_EXISTS", "An insurance claim already exists for this invoice.");
        }
        throw error;
      }
    },
  );

  settlements.get(
    "/clinic/claims",
    requireRole(...CLAIM_READ_ROLES),
    async (c) => {
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        c.get("user"),
        c.req.query("organization_id"),
      );
      const status = c.req.query("status") || "all";
      if (status !== "all" && !["submitted", "approved", "rejected", "paid"].includes(status)) {
        throw new ApiError(400, "VALIDATION_ERROR", "status is invalid.");
      }
      const providerId = optionalUuid(c.req.query("provider_id"), "provider_id");
      const limit = parseLimit(c.req.query("limit"), 100);
      const rows = await sql`
        SELECT claim.id, claim.organization_id, claim.invoice_id, claim.provider_id,
          claim.claim_number, claim.claim_amount, claim.approved_amount, claim.status,
          claim.submitted_at, claim.responded_at, claim.payment_received_at,
          claim.rejection_reason, claim.notes,
          invoice.invoice_number, invoice.patient_id, invoice.currency,
          concat_ws(' ', patient.first_name, patient.last_name) AS patient_name,
          patient.patient_number, provider.name AS provider_name
        FROM clinic_insurance_claims claim
        JOIN clinic_invoices invoice ON invoice.id = claim.invoice_id
        JOIN clinic_patients patient ON patient.id = invoice.patient_id
        LEFT JOIN clinic_insurance_providers provider ON provider.id = claim.provider_id
        WHERE claim.organization_id = ${organizationId}
          AND (${status === "all"} OR claim.status = ${status})
          AND (${providerId === null} OR claim.provider_id = ${providerId})
        ORDER BY claim.submitted_at DESC
        LIMIT ${limit}
      `;
      return c.json({ claims: rows });
    },
  );

  settlements.get(
    "/clinic/claims/:id",
    requireRole(...CLAIM_READ_ROLES),
    async (c) => {
      const claimId = pathUuid(c.req.param("id"), "claim_id");
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        c.get("user"),
        c.req.query("organization_id"),
      );
      const rows = await sql`
        SELECT claim.*, invoice.invoice_number, invoice.patient_id,
          invoice.total, invoice.insurance_covered, invoice.insurance_portion_paid,
          invoice.balance_due, invoice.currency,
          concat_ws(' ', patient.first_name, patient.last_name) AS patient_name,
          patient.patient_number, provider.name AS provider_name
        FROM clinic_insurance_claims claim
        JOIN clinic_invoices invoice ON invoice.id = claim.invoice_id
        JOIN clinic_patients patient ON patient.id = invoice.patient_id
        LEFT JOIN clinic_insurance_providers provider ON provider.id = claim.provider_id
        WHERE claim.id = ${claimId} AND claim.organization_id = ${organizationId}
        LIMIT 1
      `;
      if (!rows[0]) throw new ApiError(404, "CLAIM_NOT_FOUND", "Insurance claim was not found.");
      return c.json({ claim: rows[0] });
    },
  );

  settlements.patch(
    "/clinic/claims/:id",
    requireRole("clinic_admin"),
    async (c) => {
      const claimId = pathUuid(c.req.param("id"), "claim_id");
      const body = await readJson(c);
      assertAllowedKeys(body, ["status", "approved_amount", "rejection_reason", "notes"]);
      const status = body.status;
      if (!["approved", "rejected", "paid"].includes(String(status))) {
        throw new ApiError(400, "VALIDATION_ERROR", "status must be approved, rejected, or paid.");
      }
      const approvedCents = body.approved_amount === undefined
        ? undefined
        : moneyCents(body.approved_amount, "approved_amount");
      const rejectionReason = optionalText(body.rejection_reason, "rejection_reason", 1000);
      const notes = optionalText(body.notes, "notes", 2000);
      if (status === "rejected" && (!rejectionReason || rejectionReason.length < 5)) {
        throw new ApiError(400, "VALIDATION_ERROR", "rejection_reason is required and must contain at least 5 characters.");
      }
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        actor,
        c.req.query("organization_id"),
      );
      const currentRows = await sql`
        SELECT claim.*, invoice.insurance_covered, invoice.insurance_portion_paid,
          invoice.patient_id, invoice.invoice_number
        FROM clinic_insurance_claims claim
        JOIN clinic_invoices invoice ON invoice.id = claim.invoice_id
        WHERE claim.id = ${claimId} AND claim.organization_id = ${organizationId}
        LIMIT 1
      `;
      const current = currentRows[0] as {
        status: string;
        claim_amount: string | number;
        approved_amount: string | number | null;
        insurance_covered: string | number;
        insurance_portion_paid: string | number;
        invoice_id: string;
      } | undefined;
      if (!current) throw new ApiError(404, "CLAIM_NOT_FOUND", "Insurance claim was not found.");
      if (current.status === "paid" || current.status === "rejected") {
        throw new ApiError(409, "CLAIM_LOCKED", "A paid or rejected claim cannot be changed.");
      }

      const claimAmountCents = moneyCents(String(current.claim_amount), "claim_amount");
      const insuranceRemainingCents =
        moneyCents(String(current.insurance_covered), "insurance_covered") -
        moneyCents(String(current.insurance_portion_paid), "insurance_portion_paid");
      const finalApprovedCents = status === "approved"
        ? approvedCents ?? claimAmountCents
        : status === "paid"
          ? approvedCents ?? (current.approved_amount == null
            ? claimAmountCents
            : moneyCents(String(current.approved_amount), "approved_amount"))
          : undefined;
      if (finalApprovedCents !== undefined) {
        if (finalApprovedCents <= 0n || finalApprovedCents > claimAmountCents) {
          throw new ApiError(400, "INVALID_APPROVED_AMOUNT", "approved_amount must be greater than zero and no more than the claim amount.");
        }
      }
      if (status === "paid" && finalApprovedCents! > insuranceRemainingCents) {
        throw new ApiError(409, "APPROVED_AMOUNT_EXCEEDS_BALANCE", "The approved claim amount exceeds the remaining insurance portion.");
      }
      const ip = helpers.requestIp(c);

      if (status !== "paid") {
        const rows = await sql`
          WITH updated AS (
            UPDATE clinic_insurance_claims
            SET status = ${status},
              approved_amount = CASE
                WHEN ${status} = 'approved' THEN ${finalApprovedCents === undefined ? null : centsDecimal(finalApprovedCents)}::numeric
                ELSE approved_amount
              END,
              rejection_reason = CASE WHEN ${status} = 'rejected' THEN ${rejectionReason ?? null} ELSE NULL END,
              notes = CASE WHEN ${notes !== undefined} THEN ${notes ?? null} ELSE notes END,
              responded_at = NOW()
            WHERE id = ${claimId}
              AND organization_id = ${organizationId}
              AND status IN ('submitted', 'approved')
            RETURNING *
          ),
          local_audit AS (
            INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
            SELECT organization_id, ${actor.id}, 'clinic.insurance_claim_' || status,
              'clinic_insurance_claims', id,
              jsonb_build_object(
                'claim_number', claim_number,
                'approved_amount', approved_amount,
                'rejection_reason', rejection_reason
              )
            FROM updated RETURNING id
          ),
          platform_audit AS (
            INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
            SELECT ${actor.id}, 'clinic', 'clinic.insurance_claim_' || status,
              'clinic_insurance_claims', id,
              jsonb_build_object(
                'claim_number', claim_number,
                'approved_amount', approved_amount,
                'rejection_reason', rejection_reason
              ), ${ip}
            FROM updated RETURNING id
          )
          SELECT * FROM updated
        `;
        if (!rows[0]) {
          throw new ApiError(409, "INVALID_CLAIM_TRANSITION", "Claim status changed; reload before updating it.");
        }
        return c.json({ claim: rows[0] });
      }

      const approvedAmount = centsDecimal(finalApprovedCents!);
      const rows = await sql`
        WITH target_claim AS MATERIALIZED (
          SELECT claim.*, invoice.patient_id, invoice.insurance_covered,
            invoice.insurance_portion_paid
          FROM clinic_insurance_claims claim
          JOIN clinic_invoices invoice
            ON invoice.id = claim.invoice_id
            AND invoice.organization_id = claim.organization_id
          WHERE claim.id = ${claimId}
            AND claim.organization_id = ${organizationId}
            AND claim.status = 'approved'
            AND invoice.insurance_covered - invoice.insurance_portion_paid >= ${approvedAmount}::numeric
          FOR UPDATE OF claim, invoice
        ),
        paid_claim AS (
          UPDATE clinic_insurance_claims claim
          SET status = 'paid',
            approved_amount = ${approvedAmount}::numeric,
            payment_received_at = NOW(),
            responded_at = COALESCE(claim.responded_at, NOW())
          FROM target_claim target
          WHERE claim.id = target.id
          RETURNING claim.*
        ),
        number_counter AS (
          INSERT INTO clinic_billing_number_counters (
            organization_id, period, number_type, last_value
          )
          VALUES (
            ${organizationId},
            to_char(NOW() AT TIME ZONE 'Africa/Kampala', 'YYYYMM'),
            'receipt',
            1
          )
          ON CONFLICT (organization_id, period, number_type)
          DO UPDATE SET last_value = clinic_billing_number_counters.last_value + 1
          RETURNING period, last_value
        ),
        created_payment AS (
          INSERT INTO clinic_payments (
            organization_id, invoice_id, patient_id, receipt_number,
            amount, applied_amount, payment_method, payment_reference,
            received_by, notes
          )
          SELECT claim.organization_id, claim.invoice_id, invoice.patient_id,
            'RCPT-' || number_counter.period || '-' || lpad(number_counter.last_value::text, 4, '0'),
            claim.approved_amount, claim.approved_amount, 'insurance',
            'claim:' || claim.id::text, ${actor.id},
            'Insurance claim settlement ' || claim.claim_number
          FROM paid_claim claim
          JOIN clinic_invoices invoice ON invoice.id = claim.invoice_id
          CROSS JOIN number_counter
          RETURNING *
        ),
        new_portions AS MATERIALIZED (
          SELECT invoice.id, invoice.patient_portion_paid AS patient_paid,
            invoice.insurance_portion_paid + payment.applied_amount AS insurance_paid,
            invoice.patient_portion, invoice.insurance_covered
          FROM clinic_invoices invoice
          JOIN created_payment payment ON payment.invoice_id = invoice.id
        ),
        updated_invoice AS (
          UPDATE clinic_invoices invoice
          SET patient_portion_paid = portions.patient_paid,
            insurance_portion_paid = portions.insurance_paid,
            amount_paid = portions.patient_paid + portions.insurance_paid,
            balance_due =
              GREATEST(portions.patient_portion - portions.patient_paid, 0)
              + GREATEST(portions.insurance_covered - portions.insurance_paid, 0),
            status = CASE
              WHEN portions.patient_paid >= portions.patient_portion
                AND portions.insurance_paid >= portions.insurance_covered THEN 'paid'
              WHEN portions.patient_paid >= portions.patient_portion THEN 'patient_settled'
              WHEN portions.insurance_paid >= portions.insurance_covered THEN 'insurance_settled'
              ELSE 'partial'
            END,
            updated_at = NOW()
          FROM new_portions portions
          WHERE invoice.id = portions.id
          RETURNING invoice.*
        ),
        local_audit AS (
          INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
          SELECT claim.organization_id, ${actor.id}, 'clinic.insurance_claim_paid',
            'clinic_insurance_claims', claim.id,
            jsonb_build_object('claim_number', claim.claim_number, 'approved_amount', claim.approved_amount)
          FROM paid_claim claim
          UNION ALL
          SELECT payment.organization_id, ${actor.id}, 'clinic.payment_recorded',
            'clinic_payments', payment.id,
            jsonb_build_object('receipt_number', payment.receipt_number, 'claim_id', payment.payment_reference)
          FROM created_payment payment
          RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
          SELECT ${actor.id}, 'clinic', 'clinic.insurance_claim_paid',
            'clinic_insurance_claims', claim.id,
            jsonb_build_object('claim_number', claim.claim_number, 'approved_amount', claim.approved_amount), ${ip}
          FROM paid_claim claim
          UNION ALL
          SELECT ${actor.id}, 'clinic', 'clinic.payment_recorded',
            'clinic_payments', payment.id,
            jsonb_build_object('receipt_number', payment.receipt_number, 'claim_id', payment.payment_reference), ${ip}
          FROM created_payment payment
          RETURNING id
        )
        SELECT claim.*, payment.receipt_number,
          invoice.status AS invoice_status, invoice.balance_due
        FROM paid_claim claim
        JOIN created_payment payment ON payment.invoice_id = claim.invoice_id
        JOIN updated_invoice invoice ON invoice.id = claim.invoice_id
      `;
      if (!rows[0]) {
        throw new ApiError(409, "CLAIM_SETTLEMENT_FAILED", "Claim is not approved or its insurance balance changed. Reload and try again.");
      }
      return c.json({ claim: rows[0] });
    },
  );

  return settlements;
}
