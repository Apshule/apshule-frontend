import { Hono } from "hono";
import { ApiError, getDb } from "../db.js";
import { authMiddleware, requireRole } from "../auth.js";
import {
  calculatePar,
  csvDocument,
  parseReportDate,
} from "../mfi-reports-domain.js";
import {
  pathUuid,
  requireMfiSector,
  resolveMfiOrganization,
} from "../mfi-organization-access.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";

const reports = new Hono<AppEnv>();
const MFI_ROLES = [
  "mfi_admin",
  "loan_officer",
  "loan_manager",
  "loan_director",
  "superadmin",
] as const;
const ACTIVE_LOAN_STATUSES = ["active", "past_due", "defaulted"] as const;

reports.use("/mfi/*", authMiddleware, requireMfiSector);

function dateRange(startDate: string, endDateExclusive: string): [Date, Date] {
  return [
    new Date(`${startDate}T00:00:00+03:00`),
    new Date(`${endDateExclusive}T00:00:00+03:00`),
  ];
}

function requiredDate(value: string | undefined, field: string): string {
  if (!value) throw new ApiError(400, "VALIDATION_ERROR", `${field} is required.`);
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

function monthRange(monthText: string | undefined, yearText: string | undefined): {
  month: number;
  year: number;
  start: string;
  end: string;
} {
  const month = Number(monthText);
  const year = Number(yearText);
  if (
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isInteger(year) ||
    year < 2000 ||
    year > 2200
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", "month and year must identify a valid report period.");
  }
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const next = new Date(Date.UTC(year, month, 1));
  const end = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`;
  return { month, year, start, end };
}

function numberValue(value: unknown): number {
  const result = Number(value ?? 0);
  if (!Number.isFinite(result)) {
    throw new ApiError(500, "INVALID_REPORT_DATA", "A report contains a non-numeric amount.");
  }
  return result;
}

async function organizationForRequest(
  c: any,
  sql: ReturnType<typeof getDb>,
  user: AuthenticatedUser,
) {
  return resolveMfiOrganization(sql, user, c.req.query("organization_id"));
}

function csvResponse(
  c: any,
  filename: string,
  csv: string,
) {
  return c.text(csv, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store",
  });
}

reports.get("/mfi/reports/daily-collection", requireRole(...MFI_ROLES), async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const organization = await organizationForRequest(c, sql, user);
  const date = requiredDate(c.req.query("date"), "date");
  const [start, end] = dateRange(date, new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000)
    .toISOString().slice(0, 10));
  const rows = await sql`
    SELECT payment.id, payment.receipt_number, payment.paid_at,
      payment.amount, payment.payment_method, payment.payment_reference,
      payment.notes, payment.reversed_at, payment.reversal_reason,
      loan.loan_number, customer.first_name, customer.last_name,
      customer.phone, officer.name AS recorded_by_name
    FROM mfi_loan_payments payment
    JOIN mfi_loans loan ON loan.id = payment.loan_id
    JOIN mfi_customers customer ON customer.id = loan.customer_id
    LEFT JOIN users officer ON officer.id = payment.recorded_by
    WHERE payment.organization_id = ${organization.id}
      AND payment.paid_at >= ${start}
      AND payment.paid_at < ${end}
    ORDER BY payment.paid_at, payment.receipt_number
  `;
  const collections = rows as Array<Record<string, unknown>>;
  const result = {
    date,
    organization: { id: organization.id, name: organization.name },
    total_collected: collections.reduce(
      (sum, row) => sum + (row.reversed_at ? 0 : numberValue(row.amount)),
      0,
    ),
    payment_count: collections.filter((row) => !row.reversed_at).length,
    rows: collections,
  };
  if (c.req.query("format")?.toLowerCase() === "csv") {
    const csv = csvDocument(
      [
        "Date/time",
        "Receipt",
        "Loan number",
        "Borrower",
        "Phone",
        "Method",
        "Reference",
        "Amount UGX",
        "Recorded by",
        "Status",
        "Notes",
      ],
      collections.map((row) => [
        row.paid_at,
        row.receipt_number,
        row.loan_number,
        `${row.first_name || ""} ${row.last_name || ""}`.trim(),
        row.phone,
        row.payment_method,
        row.payment_reference,
        row.reversed_at ? 0 : row.amount,
        row.recorded_by_name,
        row.reversed_at ? "reversed" : "posted",
        row.reversed_at ? row.reversal_reason : row.notes,
      ]),
    );
    return csvResponse(c, `mfi-daily-collections-${date}.csv`, csv);
  }
  return c.json(result);
});

reports.get("/mfi/reports/portfolio-aging", requireRole(...MFI_ROLES), async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const organization = await organizationForRequest(c, sql, user);
  const asOf = requiredDate(c.req.query("as_of") || currentKampalaDate(), "as_of");
  if (asOf !== currentKampalaDate()) {
    throw new ApiError(
      400,
      "HISTORICAL_SNAPSHOT_UNAVAILABLE",
      "Historical portfolio snapshots are not stored yet. Request today's date.",
    );
  }
  const rows = await sql`
    SELECT loan.id, loan.loan_number, loan.status, loan.outstanding_balance,
      loan.days_overdue, loan.disbursed_at, customer.id AS customer_id,
      customer.first_name, customer.last_name, branch.name AS branch_name,
      officer.name AS officer_name,
      GREATEST(loan.days_overdue, COALESCE(MAX(schedule.days_late), 0)) AS reported_days_overdue
    FROM mfi_loans loan
    JOIN mfi_customers customer ON customer.id = loan.customer_id
    LEFT JOIN mfi_branches branch ON branch.id = loan.branch_id
    LEFT JOIN users officer ON officer.id = loan.disbursed_by
    LEFT JOIN mfi_loan_schedules schedule
      ON schedule.loan_id = loan.id
      AND schedule.status NOT IN ('paid', 'restructured')
    WHERE loan.organization_id = ${organization.id}
      AND loan.status = ANY(${ACTIVE_LOAN_STATUSES}::text[])
    GROUP BY loan.id, customer.id, branch.name, officer.name
    ORDER BY reported_days_overdue DESC, loan.outstanding_balance DESC
  `;
  const loans = (rows as Array<Record<string, unknown>>).map((row) => ({
    ...row,
    outstanding_balance: numberValue(row.outstanding_balance),
    reported_days_overdue: numberValue(row.reported_days_overdue),
  }));
  const total = loans.reduce((sum, loan) => sum + numberValue(loan.outstanding_balance), 0);
  const bucketDefinitions = [
    { key: "current", label: "Current", matches: (days: number) => days === 0 },
    { key: "days_1_30", label: "1-30 days", matches: (days: number) => days >= 1 && days <= 30 },
    { key: "days_31_60", label: "31-60 days", matches: (days: number) => days >= 31 && days <= 60 },
    { key: "days_61_90", label: "61-90 days", matches: (days: number) => days >= 61 && days <= 90 },
    { key: "days_91_plus", label: "91+ days", matches: (days: number) => days > 90 },
  ];
  const buckets = bucketDefinitions.map((bucket) => {
    const matches = loans.filter((loan) => bucket.matches(numberValue(loan.reported_days_overdue)));
    const balance = matches.reduce((sum, loan) => sum + numberValue(loan.outstanding_balance), 0);
    return {
      key: bucket.key,
      label: bucket.label,
      account_count: matches.length,
      outstanding_balance: balance,
      portfolio_share: total === 0 ? 0 : balance / total,
    };
  });
  const par = [30, 60, 90].map((threshold) => ({
    threshold_days: threshold,
    ...calculatePar(
      loans.map((loan) => ({
        outstandingBalance: numberValue(loan.outstanding_balance),
        daysOverdue: numberValue(loan.reported_days_overdue),
      })),
      threshold,
    ),
  }));
  return c.json({
    as_of: asOf,
    organization: { id: organization.id, name: organization.name },
    portfolio_balance: total,
    active_loan_count: loans.length,
    buckets,
    par,
    loans,
  });
});

reports.get("/mfi/reports/officer-performance", requireRole(...MFI_ROLES), async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const organization = await organizationForRequest(c, sql, user);
  const period = monthRange(c.req.query("month"), c.req.query("year"));
  const [start, end] = dateRange(period.start, period.end);
  const rows = await sql`
    SELECT officer.user_id, user_record.name, officer.role, branch.name AS branch_name,
      (SELECT COUNT(*) FROM mfi_loans loan
        WHERE loan.organization_id = ${organization.id}
          AND loan.disbursed_by = officer.user_id
          AND loan.disbursed_at >= ${start} AND loan.disbursed_at < ${end}) AS loans_disbursed,
      (SELECT COALESCE(SUM(loan.principal), 0) FROM mfi_loans loan
        WHERE loan.organization_id = ${organization.id}
          AND loan.disbursed_by = officer.user_id
          AND loan.disbursed_at >= ${start} AND loan.disbursed_at < ${end}) AS amount_disbursed,
      (SELECT COUNT(*) FROM mfi_loans loan
        WHERE loan.organization_id = ${organization.id}
          AND loan.disbursed_by = officer.user_id
          AND loan.status = ANY(${ACTIVE_LOAN_STATUSES}::text[])) AS active_loans,
      (SELECT COALESCE(SUM(loan.outstanding_balance), 0) FROM mfi_loans loan
        WHERE loan.organization_id = ${organization.id}
          AND loan.disbursed_by = officer.user_id
          AND loan.status = ANY(${ACTIVE_LOAN_STATUSES}::text[])) AS managed_portfolio,
      (SELECT COALESCE(SUM(loan.outstanding_balance), 0) FROM mfi_loans loan
        WHERE loan.organization_id = ${organization.id}
          AND loan.disbursed_by = officer.user_id
          AND loan.status = ANY(${ACTIVE_LOAN_STATUSES}::text[])
          AND loan.days_overdue >= 30) AS par30_balance,
      (SELECT COALESCE(SUM(payment.amount), 0) FROM mfi_loan_payments payment
        WHERE payment.organization_id = ${organization.id}
          AND payment.recorded_by = officer.user_id
          AND payment.paid_at >= ${start} AND payment.paid_at < ${end}
          AND payment.reversed_at IS NULL) AS collections
    FROM mfi_officers officer
    JOIN users user_record ON user_record.id = officer.user_id
    LEFT JOIN mfi_branches branch ON branch.id = officer.branch_id
    WHERE officer.organization_id = ${organization.id}
      AND officer.active IS TRUE
    ORDER BY amount_disbursed DESC, collections DESC, user_record.name
  `;
  return c.json({
    month: period.month,
    year: period.year,
    organization: { id: organization.id, name: organization.name },
    officers: (rows as Array<Record<string, unknown>>).map((row) => {
      const managedPortfolio = numberValue(row.managed_portfolio);
      const par30Balance = numberValue(row.par30_balance);
      return {
        ...row,
        portfolio_quality_ratio: managedPortfolio === 0
          ? null
          : Math.max(0, 1 - par30Balance / managedPortfolio),
      };
    }),
  });
});

reports.get("/mfi/reports/disbursements", requireRole(...MFI_ROLES), async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const organization = await organizationForRequest(c, sql, user);
  const from = requiredDate(c.req.query("from"), "from");
  const to = requiredDate(c.req.query("to"), "to");
  if (to < from) throw new ApiError(400, "VALIDATION_ERROR", "to must be on or after from.");
  const [, end] = dateRange(
    from,
    new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10),
  );
  const [start] = dateRange(from, from);
  const rows = await sql`
    SELECT loan.id, loan.loan_number, loan.principal, loan.interest_rate,
      loan.term_months, loan.repayment_frequency, loan.disbursed_at,
      loan.disbursement_method, loan.disbursement_reference, loan.status,
      customer.first_name, customer.last_name, customer.phone,
      branch.name AS branch_name, officer.name AS officer_name
    FROM mfi_loans loan
    JOIN mfi_customers customer ON customer.id = loan.customer_id
    LEFT JOIN mfi_branches branch ON branch.id = loan.branch_id
    LEFT JOIN users officer ON officer.id = loan.disbursed_by
    WHERE loan.organization_id = ${organization.id}
      AND loan.disbursed_at >= ${start} AND loan.disbursed_at < ${end}
    ORDER BY loan.disbursed_at DESC, loan.loan_number
  `;
  const items = rows as Array<Record<string, unknown>>;
  return c.json({
    from,
    to,
    organization: { id: organization.id, name: organization.name },
    count: items.length,
    total_disbursed: items.reduce((sum, row) => sum + numberValue(row.principal), 0),
    disbursements: items,
  });
});

reports.get("/mfi/reports/loans/:loanId/statement", requireRole(...MFI_ROLES), async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const organization = await organizationForRequest(c, sql, user);
  const loanId = pathUuid(c.req.param("loanId"), "loan_id");
  const loanRows = await sql`
    SELECT loan.*, customer.first_name, customer.last_name, customer.phone,
      customer.email, branch.name AS branch_name, product.name AS product_name,
      disburser.name AS disbursed_by_name
    FROM mfi_loans loan
    JOIN mfi_customers customer ON customer.id = loan.customer_id
    LEFT JOIN mfi_branches branch ON branch.id = loan.branch_id
    LEFT JOIN mfi_loan_products product ON product.id = loan.product_id
    LEFT JOIN users disburser ON disburser.id = loan.disbursed_by
    WHERE loan.id = ${loanId} AND loan.organization_id = ${organization.id}
    LIMIT 1
  `;
  const loan = loanRows[0] as Record<string, unknown> | undefined;
  if (!loan) throw new ApiError(404, "LOAN_NOT_FOUND", "The loan was not found.");
  const events = await sql`
    SELECT event_id, event_type, event_at, signed_amount, reference, description, metadata
    FROM (
      SELECT loan.id::text AS event_id, 'disbursement'::text AS event_type,
        loan.disbursed_at AS event_at, loan.principal::numeric AS signed_amount,
        loan.loan_number::text AS reference, 'Loan disbursed'::text AS description,
        jsonb_build_object('method', loan.disbursement_method,
          'payment_reference', loan.disbursement_reference) AS metadata
      FROM mfi_loans loan
      WHERE loan.id = ${loanId} AND loan.organization_id = ${organization.id}
      UNION ALL
      SELECT payment.id::text, 'payment'::text, payment.paid_at,
        CASE WHEN payment.reversed_at IS NULL THEN -payment.amount ELSE 0 END,
        payment.receipt_number::text,
        CASE WHEN payment.reversed_at IS NULL THEN 'Repayment received' ELSE 'Repayment reversed' END,
        jsonb_build_object('payment_method', payment.payment_method,
          'payment_reference', payment.payment_reference,
          'reversed_at', payment.reversed_at, 'reversal_reason', payment.reversal_reason,
          'principal_applied', payment.principal_applied,
          'interest_applied', payment.interest_applied,
          'fees_applied', payment.fees_applied,
          'late_fees_applied', payment.late_fees_applied)
      FROM mfi_loan_payments payment
      WHERE payment.loan_id = ${loanId} AND payment.organization_id = ${organization.id}
      UNION ALL
      SELECT note.id::text, 'credit_note'::text, note.created_at, -note.amount,
        note.id::text, 'Credit note issued', jsonb_build_object('reason', note.reason)
      FROM mfi_credit_notes note
      WHERE note.loan_id = ${loanId} AND note.organization_id = ${organization.id}
      UNION ALL
      SELECT restructure.id::text, 'restructure'::text, restructure.created_at,
        restructure.new_total_repayable - restructure.old_total_repayable,
        restructure.id::text, 'Loan terms restructured',
        jsonb_build_object('reason', restructure.reason,
          'old_annual_rate', restructure.old_annual_rate,
          'new_annual_rate', restructure.new_annual_rate,
          'old_term_months', restructure.old_term_months,
          'new_term_months', restructure.new_term_months,
          'remaining_principal', restructure.remaining_principal,
          'installment_amount', restructure.installment_amount,
          'new_maturity_date', restructure.new_maturity_date)
      FROM mfi_loan_restructures restructure
      WHERE restructure.loan_id = ${loanId}
        AND restructure.organization_id = ${organization.id}
      UNION ALL
      SELECT history.id::text,
        CASE history.action
          WHEN 'mfi.loan_written_off' THEN 'write_off'
          ELSE 'write_off_reversal'
        END,
        history.created_at,
        CASE history.action
          WHEN 'mfi.loan_written_off' THEN -COALESCE((history.metadata->>'amount')::numeric, 0)
          ELSE COALESCE((history.metadata->>'amount')::numeric, 0)
        END,
        history.id::text,
        CASE history.action
          WHEN 'mfi.loan_written_off' THEN 'Loan written off'
          ELSE 'Write-off reversed'
        END,
        history.metadata
      FROM mfi_loan_history history
      WHERE history.loan_id = ${loanId}
        AND history.organization_id = ${organization.id}
        AND history.action IN ('mfi.loan_written_off', 'mfi.loan_writeoff_reversed')
    ) statement_events
    ORDER BY event_at, event_id
  `;
  return c.json({
    organization: { id: organization.id, name: organization.name },
    loan,
    transactions: events,
  });
});

reports.get("/mfi/director/dashboard", requireRole("mfi_admin", "loan_director", "loan_manager", "superadmin"), async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const organization = await organizationForRequest(c, sql, user);
  const currentMonth = currentKampalaDate().slice(0, 7);
  const [yearText, monthText] = currentMonth.split("-");
  const period = monthRange(monthText, yearText);
  const [start, end] = dateRange(period.start, period.end);
  const kpiRows = await sql`
    SELECT
      (SELECT COUNT(*) FROM mfi_loans
        WHERE organization_id = ${organization.id}
          AND status = ANY(${ACTIVE_LOAN_STATUSES}::text[])) AS active_loans,
      (SELECT COALESCE(SUM(outstanding_balance), 0) FROM mfi_loans
        WHERE organization_id = ${organization.id}
          AND status = ANY(${ACTIVE_LOAN_STATUSES}::text[])) AS loan_book,
      (SELECT COALESCE(SUM(amount), 0) FROM mfi_loan_payments
        WHERE organization_id = ${organization.id}
          AND paid_at >= ${start} AND paid_at < ${end}
          AND reversed_at IS NULL) AS collections_this_month,
      (SELECT COALESCE(SUM(CASE
        WHEN action = 'mfi.loan_written_off' THEN COALESCE((metadata->>'amount')::numeric, 0)
        ELSE -COALESCE((metadata->>'amount')::numeric, 0)
      END), 0) FROM mfi_loan_history
        WHERE organization_id = ${organization.id}
          AND action IN ('mfi.loan_written_off', 'mfi.loan_writeoff_reversed')
          AND created_at >= ${start} AND created_at < ${end}) AS write_offs_this_month
  `;
  const riskRows = await sql`
    SELECT loan.id, loan.loan_number, loan.status, loan.days_overdue,
      loan.outstanding_balance, customer.first_name, customer.last_name,
      branch.name AS branch_name,
      GREATEST(loan.days_overdue, COALESCE(MAX(schedule.days_late), 0)) AS reported_days_overdue
    FROM mfi_loans loan
    JOIN mfi_customers customer ON customer.id = loan.customer_id
    LEFT JOIN mfi_branches branch ON branch.id = loan.branch_id
    LEFT JOIN mfi_loan_schedules schedule
      ON schedule.loan_id = loan.id AND schedule.status NOT IN ('paid', 'restructured')
    WHERE loan.organization_id = ${organization.id}
      AND loan.status = ANY(${ACTIVE_LOAN_STATUSES}::text[])
    GROUP BY loan.id, customer.id, branch.name
    HAVING GREATEST(loan.days_overdue, COALESCE(MAX(schedule.days_late), 0)) > 0
    ORDER BY reported_days_overdue DESC, loan.outstanding_balance DESC
    LIMIT 8
  `;
  const officerRows = await sql`
    SELECT user_record.id, user_record.name,
      COALESCE(SUM(payment.amount) FILTER (
        WHERE payment.paid_at >= ${start} AND payment.paid_at < ${end}
          AND payment.reversed_at IS NULL
      ), 0) AS collections
    FROM mfi_officers officer
    JOIN users user_record ON user_record.id = officer.user_id
    LEFT JOIN mfi_loan_payments payment
      ON payment.recorded_by = officer.user_id
      AND payment.organization_id = officer.organization_id
    WHERE officer.organization_id = ${organization.id}
      AND officer.active IS TRUE
    GROUP BY user_record.id, user_record.name
    ORDER BY collections DESC, user_record.name
    LIMIT 5
  `;
  const trendRows = await sql`
    WITH months AS (
      SELECT month_start
      FROM generate_series(
        date_trunc('month', ${period.start}::date - INTERVAL '5 months'),
        date_trunc('month', ${period.start}::date),
        INTERVAL '1 month'
      ) AS generated(month_start)
    )
    SELECT to_char(months.month_start, 'YYYY-MM') AS month,
      COALESCE((SELECT SUM(loan.principal) FROM mfi_loans loan
        WHERE loan.organization_id = ${organization.id}
          AND loan.disbursed_at >= months.month_start
          AND loan.disbursed_at < months.month_start + INTERVAL '1 month'), 0) AS disbursed,
      COALESCE((SELECT SUM(payment.amount) FROM mfi_loan_payments payment
        WHERE payment.organization_id = ${organization.id}
          AND payment.paid_at >= months.month_start
          AND payment.paid_at < months.month_start + INTERVAL '1 month'
          AND payment.reversed_at IS NULL), 0) AS collections
    FROM months
    ORDER BY months.month_start
  `;
  const portfolioRows = await sql`
    SELECT outstanding_balance, GREATEST(days_overdue, 0) AS days_overdue
    FROM mfi_loans
    WHERE organization_id = ${organization.id}
      AND status = ANY(${ACTIVE_LOAN_STATUSES}::text[])
  `;
  const par30 = calculatePar(
    (portfolioRows as Array<Record<string, unknown>>).map((row) => ({
      outstandingBalance: numberValue(row.outstanding_balance),
      daysOverdue: numberValue(row.days_overdue),
    })),
    30,
  );
  return c.json({
    organization: { id: organization.id, name: organization.name },
    month: currentMonth,
    kpis: kpiRows[0] || {},
    par30,
    six_month_trend: trendRows,
    top_risks: riskRows,
    top_officers: officerRows,
  });
});

reports.get("/mfi/superadmin/overview", requireRole("superadmin"), async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT
      (SELECT COUNT(*) FROM mfi_organizations) AS organization_count,
      (SELECT COUNT(*) FROM mfi_loans) AS total_loans,
      (SELECT COUNT(*) FROM mfi_loans
        WHERE status = ANY(${ACTIVE_LOAN_STATUSES}::text[])) AS active_loans,
      (SELECT COALESCE(SUM(outstanding_balance), 0) FROM mfi_loans
        WHERE status = ANY(${ACTIVE_LOAN_STATUSES}::text[])) AS loan_book,
      (SELECT COALESCE(SUM(amount), 0) FROM mfi_loan_payments
        WHERE paid_at >= date_trunc('month', CURRENT_TIMESTAMP)
          AND reversed_at IS NULL) AS collections_this_month
  `;
  return c.json({ overview: rows[0] || {} });
});

function currentKampalaDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export default reports;
