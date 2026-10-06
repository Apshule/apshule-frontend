import { Hono } from "hono";
import { ApiError, getDb, isUniqueViolation } from "../db.js";
import { authMiddleware, hashPassword, requireRole } from "../auth.js";
import { sendEmail, welcomeEmailTemplate } from "../email.js";
import { validEmail } from "../http.js";
import {
  requireMfiSector,
  resolveMfiOrganization,
  pathUuid,
} from "../mfi-organization-access.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";

const portal = new Hono<AppEnv>();
const PROVISION_ROLES = ["mfi_admin", "loan_manager", "loan_director", "superadmin"] as const;

portal.use("/mfi/*", authMiddleware, requireMfiSector);
portal.use("/borrower/*", authMiddleware);

function portalIp(c: any): string | null {
  return c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;
}

async function getBorrowerCustomer(
  sql: ReturnType<typeof getDb>,
  user: AuthenticatedUser,
) {
  if (user.role !== "borrower" || user.sector !== "mfi") {
    throw new ApiError(403, "BORROWER_ACCESS_REQUIRED", "A borrower account is required.");
  }
  const rows = await sql`
    SELECT customer.id, customer.organization_id, customer.branch_id,
      customer.first_name, customer.last_name, customer.gender,
      customer.phone, customer.email, customer.address, customer.village,
      customer.district, customer.occupation, customer.portal_enabled,
      organization.name AS organization_name, organization.brand_color,
      organization.logo_base64
    FROM mfi_customers customer
    JOIN mfi_organizations organization ON organization.id = customer.organization_id
    WHERE customer.user_id = ${user.id}
      AND customer.portal_enabled IS TRUE
    LIMIT 1
  `;
  const customer = rows[0] as Record<string, unknown> | undefined;
  if (!customer) {
    throw new ApiError(
      403,
      "BORROWER_PORTAL_DISABLED",
      "Borrower portal access is not enabled for this account.",
    );
  }
  return customer;
}

async function logPortalAccess(
  sql: ReturnType<typeof getDb>,
  c: any,
  customer: Record<string, unknown>,
  user: AuthenticatedUser,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await sql`
    INSERT INTO mfi_customer_portal_log (
      organization_id, customer_id, user_id, action, metadata, ip
    )
    VALUES (
      ${customer.organization_id}, ${customer.id}, ${user.id},
      ${action}, ${JSON.stringify(metadata)}::jsonb, ${portalIp(c)}
    )
  `;
}

portal.post(
  "/mfi/customers/:customerId/portal-access",
  requireRole(...PROVISION_ROLES),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const organization = await resolveMfiOrganization(sql, user, c.req.query("organization_id"));
    const customerId = pathUuid(c.req.param("customerId"), "customer_id");
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) throw new ApiError(400, "INVALID_JSON", "A JSON request body is required.");
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!validEmail(email)) {
      throw new ApiError(400, "VALIDATION_ERROR", "email must be a valid email address.");
    }
    if (password.length < 12 || password.length > 128) {
      throw new ApiError(400, "VALIDATION_ERROR", "password must be between 12 and 128 characters.");
    }
    const hash = await hashPassword(password);
    const ip = portalIp(c);
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await sql`
        WITH target_customer AS (
          SELECT id, organization_id, first_name, last_name, phone, user_id, portal_enabled
          FROM mfi_customers
          WHERE id = ${customerId} AND organization_id = ${organization.id}
          LIMIT 1
        ),
        created_user AS (
          INSERT INTO users (
            name, email, phone, password_hash, role, sector, waitlist, created_at
          )
          SELECT concat_ws(' ', customer.first_name, customer.last_name),
            ${email}, customer.phone, ${hash}, 'borrower', 'mfi', FALSE, NOW()
          FROM target_customer customer
          WHERE customer.user_id IS NULL
            AND customer.portal_enabled IS FALSE
          RETURNING id, name, email
        ),
        linked_customer AS (
          UPDATE mfi_customers customer
          SET user_id = created_user.id,
            email = ${email},
            portal_enabled = TRUE
          FROM created_user
          WHERE customer.id = ${customerId}
            AND customer.organization_id = ${organization.id}
            AND customer.user_id IS NULL
            AND customer.portal_enabled IS FALSE
          RETURNING customer.id, customer.organization_id, customer.user_id,
            customer.first_name, customer.last_name, customer.email
        ),
        local_audit AS (
          INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
          SELECT organization_id, ${user.id}, 'mfi.borrower_portal_enabled',
            'mfi_customers', id,
            jsonb_build_object('user_id', user_id, 'email', email)
          FROM linked_customer
          RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
          SELECT ${user.id}, 'mfi', 'mfi.borrower_portal_enabled',
            'mfi_customers', id,
            jsonb_build_object('user_id', user_id, 'email', email), ${ip}
          FROM linked_customer
          RETURNING id
        )
        SELECT linked_customer.*, created_user.name AS account_name,
          created_user.email AS account_email
        FROM linked_customer
        JOIN created_user ON created_user.id = linked_customer.user_id
      `;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(
          409,
          "BORROWER_EMAIL_IN_USE",
          "That email address is already linked to another APSHULE account.",
        );
      }
      throw error;
    }
    const linked = rows[0];
    if (!linked) {
      const customerRows = await sql`
        SELECT id, user_id, portal_enabled
        FROM mfi_customers
        WHERE id = ${customerId} AND organization_id = ${organization.id}
        LIMIT 1
      `;
      if (!customerRows[0]) throw new ApiError(404, "CUSTOMER_NOT_FOUND", "The customer was not found.");
      throw new ApiError(
        409,
        "PORTAL_ALREADY_ENABLED",
        "This customer already has portal access or an account link. Contact an MFI administrator to resolve it.",
      );
    }
    const emailSent = await sendEmail(c.env, {
      to: email,
      subject: "Your APSHULE borrower account is ready",
      html: welcomeEmailTemplate(
        `${String(linked.first_name || "")} ${String(linked.last_name || "")}`.trim(),
        "MFI borrower",
        null,
        c.env.APP_URL,
      ),
    });
    return c.json({
      customer_id: linked.id,
      user_id: linked.user_id,
      email,
      portal_enabled: true,
      email_sent: emailSent,
    }, 201);
  },
);

