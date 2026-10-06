import { Hono } from "hono";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { ApiError, getDb } from "../db.js";
import { authMiddleware, requireRole } from "../auth.js";
import {
  buildUmraRiskClassification,
  calculatePar,
  parseReportDate,
  type RiskPortfolioLoan,
} from "../mfi-reports-domain.js";
import {
  requireMfiSector,
  resolveMfiOrganization,
} from "../mfi-organization-access.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";

const umra = new Hono<AppEnv>();
const UMRA_ROLES = ["mfi_admin", "loan_manager", "loan_director", "superadmin"] as const;
const ACTIVE_LOAN_STATUSES = ["active", "past_due", "defaulted"] as const;
type ReportType = "monthly_summary" | "quarterly_risk_classification";

umra.use("/mfi/*", authMiddleware, requireMfiSector);

function numberValue(value: unknown): number {
  const result = Number(value ?? 0);
  if (!Number.isFinite(result)) {
    throw new ApiError(500, "INVALID_REPORT_DATA", "A report contains a non-numeric amount.");
  }
  return result;
}

function parsePeriod(monthText?: string, yearText?: string): { month: number; year: number } {
  if (!monthText && !yearText) {
    const [year, month] = kampalaDate().slice(0, 7).split("-").map(Number);
    return { month, year };
  }
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
  return { month, year };
}

