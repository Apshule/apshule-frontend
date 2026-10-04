import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { ApiError, getDb } from "../db.js";
import { authMiddleware, requireRealSuperAdmin, requireRole } from "../auth.js";
import { optionalString, readJson, requiredString } from "../http.js";
import {
  findIdempotencyReplay,
  idempotencyClaimQuery,
  idempotencyLookupQuery,
  readIdempotencyKey,
  resolveIdempotencyTransaction,
  scheduleIdempotencyCleanup,
} from "../idempotency.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";

const earnings = new Hono<AppEnv>();
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PAYMENT_METHODS = new Set(["mtn_momo", "airtel_money", "bank_transfer"]);
const MAX_AMOUNT_UGX = 1_000_000_000;
const MAX_REPORT_DAYS = 366;

type DateRange = { from: string; to: string };
type EarningsSummary = {
  total_views: number;
  total_earned: number | string;
  this_month_earned: number | string;
  pending_payout: number | string;
  available_balance: number | string;
  min_withdrawal: number | string;
  per_view_ugx: number | string;
};

const requireRealTeacher = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("user").impersonatedBy) {
    throw new ApiError(403, "FORBIDDEN", "A teacher account session is required.");
  }
  await next();
});

function requestIp(c: Context<AppEnv>): string | null {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    null
  )?.slice(0, 255) ?? null;
}

function assertRealUser(user: AuthenticatedUser): void {
  if (user.impersonatedBy) {
    throw new ApiError(403, "FORBIDDEN", "This action is not available during impersonation.");
  }
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function todayInKampala(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((value) => value.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function shiftIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + days));
  return formatIsoDate(date);
}