portal.get("/borrower/me", requireRole("borrower"), async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const customer = await getBorrowerCustomer(sql, user);
  await logPortalAccess(sql, c, customer, user, "profile_viewed");
  return c.json({
    customer: {
      id: customer.id,
      first_name: customer.first_name,
      last_name: customer.last_name,
      gender: customer.gender,
      phone: customer.phone,
      email: customer.email,
      address: customer.address,
      village: customer.village,
      district: customer.district,
      occupation: customer.occupation,
    },
    organization: {
      name: customer.organization_name,
      brand_color: customer.brand_color,
      logo_base64: customer.logo_base64,
    },
  });
});

portal.patch("/borrower/me/profile", requireRole("borrower"), async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const customer = await getBorrowerCustomer(sql, user);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) throw new ApiError(400, "INVALID_JSON", "A JSON request body is required.");
  const allowed = ["phone", "address", "village"] as const;
  const provided = allowed.filter((field) => Object.hasOwn(body, field));
  if (provided.length === 0 || Object.keys(body).some((key) => !allowed.includes(key as typeof allowed[number]))) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Only phone, address, and village can be updated in the borrower portal.",
    );
  }
  const normalized: Record<string, string | null> = {};
  for (const field of provided) {
    const value = body[field];
    if (value !== null && (typeof value !== "string" || value.trim().length > (field === "phone" ? 40 : 200))) {
      throw new ApiError(400, "VALIDATION_ERROR", `${field} must be text within the allowed length.`);
    }
    normalized[field] = typeof value === "string" && value.trim() ? value.trim() : null;
  }
  const ip = portalIp(c);
  const phoneChanged = Object.hasOwn(normalized, "phone");
  const addressChanged = Object.hasOwn(normalized, "address");
  const villageChanged = Object.hasOwn(normalized, "village");
  const rows = await sql`
    WITH updated AS (
      UPDATE mfi_customers
      SET phone = CASE WHEN ${phoneChanged} THEN ${normalized.phone ?? null} ELSE phone END,
        address = CASE WHEN ${addressChanged} THEN ${normalized.address ?? null} ELSE address END,
        village = CASE WHEN ${villageChanged} THEN ${normalized.village ?? null} ELSE village END
      WHERE id = ${customer.id}
        AND user_id = ${user.id}
        AND portal_enabled IS TRUE
      RETURNING id, organization_id, first_name, last_name, phone, email, address, village
    ),
    portal_audit AS (
      INSERT INTO mfi_customer_portal_log (
        organization_id, customer_id, user_id, action, metadata, ip
      )
      SELECT organization_id, id, ${user.id}, 'profile_updated',
        ${JSON.stringify(normalized)}::jsonb, ${ip}
      FROM updated
      RETURNING id
    ),
    local_audit AS (
      INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
      SELECT organization_id, ${user.id}, 'mfi.borrower_profile_updated',
        'mfi_customers', id, ${JSON.stringify(normalized)}::jsonb
      FROM updated
      RETURNING id
    )
    SELECT * FROM updated
  `;
  const updated = rows[0] as Record<string, unknown> | undefined;
  if (!updated) throw new ApiError(403, "BORROWER_PORTAL_DISABLED", "Borrower portal access is disabled.");
  return c.json({ customer: updated });
});