function periodDates(month: number, year: number): { start: Date; end: Date; startDate: string; endDate: string } {
  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextMonth = new Date(Date.UTC(year, month, 1));
  const endDate = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, "0")}-01`;
  return {
    start: new Date(`${startDate}T00:00:00+03:00`),
    end: new Date(`${endDate}T00:00:00+03:00`),
    startDate,
    endDate,
  };
}

function parseDateField(value: unknown, field: string): string {
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

async function organizationForRequest(c: any, user: AuthenticatedUser) {
  const sql = getDb(c.env);
  return resolveMfiOrganization(sql, user, c.req.query("organization_id"));
}

async function riskPortfolio(sql: ReturnType<typeof getDb>, organizationId: string): Promise<{
  loans: RiskPortfolioLoan[];
  parLoans: Array<{ outstandingBalance: number; daysOverdue: number }>;
}> {
  const rows = await sql`
    SELECT loan.id,
      COALESCE(
        NULLIF(SUM(GREATEST(schedule.principal_due - schedule.principal_paid, 0)), 0),
        GREATEST(loan.outstanding_balance, 0)
      ) AS outstanding_principal,
      GREATEST(loan.days_overdue, COALESCE(MAX(schedule.days_late), 0)) AS days_overdue,
      EXISTS (
        SELECT 1 FROM mfi_loan_restructures restructure
        WHERE restructure.loan_id = loan.id
          AND restructure.organization_id = loan.organization_id
      ) AS restructured,
      loan.outstanding_balance
    FROM mfi_loans loan
    LEFT JOIN mfi_loan_schedules schedule
      ON schedule.loan_id = loan.id
      AND schedule.status NOT IN ('paid', 'restructured')
    WHERE loan.organization_id = ${organizationId}
      AND loan.status = ANY(${ACTIVE_LOAN_STATUSES}::text[])
    GROUP BY loan.id
  `;
  const mapped = (rows as Array<Record<string, unknown>>).map((row) => ({
    outstandingPrincipal: numberValue(row.outstanding_principal),
    daysOverdue: numberValue(row.days_overdue),
    restructured: row.restructured === true,
    outstandingBalance: numberValue(row.outstanding_balance),
  }));
  return {
    loans: mapped.map(({ outstandingPrincipal, daysOverdue, restructured }) => ({
      outstandingPrincipal,
      daysOverdue,
      restructured,
    })),
    parLoans: mapped.map(({ outstandingBalance, daysOverdue }) => ({
      outstandingBalance,
      daysOverdue,
    })),
  };
}

async function monthlySummary(
  sql: ReturnType<typeof getDb>,
  organization: { id: string; name: string; license_number: string | null },
  month: number,
  year: number,
) {
  const period = periodDates(month, year);
  const [summaryRows, writeOffRows] = await Promise.all([
    sql`
      SELECT
        (SELECT COUNT(*) FROM mfi_loans
          WHERE organization_id = ${organization.id}
            AND disbursed_at >= ${period.start} AND disbursed_at < ${period.end}) AS loans_disbursed,
        (SELECT COALESCE(SUM(principal), 0) FROM mfi_loans
          WHERE organization_id = ${organization.id}
            AND disbursed_at >= ${period.start} AND disbursed_at < ${period.end}) AS amount_disbursed,
        (SELECT COUNT(*) FROM mfi_loans
          WHERE organization_id = ${organization.id}
            AND status = ANY(${ACTIVE_LOAN_STATUSES}::text[])) AS active_loans,
        (SELECT COALESCE(SUM(outstanding_balance), 0) FROM mfi_loans
          WHERE organization_id = ${organization.id}
            AND status = ANY(${ACTIVE_LOAN_STATUSES}::text[])) AS loan_book,
        (SELECT COALESCE(SUM(payment.amount), 0) FROM mfi_loan_payments payment
          WHERE payment.organization_id = ${organization.id}
            AND payment.paid_at >= ${period.start} AND payment.paid_at < ${period.end}
            AND payment.reversed_at IS NULL) AS collections,
        (SELECT COUNT(*) FROM mfi_branches
          WHERE organization_id = ${organization.id} AND active IS TRUE) AS active_branches,
        (SELECT COUNT(DISTINCT loan.customer_id) FROM mfi_loans loan
          WHERE loan.organization_id = ${organization.id}
            AND loan.status = ANY(${ACTIVE_LOAN_STATUSES}::text[])) AS active_borrowers,
        (SELECT COUNT(DISTINCT loan.customer_id)
          FROM mfi_loans loan
          JOIN mfi_customers customer ON customer.id = loan.customer_id
          WHERE loan.organization_id = ${organization.id}
            AND loan.status = ANY(${ACTIVE_LOAN_STATUSES}::text[])
            AND lower(trim(COALESCE(customer.gender, ''))) IN ('female', 'f')) AS female_borrowers
    `,
    sql`
      SELECT
        COALESCE(SUM(CASE WHEN action = 'mfi.loan_written_off'
          THEN COALESCE((metadata->>'amount')::numeric, 0) ELSE 0 END), 0) AS gross_write_offs,
        COALESCE(SUM(CASE WHEN action = 'mfi.loan_writeoff_reversed'
          THEN COALESCE((metadata->>'amount')::numeric, 0) ELSE 0 END), 0) AS reversed_write_offs
      FROM mfi_loan_history
      WHERE organization_id = ${organization.id}
        AND action IN ('mfi.loan_written_off', 'mfi.loan_writeoff_reversed')
        AND created_at >= ${period.start} AND created_at < ${period.end}
    `,
  ]);
  const portfolio = await riskPortfolio(sql, organization.id);
  const risk = buildUmraRiskClassification(portfolio.loans);
  const par = [30, 60, 90].map((threshold) => ({
    threshold_days: threshold,
    ...calculatePar(portfolio.parLoans, threshold),
  }));
  const summary = summaryRows[0] as Record<string, unknown> | undefined;
  const writeOffs = writeOffRows[0] as Record<string, unknown> | undefined;
  const disbursed = numberValue(summary?.amount_disbursed);
  const disbursedCount = numberValue(summary?.loans_disbursed);
  const activeBorrowers = numberValue(summary?.active_borrowers);
  const femaleBorrowers = numberValue(summary?.female_borrowers);
  return {
    report_type: "monthly_summary" as const,
    organization: {
      id: organization.id,
      name: organization.name,
      license_number: organization.license_number,
    },
    period: { month, year, start: period.startDate, end_exclusive: period.endDate },
    generated_at: new Date().toISOString(),
    balance_as_of: kampalaDate(),
    period_metrics: {
      loans_disbursed: disbursedCount,
      amount_disbursed: disbursed,
      average_loan_size: disbursedCount === 0 ? 0 : Math.round(disbursed / disbursedCount),
      collections: numberValue(summary?.collections),
      gross_write_offs: numberValue(writeOffs?.gross_write_offs),
      reversed_write_offs: numberValue(writeOffs?.reversed_write_offs),
    },
    portfolio_snapshot: {
      active_loans: numberValue(summary?.active_loans),
      loan_book: numberValue(summary?.loan_book),
      active_borrowers: activeBorrowers,
      female_borrowers: femaleBorrowers,
      female_borrower_percentage: activeBorrowers === 0
        ? 0
        : Math.round((femaleBorrowers / activeBorrowers) * 10_000) / 100,
      active_branches: numberValue(summary?.active_branches),
      par,
      total_required_provisions: risk.required_provision_amount,
    },
    operational_self_sufficiency: {
      available: false,
      value: null,
      note: "Income and operating-expense data are not yet captured in APSHULE MFI.",
    },
    statutory_note:
      "This is a monthly management summary. UMRA's published Schedule 3 risk-classification and provisioning return is quarterly.",
  };
}

async function quarterlyRiskReport(
  sql: ReturnType<typeof getDb>,
  organization: { id: string; name: string; license_number: string | null },
  month: number,
  year: number,
  financialYearStart: string,
  financialYearEnd: string,
) {
  if (![3, 6, 9, 12].includes(month)) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "The statutory risk-classification return period must end in March, June, September, or December.",
    );
  }
  if (financialYearEnd < financialYearStart) {
    throw new ApiError(400, "VALIDATION_ERROR", "Financial year end must not be before its start.");
  }
  const risk = await riskPortfolio(sql, organization.id);
  return {
    report_type: "quarterly_risk_classification" as const,
    organization: {
      id: organization.id,
      name: organization.name,
      license_number: organization.license_number,
    },
    period: {
      month,
      year,
      quarter: month / 3,
      quarter_end: `${year}-${String(month).padStart(2, "0")}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`,
    },
    financial_year: { start: financialYearStart, end: financialYearEnd },
    generated_at: new Date().toISOString(),
    schedule_3: buildUmraRiskClassification(risk.loans),
    note:
      "Prepared as a local Schedule 3 draft. APSHULE does not transmit this return to UMRA; submit through the UMRA reporting portal.",
  };
}

async function saveSubmission(
  c: any,
  organizationId: string,
  reportType: ReportType,
  month: number,
  year: number,
  report: Record<string, unknown>,
) {
  const sql = getDb(c.env);
  const user = c.get("user") as AuthenticatedUser;
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || null;
  const serialized = JSON.stringify(report);
  const rows = await sql`
    WITH saved AS (
      INSERT INTO mfi_umra_submissions (
        organization_id, period_month, period_year, report_type, report_data, submitted_by, submitted_at
      )
      VALUES (
        ${organizationId}, ${month}, ${year}, ${reportType}, ${serialized}::jsonb, ${user.id}, NOW()
      )
      ON CONFLICT (organization_id, period_month, period_year, report_type)
      DO UPDATE SET report_data = EXCLUDED.report_data,
        submitted_by = EXCLUDED.submitted_by,
        submitted_at = NOW()
      RETURNING id, organization_id, period_month, period_year, report_type, report_data, submitted_by, submitted_at
    ),
    local_audit AS (
      INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
      SELECT organization_id, ${user.id}, 'mfi.umra_return_saved',
        'mfi_umra_submissions', id,
        jsonb_build_object('report_type', report_type, 'period_month', period_month,
          'period_year', period_year)
      FROM saved
      RETURNING id
    ),
    platform_audit AS (
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT ${user.id}, 'mfi', 'mfi.umra_return_saved', 'mfi_umra_submissions', id,
        jsonb_build_object('report_type', report_type, 'period_month', period_month,
          'period_year', period_year), ${ip}
      FROM saved
      RETURNING id
    )
    SELECT saved.* FROM saved
  `;
  return rows[0] || null;
}

umra.get("/mfi/umra/monthly-return", requireRole(...UMRA_ROLES), async (c) => {
  const user = c.get("user");
  const organization = await organizationForRequest(c, user);
  const sql = getDb(c.env);
  const period = parsePeriod(c.req.query("month"), c.req.query("year"));
  const report = await monthlySummary(sql, organization, period.month, period.year);
  const saved = await sql`
    SELECT id, submitted_at, submitted_by
    FROM mfi_umra_submissions
    WHERE organization_id = ${organization.id}
      AND report_type = 'monthly_summary'
      AND period_month = ${period.month}
      AND period_year = ${period.year}
    LIMIT 1
  `;
  return c.json({ report, submission: saved[0] || null });
});

umra.post("/mfi/umra/monthly-return", requireRole(...UMRA_ROLES), async (c) => {
  const user = c.get("user");
  const organization = await organizationForRequest(c, user);
  const sql = getDb(c.env);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) throw new ApiError(400, "INVALID_JSON", "A JSON request body is required.");
  const period = parsePeriod(String(body.month ?? ""), String(body.year ?? ""));
  const report = await monthlySummary(sql, organization, period.month, period.year);
  const submission = await saveSubmission(
    c,
    organization.id,
    "monthly_summary",
    period.month,
    period.year,
    report,
  );
  return c.json({ submission, report }, 201);
});

umra.get("/mfi/umra/risk-classification", requireRole(...UMRA_ROLES), async (c) => {
  const user = c.get("user");
  const organization = await organizationForRequest(c, user);
  const sql = getDb(c.env);
  const period = parsePeriod(c.req.query("month"), c.req.query("year"));
  const report = await quarterlyRiskReport(
    sql,
    organization,
    period.month,
    period.year,
    c.req.query("financial_year_start") || "",
    c.req.query("financial_year_end") || "",
  ).catch((error) => {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "VALIDATION_ERROR", error instanceof Error ? error.message : "Invalid report period.");
  });
  const saved = await sql`
    SELECT id, submitted_at, submitted_by
    FROM mfi_umra_submissions
    WHERE organization_id = ${organization.id}
      AND report_type = 'quarterly_risk_classification'
      AND period_month = ${period.month}
      AND period_year = ${period.year}
    LIMIT 1
  `;
  return c.json({ report, submission: saved[0] || null });
});

umra.post("/mfi/umra/risk-classification", requireRole(...UMRA_ROLES), async (c) => {
  const user = c.get("user");
  const organization = await organizationForRequest(c, user);
  const sql = getDb(c.env);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) throw new ApiError(400, "INVALID_JSON", "A JSON request body is required.");
  const period = parsePeriod(String(body.month ?? ""), String(body.year ?? ""));
  const start = parseDateField(body.financial_year_start, "financial_year_start");
  const end = parseDateField(body.financial_year_end, "financial_year_end");
  const report = await quarterlyRiskReport(sql, organization, period.month, period.year, start, end);
  const submission = await saveSubmission(
    c,
    organization.id,
    "quarterly_risk_classification",
    period.month,
    period.year,
    report,
  );
  return c.json({ submission, report }, 201);
});

umra.get("/mfi/umra/submissions", requireRole(...UMRA_ROLES), async (c) => {
  const user = c.get("user");
  const organization = await organizationForRequest(c, user);
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, period_month, period_year, report_type, submitted_by, submitted_at, created_at
    FROM mfi_umra_submissions
    WHERE organization_id = ${organization.id}
    ORDER BY period_year DESC, period_month DESC, submitted_at DESC
    LIMIT 100
  `;
  return c.json({ submissions: rows });
});

