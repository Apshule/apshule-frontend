import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { ApiError, getDb, isUniqueViolation } from "../db.js";
import { authMiddleware, requireRole } from "../auth.js";
import { optionalString, readJson, requiredString } from "../http.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";
import { calculateDebtToIncome, estimateMonthlyPayment } from "../../../../mfi-loans-domain.mjs";
import type { LoanInterestMethod } from "../../../../mfi-loans-domain.mjs";

const loans = new Hono<AppEnv>();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACCESS_ROLES = [
  "loan_officer",
  "loan_manager",
  "loan_director",
  "mfi_admin",
  "superadmin",
] as const;
const APPLICATION_STATUSES = [
  "draft",
  "submitted",
  "pending_director",
  "approved",
  "disbursed",
  "rejected",
  "changes_requested",
  "cancelled",
] as const;
const INTEREST_METHODS = ["flat", "reducing_balance"] as const;
const REPAYMENT_FREQUENCIES = ["weekly", "biweekly", "monthly"] as const;
const MANAGER_ROLES = ["loan_manager", "mfi_admin"] as const;

export const requireMfiSector = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user.role !== "superadmin" && user.sector !== "mfi") {
    throw new ApiError(403, "MFI_SECTOR_REQUIRED", "This endpoint is for MFI accounts.");
  }
  await next();
});

loans.use("/mfi/*", authMiddleware, requireMfiSector);

export function uuid(value: string, field = "id"): string {
  if (!UUID_PATTERN.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a valid UUID.`);
  }
  return value;
}

export function optionalText(body: Record<string, unknown>, key: string, max = 2000) {
  const value = optionalString(body, key, { max, allowNull: true });
  if (value === undefined || value === null) return value;
  return value.trim() || null;
}

function optionalNumber(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  integer = false,
): number | null | undefined {
  if (!(key in body)) return undefined;
  const raw = body[key];
  if (raw === null || raw === "") return null;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} is outside the allowed range.`);
  }
  return value;
}

function optionalBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean | undefined {
  if (!(key in body)) return undefined;
  if (typeof body[key] === "boolean") return body[key];
  if (body[key] === "true") return true;
  if (body[key] === "false") return false;
  throw new ApiError(400, "VALIDATION_ERROR", `${key} must be true or false.`);
}

export function requestIp(c: { req: { header(name: string): string | undefined } }): string | null {
  return (
    c.req.header("CF-Connecting-IP") ??
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    null
  )?.slice(0, 255) ?? null;
}

export function requestedOrganizationId(
  c: { req: { query(name: string): string | undefined } },
  body?: Record<string, unknown>,
): string | undefined {
  const fromBody = typeof body?.organization_id === "string" ? body.organization_id : undefined;
  const fromQuery = c.req.query("organization_id");
  if (fromBody && fromQuery && fromBody !== fromQuery) {
    throw new ApiError(400, "VALIDATION_ERROR", "organization_id values do not match.");
  }
  const value = fromBody ?? fromQuery;
  return value ? uuid(value, "organization_id") : undefined;
}

export async function organizationForUser(
  sql: ReturnType<typeof getDb>,
  user: AuthenticatedUser,
  requested?: string,
): Promise<string> {
  if (user.role === "superadmin") {
    if (!requested) {
      throw new ApiError(400, "ORGANIZATION_REQUIRED", "Pass organization_id to access MFI loan records.");
    }
    const rows = await sql`
      SELECT id FROM mfi_organizations WHERE id = ${requested} LIMIT 1
    `;
    if (!rows[0]) throw new ApiError(404, "MFI_ORGANIZATION_NOT_FOUND", "MFI organization was not found.");
    return requested;
  }

  const rows = user.role === "mfi_admin"
    ? await sql`
        SELECT id FROM mfi_organizations WHERE created_by = ${user.id} LIMIT 1
      `
    : await sql`
        SELECT organization_id AS id
        FROM mfi_officers
        WHERE user_id = ${user.id} AND active IS TRUE
        LIMIT 1
      `;
  const id = (rows[0] as { id?: string } | undefined)?.id;
  if (!id) {
    throw new ApiError(403, "MFI_ORGANIZATION_REQUIRED", "Your MFI account is not linked to an organization.");
  }
  if (requested && requested !== id) {
    throw new ApiError(403, "MFI_ORGANIZATION_FORBIDDEN", "You cannot access another MFI organization.");
  }
  return id;
}