function parseIsoDate(value: string, field: "from" | "to"): string {
  if (!DATE_PATTERN.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a valid YYYY-MM-DD date.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  if (formatIsoDate(date) !== value) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a valid YYYY-MM-DD date.`);
  }
  return value;
}

function getDateRange(fromValue: string | undefined, toValue: string | undefined): DateRange {
  const defaultTo = todayInKampala();
  const to = parseIsoDate(toValue ?? defaultTo, "to");
  const from = parseIsoDate(fromValue ?? shiftIsoDate(to, -29), "from");
  if (from > to) {
    throw new ApiError(400, "VALIDATION_ERROR", "from must be on or before to.");
  }
  const dayCount =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (dayCount > MAX_REPORT_DAYS) {
    throw new ApiError(400, "VALIDATION_ERROR", `The requested date range cannot exceed ${MAX_REPORT_DAYS} days.`);
  }
  return { from, to };
}

function parsePositiveAmount(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_AMOUNT_UGX
  ) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `${field} must be a whole UGX amount between 1 and ${MAX_AMOUNT_UGX}.`,
    );
  }
  return value;
}

function parsePaymentMethod(value: unknown, required: boolean): string | null {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new ApiError(400, "VALIDATION_ERROR", "payment_method is required.");
    }
    return null;
  }
  if (typeof value !== "string" || !PAYMENT_METHODS.has(value)) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "payment_method must be mtn_momo, airtel_money, or bank_transfer.",
    );
  }
  return value;
}

function asNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getPaymentStatusError(status: string | undefined): never {
  if (!status) throw new ApiError(404, "PAYOUT_NOT_FOUND", "Payout request was not found.");
  throw new ApiError(409, "PAYOUT_STATE_CONFLICT", `Payout request cannot be changed from ${status}.`);
}

async function getTeacherSummary(sql: ReturnType<typeof getDb>, teacherId: string) {
  const [earningsRows, payoutRows, rateRows] = await Promise.all([
    sql`
      SELECT
        COUNT(*)::int AS total_views,
        COALESCE(SUM(earnings_amount), 0)::numeric AS total_earned,
        COALESCE(
          SUM(earnings_amount) FILTER (
            WHERE timestamp >= (
              date_trunc('month', NOW() AT TIME ZONE 'Africa/Kampala')
              AT TIME ZONE 'Africa/Kampala'
            )
          ),
          0
        )::numeric AS this_month_earned
      FROM video_views
      WHERE teacher_id = ${teacherId}
    `,
    sql`
      SELECT
        COALESCE(SUM(amount) FILTER (WHERE status IN ('pending', 'approved')), 0)::numeric
          AS pending_payout,
        COALESCE(SUM(amount) FILTER (WHERE status IN ('pending', 'approved', 'paid')), 0)::numeric
          AS deducted_payouts
      FROM payout_requests
      WHERE teacher_id = ${teacherId}
    `,
    sql`
      SELECT per_view_ugx, min_withdrawal_ugx
      FROM teacher_earnings_rate
      WHERE id = 1
    `,
  ]);

  const earned = earningsRows[0] as {
    total_views: number;
    total_earned: number | string;
    this_month_earned: number | string;
  };
  const payouts = payoutRows[0] as {
    pending_payout: number | string;
    deducted_payouts: number | string;
  };
  const rate = rateRows[0] as
    | { per_view_ugx: number | string; min_withdrawal_ugx: number | string }
    | undefined;
  if (!rate) {
    throw new ApiError(503, "EARNINGS_NOT_CONFIGURED", "Teacher earnings have not been configured.");
  }

  const totalEarned = asNumber(earned.total_earned);
  return {
    total_views: Number(earned.total_views ?? 0),
    total_earned: totalEarned,
    this_month_earned: asNumber(earned.this_month_earned),
    pending_payout: asNumber(payouts.pending_payout),
    available_balance: Math.max(0, totalEarned - asNumber(payouts.deducted_payouts)),
    min_withdrawal: asNumber(rate.min_withdrawal_ugx),
    per_view_ugx: asNumber(rate.per_view_ugx),
  } satisfies EarningsSummary;
}

async function getDailyBreakdown(
  sql: ReturnType<typeof getDb>,
  teacherId: string,
  range: DateRange,
) {
  return sql`
    SELECT
      TO_CHAR(day_series.day, 'YYYY-MM-DD') AS date,
      COUNT(v.id)::int AS views,
      COALESCE(SUM(v.earnings_amount), 0)::numeric AS amount
    FROM generate_series(${range.from}::date, ${range.to}::date, INTERVAL '1 day')
      AS day_series(day)
    LEFT JOIN video_views v
      ON v.teacher_id = ${teacherId}
      AND (v.timestamp AT TIME ZONE 'Africa/Kampala')::date = day_series.day
    GROUP BY day_series.day
    ORDER BY day_series.day
  `;
}

function pdfText(value: unknown): string {
  return String(value ?? "")
    .replace(/[^\x20-\xff]/gu, "?")
    .replace(/\s+/gu, " ")
    .trim();
}

function fitPdfText(value: unknown, font: PDFFont, size: number, maxWidth: number): string {
  let text = pdfText(value);
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  while (text.length > 1 && font.widthOfTextAtSize(`${text}...`, size) > maxWidth) {
    text = text.slice(0, -1);
  }
  return `${text}...`;
}

function drawPdfText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  size: number,
  font: PDFFont,
  color = rgb(0.16, 0.15, 0.2),
): void {
  page.drawText(text, { x, y, size, font, color });
}

async function createEarningsPdf(
  teacher: AuthenticatedUser,
  range: DateRange,
  summary: EarningsSummary,
  dailyRows: Array<{ date: string; views: number; amount: number | string }>,
): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle("APSHULE Teacher Earnings Report");
  document.setAuthor("APSHULE");
  document.setSubject(`Teacher earnings from ${range.from} to ${range.to}`);

  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 48;
  const purple = rgb(0.27, 0.2, 0.5);
  const muted = rgb(0.39, 0.38, 0.44);
  const grid = rgb(0.84, 0.83, 0.87);
  let page = document.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;
  let pageIndex = 0;

  const addPage = () => {
    page = document.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
    pageIndex += 1;
    drawPdfText(page, "APSHULE · Teacher Earnings Report", margin, y, 15, bold, purple);
    y -= 24;
  };

  drawPdfText(page, "APSHULE · Teacher Earnings Report", margin, y, 17, bold, purple);
  y -= 29;
  drawPdfText(page, `Period: ${range.from} to ${range.to}`, margin, y, 10, regular, muted);
  y -= 19;
  drawPdfText(page, `Teacher: ${fitPdfText(teacher.name, regular, 10, 230)}`, margin, y, 10, regular);
  drawPdfText(page, `Email: ${fitPdfText(teacher.email, regular, 9, 230)}`, 300, y, 9, regular, muted);
  y -= 31;

  const summaryItems = [
    ["Total views", String(summary.total_views)],
    ["Total earned", `UGX ${asNumber(summary.total_earned).toLocaleString("en-UG")}`],
    ["This month", `UGX ${asNumber(summary.this_month_earned).toLocaleString("en-UG")}`],
    ["Available", `UGX ${asNumber(summary.available_balance).toLocaleString("en-UG")}`],
  ];
  page.drawRectangle({
    x: margin,
    y: y - 28,
    width: pageWidth - margin * 2,
    height: 34,
    color: rgb(0.95, 0.94, 0.98),
    borderColor: grid,
    borderWidth: 0.6,
  });
  summaryItems.forEach(([label, value], index) => {
    const cellX = margin + 8 + index * 124;
    drawPdfText(page, label, cellX, y - 7, 7.5, regular, muted);
    drawPdfText(page, fitPdfText(value, bold, 8.5, 112), cellX, y - 20, 8.5, bold, purple);
  });
  y -= 52;

  const drawTableHeader = () => {
    page.drawRectangle({
      x: margin,
      y: y - 12,
      width: pageWidth - margin * 2,
      height: 19,
      color: purple,
    });
    drawPdfText(page, "Date", margin + 8, y - 5, 8, bold, rgb(1, 1, 1));
    drawPdfText(page, "Views", margin + 266, y - 5, 8, bold, rgb(1, 1, 1));
    drawPdfText(page, "Earned (UGX)", margin + 358, y - 5, 8, bold, rgb(1, 1, 1));
    y -= 24;
  };

  drawPdfText(page, "Daily breakdown", margin, y, 11, bold, purple);
  y -= 17;
  drawTableHeader();
  for (const [index, row] of dailyRows.entries()) {
    if (y < margin + 37) {
      addPage();
      drawTableHeader();
    }
    if (index % 2 === 1) {
      page.drawRectangle({
        x: margin,
        y: y - 5,
        width: pageWidth - margin * 2,
        height: 17,
        color: rgb(0.975, 0.973, 0.985),
      });
    }
    drawPdfText(page, row.date, margin + 8, y, 8, regular);
    drawPdfText(page, String(row.views), margin + 266, y, 8, regular);
    drawPdfText(page, asNumber(row.amount).toLocaleString("en-UG"), margin + 358, y, 8, regular);
    y -= 18;
  }

  const generatedAt = new Intl.DateTimeFormat("en-UG", {
    dateStyle: "medium",
    timeZone: "Africa/Kampala",
  }).format(new Date());
  drawPdfText(
    page,
    `Generated on ${generatedAt}. Not valid without official stamp.`,
    margin,
    28,
    8,
    regular,
    muted,
  );
  if (pageIndex > 0) {
    drawPdfText(page, `Page ${pageIndex + 1}`, pageWidth - margin - 45, 28, 8, regular, muted);
  }
  return document.save();
}

function payoutIdFromRequest(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Payout id must be a valid UUID.");
  }
  return value;
}

earnings.post("/video-views", authMiddleware, requireRole("individual", "teacher"), async (c) => {
  const viewer = c.get("user");
  assertRealUser(viewer);
  const sql = getDb(c.env);
  const idempotency = {
    key: readIdempotencyKey(c.req.header("Idempotency-Key") ?? null),
    userId: viewer.id,
    route: c.req.path,
  };
  const replay = await findIdempotencyReplay(sql, idempotency);
  if (replay) {
    scheduleIdempotencyCleanup(c, sql);
    return c.json(replay, 200);
  }

  const body = await readJson(c);
  const lessonId = requiredString(body, "lessonId", { max: 160 });
  const classId = optionalString(body, "classId", { max: 120 }) ?? null;
  const className = optionalString(body, "className", { max: 120 }) ?? null;

  const operationQuery = sql`
    WITH idempotency_guard AS MATERIALIZED (
      SELECT TRUE AS allowed
      WHERE ${idempotency.key === null}
      UNION ALL
      SELECT TRUE
      FROM idempotency_keys
      WHERE key = ${idempotency.key}
        AND user_id = ${idempotency.userId}
        AND route = ${idempotency.route}
        AND response_body IS NULL
    ),
    viewer_lock AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(hashtextextended(${`${viewer.id}:${lessonId}`}, 0))
      FROM idempotency_guard
    ),
    mapping AS MATERIALIZED (
      SELECT
        vm.subject,
        vm.class_key,
        CASE WHEN teacher.role = 'teacher' THEN vm.teacher_id ELSE NULL END AS teacher_id
      FROM video_mappings vm
      LEFT JOIN users teacher ON teacher.id = vm.teacher_id
      WHERE vm.key = ${lessonId}
    ),
    rate AS MATERIALIZED (
      SELECT per_view_ugx FROM teacher_earnings_rate WHERE id = 1
    ),
    recent_view AS MATERIALIZED (
      SELECT EXISTS (
        SELECT 1
        FROM video_views v, viewer_lock
        WHERE v.user_id = ${viewer.id}
          AND v.lesson_id = ${lessonId}
          AND v.timestamp >= NOW() - INTERVAL '24 hours'
      ) AS already_counted
    ),
    inserted AS (
      INSERT INTO video_views (
        subject, class_id, class_name, user_id, user_name,
        teacher_id, lesson_id, earnings_paid, earnings_amount, earnings_paid_amount
      )
      SELECT
        mapping.subject,
        COALESCE(${classId}, split_part(mapping.class_key, '_', 2)),
        COALESCE(${className}, initcap(replace(mapping.class_key, '_', ' '))),
        ${viewer.id},
        ${viewer.name},
        mapping.teacher_id,
        ${lessonId},
        FALSE,
        CASE WHEN mapping.teacher_id IS NULL THEN 0 ELSE rate.per_view_ugx END,
        0
      FROM mapping
      CROSS JOIN rate
      CROSS JOIN viewer_lock
      CROSS JOIN recent_view
      CROSS JOIN idempotency_guard
      WHERE NOT recent_view.already_counted
        AND (mapping.teacher_id IS NULL OR mapping.teacher_id <> ${viewer.id})
      RETURNING id
    ), outcome AS (
      SELECT
        EXISTS(SELECT 1 FROM inserted) AS counted,
        CASE
          WHEN NOT EXISTS(SELECT 1 FROM mapping) THEN 'lesson_not_found'
          WHEN EXISTS(SELECT 1 FROM mapping WHERE teacher_id = ${viewer.id}) THEN 'self_view'
          WHEN (SELECT already_counted FROM recent_view) THEN 'duplicate'
          WHEN EXISTS(SELECT 1 FROM inserted) THEN NULL
          ELSE 'rate_not_configured'
        END AS reason
      FROM idempotency_guard
    ), response_payload AS (
      SELECT jsonb_build_object(
        'counted', outcome.counted,
        'reason', outcome.reason
      ) AS body
      FROM outcome
    ), saved_response AS (
      UPDATE idempotency_keys AS saved
      SET response_body = response_payload.body
      FROM response_payload
      WHERE saved.key = ${idempotency.key}
        AND saved.user_id = ${idempotency.userId}
        AND saved.route = ${idempotency.route}
        AND saved.response_body IS NULL
        AND ${idempotency.key !== null}
      RETURNING saved.key
    )
    SELECT body AS response_body
    FROM response_payload
  `;
  if (idempotency.key) {
    const [claimedRows, operationRows, storedRows] = await sql.transaction([
      idempotencyClaimQuery(sql, idempotency),
      operationQuery,
      idempotencyLookupQuery(sql, idempotency),
    ]);
    const result = resolveIdempotencyTransaction(
      idempotency,
      claimedRows,
      operationRows,
      storedRows,
      200,
    );
    scheduleIdempotencyCleanup(c, sql);
    return c.json(result.body, result.status);
  }

  const rows = await operationQuery;
  return c.json(rows[0]?.response_body as { counted: boolean; reason: string | null });
});

earnings.get(
  "/teacher/earnings",
  authMiddleware,
  requireRole("teacher"),
  requireRealTeacher,
  async (c) => {
    const summary = await getTeacherSummary(getDb(c.env), c.get("user").id);
    return c.json(summary);
  },
);

earnings.get(
  "/teacher/earnings/breakdown",
  authMiddleware,
  requireRole("teacher"),
  requireRealTeacher,
  async (c) => {
    const range = getDateRange(c.req.query("from"), c.req.query("to"));
    const dailyRows = await getDailyBreakdown(getDb(c.env), c.get("user").id, range);
    return c.json(dailyRows);
  },
);

earnings.get(
  "/teacher/earnings/report.pdf",
  authMiddleware,
  requireRole("teacher"),
  requireRealTeacher,
  async (c) => {
    const teacher = c.get("user");
    const range = getDateRange(c.req.query("from"), c.req.query("to"));
    const sql = getDb(c.env);
    const [summary, dailyRows] = await Promise.all([
      getTeacherSummary(sql, teacher.id),
      getDailyBreakdown(sql, teacher.id, range),
    ]);
    const pdf = await createEarningsPdf(
      teacher,
      range,
      summary,
      dailyRows as Array<{ date: string; views: number; amount: number | string }>,
    );
    const pdfBody = new Uint8Array(pdf.byteLength);
    pdfBody.set(pdf);
    return new Response(pdfBody.buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="apshule-earnings-${range.from}-to-${range.to}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  },
);

earnings.get(
  "/teacher/payouts",
  authMiddleware,
  requireRole("teacher"),
  requireRealTeacher,
  async (c) => {
    const rows = await getDb(c.env)`
      SELECT id, amount, status, requested_at, approved_at, paid_at,
        payment_method, payment_reference, notes, rejection_reason
      FROM payout_requests
      WHERE teacher_id = ${c.get("user").id}
      ORDER BY requested_at DESC
      LIMIT 500
    `;
    return c.json({ payouts: rows });
  },
);

earnings.post(
  "/teacher/payouts/request",
  authMiddleware,
  requireRole("teacher"),
  requireRealTeacher,
  async (c) => {
    const teacher = c.get("user");
    const body = await readJson(c);
    const amount = parsePositiveAmount(body.amount, "amount");
    const paymentMethod = parsePaymentMethod(body.payment_method, true)!;
    const notes = optionalString(body, "notes", { max: 1000, allowNull: true }) ?? null;
    const sql = getDb(c.env);
    const rows = await sql`
      WITH teacher_lock AS MATERIALIZED (
        SELECT pg_advisory_xact_lock(hashtextextended(${`payout:${teacher.id}`}, 0))
      ),
      balance AS MATERIALIZED (
        SELECT
          COALESCE((
            SELECT SUM(v.earnings_amount)
            FROM video_views v
            WHERE v.teacher_id = ${teacher.id}
          ), 0)::numeric AS total_earned,
          COALESCE((
            SELECT SUM(p.amount)
            FROM payout_requests p
            WHERE p.teacher_id = ${teacher.id}
              AND p.status IN ('pending', 'approved', 'paid')
          ), 0)::numeric AS already_committed,
          EXISTS (
            SELECT 1 FROM payout_requests p
            WHERE p.teacher_id = ${teacher.id} AND p.status = 'pending'
          ) AS has_pending,
          r.min_withdrawal_ugx
        FROM teacher_earnings_rate r
        CROSS JOIN teacher_lock
        WHERE r.id = 1
      ),
      decision AS MATERIALIZED (
        SELECT
          total_earned - already_committed AS available_balance,
          has_pending,
          min_withdrawal_ugx
        FROM balance
      ),
      created AS (
        INSERT INTO payout_requests (teacher_id, amount, payment_method, notes)
        SELECT ${teacher.id}, ${amount}, ${paymentMethod}, ${notes}
        FROM decision
        WHERE NOT has_pending
          AND ${amount} >= min_withdrawal_ugx
          AND ${amount} <= available_balance
        RETURNING id, teacher_id, amount, status, requested_at, approved_at, paid_at,
          payment_method, payment_reference, notes, rejection_reason
      ),
      logged AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${teacher.id}, 'education', 'teacher_payout.requested', 'payout_requests',
          created.id, jsonb_build_object('amount', created.amount, 'payment_method', created.payment_method),
          ${requestIp(c)}
        FROM created
      )
      SELECT
        'created'::text AS outcome,
        to_jsonb(created) AS payout,
        decision.available_balance
      FROM created CROSS JOIN decision
      UNION ALL
      SELECT
        CASE
          WHEN decision.has_pending THEN 'pending_exists'
          WHEN ${amount} < decision.min_withdrawal_ugx THEN 'below_minimum'
          ELSE 'insufficient_balance'
        END::text AS outcome,
        NULL::jsonb AS payout,
        decision.available_balance
      FROM decision
      WHERE NOT EXISTS (SELECT 1 FROM created)
    `;
    const result = rows[0] as
      | { outcome: string; payout: Record<string, unknown> | null }
      | undefined;
    if (!result) {
      throw new ApiError(503, "EARNINGS_NOT_CONFIGURED", "Teacher earnings have not been configured.");
    }
    if (result.outcome === "pending_exists") {
      throw new ApiError(409, "PAYOUT_ALREADY_PENDING", "You already have a pending payout request.");
    }
    if (result.outcome === "below_minimum") {
      throw new ApiError(400, "BELOW_MINIMUM", "The payout amount is below the current minimum withdrawal.");
    }
    if (result.outcome === "insufficient_balance") {
      throw new ApiError(400, "INSUFFICIENT_BALANCE", "The payout amount exceeds your available balance.");
    }
    return c.json({ payout: result.payout }, 201);
  },
);

earnings.get(
  "/superadmin/payouts",
  authMiddleware,
  requireRealSuperAdmin(),
  async (c) => {
    const statusValue = c.req.query("status");
    const status = statusValue && statusValue !== "all" ? statusValue : null;
    if (status && !["pending", "approved", "paid", "rejected"].includes(status)) {
      throw new ApiError(400, "VALIDATION_ERROR", "status must be all, pending, approved, paid, or rejected.");
    }
    const teacherIdValue = c.req.query("teacher_id");
    const teacherId = teacherIdValue?.trim() || null;
    if (teacherId && !UUID_PATTERN.test(teacherId)) {
      throw new ApiError(400, "VALIDATION_ERROR", "teacher_id must be a valid UUID.");
    }
    const sql = getDb(c.env);
    const [rows, summaryRows] = await Promise.all([
      sql`
        SELECT
          p.id, p.teacher_id, t.name AS teacher_name, t.email AS teacher_email,
          p.amount, p.status, p.requested_at, p.approved_at, p.paid_at,
          p.payment_method, p.payment_reference, p.notes, p.rejection_reason
        FROM payout_requests p
        JOIN users t ON t.id = p.teacher_id
        WHERE (${status === null} OR p.status = ${status})
          AND (${teacherId === null} OR p.teacher_id = ${teacherId}::uuid)
        ORDER BY p.requested_at DESC
        LIMIT 500
      `,
      sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count,
          COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0)::numeric AS pending_amount,
          COALESCE(
            SUM(amount) FILTER (
              WHERE status = 'paid'
                AND paid_at >= (
                  date_trunc('month', NOW() AT TIME ZONE 'Africa/Kampala')
                  AT TIME ZONE 'Africa/Kampala'
                )
            ),
            0
          )::numeric AS paid_this_month
        FROM payout_requests
      `,
    ]);
    return c.json({ payouts: rows, summary: summaryRows[0] ?? {} });
  },
);