umra.get("/mfi/umra/submissions/:id/pdf", requireRole(...UMRA_ROLES), async (c) => {
  const user = c.get("user");
  const organization = await organizationForRequest(c, user);
  const id = c.req.param("id");
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, period_month, period_year, report_type, report_data
    FROM mfi_umra_submissions
    WHERE id = ${id} AND organization_id = ${organization.id}
    LIMIT 1
  `;
  const submission = rows[0] as Record<string, unknown> | undefined;
  if (!submission) throw new ApiError(404, "UMRA_SUBMISSION_NOT_FOUND", "The saved return was not found.");
  const report = typeof submission.report_data === "string"
    ? JSON.parse(submission.report_data) as Record<string, unknown>
    : submission.report_data as Record<string, unknown>;
  const pdfBytes = await buildReturnPdf(report);
  return c.json({
    filename: `umra-${String(submission.report_type)}-${submission.period_year}-${String(submission.period_month).padStart(2, "0")}.pdf`,
    mime_type: "application/pdf",
    base64: bytesToBase64(pdfBytes),
  });
});

async function buildReturnPdf(report: Record<string, any>): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const margin = 38;
  let y = 803;
  const safe = (value: unknown) => String(value ?? "")
    .replace(/[^\x20-\x7E]/gu, "?")
    .slice(0, 120);
  const line = (text: string, options: { bold?: boolean; size?: number; gap?: number } = {}) => {
    const size = options.size || 9;
    page.drawText(safe(text), {
      x: margin,
      y,
      size,
      font: options.bold ? bold : regular,
      color: rgb(0.12, 0.17, 0.18),
      maxWidth: 520,
    });
    y -= options.gap ?? size + 6;
  };
  const money = (value: unknown) => new Intl.NumberFormat("en-UG", {
    maximumFractionDigits: 0,
  }).format(numberValue(value));
  line("UGANDA MICROFINANCE REGULATORY AUTHORITY", { bold: true, size: 11, gap: 18 });
  if (report.report_type === "quarterly_risk_classification") {
    line("RISK CLASSIFICATION OF ASSETS AND PROVISIONING - SCHEDULE 3", { bold: true, size: 10, gap: 20 });
    line("THE TIER 4 MICROFINANCE INSTITUTIONS AND MONEY LENDERS ACT, 2016", { size: 8 });
    line(`Name of institution: ${report.organization?.name || ""}`);
    line(`UMRA Licence No: ${report.organization?.license_number || ""}`);
    line(`Financial year start: ${report.financial_year?.start || ""}    End: ${report.financial_year?.end || ""}`);
    line(`Quarter ending: ${report.period?.quarter_end || ""}`, { gap: 18 });
    const drawSection = (title: string, section: Record<string, any>) => {
      line(title, { bold: true, size: 10, gap: 17 });
      line("Classification                 Accounts       Outstanding UGX       Provision       Required UGX", { bold: true, size: 7, gap: 12 });
      for (const row of section.rows || []) {
        const name = String(row.classification || "").padEnd(22).slice(0, 22);
        const count = String(row.account_count || 0).padStart(5);
        const outstanding = money(row.outstanding_portfolio).padStart(18);
        const rate = `${Math.round(Number(row.required_provision_rate || 0) * 100)}%`.padStart(9);
        const provision = money(row.required_provision_amount).padStart(18);
        line(`${name} ${count} ${outstanding} ${rate} ${provision}`, { size: 7, gap: 11 });
      }
      line(`Subtotal: ${section.account_count || 0} accounts | UGX ${money(section.outstanding_portfolio)} | Provision UGX ${money(section.required_provision_amount)}`, { bold: true, size: 8, gap: 16 });
    };
    drawSection("PORTFOLIO AGEING REPORT", report.schedule_3?.portfolio_ageing || {});
    drawSection("RESCHEDULING OR RECLASSIFICATION OF LOANS", report.schedule_3?.rescheduled_or_reclassified || {});
    line(`GRAND TOTAL: ${report.schedule_3?.account_count || 0} accounts | UGX ${money(report.schedule_3?.outstanding_portfolio)} | Provision UGX ${money(report.schedule_3?.required_provision_amount)}`, { bold: true, size: 9, gap: 19 });
    line("Note: UMRA's published return is due by the 15th day of the month after quarter-end.", { size: 7 });
    line("We declare this return, to the best of our knowledge and belief, is correct.", { gap: 28 });
    line("Authorised signatory: __________________________________     Date: __________________");
  } else {
    line("MONTHLY MANAGEMENT SUMMARY - NOT A STATUTORY FILING", { bold: true, size: 10, gap: 20 });
    line(`Institution: ${report.organization?.name || ""}`);
    line(`UMRA Licence No: ${report.organization?.license_number || ""}`);
    line(`Report period: ${report.period?.year || ""}-${String(report.period?.month || "").padStart(2, "0")}`);
    line(`Portfolio balances as at: ${report.balance_as_of || ""}`, { gap: 20 });
    line("PERIOD ACTIVITY", { bold: true, size: 10, gap: 17 });
    line(`Loans disbursed: ${report.period_metrics?.loans_disbursed || 0} | Amount: UGX ${money(report.period_metrics?.amount_disbursed)}`);
    line(`Average loan size: UGX ${money(report.period_metrics?.average_loan_size)}`);
    line(`Collections: UGX ${money(report.period_metrics?.collections)}`);
    line(`Gross write-offs: UGX ${money(report.period_metrics?.gross_write_offs)} | Reversals: UGX ${money(report.period_metrics?.reversed_write_offs)}`, { gap: 20 });
    line("PORTFOLIO SNAPSHOT", { bold: true, size: 10, gap: 17 });
    line(`Active loans: ${report.portfolio_snapshot?.active_loans || 0} | Active borrowers: ${report.portfolio_snapshot?.active_borrowers || 0}`);
    line(`Female borrowers: ${report.portfolio_snapshot?.female_borrowers || 0} (${report.portfolio_snapshot?.female_borrower_percentage || 0}%)`);
    line(`Active branches: ${report.portfolio_snapshot?.active_branches || 0}`);
    line(`Loan book: UGX ${money(report.portfolio_snapshot?.loan_book)}`);
    for (const item of report.portfolio_snapshot?.par || []) {
      line(`PAR ${item.threshold_days}: UGX ${money(item.at_risk_amount)} / UGX ${money(item.portfolio_amount)} (${(Number(item.ratio || 0) * 100).toFixed(2)}%)`);
    }
    line(`Required provisions (Schedule 3 basis): UGX ${money(report.portfolio_snapshot?.total_required_provisions)}`, { gap: 18 });
    line("Operational self-sufficiency: Not available; operating income and expense data are not captured.");
    line("This is an internal management summary. It has not been filed with UMRA.");
  }
  page.drawText("Generated by APSHULE MFI - not transmitted to UMRA", {
    x: margin,
    y: 24,
    size: 7,
    font: regular,
    color: rgb(0.35, 0.38, 0.4),
  });
  return pdf.save();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function kampalaDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export default umra;
