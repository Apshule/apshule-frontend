import { Hono } from "hono";
import { ApiError, getDb, isUniqueViolation } from "../db.js";
import { authMiddleware, requireRole } from "../auth.js";
import { optionalString, readJson, requiredString } from "../http.js";
import type { AppEnv, AuthenticatedUser, Env } from "../types.js";
import {
  allocateCredit,
  allocatePayment,
  buildSchedule,
  calculateLateFee,
  isIsoDate,
} from "../mfi/loan-math.js";
import {
  jsonMetadata,
  organizationForUser,
  requestIp,
  requestedOrganizationId,
  requireMfiSector,
  uuid,
} from "./mfi-loans.js";

const servicing = new Hono<AppEnv>();
const ALL_ROLES = ["loan_officer", "loan_manager", "loan_director", "mfi_admin", "superadmin"] as const;
const MANAGER_ROLES = ["loan_manager", "mfi_admin"] as const;
const DISBURSE_ROLES = ["loan_manager", "loan_director", "mfi_admin"] as const;
const PAYMENT_ROLES = ["loan_officer", "loan_manager", "mfi_admin"] as const;
const PAYMENT_METHODS = ["cash", "mobile_money", "bank"] as const;
const LOAN_STATUSES = ["active", "past_due", "defaulted", "completed", "written_off"] as const;

servicing.use("/mfi/*", authMiddleware, requireMfiSector);

function wholeAmount(body: Record<string, unknown>, key: string, max = 1_000_000_000_000): number {
  const raw = body[key];
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a positive whole number of UGX.`);
  }
  return value;
}

function optionalTextBody(
  body: Record<string, unknown>,
  key: string,
  max: number,
): string | null {
  const value = optionalString(body, key, { max, allowNull: true });
  if (value == null) return null;
  return value.trim() || null;
}

function requiredDate(body: Record<string, unknown>, key: string): string {
  const value = requiredString(body, key, { max: 10 }).trim();
  if (!isIsoDate(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a valid YYYY-MM-DD date.`);
  }
  return value;
}