portal.get("/borrower/me/loans", requireRole("borrower"), async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const customer = await getBorrowerCustomer(sql, user);
  const rows = await sql`
    SELECT loan.id, loan.loan_number, loan.principal, loan.interest_rate,
      loan.term_months, loan.repayment_frequency, loan.total_repayable,
      loan.total_paid, loan.outstanding_balance, loan.disbursed_at,
      loan.first_installment_date, loan.maturity_date, loan.status,
      COALESCE(schedule_rows.schedules, '[]'::jsonb) AS schedules
    FROM mfi_loans loan
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'installment_number', schedule.installment_number,
        'due_date', schedule.due_date,
        'principal_due', schedule.principal_due,
        'interest_due', schedule.interest_due,
        'fees_due', schedule.fees_due,
        'total_due', schedule.total_due,
        'total_paid', schedule.total_paid,
        'status', schedule.status
      ) ORDER BY schedule.installment_number) AS schedules
      FROM mfi_loan_schedules schedule
      WHERE schedule.loan_id = loan.id
        AND schedule.status <> 'restructured'
    ) schedule_rows ON TRUE
    WHERE loan.customer_id = ${customer.id}
      AND loan.organization_id = ${customer.organization_id}
    ORDER BY loan.disbursed_at DESC
  `;
  await logPortalAccess(sql, c, customer, user, "loan_list_viewed", { count: rows.length });
  return c.json({ loans: rows });
});

portal.get("/borrower/me/loans/:loanId", requireRole("borrower"), async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const customer = await getBorrowerCustomer(sql, user);
  const loanId = pathUuid(c.req.param("loanId"), "loan_id");
  const rows = await sql`
    SELECT loan.id, loan.loan_number, loan.principal, loan.interest_rate,
      loan.interest_method, loan.term_months, loan.repayment_frequency,
      loan.total_repayable, loan.total_paid, loan.outstanding_balance,
      loan.disbursed_at, loan.disbursement_method, loan.first_installment_date,
      loan.maturity_date, loan.status, loan.days_overdue,
      COALESCE(schedule_rows.schedules, '[]'::jsonb) AS schedules
    FROM mfi_loans loan
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'installment_number', schedule.installment_number,
        'due_date', schedule.due_date,
        'principal_due', schedule.principal_due,
        'interest_due', schedule.interest_due,
        'fees_due', schedule.fees_due,
        'late_fee_due', schedule.late_fee_due,
        'total_due', schedule.total_due + schedule.late_fee_due,
        'total_paid', schedule.total_paid,
        'status', schedule.status
      ) ORDER BY schedule.installment_number) AS schedules
      FROM mfi_loan_schedules schedule
      WHERE schedule.loan_id = loan.id
        AND schedule.status <> 'restructured'
    ) schedule_rows ON TRUE
    WHERE loan.id = ${loanId}
      AND loan.customer_id = ${customer.id}
      AND loan.organization_id = ${customer.organization_id}
    LIMIT 1
  `;
  const loan = rows[0] as Record<string, unknown> | undefined;
  if (!loan) throw new ApiError(404, "LOAN_NOT_FOUND", "The loan was not found.");
  await logPortalAccess(sql, c, customer, user, "loan_viewed", { loan_id: loanId });
  return c.json({ loan });
});

portal.get("/borrower/me/loans/:loanId/statement", requireRole("borrower"), async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const customer = await getBorrowerCustomer(sql, user);
  const loanId = pathUuid(c.req.param("loanId"), "loan_id");
  const loanRows = await sql`
    SELECT id, loan_number, principal, total_repayable, total_paid,
      outstanding_balance, status
    FROM mfi_loans
    WHERE id = ${loanId}
      AND customer_id = ${customer.id}
      AND organization_id = ${customer.organization_id}
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
        jsonb_build_object('method', loan.disbursement_method) AS metadata
      FROM mfi_loans loan WHERE loan.id = ${loanId}
      UNION ALL
      SELECT payment.id::text, 'payment'::text, payment.paid_at,
        CASE WHEN payment.reversed_at IS NULL THEN -payment.amount ELSE 0 END,
        payment.receipt_number::text,
        CASE WHEN payment.reversed_at IS NULL THEN 'Repayment received' ELSE 'Repayment reversed' END,
        jsonb_build_object('payment_method', payment.payment_method,
          'payment_reference', payment.payment_reference,
          'reversal_reason', payment.reversal_reason)
      FROM mfi_loan_payments payment
      WHERE payment.loan_id = ${loanId}
        AND payment.organization_id = ${customer.organization_id}
      UNION ALL
      SELECT note.id::text, 'credit_note'::text, note.created_at, -note.amount,
        note.id::text, 'Credit note issued', jsonb_build_object('reason', note.reason)
      FROM mfi_credit_notes note
      WHERE note.loan_id = ${loanId}
        AND note.organization_id = ${customer.organization_id}
      UNION ALL
      SELECT restructure.id::text, 'restructure'::text, restructure.created_at,
        restructure.new_total_repayable - restructure.old_total_repayable,
        restructure.id::text, 'Loan terms restructured',
        jsonb_build_object('reason', restructure.reason,
          'new_term_months', restructure.new_term_months,
          'new_annual_rate', restructure.new_annual_rate)
      FROM mfi_loan_restructures restructure
      WHERE restructure.loan_id = ${loanId}
        AND restructure.organization_id = ${customer.organization_id}
    ) statement_events
    ORDER BY event_at, event_id
  `;
  await logPortalAccess(sql, c, customer, user, "loan_statement_viewed", { loan_id: loanId });
  return c.json({ loan, transactions: events });
});

export default portal;