earnings.get(
  "/superadmin/earnings/rate",
  authMiddleware,
  requireRealSuperAdmin(),
  async (c) => {
    const rows = await getDb(c.env)`
      SELECT per_view_ugx, min_withdrawal_ugx
      FROM teacher_earnings_rate
      WHERE id = 1
    `;
    if (!rows[0]) {
      throw new ApiError(503, "EARNINGS_NOT_CONFIGURED", "Teacher earnings have not been configured.");
    }
    return c.json(rows[0]);
  },
);

earnings.patch(
  "/superadmin/earnings/rate",
  authMiddleware,
  requireRealSuperAdmin(),
  async (c) => {
    const actor = c.get("user");
    const body = await readJson(c);
    const perView = parsePositiveAmount(body.per_view_ugx, "per_view_ugx");
    const minimum = parsePositiveAmount(body.min_withdrawal_ugx, "min_withdrawal_ugx");
    const rows = await getDb(c.env)`
      WITH updated AS (
        INSERT INTO teacher_earnings_rate
          (id, per_view_ugx, min_withdrawal_ugx, updated_at, updated_by)
        VALUES (1, ${perView}, ${minimum}, NOW(), ${actor.id})
        ON CONFLICT (id) DO UPDATE
        SET per_view_ugx = EXCLUDED.per_view_ugx,
            min_withdrawal_ugx = EXCLUDED.min_withdrawal_ugx,
            updated_at = NOW(),
            updated_by = EXCLUDED.updated_by
        RETURNING per_view_ugx, min_withdrawal_ugx
      ),
      logged AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, metadata, ip)
        SELECT ${actor.id}, 'education', 'teacher_earnings.rate_updated',
          'teacher_earnings_rate',
          jsonb_build_object(
            'per_view_ugx', updated.per_view_ugx,
            'min_withdrawal_ugx', updated.min_withdrawal_ugx
          ),
          ${requestIp(c)}
        FROM updated
      )
      SELECT per_view_ugx, min_withdrawal_ugx FROM updated
    `;
    return c.json({ rate: rows[0] });
  },
);

