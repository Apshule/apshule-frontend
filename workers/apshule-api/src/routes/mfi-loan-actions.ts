import { Hono } from "hono";
import { ApiError, getDb } from "../db.js";
import { authMiddleware, requireRole } from "../auth.js";
import { buildRestructureSchedule } from "../mfi-restructure-domain.js";
import { parseReportDate } from "../mfi-reports-domain.js";
import {
  pathUuid,
  requireMfiSector,
  resolveMfiOrganization,
} from "../mfi-organization-access.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";
import type { LoanFrequency, LoanInterestMethod, ScheduleRow } from "../mfi/loan-math.js";

const actions = new Hono<AppEnv>();
const RESTRUCTURE_ROLES = ["mfi_admin", "loan_manager", "loan_director", "superadmin"] as const;
const WRITE_OFF_ROLES = ["mfi_admin", "loan_director", "superadmin"] as const;
const OPEN_SCHEDULE_STATUSES = ["pending", "partial", "overdue"] as const;
const ACTIVE_LOAN_STATUSES = ["active", "past_due", "defaulted"] as const;

actions.use("/mfi/*", authMiddleware, requireMfiSector);

function requestIp(c: any): string | null {
  return c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;
}

function parseDate(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must use YYYY-MM-DD format.`);
  }
  try {
    return parseReportDate(value);
  } catch (error) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      error instanceof Error ? `${field}: ${error.message}` : `${field} is invalid.`,
    );
  }
}

function positiveInteger(value: unknown, field: string, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a whole number from 1 to ${max}.`);
  }
  return parsed;
}

function positiveMoney(value: unknown, field: string, allowUndefined = false): number | undefined {
  if (value === undefined && allowUndefined) return undefined;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a positive whole number of UGX.`);
  }
  return amount;
}

function annualRate(value: unknown, field: string): number {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1000) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be between 0 and 1000 percent.`);
  }
  return rate;
}