export function jsonMetadata(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function assertRange(value: number, min: number, max: number, field: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} is outside the allowed range.`);
  }
}

function validateInterestMethod(value: unknown): LoanInterestMethod {
  if (!INTEREST_METHODS.includes(value as (typeof INTEREST_METHODS)[number])) {
    throw new ApiError(400, "VALIDATION_ERROR", "interest_method must be flat or reducing_balance.");
  }
  return value as LoanInterestMethod;
}

function validateFrequency(value: unknown): (typeof REPAYMENT_FREQUENCIES)[number] {
  if (!REPAYMENT_FREQUENCIES.includes(value as (typeof REPAYMENT_FREQUENCIES)[number])) {
    throw new ApiError(400, "VALIDATION_ERROR", "repayment_frequency is not supported.");
  }
  return value as (typeof REPAYMENT_FREQUENCIES)[number];
}

function validateProductValues(product: Record<string, unknown>): void {
  const minAmount = Number(product.min_amount ?? 50_000);
  const maxAmount = Number(product.max_amount ?? 5_000_000);
  const defaultAmount = product.default_amount == null ? null : Number(product.default_amount);
  if (minAmount > maxAmount) {
    throw new ApiError(400, "VALIDATION_ERROR", "min_amount cannot exceed max_amount.");
  }
  if (defaultAmount !== null && (defaultAmount < minAmount || defaultAmount > maxAmount)) {
    throw new ApiError(400, "VALIDATION_ERROR", "default_amount must be within the product amount range.");
  }
  if (Number(product.term_months) < 1 || Number(product.term_months) > 360) {
    throw new ApiError(400, "VALIDATION_ERROR", "term_months must be between 1 and 360.");
  }
  validateInterestMethod(product.interest_method ?? "reducing_balance");
  validateFrequency(product.repayment_frequency ?? "monthly");
}

const PRODUCT_COLUMNS: Record<string, string> = {
  code: "code",
  name: "name",
  description: "description",
  min_amount: "min_amount",
  max_amount: "max_amount",
  default_amount: "default_amount",
  interest_rate: "interest_rate",
  interest_method: "interest_method",
  term_months: "term_months",
  repayment_frequency: "repayment_frequency",
  processing_fee_percent: "processing_fee_percent",
  insurance_fee_percent: "insurance_fee_percent",
  late_fee_percent: "late_fee_percent",
  grace_period_days: "grace_period_days",
  requires_collateral: "requires_collateral",
  min_collateral_value: "min_collateral_value",
  requires_guarantors: "requires_guarantors",
  director_approval_threshold: "director_approval_threshold",
  active: "active",
};

const APPLICATION_UPDATE_COLUMNS: Record<string, string> = {
  product_id: "product_id",
  requested_amount: "requested_amount",
  approved_amount: "approved_amount",
  purpose: "purpose",
  term_months: "term_months",
  interest_rate: "interest_rate",
  interest_method: "interest_method",
  debt_to_income: "debt_to_income",
  submitted_by: "submitted_by",
  submitted_at: "submitted_at",
  reviewed_by: "reviewed_by",
  reviewed_at: "reviewed_at",
  review_notes: "review_notes",
  approved_by: "approved_by",
  approved_at: "approved_at",
  approval_notes: "approval_notes",
  rejection_reason: "rejection_reason",
};

async function auditedProductUpdate(
  sql: ReturnType<typeof getDb>,
  input: {
    id: string;
    organizationId: string;
    actorId: string;
    action: string;
    metadata: Record<string, unknown>;
    ip: string | null;
    updates: Record<string, unknown>;
  },
) {
  const entries = Object.entries(input.updates).filter(([key]) => PRODUCT_COLUMNS[key]);
  if (!entries.length) {
    const rows = await sql`
      SELECT * FROM mfi_loan_products
      WHERE id = ${input.id} AND organization_id = ${input.organizationId}
      LIMIT 1
    `;
    return rows;
  }
  const assignments = entries.map(
    ([key], index) => `${PRODUCT_COLUMNS[key]} = $${index + 7}`,
  );
  const values = [
    input.id,
    input.organizationId,
    input.actorId,
    input.action,
    jsonMetadata(input.metadata),
    input.ip,
    ...entries.map(([, value]) => value),
  ];
  return sql.query(
    `WITH updated AS (
       UPDATE mfi_loan_products
       SET ${assignments.join(", ")}
       WHERE id = $1 AND organization_id = $2
       RETURNING *
     ),
     local_audit AS (
       INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
       SELECT $2, $3, $4, 'mfi_loan_products', id, $5::jsonb FROM updated
       RETURNING id
     ),
     platform_audit AS (
       INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
       SELECT $3, 'mfi', $4, 'mfi_loan_products', id, $5::jsonb, $6 FROM updated
       RETURNING id
     )
     SELECT * FROM updated`,
    values,
  );
}

async function transitionApplication(
  sql: ReturnType<typeof getDb>,
  input: {
    id: string;
    organizationId: string;
    actorId: string;
    ip: string | null;
    action: string;
    metadata: Record<string, unknown>;
    allowedStatuses: string[];
    toStatus: string;
    notes: string | null;
    updates?: Record<string, unknown>;
  },
) {
  const entries = Object.entries(input.updates ?? {}).filter(
    ([key]) => APPLICATION_UPDATE_COLUMNS[key],
  );
  const assignments = [
    "status = $8",
    ...entries.map(([key], index) => `${APPLICATION_UPDATE_COLUMNS[key]} = $${index + 10}`),
    "updated_at = NOW()",
  ];
  const values = [
    input.id,
    input.organizationId,
    input.actorId,
    input.action,
    jsonMetadata(input.metadata),
    input.ip,
    input.allowedStatuses,
    input.toStatus,
    input.notes,
    ...entries.map(([, value]) => value),
  ];
  return sql.query(
    `WITH locked AS MATERIALIZED (
       SELECT id, status FROM mfi_loan_applications
       WHERE id = $1 AND organization_id = $2
       FOR UPDATE
     ),
     updated AS (
       UPDATE mfi_loan_applications a
       SET ${assignments.join(", ")}
       FROM locked l
       WHERE a.id = l.id AND l.status = ANY($7::text[])
       RETURNING a.*, l.status AS previous_status
     ),
     history AS (
       INSERT INTO mfi_loan_application_history
         (application_id, from_status, to_status, actor_id, notes)
       SELECT id, previous_status, $8, $3, $9 FROM updated
       RETURNING id
     ),
     local_audit AS (
       INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
       SELECT $2, $3, $4, 'mfi_loan_applications', id, $5::jsonb FROM updated
       RETURNING id
     ),
     platform_audit AS (
       INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
       SELECT $3, 'mfi', $4, 'mfi_loan_applications', id, $5::jsonb, $6 FROM updated
       RETURNING id
     )
     SELECT * FROM updated`,
    values,
  );
}

async function loadApplication(
  sql: ReturnType<typeof getDb>,
  id: string,
  organizationId: string,
) {
  const rows = await sql`
    SELECT a.*, c.first_name AS customer_first_name, c.last_name AS customer_last_name,
      c.phone AS customer_phone, c.photo_base64 AS customer_photo,
      c.monthly_income AS customer_monthly_income,
      p.name AS product_name, p.code AS product_code,
      p.min_amount AS product_min_amount, p.max_amount AS product_max_amount,
      p.director_approval_threshold, p.requires_collateral,
      p.requires_guarantors, p.min_collateral_value,
      branch.name AS branch_name, creator.name AS created_by_name,
      reviewer.name AS reviewed_by_name, approver.name AS approved_by_name
    FROM mfi_loan_applications a
    JOIN mfi_customers c ON c.id = a.customer_id
    LEFT JOIN mfi_loan_products p ON p.id = a.product_id
    LEFT JOIN mfi_branches branch ON branch.id = a.branch_id
    LEFT JOIN users creator ON creator.id = a.created_by
    LEFT JOIN users reviewer ON reviewer.id = a.reviewed_by
    LEFT JOIN users approver ON approver.id = a.approved_by
    WHERE a.id = ${id} AND a.organization_id = ${organizationId}
    LIMIT 1
  `;
  return rows[0] as Record<string, unknown> | undefined;
}

async function loadProduct(
  sql: ReturnType<typeof getDb>,
  id: string,
  organizationId: string,
  activeOnly = false,
) {
  const rows = await sql`
    SELECT * FROM mfi_loan_products
    WHERE id = ${id}
      AND (organization_id = ${organizationId} OR organization_id IS NULL)
      AND (${!activeOnly} OR active IS TRUE)
    LIMIT 1
  `;
  return rows[0] as Record<string, unknown> | undefined;
}

function applicationStatus(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!APPLICATION_STATUSES.includes(value as (typeof APPLICATION_STATUSES)[number])) {
    throw new ApiError(400, "VALIDATION_ERROR", "status is not a supported application status.");
  }
  return value;
}

function formProduct(body: Record<string, unknown>, partial = false): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  if (!partial || "code" in body) {
    const code = requiredString(body, "code", { max: 40 }).trim().toUpperCase().replaceAll(" ", "_");
    if (!/^[A-Z0-9_-]+$/u.test(code)) {
      throw new ApiError(400, "VALIDATION_ERROR", "code may contain only letters, numbers, hyphens, and underscores.");
    }
    updates.code = code;
  }
  if (!partial || "name" in body) {
    updates.name = requiredString(body, "name", { max: 120 }).trim();
  }
  if (!partial || "description" in body) updates.description = optionalText(body, "description", 2000) ?? null;

  const numericFields: Array<[string, number, number, boolean]> = [
    ["min_amount", 0, 1_000_000_000_000, false],
    ["max_amount", 0, 1_000_000_000_000, false],
    ["default_amount", 0, 1_000_000_000_000, false],
    ["interest_rate", 0, 1000, false],
    ["term_months", 1, 360, true],
    ["processing_fee_percent", 0, 100, false],
    ["insurance_fee_percent", 0, 100, false],
    ["late_fee_percent", 0, 100, false],
    ["grace_period_days", 0, 365, true],
    ["min_collateral_value", 0, 1_000_000_000_000, false],
    ["requires_guarantors", 0, 20, true],
    ["director_approval_threshold", 0, 1_000_000_000_000, false],
  ];
  for (const [key, min, max, integer] of numericFields) {
    if (!partial || key in body) {
      const defaultForCreate: Record<string, number> = {
        min_amount: 50_000,
        max_amount: 5_000_000,
        interest_rate: 24,
        term_months: 12,
        processing_fee_percent: 2,
        insurance_fee_percent: 1,
        late_fee_percent: 2,
        grace_period_days: 7,
        requires_guarantors: 0,
        director_approval_threshold: 2_000_000,
      };
      if (!partial && !(key in body) && key in defaultForCreate) {
        updates[key] = defaultForCreate[key];
      } else {
        const parsed = optionalNumber(body, key, min, max, integer);
        if (
          ["min_amount", "max_amount", "interest_rate", "term_months"].includes(key) &&
          parsed === null
        ) {
          throw new ApiError(400, "VALIDATION_ERROR", `${key} is required.`);
        }
        if (parsed !== undefined || key in body) updates[key] = parsed;
        else if (!partial && !(key in defaultForCreate)) updates[key] = null;
      }
    }
  }
  if (!partial || "interest_method" in body) {
    updates.interest_method = validateInterestMethod(
      body.interest_method ?? (partial ? undefined : "reducing_balance"),
    );
  }
  if (!partial || "repayment_frequency" in body) {
    updates.repayment_frequency = validateFrequency(
      body.repayment_frequency ?? (partial ? undefined : "monthly"),
    );
  }
  if (!partial || "requires_collateral" in body) {
    updates.requires_collateral = optionalBoolean(body, "requires_collateral") ?? false;
  }
  if ("active" in body) updates.active = optionalBoolean(body, "active");
  return updates;
}

function validateProductBodyAgainstCurrent(
  current: Record<string, unknown>,
  updates: Record<string, unknown>,
): void {
  validateProductValues({ ...current, ...updates });
}

async function productRowsForOrg(
  sql: ReturnType<typeof getDb>,
  organizationId: string,
  includeInactive: boolean,
) {
  return sql`
    SELECT * FROM mfi_loan_products
    WHERE (organization_id = ${organizationId} OR organization_id IS NULL)
      AND (${includeInactive} OR active IS TRUE)
    ORDER BY active DESC, name ASC
    LIMIT 300
  `;
}

// Product catalog.
loans.get("/mfi/loan-products", requireRole(...ACCESS_ROLES), async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c));
  const includeInactive =
    ["mfi_admin", "loan_director"].includes(user.role) &&
    c.req.query("include_inactive") === "true";
  const products = await productRowsForOrg(sql, organizationId, includeInactive);
  return c.json({ products });
});

loans.post(
  "/mfi/loan-products",
  requireRole("mfi_admin", "loan_director"),
  async (c) => {
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const product = formProduct(body);
    validateProductValues(product);
    const metadata = jsonMetadata({ code: product.code, name: product.name });
    try {
      const rows = await sql`
        WITH created AS (
          INSERT INTO mfi_loan_products (
            organization_id, code, name, description, min_amount, max_amount,
            default_amount, interest_rate, interest_method, term_months,
            repayment_frequency, processing_fee_percent, insurance_fee_percent,
            late_fee_percent, grace_period_days, requires_collateral,
            min_collateral_value, requires_guarantors, director_approval_threshold, active
          )
          VALUES (
            ${organizationId}, ${product.code}, ${product.name}, ${product.description},
            ${product.min_amount}, ${product.max_amount}, ${product.default_amount},
            ${product.interest_rate}, ${product.interest_method}, ${product.term_months},
            ${product.repayment_frequency}, ${product.processing_fee_percent},
            ${product.insurance_fee_percent}, ${product.late_fee_percent},
            ${product.grace_period_days}, ${product.requires_collateral},
            ${product.min_collateral_value}, ${product.requires_guarantors},
            ${product.director_approval_threshold}, TRUE
          )
          RETURNING *
        ),
        local_audit AS (
          INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
          SELECT organization_id, ${user.id}, 'mfi.loan_product_created',
            'mfi_loan_products', id, ${metadata}::jsonb FROM created
          RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
          SELECT ${user.id}, 'mfi', 'mfi.loan_product_created',
            'mfi_loan_products', id, ${metadata}::jsonb, ${requestIp(c)} FROM created
          RETURNING id
        )
        SELECT * FROM created
      `;
      if (!rows[0]) throw new ApiError(500, "MFI_LOAN_PRODUCT_CREATE_FAILED", "The loan product could not be created.");
      return c.json({ product: rows[0] }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "MFI_LOAN_PRODUCT_CODE_EXISTS", "A product with this code already exists.");
      }
      throw error;
    }
  },
);

loans.patch(
  "/mfi/loan-products/:id",
  requireRole("mfi_admin", "loan_director"),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const current = await loadProduct(sql, id, organizationId);
    if (!current) throw new ApiError(404, "MFI_LOAN_PRODUCT_NOT_FOUND", "Loan product was not found.");
    const updates = formProduct(body, true);
    if (updates.active === false) {
      throw new ApiError(403, "MFI_LOAN_PRODUCT_DEACTIVATE_ADMIN_ONLY", "Use the deactivate action; only an MFI admin may deactivate products.");
    }
    validateProductBodyAgainstCurrent(current, updates);
    const metadata = { changed_fields: Object.keys(updates) };
    try {
      const rows = await auditedProductUpdate(sql, {
        id,
        organizationId,
        actorId: user.id,
        action: "mfi.loan_product_updated",
        metadata,
        ip: requestIp(c),
        updates,
      });
      if (!rows[0]) throw new ApiError(404, "MFI_LOAN_PRODUCT_NOT_FOUND", "Loan product was not found.");
      return c.json({ product: rows[0] });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "MFI_LOAN_PRODUCT_CODE_EXISTS", "A product with this code already exists.");
      }
      throw error;
    }
  },
);

loans.delete(
  "/mfi/loan-products/:id",
  requireRole("mfi_admin"),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c));
    const rows = await auditedProductUpdate(sql, {
      id,
      organizationId,
      actorId: user.id,
      action: "mfi.loan_product_deactivated",
      metadata: { active: false },
      ip: requestIp(c),
      updates: { active: false },
    });
    if (!rows[0]) throw new ApiError(404, "MFI_LOAN_PRODUCT_NOT_FOUND", "Loan product was not found.");
    return c.json({ product: rows[0] });
  },
);

// Application list and detail.
loans.get(
  "/mfi/loan-applications",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c));
    const status = applicationStatus(c.req.query("status"));
    const branchId = c.req.query("branch_id") ? uuid(c.req.query("branch_id")!, "branch_id") : null;
    const customerId = c.req.query("customer_id") ? uuid(c.req.query("customer_id")!, "customer_id") : null;
    const search = c.req.query("search")?.trim().slice(0, 120) || null;
    const applications = await sql`
      SELECT a.id, a.reference, a.requested_amount, a.approved_amount, a.status,
        a.submitted_at, a.created_at, a.updated_at, a.term_months,
        c.id AS customer_id, c.first_name AS customer_first_name,
        c.last_name AS customer_last_name, c.phone AS customer_phone,
        p.id AS product_id, p.name AS product_name, p.code AS product_code,
        branch.id AS branch_id, branch.name AS branch_name
      FROM mfi_loan_applications a
      JOIN mfi_customers c ON c.id = a.customer_id
      LEFT JOIN mfi_loan_products p ON p.id = a.product_id
      LEFT JOIN mfi_branches branch ON branch.id = a.branch_id
      WHERE a.organization_id = ${organizationId}
        AND (${status ?? null}::text IS NULL OR a.status = ${status ?? null})
        AND (${branchId}::uuid IS NULL OR a.branch_id = ${branchId}::uuid)
        AND (${customerId}::uuid IS NULL OR a.customer_id = ${customerId}::uuid)
        AND (
          ${search}::text IS NULL OR
          a.reference ILIKE '%' || ${search} || '%' OR
          c.first_name ILIKE '%' || ${search} || '%' OR
          c.last_name ILIKE '%' || ${search} || '%' OR
          c.phone ILIKE '%' || ${search} || '%'
        )
      ORDER BY a.updated_at DESC, a.created_at DESC
      LIMIT 300
    `;
    return c.json({ applications });
  },
);

loans.get(
  "/mfi/loans/branches",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c));
    const branches = await sql`
      SELECT id, name, code, active
      FROM mfi_branches
      WHERE organization_id = ${organizationId}
      ORDER BY active DESC, name ASC
      LIMIT 500
    `;
    return c.json({ branches });
  },
);

loans.post(
  "/mfi/loan-applications",
  requireRole("loan_officer", "loan_manager", "mfi_admin"),
  async (c) => {
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const customerId = uuid(requiredString(body, "customer_id", { max: 36 }), "customer_id");
    const productId = uuid(requiredString(body, "product_id", { max: 36 }), "product_id");
    const requestedAmount = optionalNumber(body, "requested_amount", 1, 1_000_000_000_000);
    if (requestedAmount === undefined || requestedAmount === null) {
      throw new ApiError(400, "VALIDATION_ERROR", "requested_amount is required.");
    }
    const purpose = optionalText(body, "purpose", 2000) ?? null;
    const customerRows = await sql`
      SELECT id, branch_id, monthly_income
      FROM mfi_customers
      WHERE id = ${customerId} AND organization_id = ${organizationId} AND status = 'active'
      LIMIT 1
    `;
    const customer = customerRows[0] as { id: string; branch_id: string | null; monthly_income: number | string | null } | undefined;
    if (!customer) throw new ApiError(404, "MFI_CUSTOMER_NOT_FOUND", "Active customer was not found in this organization.");
    const product = await loadProduct(sql, productId, organizationId, true);
    if (!product) throw new ApiError(404, "MFI_LOAN_PRODUCT_NOT_FOUND", "Active loan product was not found in this organization.");
    const minAmount = Number(product.min_amount);
    const maxAmount = Number(product.max_amount);
    assertRange(requestedAmount, minAmount, maxAmount, "requested_amount");
    const termMonths = body.term_months === undefined || body.term_months === null || body.term_months === ""
      ? Number(product.term_months)
      : optionalNumber(body, "term_months", 1, 360, true);
    if (termMonths === undefined || termMonths === null) {
      throw new ApiError(400, "VALIDATION_ERROR", "term_months is required.");
    }
    const interestMethod = validateInterestMethod(product.interest_method ?? "reducing_balance");
    const rate = Number(product.interest_rate ?? 0);
    const estimate = estimateMonthlyPayment(requestedAmount, rate, termMonths, interestMethod);
    const debtToIncome = calculateDebtToIncome(
      estimate.monthlyPayment,
      customer.monthly_income,
    );
    const month = new Date().toISOString().slice(0, 7).replace("-", "");
    const metadata = jsonMetadata({
      status_from: null,
      status_to: "draft",
      customer_id: customerId,
      product_id: productId,
      requested_amount: requestedAmount,
    });
    // The requested schema makes reference globally unique. A per-month lock
    // keeps concurrent organizations collision-free; each organization's own
    // sequence still advances independently and skips a number already used globally.
    const rows = await sql.query(
      `WITH reference_lock AS MATERIALIZED (
         SELECT pg_advisory_xact_lock(hashtextextended('mfi-loan-reference:' || $2, 0))
       ),
       start_sequence AS MATERIALIZED (
         SELECT COALESCE(MAX(split_part(reference, '-', 3)::integer), 0) + 1 AS first_number
         FROM mfi_loan_applications
         WHERE organization_id = $1
           AND reference ~ '^LA-[0-9]{6}-[0-9]{4,}$'
           AND split_part(reference, '-', 2) = $2
       ),
       free_reference AS (
         SELECT 'LA-' || $2 || '-' || LPAD(candidate.number::text, 4, '0') AS reference
         FROM reference_lock
         CROSS JOIN start_sequence
         CROSS JOIN LATERAL generate_series(start_sequence.first_number, 9999) AS candidate(number)
         WHERE NOT EXISTS (
           SELECT 1 FROM mfi_loan_applications existing
           WHERE existing.reference =
             'LA-' || $2 || '-' || LPAD(candidate.number::text, 4, '0')
         )
         ORDER BY candidate.number
         LIMIT 1
       ),
       created AS (
         INSERT INTO mfi_loan_applications (
           organization_id, branch_id, customer_id, product_id, reference,
           requested_amount, purpose, term_months, interest_rate, interest_method,
           debt_to_income, status, created_by
         )
         SELECT $1, $3::uuid, $4::uuid, $5::uuid, free_reference.reference,
           $6, $7, $8, $9, $10, $11, 'draft', $12::uuid
         FROM free_reference
         RETURNING *
       ),
       history AS (
         INSERT INTO mfi_loan_application_history
           (application_id, from_status, to_status, actor_id, notes)
         SELECT id, NULL, 'draft', $12::uuid, 'Application created as draft'
         FROM created
         RETURNING id
       ),
       local_audit AS (
         INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
         SELECT organization_id, $12::uuid, 'mfi.loan_application_created',
           'mfi_loan_applications', id, $13::jsonb FROM created
         RETURNING id
       ),
       platform_audit AS (
         INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
         SELECT $12::uuid, 'mfi', 'mfi.loan_application_created',
           'mfi_loan_applications', id, $13::jsonb, $14 FROM created
         RETURNING id
       )
       SELECT * FROM created`,
      [
        organizationId,
        month,
        customer.branch_id,
        customerId,
        productId,
        requestedAmount,
        purpose,
        termMonths,
        rate,
        interestMethod,
        debtToIncome,
        user.id,
        metadata,
        requestIp(c),
      ],
    );
    if (!rows[0]) {
      throw new ApiError(409, "MFI_LOAN_REFERENCE_EXHAUSTED", "No loan reference is available for this organization and month.");
    }
    return c.json({ application: rows[0] }, 201);
  },
);

loans.get(
  "/mfi/loan-applications/:id/history",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, c.get("user"), requestedOrganizationId(c));
    const exists = await loadApplication(sql, id, organizationId);
    if (!exists) throw new ApiError(404, "MFI_LOAN_APPLICATION_NOT_FOUND", "Loan application was not found.");
    const history = await sql`
      SELECT h.id, h.from_status, h.to_status, h.actor_id, h.notes, h.created_at,
        actor.name AS actor_name
      FROM mfi_loan_application_history h
      LEFT JOIN users actor ON actor.id = h.actor_id
      WHERE h.application_id = ${id}
      ORDER BY h.created_at ASC, h.id ASC
    `;
    return c.json({ history });
  },
);

loans.get(
  "/mfi/loan-applications/:id",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, c.get("user"), requestedOrganizationId(c));
    const application = await loadApplication(sql, id, organizationId);
    if (!application) throw new ApiError(404, "MFI_LOAN_APPLICATION_NOT_FOUND", "Loan application was not found.");
    const collateral = await sql`
      SELECT c.id, c.title, c.estimated_value, c.currency, c.score, c.status,
        c.condition, c.collateral_type_id, type.name AS collateral_type_name,
        linked.linked_at
      FROM mfi_loan_application_collateral linked
      JOIN mfi_collateral c ON c.id = linked.collateral_id
      LEFT JOIN mfi_collateral_types type ON type.id = c.collateral_type_id
      WHERE linked.application_id = ${id}
        AND c.organization_id = ${organizationId}
      ORDER BY linked.linked_at ASC
    `;
    const history = await sql`
      SELECT h.id, h.from_status, h.to_status, h.actor_id, h.notes, h.created_at,
        actor.name AS actor_name
      FROM mfi_loan_application_history h
      LEFT JOIN users actor ON actor.id = h.actor_id
      WHERE h.application_id = ${id}
      ORDER BY h.created_at ASC, h.id ASC
    `;
    const customer = {
      id: application.customer_id,
      first_name: application.customer_first_name,
      last_name: application.customer_last_name,
      phone: application.customer_phone,
      photo_base64: application.customer_photo,
      monthly_income: application.customer_monthly_income,
    };
    const product = {
      id: application.product_id,
      name: application.product_name,
      code: application.product_code,
      interest_rate: application.interest_rate,
      interest_method: application.interest_method,
      term_months: application.term_months,
      min_amount: application.product_min_amount,
      max_amount: application.product_max_amount,
      director_approval_threshold: application.director_approval_threshold,
      requires_collateral: application.requires_collateral,
      requires_guarantors: application.requires_guarantors,
      min_collateral_value: application.min_collateral_value,
    };
    return c.json({ application, customer, product, collateral, history });
  },
);

loans.patch(
  "/mfi/loan-applications/:id",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const current = await loadApplication(sql, id, organizationId);
    if (!current) throw new ApiError(404, "MFI_LOAN_APPLICATION_NOT_FOUND", "Loan application was not found.");
    if (current.status !== "draft") {
      throw new ApiError(409, "MFI_LOAN_APPLICATION_NOT_DRAFT", "Only draft applications can be edited.");
    }
    const customerId = body.customer_id === undefined
      ? String(current.customer_id)
      : uuid(requiredString(body, "customer_id", { max: 36 }), "customer_id");
    const productId = body.product_id === undefined
      ? String(current.product_id)
      : uuid(requiredString(body, "product_id", { max: 36 }), "product_id");
    if (customerId !== String(current.customer_id)) {
      const linkedRows = await sql`
        SELECT COUNT(*)::int AS count
        FROM mfi_loan_application_collateral
        WHERE application_id = ${id}
      `;
      if (Number(linkedRows[0]?.count ?? 0) > 0) {
        throw new ApiError(409, "MFI_LOAN_CUSTOMER_HAS_COLLATERAL", "Unlink the draft's collateral before changing its customer.");
      }
    }
    const customerRows = await sql`
      SELECT id, branch_id, monthly_income FROM mfi_customers
      WHERE id = ${customerId} AND organization_id = ${organizationId} AND status = 'active'
      LIMIT 1
    `;
    const customer = customerRows[0] as { id: string; branch_id: string | null; monthly_income: number | string | null } | undefined;
    if (!customer) throw new ApiError(404, "MFI_CUSTOMER_NOT_FOUND", "Active customer was not found in this organization.");
    const product = await loadProduct(sql, productId, organizationId);
    if (!product) throw new ApiError(404, "MFI_LOAN_PRODUCT_NOT_FOUND", "Loan product was not found in this organization.");
    if (product.active === false && productId !== String(current.product_id)) {
      throw new ApiError(400, "MFI_LOAN_PRODUCT_INACTIVE", "Choose an active product for this application.");
    }
    const requestedAmount = body.requested_amount === undefined
      ? Number(current.requested_amount)
      : optionalNumber(body, "requested_amount", 1, 1_000_000_000_000);
    if (requestedAmount === undefined || requestedAmount === null) {
      throw new ApiError(400, "VALIDATION_ERROR", "requested_amount is required.");
    }
    assertRange(requestedAmount, Number(product.min_amount), Number(product.max_amount), "requested_amount");
    const termMonths = body.term_months === undefined
      ? Number(current.term_months)
      : optionalNumber(body, "term_months", 1, 360, true);
    if (termMonths === undefined || termMonths === null) {
      throw new ApiError(400, "VALIDATION_ERROR", "term_months is required.");
    }
    const interestMethod = validateInterestMethod(product.interest_method ?? "reducing_balance");
    const interestRate = Number(product.interest_rate ?? 0);
    const estimate = estimateMonthlyPayment(requestedAmount, interestRate, termMonths, interestMethod);
    const updates = {
      product_id: productId,
      requested_amount: requestedAmount,
      purpose: body.purpose === undefined ? current.purpose : optionalText(body, "purpose", 2000) ?? null,
      term_months: termMonths,
      interest_rate: interestRate,
      interest_method: interestMethod,
      debt_to_income: calculateDebtToIncome(estimate.monthlyPayment, customer.monthly_income),
    };
    const metadata = {
      changed_fields: Object.keys(body).filter((key) =>
        ["customer_id", "product_id", "requested_amount", "purpose", "term_months"].includes(key),
      ),
    };
    const rows = await sql`
      WITH updated AS (
        UPDATE mfi_loan_applications
        SET customer_id = ${customerId}, branch_id = ${customer.branch_id},
          product_id = ${updates.product_id}, requested_amount = ${updates.requested_amount},
          purpose = ${updates.purpose}, term_months = ${updates.term_months},
          interest_rate = ${updates.interest_rate}, interest_method = ${updates.interest_method},
          debt_to_income = ${updates.debt_to_income}, updated_at = NOW()
        WHERE id = ${id} AND organization_id = ${organizationId} AND status = 'draft'
        RETURNING *
      ),
      local_audit AS (
        INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${user.id}, 'mfi.loan_application_updated',
          'mfi_loan_applications', id, ${jsonMetadata(metadata)}::jsonb FROM updated
        RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'mfi', 'mfi.loan_application_updated',
          'mfi_loan_applications', id, ${jsonMetadata(metadata)}::jsonb, ${requestIp(c)} FROM updated
        RETURNING id
      )
      SELECT * FROM updated
    `;
    if (!rows[0]) {
      throw new ApiError(409, "MFI_LOAN_APPLICATION_NOT_DRAFT", "Only draft applications can be edited.");
    }
    return c.json({ application: rows[0] });
  },
);

// Link only approved collateral belonging to the same customer and organization.
loans.post(
  "/mfi/loan-applications/:id/link-collateral",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const body = await readJson(c);
    const collateralId = uuid(requiredString(body, "collateral_id", { max: 36 }), "collateral_id");
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const application = await loadApplication(sql, id, organizationId);
    if (!application) throw new ApiError(404, "MFI_LOAN_APPLICATION_NOT_FOUND", "Loan application was not found.");
    if (!["draft", "submitted"].includes(String(application.status))) {
      throw new ApiError(409, "MFI_LOAN_APPLICATION_COLLATERAL_LOCKED", "Collateral can only be linked to draft or submitted applications.");
    }
    const collateralRows = await sql`
      SELECT id FROM mfi_collateral
      WHERE id = ${collateralId}
        AND organization_id = ${organizationId}
        AND customer_id = ${application.customer_id}
        AND status = 'approved'
      LIMIT 1
    `;
    if (!collateralRows[0]) {
      throw new ApiError(400, "MFI_LOAN_COLLATERAL_INVALID", "Collateral must be approved and belong to this customer and organization.");
    }
    const metadata = jsonMetadata({ collateral_id: collateralId });
    try {
      const rows = await sql`
        WITH linked AS (
          INSERT INTO mfi_loan_application_collateral (application_id, collateral_id)
          SELECT a.id, collateral.id
          FROM mfi_loan_applications a
          JOIN mfi_collateral collateral
            ON collateral.id = ${collateralId}
            AND collateral.organization_id = a.organization_id
            AND collateral.customer_id = a.customer_id
            AND collateral.status = 'approved'
          WHERE a.id = ${id} AND a.organization_id = ${organizationId}
            AND a.status IN ('draft', 'submitted')
          RETURNING application_id
        ),
        updated AS (
          UPDATE mfi_loan_applications a
          SET total_collateral_value = (
                SELECT COALESCE(SUM(c.estimated_value), 0)
                FROM mfi_loan_application_collateral link
                JOIN mfi_collateral c ON c.id = link.collateral_id
                WHERE link.application_id = a.id
              ),
              total_collateral_score = (
                SELECT COALESCE(SUM(c.score), 0)
                FROM mfi_loan_application_collateral link
                JOIN mfi_collateral c ON c.id = link.collateral_id
                WHERE link.application_id = a.id
              ),
              updated_at = NOW()
          WHERE a.id = ${id} AND a.organization_id = ${organizationId}
            AND EXISTS (SELECT 1 FROM linked)
          RETURNING a.*
        ),
        local_audit AS (
          INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
          SELECT organization_id, ${user.id}, 'mfi.loan_application_collateral_linked',
            'mfi_loan_applications', id, ${metadata}::jsonb FROM updated
          RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
          SELECT ${user.id}, 'mfi', 'mfi.loan_application_collateral_linked',
            'mfi_loan_applications', id, ${metadata}::jsonb, ${requestIp(c)} FROM updated
          RETURNING id
        )
        SELECT * FROM updated
      `;
      if (!rows[0]) {
        throw new ApiError(409, "MFI_LOAN_COLLATERAL_ALREADY_LINKED", "Collateral could not be linked; it may already be attached.");
      }
      return c.json({ application: rows[0] });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, "MFI_LOAN_COLLATERAL_ALREADY_LINKED", "Collateral is already linked to this application.");
      }
      throw error;
    }
  },
);

loans.delete(
  "/mfi/loan-applications/:id/unlink-collateral/:collateralId",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const collateralId = uuid(c.req.param("collateralId"), "collateral_id");
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c));
    const metadata = jsonMetadata({ collateral_id: collateralId });
    const rows = await sql`
      WITH unlinked AS (
        DELETE FROM mfi_loan_application_collateral link
        USING mfi_loan_applications a
        WHERE link.application_id = a.id AND a.id = ${id}
          AND a.organization_id = ${organizationId}
          AND a.status IN ('draft', 'submitted')
          AND link.collateral_id = ${collateralId}
        RETURNING link.application_id
      ),
      updated AS (
        UPDATE mfi_loan_applications a
        SET total_collateral_value = (
              SELECT COALESCE(SUM(c.estimated_value), 0)
              FROM mfi_loan_application_collateral link
              JOIN mfi_collateral c ON c.id = link.collateral_id
              WHERE link.application_id = a.id
            ),
            total_collateral_score = (
              SELECT COALESCE(SUM(c.score), 0)
              FROM mfi_loan_application_collateral link
              JOIN mfi_collateral c ON c.id = link.collateral_id
              WHERE link.application_id = a.id
            ),
            updated_at = NOW()
        WHERE a.id = ${id} AND a.organization_id = ${organizationId}
          AND EXISTS (SELECT 1 FROM unlinked)
        RETURNING a.*
      ),
      local_audit AS (
        INSERT INTO mfi_audit (organization_id, actor_id, action, target_table, target_id, metadata)
        SELECT organization_id, ${user.id}, 'mfi.loan_application_collateral_unlinked',
          'mfi_loan_applications', id, ${metadata}::jsonb FROM updated
        RETURNING id
      ),
      platform_audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'mfi', 'mfi.loan_application_collateral_unlinked',
          'mfi_loan_applications', id, ${metadata}::jsonb, ${requestIp(c)} FROM updated
        RETURNING id
      )
      SELECT * FROM updated
    `;
    if (!rows[0]) {
      throw new ApiError(409, "MFI_LOAN_COLLATERAL_UNLINK_FAILED", "Collateral can only be unlinked from a draft or submitted application.");
    }
    return c.json({ application: rows[0] });
  },
);

loans.post(
  "/mfi/loan-applications/:id/submit",
  requireRole("loan_officer", "loan_manager", "mfi_admin"),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c));
    const application = await loadApplication(sql, id, organizationId);
    if (!application) throw new ApiError(404, "MFI_LOAN_APPLICATION_NOT_FOUND", "Loan application was not found.");
    if (application.status !== "draft") {
      throw new ApiError(409, "MFI_LOAN_APPLICATION_NOT_DRAFT", "Only draft applications can be submitted.");
    }
    const guarantorRows = await sql`
      SELECT COUNT(*)::int AS count
      FROM mfi_guarantors g
      JOIN mfi_customers customer ON customer.id = g.customer_id
      WHERE g.customer_id = ${application.customer_id}
        AND customer.organization_id = ${organizationId}
    `;
    const guarantorCount = Number(guarantorRows[0]?.count ?? 0);
    const linkedCount = await sql`
      SELECT COUNT(*)::int AS count
      FROM mfi_loan_application_collateral
      WHERE application_id = ${id}
    `;
    const linkedCollateralCount = Number(linkedCount[0]?.count ?? 0);
    if (application.requires_collateral && linkedCollateralCount < 1) {
      throw new ApiError(400, "MFI_LOAN_COLLATERAL_REQUIRED", "Link at least one approved collateral item before submitting.");
    }
    if (guarantorCount < Number(application.requires_guarantors ?? 0)) {
      throw new ApiError(400, "MFI_LOAN_GUARANTORS_REQUIRED", `This product requires ${application.requires_guarantors} customer guarantor(s).`);
    }
    if (
      application.min_collateral_value != null &&
      Number(application.total_collateral_value ?? 0) < Number(application.min_collateral_value)
    ) {
      throw new ApiError(400, "MFI_LOAN_COLLATERAL_VALUE_TOO_LOW", "Linked collateral does not meet the product's minimum value.");
    }
    const rows = await transitionApplication(sql, {
      id,
      organizationId,
      actorId: user.id,
      ip: requestIp(c),
      action: "mfi.loan_application_submitted",
      metadata: { status_from: "draft", status_to: "submitted" },
      allowedStatuses: ["draft"],
      toStatus: "submitted",
      notes: "Application submitted for manager review",
      updates: {
        submitted_by: user.id,
        submitted_at: new Date().toISOString(),
        reviewed_by: null,
        reviewed_at: null,
        review_notes: null,
        approved_amount: null,
        approved_by: null,
        approved_at: null,
        approval_notes: null,
        rejection_reason: null,
      },
    });
    if (!rows[0]) throw new ApiError(409, "MFI_LOAN_APPLICATION_NOT_DRAFT", "Only draft applications can be submitted.");
    return c.json({ application: rows[0] });
  },
);

loans.post(
  "/mfi/loan-applications/:id/review",
  requireRole(...MANAGER_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const application = await loadApplication(sql, id, organizationId);
    if (!application) throw new ApiError(404, "MFI_LOAN_APPLICATION_NOT_FOUND", "Loan application was not found.");
    const decision = requiredString(body, "decision", { max: 30 });
    if (!["approve", "reject", "request_changes"].includes(decision)) {
      throw new ApiError(400, "VALIDATION_ERROR", "decision must be approve, reject, or request_changes.");
    }
    const notes = optionalText(body, "notes", 2000) ?? null;
    const updates: Record<string, unknown> = {
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
      review_notes: notes,
    };
    let status: string;
    let action: string;
    let metadata: Record<string, unknown> = { decision, notes };
    if (decision === "approve") {
      const amount = body.approved_amount === undefined || body.approved_amount === null || body.approved_amount === ""
        ? Number(application.requested_amount)
        : optionalNumber(body, "approved_amount", 1, 1_000_000_000_000);
      if (amount === undefined || amount === null) {
        throw new ApiError(400, "VALIDATION_ERROR", "approved_amount must be a valid amount.");
      }
      if (amount > Number(application.requested_amount)) {
        throw new ApiError(400, "VALIDATION_ERROR", "approved_amount cannot exceed requested_amount.");
      }
      if (amount < Number(application.product_min_amount ?? 0) || amount > Number(application.product_max_amount ?? 1_000_000_000_000)) {
        throw new ApiError(400, "VALIDATION_ERROR", "approved_amount must be within the product amount range.");
      }
      const threshold = Number(application.director_approval_threshold ?? 2_000_000);
      status = amount > threshold ? "pending_director" : "approved";
      updates.approved_amount = amount;
      if (status === "approved") {
        updates.approved_by = user.id;
        updates.approved_at = new Date().toISOString();
        updates.approval_notes = notes;
      }
      metadata = { ...metadata, approved_amount: amount, director_threshold: threshold };
      action = status === "approved"
        ? "mfi.loan_application_approved_by_manager"
        : "mfi.loan_application_sent_to_director";
    } else if (decision === "reject") {
      status = "rejected";
      updates.rejection_reason = notes;
      action = "mfi.loan_application_rejected";
    } else {
      status = "changes_requested";
      action = "mfi.loan_application_changes_requested";
    }
    metadata = { ...metadata, status_from: "submitted", status_to: status };
    const rows = await transitionApplication(sql, {
      id,
      organizationId,
      actorId: user.id,
      ip: requestIp(c),
      action,
      metadata,
      allowedStatuses: ["submitted"],
      toStatus: status,
      notes,
      updates,
    });
    if (!rows[0]) throw new ApiError(409, "MFI_LOAN_APPLICATION_NOT_SUBMITTED", "Only submitted applications can be reviewed.");
    return c.json({ application: rows[0] });
  },
);

loans.post(
  "/mfi/loan-applications/:id/director-approve",
  requireRole("loan_director", "mfi_admin"),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const application = await loadApplication(sql, id, organizationId);
    if (!application) throw new ApiError(404, "MFI_LOAN_APPLICATION_NOT_FOUND", "Loan application was not found.");
    const notes = optionalText(body, "notes", 2000) ?? null;
    const decision = body.decision === undefined ? "approve" : requiredString(body, "decision", { max: 30 });
    if (!["approve", "reject"].includes(decision)) {
      throw new ApiError(400, "VALIDATION_ERROR", "Director decision must be approve or reject.");
    }
    let status: string;
    let action: string;
    const updates: Record<string, unknown> = {
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
      review_notes: notes,
    };
    let metadata: Record<string, unknown> = { decision, notes, status_from: "pending_director" };
    if (decision === "approve") {
      const amount = optionalNumber(body, "approved_amount", 1, 1_000_000_000_000);
      if (amount === undefined || amount === null) {
        throw new ApiError(400, "VALIDATION_ERROR", "approved_amount is required for director approval.");
      }
      if (amount > Number(application.requested_amount)) {
        throw new ApiError(400, "VALIDATION_ERROR", "approved_amount cannot exceed requested_amount.");
      }
      if (amount < Number(application.product_min_amount ?? 0) || amount > Number(application.product_max_amount ?? 1_000_000_000_000)) {
        throw new ApiError(400, "VALIDATION_ERROR", "approved_amount must be within the product amount range.");
      }
      status = "approved";
      action = "mfi.loan_application_approved_by_director";
      updates.approved_amount = amount;
      updates.approved_by = user.id;
      updates.approved_at = new Date().toISOString();
      updates.approval_notes = notes;
      metadata = { ...metadata, approved_amount: amount, status_to: status };
    } else {
      status = "rejected";
      action = "mfi.loan_application_rejected_by_director";
      updates.rejection_reason = notes;
      metadata = { ...metadata, status_to: status };
    }
    const rows = await transitionApplication(sql, {
      id,
      organizationId,
      actorId: user.id,
      ip: requestIp(c),
      action,
      metadata,
      allowedStatuses: ["pending_director"],
      toStatus: status,
      notes,
      updates,
    });
    if (!rows[0]) throw new ApiError(409, "MFI_LOAN_APPLICATION_NOT_PENDING_DIRECTOR", "Only applications awaiting director approval can be decided.");
    return c.json({ application: rows[0] });
  },
);

loans.post(
  "/mfi/loan-applications/:id/cancel",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const application = await loadApplication(sql, id, organizationId);
    if (!application) throw new ApiError(404, "MFI_LOAN_APPLICATION_NOT_FOUND", "Loan application was not found.");
    const isManager = MANAGER_ROLES.includes(user.role as (typeof MANAGER_ROLES)[number]);
    if (application.created_by !== user.id && !isManager) {
      throw new ApiError(403, "MFI_LOAN_APPLICATION_CANCEL_FORBIDDEN", "Only the application owner or a loan manager may cancel it.");
    }
    const notes = optionalText(body, "notes", 2000) ?? null;
    const rows = await transitionApplication(sql, {
      id,
      organizationId,
      actorId: user.id,
      ip: requestIp(c),
      action: "mfi.loan_application_cancelled",
      metadata: { status_from: application.status, status_to: "cancelled", notes },
      allowedStatuses: ["draft", "submitted", "pending_director", "changes_requested"],
      toStatus: "cancelled",
      notes,
    });
    if (!rows[0]) throw new ApiError(409, "MFI_LOAN_APPLICATION_CANNOT_CANCEL", "This application can no longer be cancelled.");
    return c.json({ application: rows[0] });
  },
);

// A rejected application may be reopened by a manager; the owner can reopen a
// changes-requested application so that the draft-only edit flow remains usable.
loans.post(
  "/mfi/loan-applications/:id/reopen",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const id = uuid(c.req.param("id"));
    const body = await readJson(c);
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c, body));
    const application = await loadApplication(sql, id, organizationId);
    if (!application) throw new ApiError(404, "MFI_LOAN_APPLICATION_NOT_FOUND", "Loan application was not found.");
    const isManager = MANAGER_ROLES.includes(user.role as (typeof MANAGER_ROLES)[number]);
    const canReopenRejected = application.status === "rejected" && isManager;
    const canReopenChanges = application.status === "changes_requested" &&
      (application.created_by === user.id || isManager);
    if (!canReopenRejected && !canReopenChanges) {
      throw new ApiError(403, "MFI_LOAN_APPLICATION_REOPEN_FORBIDDEN", "A manager can reopen rejected applications; owners or managers can reopen applications with requested changes.");
    }
    const notes = optionalText(body, "notes", 2000) ?? null;
    const rows = await transitionApplication(sql, {
      id,
      organizationId,
      actorId: user.id,
      ip: requestIp(c),
      action: "mfi.loan_application_reopened",
      metadata: { status_from: application.status, status_to: "draft", notes },
      allowedStatuses: [String(application.status)],
      toStatus: "draft",
      notes,
    });
    if (!rows[0]) throw new ApiError(409, "MFI_LOAN_APPLICATION_CANNOT_REOPEN", "This application can no longer be reopened.");
    return c.json({ application: rows[0] });
  },
);

loans.get(
  "/mfi/loans/stats",
  requireRole(...ACCESS_ROLES),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const organizationId = await organizationForUser(sql, user, requestedOrganizationId(c));
    const rows = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('submitted', 'pending_director', 'changes_requested'))::int AS pending_applications,
        COUNT(*) FILTER (
          WHERE status = 'approved' AND approved_at >= date_trunc('month', NOW())
        )::int AS approved_this_month,
        COUNT(*) FILTER (
          WHERE status = 'rejected' AND reviewed_at >= date_trunc('month', NOW())
        )::int AS rejected_this_month,
        COALESCE(SUM(requested_amount) FILTER (
          WHERE status IN ('submitted', 'pending_director', 'changes_requested')
        ), 0) AS total_pipeline_value,
        COALESCE(AVG(COALESCE(approved_amount, requested_amount)) FILTER (
          WHERE status NOT IN ('draft', 'cancelled')
        ), 0) AS avg_ticket_size
      FROM mfi_loan_applications
      WHERE organization_id = ${organizationId}
    `;
    const portfolioRows = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('active', 'past_due', 'defaulted'))::int AS active_loans,
        COUNT(*) FILTER (WHERE status = 'defaulted')::int AS defaulted_count,
        COALESCE(SUM(principal), 0) AS total_disbursed,
        COALESCE(SUM(outstanding_balance), 0) AS total_outstanding,
        COALESCE(SUM(principal) FILTER (
          WHERE disbursed_at >= date_trunc('month', NOW())
        ), 0) AS disbursed_this_month,
        COALESCE((
          SELECT SUM(payment.amount)
          FROM mfi_loan_payments payment
          WHERE payment.organization_id = ${organizationId}
            AND payment.reversed_at IS NULL
            AND payment.paid_at >= date_trunc('month', NOW())
        ), 0) AS collected_this_month,
        COALESCE((
          SELECT SUM(payment.amount)
          FROM mfi_loan_payments payment
          WHERE payment.organization_id = ${organizationId}
            AND payment.reversed_at IS NULL
            AND (payment.paid_at AT TIME ZONE 'Africa/Kampala')::date =
              (NOW() AT TIME ZONE 'Africa/Kampala')::date
        ), 0) AS collected_today,
        COALESCE((
          SELECT SUM(GREATEST(0, schedule.principal_due - schedule.principal_paid)
            + GREATEST(0, schedule.interest_due - schedule.interest_paid)
            + GREATEST(0, schedule.fees_due - schedule.fees_paid)
            + GREATEST(0, schedule.late_fee_due - schedule.late_fee_paid))
          FROM mfi_loan_schedules schedule
          JOIN mfi_loans scheduled_loan ON scheduled_loan.id = schedule.loan_id
          WHERE scheduled_loan.organization_id = ${organizationId}
            AND schedule.status = 'overdue'
            AND schedule.due_date < CURRENT_DATE
        ), 0) AS overdue_amount,
        (
          SELECT COUNT(DISTINCT loan.id)::int
          FROM mfi_loans loan
          JOIN mfi_loan_schedules schedule ON schedule.loan_id = loan.id
          WHERE loan.organization_id = ${organizationId}
            AND schedule.status = 'overdue'
            AND schedule.due_date < CURRENT_DATE
        ) AS overdue_count,
        COALESCE((
          SELECT SUM(GREATEST(0, schedule.principal_due - schedule.principal_paid)
            + GREATEST(0, schedule.interest_due - schedule.interest_paid)
            + GREATEST(0, schedule.fees_due - schedule.fees_paid)
            + GREATEST(0, schedule.late_fee_due - schedule.late_fee_paid))
          FROM mfi_loan_schedules schedule
          JOIN mfi_loans scheduled_loan ON scheduled_loan.id = schedule.loan_id
          WHERE scheduled_loan.organization_id = ${organizationId}
            AND schedule.status <> 'paid'
            AND schedule.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
        ), 0) AS due_next_7_days
      FROM mfi_loans
      WHERE organization_id = ${organizationId}
    `;
    const applicationStats = rows[0] ?? {
      pending_applications: 0,
      approved_this_month: 0,
      rejected_this_month: 0,
      total_pipeline_value: 0,
      avg_ticket_size: 0,
    };
    const portfolioStats = portfolioRows[0] ?? {
      active_loans: 0,
      defaulted_count: 0,
      total_disbursed: 0,
      total_outstanding: 0,
      disbursed_this_month: 0,
      collected_this_month: 0,
      collected_today: 0,
      overdue_amount: 0,
      overdue_count: 0,
      due_next_7_days: 0,
    };
    const activeLoanCount = Number(portfolioStats.active_loans ?? 0);
    const overdueLoanCount = Number(portfolioStats.overdue_count ?? 0);
    return c.json({
      stats: {
        ...applicationStats,
        ...portfolioStats,
        overdue_percentage: activeLoanCount > 0
          ? Math.round((overdueLoanCount / activeLoanCount) * 1000) / 10
          : 0,
      },
    });
  },
);

export default loans;