earnings.patch(
  "/superadmin/payouts/:id/approve",
  authMiddleware,
  requireRealSuperAdmin(),
  async (c) => {
    const actor = c.get("user");
    const id = payoutIdFromRequest(c.req.param("id"));
    const body = await readJson(c);
    const notes = optionalString(body, "notes", { max: 1000, allowNull: true }) ?? null;
    const rows = await getDb(c.env)`
      WITH changed AS (
        UPDATE payout_requests
        SET status = 'approved',
            approved_at = NOW(),
            approved_by = ${actor.id},
            notes = COALESCE(${notes}, notes)
        WHERE id = ${id}::uuid AND status = 'pending'
        RETURNING id, teacher_id, amount, status, requested_at, approved_at, paid_at,
          payment_method, payment_reference, notes, rejection_reason
      ),
      logged AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${actor.id}, 'education', 'teacher_payout.approved', 'payout_requests',
          changed.id, jsonb_build_object('amount', changed.amount), ${requestIp(c)}
        FROM changed
      )
      SELECT * FROM changed
    `;
    if (!rows[0]) {
      const current = await getDb(c.env)`SELECT status FROM payout_requests WHERE id = ${id}::uuid`;
      getPaymentStatusError((current[0] as { status?: string } | undefined)?.status);
    }
    return c.json({ payout: rows[0] });
  },
);