function reasonText(value: unknown, field = "reason"): string {
  if (typeof value !== "string" || value.trim().length < 5 || value.trim().length > 1000) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be between 5 and 1000 characters.`);
  }
  return value.trim();
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) {
    throw new ApiError(500, "INVALID_LOAN_DATA", "The loan contains a non-numeric balance.");
  }
  return number;
}

function todayKampala(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function addMonthsClamped(dateText: string, months: number): string {
  const [year, month, day] = dateText.split("-").map(Number);
  const targetMonth = month - 1 + months;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return `${targetYear.toString().padStart(4, "0")}-${String(normalizedMonth + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

function addDays(dateText: string, days: number): string {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function firstInstallmentDate(
  frequency: LoanFrequency,
  today: string,
  existingDueDate: string | null,
): string {
  if (existingDueDate && existingDueDate > today) return existingDueDate;
  if (frequency === "monthly") return addMonthsClamped(today, 1);
  return addDays(today, frequency === "biweekly" ? 14 : 7);
}

function scheduleWithCarryover(
  schedule: ScheduleRow[],
  carryInterest: number,
  carryFees: number,
): ScheduleRow[] {
  return schedule.map((row, index) => index === 0
    ? {
        ...row,
        interest_due: row.interest_due + carryInterest,
        fees_due: row.fees_due + carryFees,
        total_due: row.total_due + carryInterest + carryFees,
      }
    : row);
}

actions.get(
  "/mfi/loans/:loanId/restructures",
  requireRole(...RESTRUCTURE_ROLES),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const organization = await resolveMfiOrganization(sql, user, c.req.query("organization_id"));
    const loanId = pathUuid(c.req.param("loanId"), "loan_id");
    const rows = await sql`
      SELECT restructure.*, approver.name AS approved_by_name
      FROM mfi_loan_restructures restructure
      LEFT JOIN users approver ON approver.id = restructure.approved_by
      WHERE restructure.loan_id = ${loanId}
        AND restructure.organization_id = ${organization.id}
      ORDER BY restructure.created_at DESC
    `;
    return c.json({ restructures: rows });
  },
);

actions.post(
  "/mfi/loans/:loanId/restructure",
  requireRole(...RESTRUCTURE_ROLES),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const organization = await resolveMfiOrganization(sql, user, c.req.query("organization_id"));
    const loanId = pathUuid(c.req.param("loanId"), "loan_id");
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) throw new ApiError(400, "INVALID_JSON", "A JSON request body is required.");
    const reason = reasonText(body.reason);

    const loanRows = await sql`
      SELECT id, organization_id, interest_rate, interest_method, term_months,
        repayment_frequency, maturity_date, first_installment_date, status,
        total_paid, total_principal_paid, total_interest_paid, total_fees_paid,
        total_interest, total_fees, total_repayable, outstanding_balance, updated_at
      FROM mfi_loans
      WHERE id = ${loanId} AND organization_id = ${organization.id}
      LIMIT 1
    `;
    const loan = loanRows[0] as Record<string, unknown> | undefined;
    if (!loan) throw new ApiError(404, "LOAN_NOT_FOUND", "The loan was not found.");
    if (!ACTIVE_LOAN_STATUSES.includes(String(loan.status) as typeof ACTIVE_LOAN_STATUSES[number])) {
      throw new ApiError(
        409,
        "LOAN_NOT_RESTRUCTURABLE",
        "Only active, past-due, or defaulted loans can be restructured.",
      );
    }
    const scheduleRows = await sql`
      SELECT installment_number, due_date,
        GREATEST(principal_due - principal_paid, 0) AS principal_remaining,
        GREATEST(interest_due - interest_paid, 0) AS interest_remaining,
        GREATEST(fees_due - fees_paid, 0) + GREATEST(late_fee_due - late_fee_paid, 0) AS fees_remaining
      FROM mfi_loan_schedules
      WHERE loan_id = ${loanId}
        AND status = ANY(${OPEN_SCHEDULE_STATUSES}::text[])
      ORDER BY due_date, installment_number
    `;
    const openSchedules = scheduleRows as Array<Record<string, unknown>>;
    const remainingPrincipal = Math.round(openSchedules.reduce(
      (sum, row) => sum + numberValue(row.principal_remaining),
      0,
    ));
    if (remainingPrincipal <= 0 || openSchedules.length === 0) {
      throw new ApiError(409, "NO_REMAINING_PRINCIPAL", "There is no unpaid principal to restructure.");
    }
    const carryInterest = Math.round(openSchedules.reduce(
      (sum, row) => sum + numberValue(row.interest_remaining),
      0,
    ));
    const carryFees = Math.round(openSchedules.reduce(
      (sum, row) => sum + numberValue(row.fees_remaining),
      0,
    ));
    const newRate = body.new_annual_rate === undefined
      ? numberValue(loan.interest_rate)
      : annualRate(body.new_annual_rate, "new_annual_rate");
    const newTerm = body.new_term_months === undefined
      ? Number(loan.term_months)
      : positiveInteger(body.new_term_months, "new_term_months", 360);
    const frequency = String(loan.repayment_frequency) as LoanFrequency;
    const method = String(loan.interest_method) as LoanInterestMethod;
    const requestedInstallment = positiveMoney(
      body.new_repayment_amount,
      "new_repayment_amount",
      true,
    );
    if (
      newRate === numberValue(loan.interest_rate) &&
      newTerm === Number(loan.term_months) &&
      requestedInstallment === undefined
    ) {
      throw new ApiError(400, "NO_TERM_CHANGE", "Provide a new interest rate, term, or repayment amount.");
    }
    const today = todayKampala();
    const nextInstallment = firstInstallmentDate(
      frequency,
      today,
      String(openSchedules[0]?.due_date || "").slice(0, 10) || null,
    );
    let built;
    try {
      built = buildRestructureSchedule(
        {
          principal: remainingPrincipal,
          annual_rate: newRate,
          term_months: newTerm,
          frequency,
          start_date: nextInstallment,
        },
        method,
        requestedInstallment,
      );
    } catch (error) {
      throw new ApiError(
        400,
        "INVALID_RESTRUCTURE_TERMS",
        error instanceof Error ? error.message : "The proposed terms cannot be scheduled.",
      );
    }
    const newSchedule = scheduleWithCarryover(
      built.schedules,
      carryInterest,
      carryFees,
    );
    const newOutstanding = newSchedule.reduce((sum, row) => sum + row.total_due, 0);
    const newTotalInterest = numberValue(loan.total_interest_paid) + built.total_interest + carryInterest;
    const newTotalFees = numberValue(loan.total_fees_paid) + built.total_fees + carryFees;
    const newTotalRepayable = numberValue(loan.total_paid) + newOutstanding;
    const oldOutstanding = numberValue(loan.outstanding_balance);
    const payload = JSON.stringify(newSchedule);
    const restructureId = crypto.randomUUID();
    const ip = requestIp(c);
    const rows = await sql`
      WITH updated_loan AS (
        UPDATE mfi_loans
        SET interest_rate = ${newRate},
          term_months = ${newTerm},
          first_installment_date = ${nextInstallment}::date,
          maturity_date = ${built.maturity_date}::date,
          total_interest = ${newTotalInterest},
          total_fees = ${newTotalFees},
          total_repayable = ${newTotalRepayable},
          outstanding_balance = ${newOutstanding},
          status = 'active',
          days_overdue = 0,
          updated_at = NOW()
        WHERE id = ${loanId}
          AND organization_id = ${organization.id}
          AND updated_at = ${loan.updated_at}
          AND status = ANY(${ACTIVE_LOAN_STATUSES}::text[])
        RETURNING *
      ),
      retired_schedules AS (
        UPDATE mfi_loan_schedules
        SET status = 'restructured'
        WHERE loan_id = ${loanId}
          AND status = ANY(${OPEN_SCHEDULE_STATUSES}::text[])
          AND EXISTS (SELECT 1 FROM updated_loan)
        RETURNING id
      ),
      retired_count AS (
        SELECT COUNT(*) AS count FROM retired_schedules
      ),
      new_schedules AS (
        INSERT INTO mfi_loan_schedules (
          loan_id, installment_number, due_date, principal_due, interest_due,
          fees_due, total_due, status
        )
        SELECT ${loanId}, schedule.installment_number, schedule.due_date,
          schedule.principal_due, schedule.interest_due, schedule.fees_due,
          schedule.total_due, 'pending'
        FROM jsonb_to_recordset(${payload}::jsonb) AS schedule(
          installment_number INT,
          due_date DATE,
          principal_due NUMERIC,
          interest_due NUMERIC,
          fees_due NUMERIC,
          total_due NUMERIC
        )
        CROSS JOIN retired_count
        WHERE retired_count.count > 0
          AND EXISTS (SELECT 1 FROM updated_loan)
        RETURNING id
      ),
      created_restructure AS (
        INSERT INTO mfi_loan_restructures (
          id, organization_id, loan_id, reason,
          old_annual_rate, new_annual_rate, old_term_months, new_term_months,
          old_repayment_frequency, new_repayment_frequency,
          old_maturity_date, new_maturity_date,
          old_outstanding_balance, new_outstanding_balance,
          old_total_repayable, new_total_repayable,
          remaining_principal, capitalized_interest, capitalized_fees,
          installment_amount, first_installment_date, schedule_count,
          approved_by, approved_at
        )
        SELECT ${restructureId}, ${organization.id}, ${loanId}, ${reason},
          ${numberValue(loan.interest_rate)}, ${newRate}, ${Number(loan.term_months)}, ${newTerm},
          ${frequency}, ${frequency},
          ${String(loan.maturity_date).slice(0, 10)}::date, ${built.maturity_date}::date,
          ${oldOutstanding}, ${newOutstanding},
          ${numberValue(loan.total_repayable)}, ${newTotalRepayable},
          ${remainingPrincipal}, ${carryInterest}, ${carryFees},
          ${requestedInstallment ?? null}, ${nextInstallment}::date,
          ${newSchedule.length}, ${user.id}, NOW()
        FROM updated_loan
        WHERE EXISTS (SELECT 1 FROM new_schedules)
        RETURNING id, organization_id, loan_id
      ),
      history AS (
        INSERT INTO mfi_loan_history (organization_id, loan_id, action, actor_id, metadata)
        SELECT organization_id, loan_id, 'mfi.loan_restructured', ${user.id},
          jsonb_build_object(
            'restructure_id', id,
            'reason', ${reason},
            'remaining_principal', ${remainingPrincipal},
            'new_interest_rate', ${newRate},
            'new_term_months', ${newTerm},
            'new_outstanding_balance', ${newOutstanding},
            'capitalized_interest', ${carryInterest},
            'capitalized_fees', ${carryFees}
          )
        FROM created_restructure
        RETURNING id
      ),
      local_audit AS (
        INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${user.id}, 'mfi.loan_restructured',
          'mfi_loans', loan_id,
          jsonb_build_object('restructure_id', id, 'reason', ${reason},
            'new_term_months', ${newTerm}, 'new_annual_rate', ${newRate})
        FROM created_restructure
        RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'mfi', 'mfi.loan_restructured', 'mfi_loans', loan_id,
          jsonb_build_object('restructure_id', id, 'reason', ${reason},
            'new_term_months', ${newTerm}, 'new_annual_rate', ${newRate}), ${ip}
        FROM created_restructure
        RETURNING id
      )
      SELECT updated_loan.*, created_restructure.id AS restructure_id,
        (SELECT COUNT(*) FROM new_schedules) AS schedules_created
      FROM updated_loan
      JOIN created_restructure ON created_restructure.loan_id = updated_loan.id
    `;
    const result = rows[0] as Record<string, unknown> | undefined;
    if (!result) {
      throw new ApiError(
        409,
        "LOAN_CHANGED",
        "The loan changed while this restructure was being saved. Refresh it and try again.",
      );
    }
    return c.json({
      loan: result,
      restructure_id: result.restructure_id,
      schedules_created: numberValue(result.schedules_created),
      capitalized_interest: carryInterest,
      capitalized_fees: carryFees,
    });
  },
);

actions.post(
  "/mfi/loans/:loanId/write-off",
  requireRole(...WRITE_OFF_ROLES),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const organization = await resolveMfiOrganization(sql, user, c.req.query("organization_id"));
    const loanId = pathUuid(c.req.param("loanId"), "loan_id");
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) throw new ApiError(400, "INVALID_JSON", "A JSON request body is required.");
    const amountValue = positiveMoney(body.amount, "amount");
    if (amountValue === undefined) {
      throw new ApiError(400, "VALIDATION_ERROR", "amount is required.");
    }
    const amount = amountValue;
    const reason = reasonText(body.reason);
    const effectiveDate = parseDate(body.write_off_date, "write_off_date");
    if (effectiveDate > todayKampala()) {
      throw new ApiError(400, "VALIDATION_ERROR", "write_off_date cannot be in the future.");
    }
    const existingRows = await sql`
      SELECT id, status, outstanding_balance, written_off, updated_at
      FROM mfi_loans
      WHERE id = ${loanId} AND organization_id = ${organization.id}
      LIMIT 1
    `;
    const existing = existingRows[0] as Record<string, unknown> | undefined;
    if (!existing) throw new ApiError(404, "LOAN_NOT_FOUND", "The loan was not found.");
    if (
      existing.written_off === true ||
      !ACTIVE_LOAN_STATUSES.includes(String(existing.status) as typeof ACTIVE_LOAN_STATUSES[number])
    ) {
      throw new ApiError(409, "LOAN_NOT_WRITABLE_OFF", "Only active, past-due, or defaulted loans can be written off.");
    }
    const outstandingBefore = numberValue(existing.outstanding_balance);
    if (amount > outstandingBefore) {
      throw new ApiError(400, "VALIDATION_ERROR", "Write-off amount cannot exceed the current outstanding balance.");
    }
    const eventId = crypto.randomUUID();
    const eventDate = new Date(`${effectiveDate}T12:00:00+03:00`);
    const ip = requestIp(c);
    const rows = await sql`
      WITH updated AS (
        UPDATE mfi_loans
        SET written_off = TRUE,
          written_off_at = ${eventDate},
          written_off_amount = ${amount},
          written_off_reason = ${reason},
          written_off_by = ${user.id},
          write_off_event_id = ${eventId},
          write_off_status_before = status,
          write_off_outstanding_before = outstanding_balance,
          outstanding_balance = GREATEST(outstanding_balance - ${amount}, 0),
          status = 'written_off',
          updated_at = NOW()
        WHERE id = ${loanId}
          AND organization_id = ${organization.id}
          AND updated_at = ${existing.updated_at}
          AND written_off IS FALSE
          AND status = ANY(${ACTIVE_LOAN_STATUSES}::text[])
        RETURNING id, organization_id, status, written_off_amount,
          written_off_at, written_off_reason, outstanding_balance
      ),
      history AS (
        INSERT INTO mfi_loan_history (id, organization_id, loan_id, action, actor_id, metadata)
        SELECT ${eventId}, organization_id, id, 'mfi.loan_written_off', ${user.id},
          jsonb_build_object('amount', written_off_amount, 'reason', written_off_reason,
            'effective_date', ${effectiveDate}, 'outstanding_after', outstanding_balance)
        FROM updated
        RETURNING id
      ),
      local_audit AS (
        INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${user.id}, 'mfi.loan_written_off', 'mfi_loans', id,
          jsonb_build_object('event_id', ${eventId}, 'amount', written_off_amount,
            'reason', written_off_reason, 'effective_date', ${effectiveDate})
        FROM updated
        RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'mfi', 'mfi.loan_written_off', 'mfi_loans', id,
          jsonb_build_object('event_id', ${eventId}, 'amount', written_off_amount,
            'reason', written_off_reason, 'effective_date', ${effectiveDate}), ${ip}
        FROM updated
        RETURNING id
      )
      SELECT * FROM updated
    `;
    const updated = rows[0] as Record<string, unknown> | undefined;
    if (!updated) {
      throw new ApiError(409, "LOAN_CHANGED", "The loan changed while the write-off was being saved.");
    }
    return c.json({ loan: updated, write_off_event_id: eventId });
  },
);