function paymentMethod(body: Record<string, unknown>, key: string): string {
  const value = requiredString(body, key, { max: 30 }).trim();
  if (!PAYMENT_METHODS.includes(value as (typeof PAYMENT_METHODS)[number])) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be cash, mobile_money, or bank.`);
  }
  return value;
}

function kampalaDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dateDifference(later: string, earlier: string): number {
  return Math.max(
    0,
    Math.floor(
      (Date.parse(`${later}T00:00:00.000Z`) - Date.parse(`${earlier}T00:00:00.000Z`)) /
        86_400_000,
    ),
  );
}

function dateOnly(value: unknown): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function dueBalance(schedule: Record<string, unknown>): number {
  return Math.max(0, Number(schedule.principal_due) - Number(schedule.principal_paid)) +
    Math.max(0, Number(schedule.interest_due) - Number(schedule.interest_paid)) +
    Math.max(0, Number(schedule.fees_due) - Number(schedule.fees_paid)) +
    Math.max(0, Number(schedule.late_fee_due) - Number(schedule.late_fee_paid));
}

async function scopedLoan(
  sql: ReturnType<typeof getDb>,
  id: string,
  organizationId: string,
) {
  const rows = await sql`
    SELECT loan.*, customer.first_name AS customer_first_name,
      customer.last_name AS customer_last_name, customer.phone AS customer_phone,
      customer.status AS customer_status, product.name AS product_name,
      branch.name AS branch_name, disburser.name AS disbursed_by_name,
      creator.name AS created_by_name
    FROM mfi_loans loan
    JOIN mfi_customers customer ON customer.id = loan.customer_id
    LEFT JOIN mfi_loan_products product ON product.id = loan.product_id
    LEFT JOIN mfi_branches branch ON branch.id = loan.branch_id
    LEFT JOIN users disburser ON disburser.id = loan.disbursed_by
    LEFT JOIN users creator ON creator.id = loan.created_by
    WHERE loan.id = ${id} AND loan.organization_id = ${organizationId}
    LIMIT 1
  `;
  return rows[0] as Record<string, unknown> | undefined;
}

servicing.post(
  "/mfi/loans/disburse",
  requireRole(...DISBURSE_ROLES),
  async (c) => {
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const applicationId = uuid(requiredString(body, "application_id", { max: 36 }), "application_id");
    const disbursementDate = requiredDate(body, "disbursement_date");
    const firstInstallmentDate = requiredDate(body, "first_installment_date");
    if (firstInstallmentDate < disbursementDate) {
      throw new ApiError(400, "VALIDATION_ERROR", "first_installment_date cannot be before disbursement_date.");
    }
    const method = paymentMethod(body, "disbursement_method");
    const reference = optionalTextBody(body, "disbursement_reference", 160);

    const existingRows = await sql`
      SELECT * FROM mfi_loans
      WHERE application_id = ${applicationId} AND organization_id = ${organizationId}
      LIMIT 1
    `;
    if (existingRows[0]) {
      const existingSchedule = await sql`
        SELECT installment_number, due_date, principal_due, interest_due, fees_due, total_due
        FROM mfi_loan_schedules WHERE loan_id = ${existingRows[0].id}
        ORDER BY installment_number
      `;
      return c.json({
        loan: existingRows[0],
        loan_number: existingRows[0].loan_number,
        total_repayable: existingRows[0].total_repayable,
        schedule_preview: existingSchedule,
        already_disbursed: true,
      });
    }

    const applicationRows = await sql`
      SELECT application.*, customer.status AS customer_status,
        product.repayment_frequency, product.processing_fee_percent,
        product.insurance_fee_percent, product.late_fee_percent,
        product.grace_period_days
      FROM mfi_loan_applications application
      JOIN mfi_customers customer ON customer.id = application.customer_id
      JOIN mfi_loan_products product ON product.id = application.product_id
      WHERE application.id = ${applicationId}
        AND application.organization_id = ${organizationId}
      LIMIT 1
    `;
    const application = applicationRows[0] as Record<string, unknown> | undefined;
    if (!application) {
      throw new ApiError(404, "MFI_LOAN_APPLICATION_NOT_FOUND", "Approved application or its product was not found.");
    }
    if (application.status !== "approved") {
      throw new ApiError(409, "MFI_LOAN_APPLICATION_NOT_APPROVED", "Only finally approved applications can be disbursed.");
    }
    if (application.customer_status !== "active") {
      throw new ApiError(409, "MFI_CUSTOMER_NOT_AVAILABLE", "This customer is inactive or already has an active loan.");
    }
    const frequency = String(application.repayment_frequency || "monthly");
    if (!["monthly", "biweekly", "weekly"].includes(frequency)) {
      throw new ApiError(400, "MFI_REPAYMENT_FREQUENCY_UNSUPPORTED", "Disbursement supports monthly, biweekly, and weekly schedules.");
    }
    const principal = Math.round(Number(application.approved_amount));
    if (!Number.isSafeInteger(principal) || principal <= 0) {
      throw new ApiError(400, "MFI_APPROVED_AMOUNT_INVALID", "The approved amount must round to a positive whole number of UGX.");
    }
    const rate = Number(application.interest_rate);
    const termMonths = Number(application.term_months);
    const interestMethod = String(application.interest_method);
    let built;
    try {
      built = buildSchedule({
        principal,
        annual_rate: rate,
        term_months: termMonths,
        frequency: frequency as "monthly" | "biweekly" | "weekly",
        start_date: firstInstallmentDate,
        processing_fee_percent: Number(application.processing_fee_percent ?? 0),
        insurance_fee_percent: Number(application.insurance_fee_percent ?? 0),
      }, interestMethod as "flat" | "reducing_balance");
    } catch (error) {
      throw new ApiError(400, "MFI_SCHEDULE_INVALID", error instanceof Error ? error.message : "Loan schedule terms are invalid.");
    }

    const metadata = jsonMetadata({
      application_id: applicationId,
      loan_number: "assigned_at_disbursement",
      principal,
      disbursement_method: method,
      disbursement_reference: reference,
      total_repayable: built.total_repayable,
      schedule_count: built.schedules.length,
    });
    let createdRows: Record<string, unknown>[];
    try {
      createdRows = await sql.query(
        `WITH number_lock AS MATERIALIZED (
           SELECT pg_advisory_xact_lock(hashtextextended('mfi-loan-number:' || $4, 0))
         ),
         application_locked AS MATERIALIZED (
           SELECT application.*, product.repayment_frequency,
             product.processing_fee_percent, product.insurance_fee_percent,
             product.late_fee_percent, product.grace_period_days
           FROM mfi_loan_applications application
           JOIN mfi_loan_products product ON product.id = application.product_id
           CROSS JOIN number_lock
           WHERE application.id = $1::uuid
             AND application.organization_id = $2::uuid
           FOR UPDATE OF application
         ),
         customer_locked AS MATERIALIZED (
           SELECT customer.*
           FROM mfi_customers customer
           JOIN application_locked application ON application.customer_id = customer.id
           WHERE customer.organization_id = $2::uuid
             AND customer.status = 'active'
           FOR UPDATE OF customer
         ),
         sequence_start AS MATERIALIZED (
           SELECT COALESCE(MAX(split_part(loan_number, '-', 3)::integer), 0) + 1 AS first_number
           FROM mfi_loans
           WHERE organization_id = $2::uuid
             AND loan_number ~ '^LN-[0-9]{6}-[0-9]{4,}$'
             AND split_part(loan_number, '-', 2) = $4
         ),
         free_number AS (
           SELECT 'LN-' || $4 || '-' || LPAD(candidate.number::text, 4, '0') AS loan_number
           FROM number_lock
           CROSS JOIN sequence_start
           CROSS JOIN LATERAL generate_series(sequence_start.first_number, 999999) AS candidate(number)
           WHERE NOT EXISTS (
             SELECT 1 FROM mfi_loans existing
             WHERE existing.loan_number =
               'LN-' || $4 || '-' || LPAD(candidate.number::text, 4, '0')
           )
           ORDER BY candidate.number
           LIMIT 1
         ),
         created AS (
           INSERT INTO mfi_loans (
             organization_id, application_id, customer_id, product_id, branch_id,
             loan_number, principal, interest_rate, interest_method, term_months,
             repayment_frequency, late_fee_percent, grace_period_days,
             total_interest, total_fees, total_repayable, outstanding_balance,
             disbursement_method, disbursement_reference, disbursed_at,
             first_installment_date, maturity_date, status, created_by, disbursed_by
           )
           SELECT $2::uuid, application.id, application.customer_id, application.product_id,
             application.branch_id, number.loan_number, $5, application.interest_rate,
             application.interest_method, application.term_months,
             application.repayment_frequency, application.late_fee_percent,
             application.grace_period_days, $6, $7, $8, $8,
             $9, $10, $11::timestamptz, $12::date, $13::date, 'active',
             application.created_by, $14::uuid
           FROM application_locked application
           JOIN customer_locked customer ON customer.id = application.customer_id
           CROSS JOIN free_number number
           WHERE application.status = 'approved'
             AND application.updated_at = $15::timestamptz
             AND application.approved_amount = $16::numeric
             AND application.interest_rate = $17::numeric
             AND application.interest_method = $18
             AND application.term_months = $19
             AND application.repayment_frequency = $20
             AND application.processing_fee_percent IS NOT DISTINCT FROM $21::numeric
             AND application.insurance_fee_percent IS NOT DISTINCT FROM $22::numeric
             AND application.late_fee_percent IS NOT DISTINCT FROM $23::numeric
             AND application.grace_period_days IS NOT DISTINCT FROM $24::integer
           RETURNING *
         ),
         schedules AS (
           INSERT INTO mfi_loan_schedules (
             loan_id, installment_number, due_date, principal_due,
             interest_due, fees_due, total_due
           )
           SELECT loan.id, row.installment_number, row.due_date::date,
             row.principal_due, row.interest_due, row.fees_due, row.total_due
           FROM created loan
           CROSS JOIN jsonb_to_recordset($25::jsonb) AS row(
             installment_number integer,
             due_date text,
             principal_due numeric,
             interest_due numeric,
             fees_due numeric,
             total_due numeric
           )
           RETURNING loan_id
         ),
         application_updated AS (
           UPDATE mfi_loan_applications application
           SET status = 'disbursed', updated_at = NOW()
           FROM created loan
           WHERE application.id = loan.application_id
             AND application.organization_id = $2::uuid
             AND application.status = 'approved'
           RETURNING application.id
         ),
         customer_updated AS (
           UPDATE mfi_customers customer
           SET status = 'has_active_loan', updated_at = NOW()
           FROM created loan
           WHERE customer.id = loan.customer_id
             AND customer.organization_id = $2::uuid
             AND customer.status = 'active'
           RETURNING customer.id
         ),
         history AS (
           INSERT INTO mfi_loan_history (organization_id, loan_id, action, actor_id, metadata)
           SELECT $2::uuid, loan.id, 'loan_disbursed', $14::uuid, $3::jsonb
           FROM created loan
           RETURNING id
         ),
         local_audit AS (
           INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
           SELECT $2::uuid, $14::uuid, 'mfi.loan_disbursed', 'mfi_loans', loan.id, $3::jsonb
           FROM created loan
           RETURNING id
         ),
         platform_audit AS (
           INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
           SELECT $14::uuid, 'mfi', 'mfi.loan_disbursed', 'mfi_loans', loan.id, $3::jsonb, $26
           FROM created loan
           RETURNING id
         )
         SELECT created.*, (SELECT COUNT(*)::int FROM schedules) AS schedule_count
         FROM created
         WHERE EXISTS (SELECT 1 FROM application_updated)`,
        [
          applicationId,
          organizationId,
          metadata,
          disbursementDate.slice(0, 7).replace("-", ""),
          principal,
          built.total_interest,
          built.total_fees,
          built.total_repayable,
          method,
          reference,
          `${disbursementDate}T12:00:00.000Z`,
          firstInstallmentDate,
          built.maturity_date,
          user.id,
          String(application.updated_at),
          String(application.approved_amount),
          String(application.interest_rate),
          interestMethod,
          termMonths,
          frequency,
          application.processing_fee_percent == null ? null : String(application.processing_fee_percent),
          application.insurance_fee_percent == null ? null : String(application.insurance_fee_percent),
          application.late_fee_percent == null ? null : String(application.late_fee_percent),
          application.grace_period_days == null ? null : Number(application.grace_period_days),
          JSON.stringify(built.schedules),
          requestIp(c),
        ],
      ) as Record<string, unknown>[];
    } catch (error) {
      if (isUniqueViolation(error)) {
        const racedRows = await sql`
          SELECT * FROM mfi_loans
          WHERE application_id = ${applicationId} AND organization_id = ${organizationId}
          LIMIT 1
        `;
        if (racedRows[0]) return c.json({ loan: racedRows[0], already_disbursed: true });
      }
      throw error;
    }
    if (!createdRows[0]) {
      throw new ApiError(409, "MFI_DISBURSEMENT_CONFLICT", "The approved application or its product changed. Refresh and retry.");
    }
    return c.json({
      loan: createdRows[0],
      loan_number: createdRows[0].loan_number,
      total_repayable: built.total_repayable,
      schedule_preview: built.schedules,
      schedule_count: built.schedules.length,
    }, 201);
  },
);

servicing.get(
  "/mfi/loans",
  requireRole(...ALL_ROLES),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c));
    const status = c.req.query("status") || null;
    if (status && !LOAN_STATUSES.includes(status as (typeof LOAN_STATUSES)[number])) {
      throw new ApiError(400, "VALIDATION_ERROR", "status is not a supported loan status.");
    }
    const branchId = c.req.query("branch_id") ? uuid(c.req.query("branch_id")!, "branch_id") : null;
    const customerId = c.req.query("customer_id") ? uuid(c.req.query("customer_id")!, "customer_id") : null;
    const officerId = c.req.query("officer_id") ? uuid(c.req.query("officer_id")!, "officer_id") : null;
    const search = c.req.query("search")?.trim().slice(0, 120) || null;
    const loans = await sql`
      SELECT loan.id, loan.loan_number, loan.application_id, loan.principal,
        loan.total_repayable, loan.total_paid, loan.outstanding_balance,
        loan.status, loan.days_overdue, loan.disbursed_at, loan.first_installment_date,
        loan.maturity_date, customer.id AS customer_id,
        customer.first_name AS customer_first_name, customer.last_name AS customer_last_name,
        customer.phone AS customer_phone, product.name AS product_name,
        branch.name AS branch_name, COALESCE(officer.name, 'Unassigned') AS officer_name,
        next_schedule.due_date AS next_due_date,
        next_schedule.due_balance AS next_due_balance
      FROM mfi_loans loan
      JOIN mfi_customers customer ON customer.id = loan.customer_id
      LEFT JOIN mfi_loan_products product ON product.id = loan.product_id
      LEFT JOIN mfi_branches branch ON branch.id = loan.branch_id
       LEFT JOIN users officer ON officer.id = COALESCE(loan.created_by, loan.disbursed_by)
      LEFT JOIN LATERAL (
         SELECT due_date,
           GREATEST(0, principal_due - principal_paid)
           + GREATEST(0, interest_due - interest_paid)
           + GREATEST(0, fees_due - fees_paid)
           + GREATEST(0, late_fee_due - late_fee_paid) AS due_balance
        FROM mfi_loan_schedules schedule
        WHERE schedule.loan_id = loan.id AND schedule.status <> 'paid'
        ORDER BY due_date, installment_number
        LIMIT 1
      ) next_schedule ON TRUE
      WHERE loan.organization_id = ${organizationId}
        AND (${status}::text IS NULL OR loan.status = ${status})
        AND (${branchId}::uuid IS NULL OR loan.branch_id = ${branchId}::uuid)
        AND (${customerId}::uuid IS NULL OR loan.customer_id = ${customerId}::uuid)
         AND (${officerId}::uuid IS NULL OR COALESCE(loan.created_by, loan.disbursed_by) = ${officerId}::uuid)
        AND (
          ${search}::text IS NULL OR
          loan.loan_number ILIKE '%' || ${search} || '%' OR
          customer.first_name ILIKE '%' || ${search} || '%' OR
          customer.last_name ILIKE '%' || ${search} || '%' OR
          customer.phone ILIKE '%' || ${search} || '%'
        )
      ORDER BY loan.disbursed_at DESC
      LIMIT 300
    `;
    return c.json({ loans });
  },
);

servicing.get(
  "/mfi/loans/portfolio-by-officer",
  requireRole(...ALL_ROLES),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c));
    const officers = await sql`
      SELECT COALESCE(loan.created_by, loan.disbursed_by) AS officer_id,
        COALESCE(actor.name, 'Unassigned') AS officer_name,
        COUNT(*)::int AS total_loans,
        COUNT(*) FILTER (WHERE loan.status IN ('active', 'past_due', 'defaulted'))::int AS open_loans,
        COUNT(*) FILTER (WHERE loan.status = 'past_due')::int AS past_due_loans,
        COUNT(*) FILTER (WHERE loan.status = 'defaulted')::int AS defaulted_loans,
        COALESCE(SUM(loan.principal), 0) AS total_disbursed,
        COALESCE(SUM(loan.outstanding_balance), 0) AS outstanding_balance
      FROM mfi_loans loan
      LEFT JOIN users actor ON actor.id = COALESCE(loan.created_by, loan.disbursed_by)
      WHERE loan.organization_id = ${organizationId}
      GROUP BY COALESCE(loan.created_by, loan.disbursed_by), actor.name
      ORDER BY outstanding_balance DESC, officer_name ASC
    `;
    return c.json({ officers });
  },
);

servicing.get(
  "/mfi/loans/:id",
  requireRole(...ALL_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, c.get("user"), requestedOrganizationId(c));
    const loan = await scopedLoan(sql, id, organizationId);
    if (!loan) throw new ApiError(404, "MFI_LOAN_NOT_FOUND", "Loan was not found in this organization.");
    const [schedules, payments, history] = await Promise.all([
      sql`
        SELECT * FROM mfi_loan_schedules
        WHERE loan_id = ${id}
        ORDER BY installment_number
      `,
      sql`
        SELECT payment.*, recorder.name AS recorded_by_name, reverser.name AS reversed_by_name
        FROM mfi_loan_payments payment
        LEFT JOIN users recorder ON recorder.id = payment.recorded_by
        LEFT JOIN users reverser ON reverser.id = payment.reversed_by
        WHERE payment.loan_id = ${id} AND payment.organization_id = ${organizationId}
        ORDER BY payment.paid_at DESC, payment.created_at DESC
        LIMIT 500
      `,
      sql`
        SELECT history.*, actor.name AS actor_name
        FROM mfi_loan_history history
        LEFT JOIN users actor ON actor.id = history.actor_id
        WHERE history.loan_id = ${id} AND history.organization_id = ${organizationId}
        ORDER BY history.created_at DESC, history.id DESC
        LIMIT 500
      `,
    ]);
    return c.json({ loan, schedules, payments, history });
  },
);

servicing.get(
  "/mfi/loans/:id/schedule",
  requireRole(...ALL_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, c.get("user"), requestedOrganizationId(c));
    if (!(await scopedLoan(sql, id, organizationId))) {
      throw new ApiError(404, "MFI_LOAN_NOT_FOUND", "Loan was not found in this organization.");
    }
    const schedules = await sql`
      SELECT id, installment_number, due_date, principal_due, interest_due, fees_due,
        total_due, principal_paid, interest_paid, fees_paid, late_fee_due,
        late_fee_paid, total_paid, status, days_late, paid_at,
        GREATEST(0, principal_due - principal_paid) AS outstanding_principal,
        GREATEST(0, interest_due - interest_paid) AS outstanding_interest,
        GREATEST(0, fees_due - fees_paid) AS outstanding_fees,
        GREATEST(0, late_fee_due - late_fee_paid) AS outstanding_late_fees
      FROM mfi_loan_schedules
      WHERE loan_id = ${id}
      ORDER BY installment_number
    `;
    return c.json({ schedules });
  },
);

servicing.get(
  "/mfi/loans/:id/payments",
  requireRole(...ALL_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, c.get("user"), requestedOrganizationId(c));
    if (!(await scopedLoan(sql, id, organizationId))) {
      throw new ApiError(404, "MFI_LOAN_NOT_FOUND", "Loan was not found in this organization.");
    }
    const payments = await sql`
      SELECT payment.*, recorder.name AS recorded_by_name, reverser.name AS reversed_by_name
      FROM mfi_loan_payments payment
      LEFT JOIN users recorder ON recorder.id = payment.recorded_by
      LEFT JOIN users reverser ON reverser.id = payment.reversed_by
      WHERE payment.loan_id = ${id} AND payment.organization_id = ${organizationId}
      ORDER BY payment.paid_at DESC, payment.created_at DESC
      LIMIT 500
    `;
    return c.json({ payments });
  },
);

servicing.get(
  "/mfi/loans/:id/receipt/:paymentId",
  requireRole(...ALL_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"), "loan_id");
    const paymentId = uuid(c.req.param("paymentId"), "payment_id");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, c.get("user"), requestedOrganizationId(c));
    const rows = await sql`
      SELECT payment.*, loan.loan_number, loan.principal, customer.first_name,
        customer.last_name, customer.phone, recorder.name AS recorded_by_name
      FROM mfi_loan_payments payment
      JOIN mfi_loans loan ON loan.id = payment.loan_id
      JOIN mfi_customers customer ON customer.id = loan.customer_id
      LEFT JOIN users recorder ON recorder.id = payment.recorded_by
      WHERE payment.id = ${paymentId}
        AND payment.loan_id = ${id}
        AND payment.organization_id = ${organizationId}
      LIMIT 1
    `;
    if (!rows[0]) throw new ApiError(404, "MFI_PAYMENT_NOT_FOUND", "Payment receipt was not found.");
    return c.json({ receipt: rows[0] });
  },
);

function scheduleSnapshot(schedule: Record<string, unknown>) {
  return {
    id: String(schedule.id),
    installment_number: Number(schedule.installment_number),
    due_date: String(schedule.due_date).slice(0, 10),
    principal_due: String(schedule.principal_due),
    interest_due: String(schedule.interest_due),
    fees_due: String(schedule.fees_due),
    total_due: String(schedule.total_due),
    principal_paid: String(schedule.principal_paid),
    interest_paid: String(schedule.interest_paid),
    fees_paid: String(schedule.fees_paid),
    late_fee_due: String(schedule.late_fee_due),
    late_fee_paid: String(schedule.late_fee_paid),
    total_paid: String(schedule.total_paid),
    status: String(schedule.status),
    days_late: Number(schedule.days_late),
    paid_at: schedule.paid_at ? new Date(String(schedule.paid_at)).toISOString() : null,
  };
}

function paymentUpdates(
  schedules: Record<string, unknown>[],
  allocations: ReturnType<typeof allocatePayment>["allocations"],
  loan: Record<string, unknown>,
  paymentDate: string,
  paidAt: string,
) {
  const allocationById = new Map(allocations.map((item) => [item.schedule_id, item]));
  return schedules.map((schedule) => {
    const id = String(schedule.id);
    const allocation = allocationById.get(id);
    const principalPaid = Number(schedule.principal_paid) + Number(allocation?.principal_applied ?? 0);
    const interestPaid = Number(schedule.interest_paid) + Number(allocation?.interest_applied ?? 0);
    const feesPaid = Number(schedule.fees_paid) + Number(allocation?.fees_applied ?? 0);
    const daysLate = dateDifference(paymentDate, String(schedule.due_date).slice(0, 10));
    const calculatedLateFee = calculateLateFee(
      Number(schedule.total_due),
      Number(loan.late_fee_percent ?? 0),
      daysLate,
      Number(loan.grace_period_days ?? 0),
    );
    const lateFeeDue = Math.max(
      Number(schedule.late_fee_due ?? 0),
      calculatedLateFee,
      Number(schedule.late_fee_paid ?? 0),
    );
    const lateFeePaid = Number(schedule.late_fee_paid) + Number(allocation?.late_fees_applied ?? 0);
    const totalPaid = Number(schedule.total_paid) +
      Number(allocation?.principal_applied ?? 0) +
      Number(allocation?.interest_applied ?? 0) +
      Number(allocation?.fees_applied ?? 0) +
      Number(allocation?.late_fees_applied ?? 0);
    const next = {
      ...schedule,
      principal_paid: principalPaid,
      interest_paid: interestPaid,
      fees_paid: feesPaid,
      late_fee_due: lateFeeDue,
      late_fee_paid: lateFeePaid,
    };
    const unpaid = dueBalance(next);
    const hasApplied = totalPaid > 0;
    const status = unpaid === 0
      ? "paid"
      : daysLate > 0
        ? "overdue"
        : hasApplied
          ? "partial"
          : "pending";
    return {
      id,
      principal_paid: principalPaid,
      interest_paid: interestPaid,
      fees_paid: feesPaid,
      late_fee_due: lateFeeDue,
      late_fee_paid: lateFeePaid,
      total_paid: totalPaid,
      status,
      days_late: daysLate,
      paid_at: status === "paid" ? (schedule.paid_at ? new Date(String(schedule.paid_at)).toISOString() : paidAt) : null,
      principal_applied: Number(allocation?.principal_applied ?? 0),
      interest_applied: Number(allocation?.interest_applied ?? 0),
      fees_applied: Number(allocation?.fees_applied ?? 0),
      late_fees_applied: Number(allocation?.late_fees_applied ?? 0),
    };
  });
}

function assertSchedulesUnchangedCte(expectedParameter: number, lockedName = "locked_schedules") {
  return `
    expected_schedules AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset($${expectedParameter}::jsonb) AS expected(
        id uuid, installment_number integer, due_date text,
        principal_due numeric, interest_due numeric, fees_due numeric,
        total_due numeric, principal_paid numeric, interest_paid numeric,
        fees_paid numeric, late_fee_due numeric, late_fee_paid numeric,
        total_paid numeric, status text, days_late integer, paid_at text
      )
    ),
    schedules_match AS MATERIALIZED (
      SELECT
        (SELECT COUNT(*) FROM ${lockedName}) = jsonb_array_length($${expectedParameter}::jsonb)
        AND
        (SELECT COUNT(*)
         FROM ${lockedName} current
         JOIN expected_schedules expected ON expected.id = current.id
         WHERE current.installment_number = expected.installment_number
           AND current.due_date = expected.due_date::date
           AND current.principal_due = expected.principal_due
           AND current.interest_due = expected.interest_due
           AND current.fees_due = expected.fees_due
           AND current.total_due = expected.total_due
           AND current.principal_paid = expected.principal_paid
           AND current.interest_paid = expected.interest_paid
           AND current.fees_paid = expected.fees_paid
           AND current.late_fee_due = expected.late_fee_due
           AND current.late_fee_paid = expected.late_fee_paid
           AND current.total_paid = expected.total_paid
           AND current.status = expected.status
           AND current.days_late = expected.days_late
           AND current.paid_at IS NOT DISTINCT FROM expected.paid_at::timestamptz
        ) = jsonb_array_length($${expectedParameter}::jsonb) AS matches
    )`;
}

servicing.post(
  "/mfi/loans/:id/payments",
  requireRole(...PAYMENT_ROLES),
  async (c) => {
    const loanId = uuid(c.req.param("id"), "loan_id");
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const amount = wholeAmount(body, "amount");
    const method = paymentMethod(body, "payment_method");
    const paymentDate = body.payment_date === undefined || body.payment_date === null || body.payment_date === ""
      ? kampalaDate()
      : requiredDate(body, "payment_date");
    const reference = optionalTextBody(body, "payment_reference", 160);
    const notes = optionalTextBody(body, "notes", 1000);
    const loan = await scopedLoan(sql, loanId, organizationId);
    if (!loan) throw new ApiError(404, "MFI_LOAN_NOT_FOUND", "Loan was not found in this organization.");
    if (!["active", "past_due", "defaulted"].includes(String(loan.status))) {
      throw new ApiError(409, "MFI_LOAN_NOT_PAYABLE", "Payments can only be recorded against active, past-due, or defaulted loans.");
    }
    const scheduleRows = await sql`
      SELECT * FROM mfi_loan_schedules
      WHERE loan_id = ${loanId}
      ORDER BY due_date, installment_number
    `;
    const schedules = scheduleRows as Record<string, unknown>[];
    const expected = schedules.map(scheduleSnapshot);
    const allocationInputs = schedules.map((schedule) => {
      const daysLate = dateDifference(paymentDate, String(schedule.due_date).slice(0, 10));
      const lateFeeDue = Math.max(
        Number(schedule.late_fee_due ?? 0),
        calculateLateFee(
          Number(schedule.total_due),
          Number(loan.late_fee_percent ?? 0),
          daysLate,
          Number(loan.grace_period_days ?? 0),
        ),
        Number(schedule.late_fee_paid ?? 0),
      );
      return {
        id: String(schedule.id),
        installment_number: Number(schedule.installment_number),
        due_date: String(schedule.due_date).slice(0, 10),
        principal_due: Number(schedule.principal_due),
        interest_due: Number(schedule.interest_due),
        fees_due: Number(schedule.fees_due),
        late_fee_due: lateFeeDue,
        principal_paid: Number(schedule.principal_paid),
        interest_paid: Number(schedule.interest_paid),
        fees_paid: Number(schedule.fees_paid),
        late_fee_paid: Number(schedule.late_fee_paid),
      };
    });
    const paymentAllocation = allocatePayment(amount, allocationInputs);
    const paidAt = `${paymentDate}T12:00:00.000Z`;
    const updates = paymentUpdates(schedules, paymentAllocation.allocations, loan, paymentDate, paidAt);
    const scheduleAllocations = paymentAllocation.allocations
      .filter((allocation) =>
        allocation.principal_applied + allocation.interest_applied +
        allocation.fees_applied + allocation.late_fees_applied > 0,
      );
    const month = paymentDate.slice(0, 7).replace("-", "");
    const metadata = jsonMetadata({
      loan_id: loanId,
      receipt_number: "assigned_at_payment",
      amount,
      principal_applied: paymentAllocation.allocations.reduce((sum, item) => sum + item.principal_applied, 0),
      interest_applied: paymentAllocation.allocations.reduce((sum, item) => sum + item.interest_applied, 0),
      fees_applied: paymentAllocation.allocations.reduce((sum, item) => sum + item.fees_applied, 0),
      late_fees_applied: paymentAllocation.allocations.reduce((sum, item) => sum + item.late_fees_applied, 0),
      overpayment: paymentAllocation.overpayment,
    });
    const expectedJson = JSON.stringify(expected);
    const updatesJson = JSON.stringify(updates);
    const allocationsJson = JSON.stringify(scheduleAllocations);
    const values = [
      loanId,
      organizationId,
      user.id,
      requestIp(c),
      amount,
      paymentAllocation.allocations.reduce((sum, item) => sum + item.principal_applied, 0),
      paymentAllocation.allocations.reduce((sum, item) => sum + item.interest_applied, 0),
      paymentAllocation.allocations.reduce((sum, item) => sum + item.fees_applied, 0),
      paymentAllocation.allocations.reduce((sum, item) => sum + item.late_fees_applied, 0),
      paymentAllocation.overpayment,
      method,
      reference,
      paidAt,
      notes,
      expectedJson,
      updatesJson,
      allocationsJson,
      month,
      metadata,
    ];
    const rows = await sql.query(
      `WITH loan_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended('mfi-loan-mutation:' || $1::text, 0))
       ),
       locked_loan AS MATERIALIZED (
         SELECT loan.* FROM mfi_loans loan CROSS JOIN loan_lock
         WHERE loan.id = $1::uuid AND loan.organization_id = $2::uuid
           AND loan.status = ANY(ARRAY['active', 'past_due', 'defaulted']::text[])
         FOR UPDATE OF loan
       ),
       locked_schedules AS MATERIALIZED (
         SELECT schedule.* FROM mfi_loan_schedules schedule
         JOIN locked_loan loan ON loan.id = schedule.loan_id
         FOR UPDATE OF schedule
       ),
       ${assertSchedulesUnchangedCte(15)},
       update_rows AS MATERIALIZED (
         SELECT * FROM jsonb_to_recordset($16::jsonb) AS update_row(
           id uuid, principal_paid numeric, interest_paid numeric,
           fees_paid numeric, late_fee_due numeric, late_fee_paid numeric,
           total_paid numeric, status text, days_late integer, paid_at text,
           principal_applied numeric, interest_applied numeric,
           fees_applied numeric, late_fees_applied numeric
         )
       ),
       schedule_updated AS (
         UPDATE mfi_loan_schedules schedule
         SET principal_paid = update_row.principal_paid,
           interest_paid = update_row.interest_paid,
           fees_paid = update_row.fees_paid,
           late_fee_due = update_row.late_fee_due,
           late_fee_paid = update_row.late_fee_paid,
           total_paid = update_row.total_paid,
           status = update_row.status,
           days_late = update_row.days_late,
           paid_at = update_row.paid_at::timestamptz
         FROM update_rows update_row, schedules_match match, locked_loan loan
         WHERE schedule.id = update_row.id
           AND schedule.loan_id = loan.id
           AND match.matches IS TRUE
         RETURNING schedule.*
       ),
       schedule_state AS MATERIALIZED (
         SELECT updated.* FROM schedule_updated updated
         UNION ALL
         SELECT current.* FROM locked_schedules current
         WHERE NOT EXISTS (SELECT 1 FROM schedule_updated updated WHERE updated.id = current.id)
       ),
       balances AS MATERIALIZED (
         SELECT
           COALESCE(SUM(GREATEST(0, principal_due - principal_paid)
             + GREATEST(0, interest_due - interest_paid)
             + GREATEST(0, fees_due - fees_paid)
             + GREATEST(0, late_fee_due - late_fee_paid)), 0) AS outstanding_balance,
           COALESCE(SUM(late_fee_due), 0) AS total_late_fees,
           COALESCE(MAX(days_late) FILTER (WHERE status = 'overdue'), 0)::int AS days_overdue
         FROM schedule_state
       ),
       receipt_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended('mfi-payment-receipt:' || $18, 0))
       ),
       sequence_start AS MATERIALIZED (
         SELECT COALESCE(MAX(split_part(receipt_number, '-', 3)::integer), 0) + 1 AS first_number
         FROM mfi_loan_payments
         WHERE organization_id = $2::uuid
           AND receipt_number ~ '^RCPT-[0-9]{6}-[0-9]{4,}$'
           AND split_part(receipt_number, '-', 2) = $18
       ),
       free_receipt AS (
         SELECT 'RCPT-' || $18 || '-' || LPAD(candidate.number::text, 4, '0') AS receipt_number
         FROM receipt_lock
         CROSS JOIN sequence_start
         CROSS JOIN LATERAL generate_series(sequence_start.first_number, 999999) AS candidate(number)
         WHERE NOT EXISTS (
           SELECT 1 FROM mfi_loan_payments existing
           WHERE existing.receipt_number =
             'RCPT-' || $18 || '-' || LPAD(candidate.number::text, 4, '0')
         )
         ORDER BY candidate.number
         LIMIT 1
       ),
       payment_created AS (
         INSERT INTO mfi_loan_payments (
           organization_id, loan_id, receipt_number, amount,
           principal_applied, interest_applied, fees_applied, late_fees_applied,
           overpayment, schedule_allocations, payment_method, payment_reference,
           paid_at, notes, recorded_by
         )
         SELECT loan.organization_id, loan.id, receipt.receipt_number, $5,
           $6, $7, $8, $9, $10, $17::jsonb, $11, $12,
           $13::timestamptz, $14, $3::uuid
         FROM locked_loan loan
         CROSS JOIN free_receipt receipt
         WHERE (SELECT matches FROM schedules_match) IS TRUE
           AND (SELECT COUNT(*) FROM schedule_updated) = jsonb_array_length($16::jsonb)
         RETURNING *
       ),
       loan_updated AS (
         UPDATE mfi_loans loan
         SET total_paid = loan.total_paid + $5,
           total_principal_paid = loan.total_principal_paid + $6,
           total_interest_paid = loan.total_interest_paid + $7,
           total_fees_paid = loan.total_fees_paid + $8,
           total_late_fees = balances.total_late_fees,
           outstanding_balance = balances.outstanding_balance,
           days_overdue = balances.days_overdue,
           status = CASE
             WHEN balances.outstanding_balance <= 0 THEN 'completed'
             WHEN balances.days_overdue >= 90 THEN 'defaulted'
             WHEN balances.days_overdue > 0 THEN 'past_due'
             ELSE 'active'
           END,
           updated_at = NOW()
         FROM locked_loan locked, balances
         WHERE loan.id = locked.id
           AND EXISTS (SELECT 1 FROM payment_created)
         RETURNING loan.*
       ),
       customer_updated AS (
         UPDATE mfi_customers customer
         SET status = CASE WHEN loan.status = 'completed' AND NOT EXISTS (
             SELECT 1 FROM mfi_loans other
             WHERE other.customer_id = customer.id AND other.id <> loan.id
               AND other.status IN ('active', 'past_due', 'defaulted')
               AND other.outstanding_balance > 0
           ) THEN 'active' ELSE 'has_active_loan' END,
           updated_at = NOW()
         FROM loan_updated loan
         WHERE customer.id = loan.customer_id
         RETURNING customer.id
       ),
       history AS (
         INSERT INTO mfi_loan_history (organization_id, loan_id, action, actor_id, metadata)
         SELECT $2::uuid, $1::uuid, 'payment_recorded', $3::uuid, $19::jsonb
         FROM payment_created
         RETURNING id
       ),
       local_audit AS (
         INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
         SELECT $2::uuid, $3::uuid, 'mfi.loan_payment_recorded',
           'mfi_loan_payments', payment.id, $19::jsonb
         FROM payment_created payment
         RETURNING id
       ),
       platform_audit AS (
         INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
         SELECT $3::uuid, 'mfi', 'mfi.loan_payment_recorded',
           'mfi_loan_payments', payment.id, $19::jsonb, $4
         FROM payment_created payment
         RETURNING id
       )
       SELECT payment_created.*,
         loan_updated.status AS loan_status,
         loan_updated.outstanding_balance AS new_outstanding,
         jsonb_build_object(
           'principal', payment_created.principal_applied,
           'interest', payment_created.interest_applied,
           'fees', payment_created.fees_applied,
           'late_fee', payment_created.late_fees_applied
         ) AS allocated,
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'schedule_id', update_rows.id,
           'principal_applied', update_rows.principal_applied,
           'interest_applied', update_rows.interest_applied,
           'fees_applied', update_rows.fees_applied,
           'late_fees_applied', update_rows.late_fees_applied,
           'status', schedule_updated.status,
           'total_paid', schedule_updated.total_paid
         ) ORDER BY schedule_updated.installment_number), '[]'::jsonb)
          FROM schedule_updated
          JOIN update_rows ON update_rows.id = schedule_updated.id) AS schedule_updates
       FROM payment_created CROSS JOIN loan_updated`,
      values,
    ) as Record<string, unknown>[];
    if (!rows[0]) {
      throw new ApiError(409, "MFI_PAYMENT_CONFLICT", "The loan or its schedule changed. Refresh and retry the payment.");
    }
    return c.json({ payment: rows[0] }, 201);
  },
);

function parseStoredAllocations(value: unknown): Array<{
  schedule_id: string;
  principal_applied: number;
  interest_applied: number;
  fees_applied: number;
  late_fees_applied: number;
}> {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new ApiError(409, "MFI_PAYMENT_ALLOCATION_INVALID", "The payment allocation record cannot be reversed safely.");
    }
  }
  if (!Array.isArray(parsed)) {
    throw new ApiError(409, "MFI_PAYMENT_ALLOCATION_INVALID", "The payment allocation record cannot be reversed safely.");
  }
  return parsed.map((item) => {
    if (!item || typeof item !== "object" || typeof item.schedule_id !== "string") {
      throw new ApiError(409, "MFI_PAYMENT_ALLOCATION_INVALID", "The payment allocation record cannot be reversed safely.");
    }
    const values = [
      Number(item.principal_applied ?? 0),
      Number(item.interest_applied ?? 0),
      Number(item.fees_applied ?? 0),
      Number(item.late_fees_applied ?? 0),
    ];
    if (values.some((amount) => !Number.isSafeInteger(amount) || amount < 0)) {
      throw new ApiError(409, "MFI_PAYMENT_ALLOCATION_INVALID", "The payment allocation record cannot be reversed safely.");
    }
    return {
      schedule_id: item.schedule_id,
      principal_applied: values[0],
      interest_applied: values[1],
      fees_applied: values[2],
      late_fees_applied: values[3],
    };
  });
}

servicing.post(
  "/mfi/loans/:id/payments/:paymentId/reverse",
  requireRole(...MANAGER_ROLES),
  async (c) => {
    const loanId = uuid(c.req.param("id"), "loan_id");
    const paymentId = uuid(c.req.param("paymentId"), "payment_id");
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const reason = optionalTextBody(body, "reason", 500);
    if (!reason || reason.length < 5) {
      throw new ApiError(400, "VALIDATION_ERROR", "A reversal reason of at least five characters is required.");
    }
    const paymentRows = await sql`
      SELECT * FROM mfi_loan_payments
      WHERE id = ${paymentId}
        AND loan_id = ${loanId}
        AND organization_id = ${organizationId}
      LIMIT 1
    `;
    const payment = paymentRows[0] as Record<string, unknown> | undefined;
    if (!payment) throw new ApiError(404, "MFI_PAYMENT_NOT_FOUND", "Payment was not found for this loan.");
    if (payment.reversed_at) throw new ApiError(409, "MFI_PAYMENT_ALREADY_REVERSED", "This payment has already been reversed.");
    const allocations = parseStoredAllocations(payment.schedule_allocations);
    const totals = allocations.reduce((sum, allocation) => ({
      principal: sum.principal + allocation.principal_applied,
      interest: sum.interest + allocation.interest_applied,
      fees: sum.fees + allocation.fees_applied,
      lateFees: sum.lateFees + allocation.late_fees_applied,
    }), { principal: 0, interest: 0, fees: 0, lateFees: 0 });
    if (
      totals.principal !== Number(payment.principal_applied) ||
      totals.interest !== Number(payment.interest_applied) ||
      totals.fees !== Number(payment.fees_applied) ||
      totals.lateFees !== Number(payment.late_fees_applied)
    ) {
      throw new ApiError(409, "MFI_PAYMENT_ALLOCATION_INVALID", "The payment allocation totals do not match its recorded receipt.");
    }
    const allocationJson = JSON.stringify(allocations);
    const metadata = jsonMetadata({
      payment_id: paymentId,
      receipt_number: payment.receipt_number,
      amount: payment.amount,
      reason,
      schedule_allocations: allocations,
      reversed_by: user.id,
    });
    const rows = await sql.query(
      `WITH loan_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended('mfi-loan-mutation:' || $1::text, 0))
       ),
       locked_loan AS MATERIALIZED (
         SELECT loan.* FROM mfi_loans loan CROSS JOIN loan_lock
         WHERE loan.id = $1::uuid AND loan.organization_id = $2::uuid
         FOR UPDATE OF loan
       ),
       payment_locked AS MATERIALIZED (
         SELECT payment.* FROM mfi_loan_payments payment
         JOIN locked_loan loan ON loan.id = payment.loan_id
         WHERE payment.id = $3::uuid AND payment.reversed_at IS NULL
         FOR UPDATE OF payment
       ),
       allocation_rows AS MATERIALIZED (
         SELECT * FROM jsonb_to_recordset($4::jsonb) AS allocation(
           schedule_id uuid,
           principal_applied numeric,
           interest_applied numeric,
           fees_applied numeric,
           late_fees_applied numeric
         )
       ),
       locked_schedules AS MATERIALIZED (
         SELECT schedule.* FROM mfi_loan_schedules schedule
         JOIN locked_loan loan ON loan.id = schedule.loan_id
         FOR UPDATE OF schedule
       ),
       schedule_updated AS (
         UPDATE mfi_loan_schedules schedule
         SET principal_paid = GREATEST(0, schedule.principal_paid - allocation.principal_applied),
           interest_paid = GREATEST(0, schedule.interest_paid - allocation.interest_applied),
           fees_paid = GREATEST(0, schedule.fees_paid - allocation.fees_applied),
           late_fee_paid = GREATEST(0, schedule.late_fee_paid - allocation.late_fees_applied),
           total_paid = GREATEST(0, schedule.total_paid -
             allocation.principal_applied - allocation.interest_applied -
             allocation.fees_applied - allocation.late_fees_applied),
           status = CASE
             WHEN GREATEST(0, schedule.principal_due - GREATEST(0, schedule.principal_paid - allocation.principal_applied))
               + GREATEST(0, schedule.interest_due - GREATEST(0, schedule.interest_paid - allocation.interest_applied))
               + GREATEST(0, schedule.fees_due - GREATEST(0, schedule.fees_paid - allocation.fees_applied))
               + GREATEST(0, schedule.late_fee_due - GREATEST(0, schedule.late_fee_paid - allocation.late_fees_applied)) = 0
               THEN 'paid'
             WHEN schedule.due_date < CURRENT_DATE THEN 'overdue'
             WHEN GREATEST(0, schedule.total_paid -
               allocation.principal_applied - allocation.interest_applied -
               allocation.fees_applied - allocation.late_fees_applied) > 0 THEN 'partial'
             ELSE 'pending'
           END,
           paid_at = CASE
             WHEN GREATEST(0, schedule.principal_due - GREATEST(0, schedule.principal_paid - allocation.principal_applied))
               + GREATEST(0, schedule.interest_due - GREATEST(0, schedule.interest_paid - allocation.interest_applied))
               + GREATEST(0, schedule.fees_due - GREATEST(0, schedule.fees_paid - allocation.fees_applied))
               + GREATEST(0, schedule.late_fee_due - GREATEST(0, schedule.late_fee_paid - allocation.late_fees_applied)) > 0
               THEN NULL ELSE schedule.paid_at END
         FROM allocation_rows allocation, payment_locked payment
         WHERE schedule.id = allocation.schedule_id
           AND schedule.loan_id = payment.loan_id
         RETURNING schedule.*
       ),
       payment_marked AS (
         UPDATE mfi_loan_payments payment
         SET reversed_at = NOW(), reversed_by = $5::uuid, reversal_reason = $6
         FROM payment_locked locked
         WHERE payment.id = locked.id AND payment.reversed_at IS NULL
         RETURNING payment.*
       ),
       schedule_state AS MATERIALIZED (
         SELECT updated.* FROM schedule_updated updated
         UNION ALL
         SELECT current.* FROM locked_schedules current
         WHERE NOT EXISTS (SELECT 1 FROM schedule_updated updated WHERE updated.id = current.id)
       ),
       balances AS MATERIALIZED (
         SELECT
           COALESCE(SUM(GREATEST(0, principal_due - principal_paid)
             + GREATEST(0, interest_due - interest_paid)
             + GREATEST(0, fees_due - fees_paid)
             + GREATEST(0, late_fee_due - late_fee_paid)), 0) AS outstanding_balance,
           COALESCE(SUM(late_fee_due), 0) AS total_late_fees,
           COALESCE(MAX(days_late) FILTER (WHERE status = 'overdue'), 0)::int AS days_overdue
         FROM schedule_state
       ),
       payment_totals AS MATERIALIZED (
         SELECT COALESCE(SUM(amount), 0) AS total_paid,
           COALESCE(SUM(principal_applied), 0) AS total_principal_paid,
           COALESCE(SUM(interest_applied), 0) AS total_interest_paid,
           COALESCE(SUM(fees_applied), 0) AS total_fees_paid
         FROM mfi_loan_payments
         WHERE loan_id = $1::uuid
           AND organization_id = $2::uuid
           AND reversed_at IS NULL
           AND id <> $3::uuid
       ),
       loan_updated AS (
         UPDATE mfi_loans loan
         SET total_paid = payment_totals.total_paid,
           total_principal_paid = payment_totals.total_principal_paid,
           total_interest_paid = payment_totals.total_interest_paid,
           total_fees_paid = payment_totals.total_fees_paid,
           total_late_fees = balances.total_late_fees,
           outstanding_balance = balances.outstanding_balance,
           days_overdue = balances.days_overdue,
           status = CASE
             WHEN balances.outstanding_balance <= 0 THEN 'completed'
             WHEN balances.days_overdue >= 90 THEN 'defaulted'
             WHEN balances.days_overdue > 0 THEN 'past_due'
             ELSE 'active'
           END,
           updated_at = NOW()
         FROM locked_loan locked, payment_totals, balances
         WHERE loan.id = locked.id AND EXISTS (SELECT 1 FROM payment_marked)
         RETURNING loan.*
       ),
       customer_updated AS (
         UPDATE mfi_customers customer
         SET status = CASE WHEN loan.status = 'completed' AND NOT EXISTS (
             SELECT 1 FROM mfi_loans other
             WHERE other.customer_id = customer.id AND other.id <> loan.id
               AND other.status IN ('active', 'past_due', 'defaulted')
               AND other.outstanding_balance > 0
           ) THEN 'active' ELSE 'has_active_loan' END,
           updated_at = NOW()
         FROM loan_updated loan
         WHERE customer.id = loan.customer_id
         RETURNING customer.id
       ),
       history AS (
         INSERT INTO mfi_loan_history (organization_id, loan_id, action, actor_id, metadata)
         SELECT $2::uuid, $1::uuid, 'payment_reversed', $5::uuid, $7::jsonb
         FROM payment_marked
         RETURNING id
       ),
       local_audit AS (
         INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
         SELECT $2::uuid, $5::uuid, 'mfi.loan_payment_reversed',
           'mfi_loan_payments', payment.id, $7::jsonb
         FROM payment_marked payment
         RETURNING id
       ),
       platform_audit AS (
         INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
         SELECT $5::uuid, 'mfi', 'mfi.loan_payment_reversed',
           'mfi_loan_payments', payment.id, $7::jsonb, $8
         FROM payment_marked payment
         RETURNING id
       )
       SELECT payment_marked.*, loan_updated.status AS loan_status
       FROM payment_marked CROSS JOIN loan_updated`,
      [
        loanId,
        organizationId,
        paymentId,
        allocationJson,
        user.id,
        reason,
        metadata,
        requestIp(c),
      ],
    ) as Record<string, unknown>[];
    if (!rows[0]) {
      throw new ApiError(409, "MFI_PAYMENT_ALREADY_REVERSED", "The payment has already been reversed or the loan changed.");
    }
    return c.json({ payment: rows[0] });
  },
);

servicing.post(
  "/mfi/loans/:id/credit-note",
  requireRole(...MANAGER_ROLES),
  async (c) => {
    const loanId = uuid(c.req.param("id"), "loan_id");
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const requestedAmount = wholeAmount(body, "amount");
    const reason = optionalTextBody(body, "reason", 1000);
    if (!reason || reason.length < 5) {
      throw new ApiError(400, "VALIDATION_ERROR", "A credit-note reason of at least five characters is required.");
    }
    const loan = await scopedLoan(sql, loanId, organizationId);
    if (!loan) throw new ApiError(404, "MFI_LOAN_NOT_FOUND", "Loan was not found in this organization.");
    if (!["active", "past_due", "defaulted"].includes(String(loan.status))) {
      throw new ApiError(409, "MFI_CREDIT_NOTE_LOAN_CLOSED", "Credit notes can only be applied to an open loan.");
    }
    const scheduleRows = await sql`
      SELECT * FROM mfi_loan_schedules
      WHERE loan_id = ${loanId}
      ORDER BY due_date, installment_number
    `;
    const asOfDate = kampalaDate();
    const schedules = scheduleRows as Record<string, unknown>[];
    const eligible = schedules.filter((schedule) =>
      schedule.status === "pending" &&
      String(schedule.due_date).slice(0, 10) > asOfDate &&
      Number(schedule.principal_due) > 0 &&
      Number(schedule.principal_paid ?? 0) === 0 &&
      Number(schedule.interest_paid ?? 0) === 0 &&
      Number(schedule.fees_paid ?? 0) === 0 &&
      Number(schedule.late_fee_paid ?? 0) === 0 &&
      Number(schedule.total_paid ?? 0) === 0,
    );
    const credit = allocateCredit(
      requestedAmount,
      schedules.map((schedule) => ({
        id: String(schedule.id),
        installment_number: Number(schedule.installment_number),
        due_date: String(schedule.due_date).slice(0, 10),
        status: String(schedule.status),
        principal_due: Number(schedule.principal_due),
        principal_paid: Number(schedule.principal_paid ?? 0),
        interest_paid: Number(schedule.interest_paid ?? 0),
        fees_paid: Number(schedule.fees_paid ?? 0),
        late_fee_paid: Number(schedule.late_fee_paid ?? 0),
        total_paid: Number(schedule.total_paid ?? 0),
      })),
      asOfDate,
    );
    if (credit.applied_amount <= 0 || !credit.allocations.length) {
      throw new ApiError(409, "MFI_CREDIT_NOTE_NO_ELIGIBLE_PRINCIPAL", "There is no future unpaid principal eligible for a credit note.");
    }
    const eligibleIds = new Set(eligible.map((schedule) => String(schedule.id)));
    const expectedSchedules = eligible
      .filter((schedule) => eligibleIds.has(String(schedule.id)))
      .map(scheduleSnapshot);
    const allocationById = new Map(credit.allocations.map((item) => [item.schedule_id, item.principal_reduction]));
    const scheduleChanges = credit.allocations.map((allocation) => {
      const schedule = eligible.find((item) => String(item.id) === allocation.schedule_id)!;
      const reduction = allocation.principal_reduction;
      return {
        schedule_id: allocation.schedule_id,
        principal_reduction: reduction,
        principal_due_before: Number(schedule.principal_due),
        principal_due_after: Number(schedule.principal_due) - reduction,
        total_due_before: Number(schedule.total_due),
        total_due_after: Number(schedule.total_due) - reduction,
      };
    });
    const expectedJson = JSON.stringify(expectedSchedules);
    const allocationsJson = JSON.stringify(credit.allocations.map((item) => ({
      id: item.schedule_id,
      principal_reduction: item.principal_reduction,
    })));
    const metadata = jsonMetadata({
      loan_id: loanId,
      requested_amount: requestedAmount,
      applied_amount: credit.applied_amount,
      reason,
      issued_by: user.id,
      schedule_allocations: scheduleChanges,
    });
    const rows = await sql.query(
      `WITH loan_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended('mfi-loan-mutation:' || $1::text, 0))
       ),
       locked_loan AS MATERIALIZED (
         SELECT loan.* FROM mfi_loans loan CROSS JOIN loan_lock
         WHERE loan.id = $1::uuid AND loan.organization_id = $2::uuid
           AND loan.status = ANY(ARRAY['active', 'past_due', 'defaulted']::text[])
         FOR UPDATE OF loan
       ),
       eligible_schedules AS MATERIALIZED (
         SELECT schedule.* FROM mfi_loan_schedules schedule
         JOIN locked_loan loan ON loan.id = schedule.loan_id
         WHERE schedule.status = 'pending'
           AND schedule.due_date > $5::date
           AND schedule.principal_due > 0
           AND schedule.principal_paid = 0
           AND schedule.interest_paid = 0
           AND schedule.fees_paid = 0
           AND schedule.late_fee_paid = 0
           AND schedule.total_paid = 0
         FOR UPDATE OF schedule
       ),
       ${assertSchedulesUnchangedCte(8, "eligible_schedules")},
       credit_rows AS MATERIALIZED (
         SELECT * FROM jsonb_to_recordset($9::jsonb) AS credit(
           id uuid, principal_reduction numeric
         )
       ),
       schedule_updated AS (
         UPDATE mfi_loan_schedules schedule
         SET principal_due = schedule.principal_due - credit.principal_reduction,
           total_due = schedule.total_due - credit.principal_reduction
         FROM credit_rows credit, schedules_match match, eligible_schedules eligible
         WHERE schedule.id = credit.id
           AND schedule.id = eligible.id
           AND match.matches IS TRUE
           AND credit.principal_reduction > 0
           AND credit.principal_reduction <= schedule.principal_due
         RETURNING schedule.*
       ),
       credit_created AS (
         INSERT INTO mfi_credit_notes (
           organization_id, loan_id, amount, reason, issued_by
         )
         SELECT $2::uuid, loan.id, $6, $7, $3::uuid
         FROM locked_loan loan
         WHERE (SELECT matches FROM schedules_match) IS TRUE
           AND (SELECT COUNT(*) FROM schedule_updated) = jsonb_array_length($9::jsonb)
         RETURNING *
       ),
       loan_updated AS (
         UPDATE mfi_loans loan
         SET total_repayable = GREATEST(loan.total_paid, loan.total_repayable - $6),
           outstanding_balance = GREATEST(0, loan.outstanding_balance - $6),
           status = CASE WHEN GREATEST(0, loan.outstanding_balance - $6) <= 0
             THEN 'completed' ELSE loan.status END,
           updated_at = NOW()
         FROM credit_created credit
         WHERE loan.id = credit.loan_id
         RETURNING loan.*
       ),
       customer_updated AS (
         UPDATE mfi_customers customer
         SET status = CASE WHEN loan.status = 'completed' AND NOT EXISTS (
             SELECT 1 FROM mfi_loans other
             WHERE other.customer_id = customer.id AND other.id <> loan.id
               AND other.status IN ('active', 'past_due', 'defaulted')
               AND other.outstanding_balance > 0
           ) THEN 'active' ELSE 'has_active_loan' END,
           updated_at = NOW()
         FROM loan_updated loan
         WHERE customer.id = loan.customer_id
         RETURNING customer.id
       ),
       history AS (
         INSERT INTO mfi_loan_history (organization_id, loan_id, action, actor_id, metadata)
         SELECT $2::uuid, $1::uuid, 'credit_note', $3::uuid, $10::jsonb
         FROM credit_created
         RETURNING id
       ),
       local_audit AS (
         INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
         SELECT $2::uuid, $3::uuid, 'mfi.loan_credit_note_issued',
           'mfi_credit_notes', credit.id, $10::jsonb
         FROM credit_created credit
         RETURNING id
       ),
       platform_audit AS (
         INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
         SELECT $3::uuid, 'mfi', 'mfi.loan_credit_note_issued',
           'mfi_credit_notes', credit.id, $10::jsonb, $4
         FROM credit_created credit
         RETURNING id
       )
       SELECT credit_created.*, loan_updated.status AS loan_status
       FROM credit_created CROSS JOIN loan_updated`,
      [
        loanId,
        organizationId,
        user.id,
        requestIp(c),
        asOfDate,
        credit.applied_amount,
        reason,
        expectedJson,
        allocationsJson,
        metadata,
      ],
    ) as Record<string, unknown>[];
    if (!rows[0]) {
      throw new ApiError(409, "MFI_CREDIT_NOTE_CONFLICT", "The loan schedule changed. Refresh and retry the credit note.");
    }
    return c.json({
      credit_note: rows[0],
      requested_amount: requestedAmount,
      applied_amount: credit.applied_amount,
      schedule_allocations: scheduleChanges,
    }, 201);
  },
);

export async function runMfiOverdueSweep(env: Env): Promise<{
  schedules_updated: number;
  loans_updated: number;
}> {
  const sql = getDb(env);
  const rows = await sql`
    WITH schedule_updates AS (
      UPDATE mfi_loan_schedules schedule
      SET days_late = GREATEST(0, CURRENT_DATE - schedule.due_date),
        status = 'overdue',
        late_fee_due = GREATEST(
          schedule.late_fee_due,
          schedule.late_fee_paid,
          ROUND(
            schedule.total_due * loan.late_fee_percent / 100 *
            GREATEST(0, CURRENT_DATE - schedule.due_date - loan.grace_period_days) / 30
          )
        )
      FROM mfi_loans loan
      WHERE loan.id = schedule.loan_id
        AND loan.status IN ('active', 'past_due', 'defaulted')
        AND schedule.due_date < CURRENT_DATE
        AND schedule.status <> 'paid'
      RETURNING schedule.*
    ),
    affected_loans AS MATERIALIZED (
      SELECT DISTINCT loan_id FROM schedule_updates
    ),
    schedule_state AS MATERIALIZED (
      SELECT updated.* FROM schedule_updates updated
      UNION ALL
      SELECT schedule.* FROM mfi_loan_schedules schedule
      JOIN affected_loans affected ON affected.loan_id = schedule.loan_id
      WHERE NOT EXISTS (
        SELECT 1 FROM schedule_updates updated WHERE updated.id = schedule.id
      )
    ),
    loan_balances AS MATERIALIZED (
      SELECT loan_id,
        COALESCE(SUM(GREATEST(0, principal_due - principal_paid)
          + GREATEST(0, interest_due - interest_paid)
          + GREATEST(0, fees_due - fees_paid)
          + GREATEST(0, late_fee_due - late_fee_paid)), 0) AS outstanding_balance,
        COALESCE(SUM(late_fee_due), 0) AS total_late_fees,
        COALESCE(MAX(days_late) FILTER (WHERE status = 'overdue'), 0)::int AS days_overdue
      FROM schedule_state
      GROUP BY loan_id
    ),
    loan_updates AS (
      UPDATE mfi_loans loan
      SET outstanding_balance = balance.outstanding_balance,
        total_late_fees = balance.total_late_fees,
        days_overdue = balance.days_overdue,
        status = CASE
          WHEN balance.outstanding_balance <= 0 THEN 'completed'
          WHEN balance.days_overdue >= 90 THEN 'defaulted'
          WHEN balance.days_overdue > 0 THEN 'past_due'
          ELSE 'active'
        END,
        updated_at = NOW()
      FROM loan_balances balance
      WHERE loan.id = balance.loan_id
      RETURNING loan.id, loan.customer_id, loan.status
    ),
    customers_released AS (
      UPDATE mfi_customers customer
      SET status = 'active', updated_at = NOW()
      FROM loan_updates loan
      WHERE loan.customer_id = customer.id
        AND loan.status = 'completed'
        AND NOT EXISTS (
          SELECT 1 FROM mfi_loans other
          WHERE other.customer_id = customer.id
            AND other.id <> loan.id
            AND other.status IN ('active', 'past_due', 'defaulted')
            AND other.outstanding_balance > 0
        )
      RETURNING customer.id
    )
    SELECT
      (SELECT COUNT(*)::int FROM schedule_updates) AS schedules_updated,
      (SELECT COUNT(*)::int FROM loan_updates) AS loans_updated
  `;
  return {
    schedules_updated: Number(rows[0]?.schedules_updated ?? 0),
    loans_updated: Number(rows[0]?.loans_updated ?? 0),
  };
}

export default servicing;