earnings.patch(
  "/superadmin/payouts/:id/paid",
  authMiddleware,
  requireRealSuperAdmin(),
  async (c) => {
    const actor = c.get("user");
    const id = payoutIdFromRequest(c.req.param("id"));
    const body = await readJson(c);
    const paymentReference = requiredString(body, "payment_reference", { max: 160 });
    const paymentMethod = parsePaymentMethod(body.payment_method, false);
    const rows = await getDb(c.env)`
      WITH changed AS (
        UPDATE payout_requests
        SET status = 'paid',
            paid_at = NOW(),
            paid_by = ${actor.id},
            payment_reference = ${paymentReference},
            payment_method = COALESCE(${paymentMethod}, payment_method)
        WHERE id = ${id}::uuid AND status = 'approved'
        RETURNING id, teacher_id, amount, status, requested_at, approved_at, paid_at,
          payment_method, payment_reference, notes, rejection_reason
      ),
      eligible_views AS MATERIALIZED (
        SELECT
          v.id,
          v.earnings_amount - COALESCE(v.earnings_paid_amount, 0) AS outstanding,
          SUM(v.earnings_amount - COALESCE(v.earnings_paid_amount, 0)) OVER (
            ORDER BY v.timestamp, v.id
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ) AS preceding_amount
        FROM video_views v
        JOIN changed ON changed.teacher_id = v.teacher_id
        WHERE v.earnings_amount > COALESCE(v.earnings_paid_amount, 0)
      ),
      allocations AS MATERIALIZED (
        SELECT
          eligible_views.id,
          LEAST(
            eligible_views.outstanding,
            GREATEST(
              changed.amount - COALESCE(eligible_views.preceding_amount, 0),
              0
            )
          ) AS amount_to_allocate
        FROM eligible_views
        CROSS JOIN changed
      ),
      allocated_views AS (
        UPDATE video_views v
        SET earnings_paid_amount = COALESCE(v.earnings_paid_amount, 0) + allocations.amount_to_allocate,
            earnings_paid =
              COALESCE(v.earnings_paid_amount, 0) + allocations.amount_to_allocate >= v.earnings_amount
        FROM allocations
        WHERE v.id = allocations.id AND allocations.amount_to_allocate > 0
        RETURNING v.id
      ),
      logged AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${actor.id}, 'education', 'teacher_payout.paid', 'payout_requests',
          changed.id,
          jsonb_build_object(
            'amount', changed.amount,
            'payment_reference', changed.payment_reference,
            'payment_method', changed.payment_method,
            'allocated_views', (SELECT COUNT(*) FROM allocated_views)
          ),
          ${requestIp(c)}
        FROM changed
      )
      SELECT * FROM changed
    `;
    if (!rows[0]) {
      const current = await getDb(c.env)`SELECT status FROM payout_requests WHERE id = ${id}::uuid`;
      getPaymentStatusError((current[0] as { status?: string } | undefined)?.status);
    }
    return c.json({ payout: rows[0] });
  },
);