actions.post(
  "/mfi/loans/:loanId/write-off/reverse",
  requireRole(...WRITE_OFF_ROLES),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const organization = await resolveMfiOrganization(sql, user, c.req.query("organization_id"));
    const loanId = pathUuid(c.req.param("loanId"), "loan_id");
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) throw new ApiError(400, "INVALID_JSON", "A JSON request body is required.");
    const reason = reasonText(body.reason);
    const eventId = crypto.randomUUID();
    const ip = requestIp(c);
    const rows = await sql`
      WITH updated AS (
        UPDATE mfi_loans
        SET written_off = FALSE,
          status = COALESCE(write_off_status_before, 'active'),
          outstanding_balance = COALESCE(write_off_outstanding_before, outstanding_balance + written_off_amount),
          write_off_reversed_at = NOW(),
          write_off_reversed_by = ${user.id},
          write_off_reversal_reason = ${reason},
          write_off_status_before = NULL,
          write_off_outstanding_before = NULL,
          updated_at = NOW()
        WHERE id = ${loanId}
          AND organization_id = ${organization.id}
          AND written_off IS TRUE
          AND status = 'written_off'
        RETURNING id, organization_id, status, written_off_amount,
          write_off_reversed_at, write_off_reversal_reason,
          write_off_reversed_by, write_off_event_id, outstanding_balance
      ),
      history AS (
        INSERT INTO mfi_loan_history (id, organization_id, loan_id, action, actor_id, metadata)
        SELECT ${eventId}, organization_id, id, 'mfi.loan_writeoff_reversed', ${user.id},
          jsonb_build_object('amount', written_off_amount,
            'reason', write_off_reversal_reason,
            'write_off_event_id', write_off_event_id,
            'restored_status', status,
            'restored_outstanding_balance', outstanding_balance)
        FROM updated
        RETURNING id
      ),
      local_audit AS (
        INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${user.id}, 'mfi.loan_writeoff_reversed', 'mfi_loans', id,
          jsonb_build_object('event_id', ${eventId}, 'amount', written_off_amount,
            'reason', write_off_reversal_reason)
        FROM updated
        RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'mfi', 'mfi.loan_writeoff_reversed', 'mfi_loans', id,
          jsonb_build_object('event_id', ${eventId}, 'amount', written_off_amount,
            'reason', write_off_reversal_reason), ${ip}
        FROM updated
        RETURNING id
      )
      SELECT * FROM updated
    `;
    const updated = rows[0] as Record<string, unknown> | undefined;
    if (!updated) {
      throw new ApiError(409, "LOAN_NOT_WRITTEN_OFF", "The loan is not currently written off.");
    }
    return c.json({ loan: updated });
  },
);

export default actions;