earnings.patch(
  "/superadmin/payouts/:id/reject",
  authMiddleware,
  requireRealSuperAdmin(),
  async (c) => {
    const actor = c.get("user");
    const id = payoutIdFromRequest(c.req.param("id"));
    const body = await readJson(c);
    const reason = requiredString(body, "reason", { max: 1000 });
    const rows = await getDb(c.env)`
      WITH changed AS (
        UPDATE payout_requests
        SET status = 'rejected', rejection_reason = ${reason}
        WHERE id = ${id}::uuid AND status = 'pending'
        RETURNING id, teacher_id, amount, status, requested_at, approved_at, paid_at,
          payment_method, payment_reference, notes, rejection_reason
      ),
      logged AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${actor.id}, 'education', 'teacher_payout.rejected', 'payout_requests',
          changed.id,
          jsonb_build_object('amount', changed.amount, 'reason', changed.rejection_reason),
          ${requestIp(c)}
        FROM changed
      )
      SELECT * FROM changed
    `;
    if (!rows[0]) {
      const current = await getDb(c.env)`SELECT status FROM payout_requests WHERE id = ${id}::uuid`;
      getPaymentStatusError((current[0] as { status?: string } | undefined)?.status);
    }
    return c.json({ payout: rows[0] });
  },
);

export default earnings;