import { Hono } from "hono";
import { ApiError, getDb, isUniqueViolation } from "../db.js";
import { hashPassword, requireRole } from "../auth.js";
import { sendEmail, welcomeEmailTemplate } from "../email.js";
import { parseLimit, readJson, validEmail } from "../http.js";
import {
  calculateInsurancePortionCents,
} from "../clinic-billing-domain.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";
import {
  assertAllowedKeys,
  centsDecimal,
  coverageBasisPoints,
  dateValue,
  lineTotalCents,
  moneyCents,
  optionalText,
  optionalUuid,
  parseInvoiceItems,
  pathUuid,
  quantityValue,
  requiredText,
  type BillingItemInput,
} from "./clinic-billing-shared.js";

type Sql = ReturnType<typeof getDb>;
type OrganizationResolver = (
  sql: Sql,
  user: AuthenticatedUser,
  requestedId?: string,
) => Promise<string>;
type RequestIp = (c: { req: { header(name: string): string | undefined } }) => string | null;

interface ClinicBillingHelpers {
  organizationForRequest: OrganizationResolver;
  requestIp: RequestIp;
}

const BILLING_ROLES = ["clinic_admin", "receptionist", "nurse"] as const;
const PROVIDER_READ_ROLES = ["clinic_admin", "receptionist", "nurse"] as const;

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be true or false.`);
  }
  return value;
}

function normalizeCode(value: unknown, field: string, max = 80): string {
  return requiredText(value, field, max).toUpperCase();
}

function moneyStringFromDb(value: unknown): string {
  const cents = moneyCents(String(value ?? "0"), "amount");
  return centsDecimal(cents);
}

async function prepareItems(
  sql: Sql,
  organizationId: string,
  patientId: string,
  rawItems: unknown,
): Promise<{ items: BillingItemInput[]; subtotalCents: bigint }> {
  const parsed = parseInvoiceItems(rawItems);
  const items: BillingItemInput[] = [];
  let subtotalCents = 0n;

  for (const original of parsed.items) {
    let item = original;
    if (original.item_type === "service" && original.reference_id) {
      const rows = await sql`
        SELECT name, price
        FROM clinic_services
        WHERE id = ${original.reference_id}
          AND organization_id = ${organizationId}
          AND active IS TRUE
        LIMIT 1
      `;
      const service = rows[0] as { name: string; price: string | number } | undefined;
      if (!service) {
        throw new ApiError(400, "INVALID_INVOICE_REFERENCE", "The selected service is not active in this clinic.");
      }
      const price = moneyStringFromDb(service.price);
      const totalCents = lineTotalCents(moneyCents(price, "unit_price"), original.quantity);
      item = {
        ...original,
        description: service.name,
        unit_price: price,
        total: centsDecimal(totalCents),
      };
    } else if (original.item_type === "prescription" && original.reference_id) {
      const rows = await sql`
        SELECT i.medicine_name, i.dosage, i.quantity,
          m.selling_price
        FROM clinic_prescription_items i
        JOIN clinic_prescriptions p ON p.id = i.prescription_id
        LEFT JOIN clinic_medicines m ON m.id = i.medicine_id
        WHERE i.id = ${original.reference_id}
          AND p.organization_id = ${organizationId}
          AND p.patient_id = ${patientId}
          AND p.status <> 'cancelled'
        LIMIT 1
      `;
      const prescribed = rows[0] as {
        medicine_name: string;
        dosage: string;
        quantity: number;
        selling_price: string | number | null;
      } | undefined;
      if (!prescribed) {
        throw new ApiError(400, "INVALID_INVOICE_REFERENCE", "The prescription item does not belong to this patient.");
      }
      const duplicateRows = await sql`
        SELECT 1
        FROM clinic_invoice_items ii
        JOIN clinic_invoices invoice ON invoice.id = ii.invoice_id
        WHERE ii.reference_id = ${original.reference_id}
          AND invoice.organization_id = ${organizationId}
          AND invoice.status <> 'cancelled'
        LIMIT 1
      `;
      if (duplicateRows[0]) {
        throw new ApiError(409, "PRESCRIPTION_ALREADY_INVOICED", "This prescription item is already included on an invoice.");
      }
      const price = prescribed.selling_price == null
        ? original.unit_price
        : moneyStringFromDb(prescribed.selling_price);
      const description = `${prescribed.medicine_name} — ${prescribed.dosage}`;
      const totalCents = lineTotalCents(moneyCents(price, "unit_price"), original.quantity);
      item = {
        ...original,
        description,
        unit_price: price,
        total: centsDecimal(totalCents),
      };
    }

    items.push(item);
    subtotalCents += moneyCents(item.total, "item total");
  }

  return { items, subtotalCents };
}

export function createClinicBillingRoutes(helpers: ClinicBillingHelpers) {
  const billing = new Hono<AppEnv>();

  billing.get(
    "/clinic/services",
    requireRole("clinic_admin", "doctor", "nurse", "receptionist", "pharmacist"),
    async (c) => {
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        c.get("user"),
        c.req.query("organization_id"),
      );
      const includeInactive = c.req.query("include_inactive") === "true" &&
        c.get("user").role === "clinic_admin";
      const rows = await sql`
        SELECT id, organization_id, code, name, category, price, active, created_at
        FROM clinic_services
        WHERE organization_id = ${organizationId}
          AND (${includeInactive} OR active IS TRUE)
        ORDER BY active DESC, name ASC
        LIMIT 500
      `;
      return c.json({ services: rows });
    },
  );

  billing.post(
    "/clinic/services",
    requireRole("clinic_admin"),
    async (c) => {
      const body = await readJson(c);
      assertAllowedKeys(body, ["code", "name", "category", "price"]);
      const code = normalizeCode(body.code, "code");
      const name = requiredText(body.name, "name", 160);
      const category = optionalText(body.category, "category", 80) ?? null;
      const price = centsDecimal(moneyCents(body.price ?? 0, "price"));
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
          WITH created AS (
            INSERT INTO clinic_services (organization_id, code, name, category, price)
            VALUES (${organizationId}, ${code}, ${name}, ${category}, ${price})
            RETURNING *
          ),
          local_audit AS (
            INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
            SELECT organization_id, ${actor.id}, 'clinic.service_created',
              'clinic_services', id, jsonb_build_object('code', code, 'price', price)
            FROM created RETURNING id
          ),
          platform_audit AS (
            INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
            SELECT ${actor.id}, 'clinic', 'clinic.service_created',
              'clinic_services', id, jsonb_build_object('code', code, 'price', price), ${ip}
            FROM created RETURNING id
          )
          SELECT * FROM created
        `;
        return c.json({ service: rows[0] }, 201);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(409, "SERVICE_CODE_IN_USE", "A service with this code already exists.");
        }
        throw error;
      }
    },
  );

  billing.patch(
    "/clinic/services/:id",
    requireRole("clinic_admin"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const body = await readJson(c);
      assertAllowedKeys(body, ["code", "name", "category", "price", "active"]);
      const code = body.code === undefined ? undefined : normalizeCode(body.code, "code");
      const name = body.name === undefined ? undefined : requiredText(body.name, "name", 160);
      const category = optionalText(body.category, "category", 80);
      const price = body.price === undefined ? undefined : centsDecimal(moneyCents(body.price, "price"));
      const active = optionalBoolean(body.active, "active");
      const fields = Object.keys(body);
      if (!fields.length) {
        throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one service field to update.");
      }
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
          WITH updated AS (
            UPDATE clinic_services
            SET code = CASE WHEN ${code !== undefined} THEN ${code ?? null} ELSE code END,
              name = CASE WHEN ${name !== undefined} THEN ${name ?? null} ELSE name END,
              category = CASE WHEN ${category !== undefined} THEN ${category ?? null} ELSE category END,
              price = CASE WHEN ${price !== undefined} THEN ${price ?? null}::numeric ELSE price END,
              active = CASE WHEN ${active !== undefined} THEN ${active ?? null} ELSE active END
            WHERE id = ${id} AND organization_id = ${organizationId}
            RETURNING *
          ),
          local_audit AS (
            INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
            SELECT organization_id, ${actor.id}, 'clinic.service_updated',
              'clinic_services', id, jsonb_build_object('fields', ${JSON.stringify(fields)}::jsonb)
            FROM updated RETURNING id
          ),
          platform_audit AS (
            INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
            SELECT ${actor.id}, 'clinic', 'clinic.service_updated',
              'clinic_services', id, jsonb_build_object('fields', ${JSON.stringify(fields)}::jsonb), ${ip}
            FROM updated RETURNING id
          )
          SELECT * FROM updated
        `;
        if (!rows[0]) throw new ApiError(404, "SERVICE_NOT_FOUND", "Clinic service was not found.");
        return c.json({ service: rows[0] });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(409, "SERVICE_CODE_IN_USE", "A service with this code already exists.");
        }
        throw error;
      }
    },
  );

  billing.delete(
    "/clinic/services/:id",
    requireRole("clinic_admin"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        actor,
        c.req.query("organization_id"),
      );
      const ip = helpers.requestIp(c);
      const rows = await sql`
        WITH deactivated AS (
          UPDATE clinic_services
          SET active = FALSE
          WHERE id = ${id} AND organization_id = ${organizationId} AND active IS TRUE
          RETURNING *
        ),
        local_audit AS (
          INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
          SELECT organization_id, ${actor.id}, 'clinic.service_deactivated',
            'clinic_services', id, '{}'::jsonb
          FROM deactivated RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
          SELECT ${actor.id}, 'clinic', 'clinic.service_deactivated',
            'clinic_services', id, '{}'::jsonb, ${ip}
          FROM deactivated RETURNING id
        )
        SELECT * FROM deactivated
      `;
      if (!rows[0]) throw new ApiError(404, "SERVICE_NOT_FOUND", "Active clinic service was not found.");
      return c.json({ service: rows[0] });
    },
  );

  billing.get(
    "/clinic/insurance-providers",
    requireRole(...PROVIDER_READ_ROLES),
    async (c) => {
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        c.get("user"),
        c.req.query("organization_id"),
      );
      const includeInactive = c.req.query("include_inactive") === "true" &&
        c.get("user").role === "clinic_admin";
      const rows = await sql`
        SELECT id, organization_id, code, name, contact_person, phone, email,
          address, coverage_percent, active, created_at
        FROM clinic_insurance_providers
        WHERE organization_id = ${organizationId}
          AND (${includeInactive} OR active IS TRUE)
        ORDER BY active DESC, name ASC
        LIMIT 500
      `;
      return c.json({ providers: rows });
    },
  );

  billing.post(
    "/clinic/insurance-providers",
    requireRole("clinic_admin"),
    async (c) => {
      const body = await readJson(c);
      assertAllowedKeys(body, [
        "code", "name", "contact_person", "phone", "email", "address", "coverage_percent",
      ]);
      const code = optionalText(body.code, "code", 80)?.toUpperCase() ?? null;
      const name = requiredText(body.name, "name", 160);
      const contactPerson = optionalText(body.contact_person, "contact_person", 120) ?? null;
      const phone = optionalText(body.phone, "phone", 40) ?? null;
      const email = optionalText(body.email, "email", 254)?.toLowerCase() ?? null;
      if (email && !validEmail(email)) {
        throw new ApiError(400, "VALIDATION_ERROR", "email must be a valid email address.");
      }
      const address = optionalText(body.address, "address", 500) ?? null;
      const coverage = body.coverage_percent === undefined
        ? "80.00"
        : centsDecimal(coverageBasisPoints(body.coverage_percent));
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
          WITH created AS (
            INSERT INTO clinic_insurance_providers (
              organization_id, code, name, contact_person, phone, email, address, coverage_percent
            )
            VALUES (
              ${organizationId}, ${code}, ${name}, ${contactPerson}, ${phone}, ${email},
              ${address}, ${coverage}::numeric
            )
            RETURNING *
          ),
          local_audit AS (
            INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
            SELECT organization_id, ${actor.id}, 'clinic.insurance_provider_created',
              'clinic_insurance_providers', id,
              jsonb_build_object('code', code, 'coverage_percent', coverage_percent)
            FROM created RETURNING id
          ),
          platform_audit AS (
            INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
            SELECT ${actor.id}, 'clinic', 'clinic.insurance_provider_created',
              'clinic_insurance_providers', id,
              jsonb_build_object('code', code, 'coverage_percent', coverage_percent), ${ip}
            FROM created RETURNING id
          )
          SELECT * FROM created
        `;
        return c.json({ provider: rows[0] }, 201);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(409, "INSURANCE_PROVIDER_CODE_IN_USE", "A provider with this code already exists.");
        }
        throw error;
      }
    },
  );

  billing.patch(
    "/clinic/insurance-providers/:id",
    requireRole("clinic_admin"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const body = await readJson(c);
      assertAllowedKeys(body, [
        "code", "name", "contact_person", "phone", "email", "address", "coverage_percent", "active",
      ]);
      const code = optionalText(body.code, "code", 80);
      const name = body.name === undefined ? undefined : requiredText(body.name, "name", 160);
      const contactPerson = optionalText(body.contact_person, "contact_person", 120);
      const phone = optionalText(body.phone, "phone", 40);
      const email = optionalText(body.email, "email", 254);
      if (email && !validEmail(email)) {
        throw new ApiError(400, "VALIDATION_ERROR", "email must be a valid email address.");
      }
      const address = optionalText(body.address, "address", 500);
      const coverage = body.coverage_percent === undefined
        ? undefined
        : centsDecimal(coverageBasisPoints(body.coverage_percent));
      const active = optionalBoolean(body.active, "active");
      const fields = Object.keys(body);
      if (!fields.length) {
        throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one provider field to update.");
      }
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
          WITH updated AS (
            UPDATE clinic_insurance_providers
            SET code = CASE WHEN ${code !== undefined} THEN ${code?.toUpperCase() ?? null} ELSE code END,
              name = CASE WHEN ${name !== undefined} THEN ${name ?? null} ELSE name END,
              contact_person = CASE WHEN ${contactPerson !== undefined} THEN ${contactPerson ?? null} ELSE contact_person END,
              phone = CASE WHEN ${phone !== undefined} THEN ${phone ?? null} ELSE phone END,
              email = CASE WHEN ${email !== undefined} THEN ${email?.toLowerCase() ?? null} ELSE email END,
              address = CASE WHEN ${address !== undefined} THEN ${address ?? null} ELSE address END,
              coverage_percent = CASE WHEN ${coverage !== undefined} THEN ${coverage ?? null}::numeric ELSE coverage_percent END,
              active = CASE WHEN ${active !== undefined} THEN ${active ?? null} ELSE active END
            WHERE id = ${id} AND organization_id = ${organizationId}
            RETURNING *
          ),
          local_audit AS (
            INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
            SELECT organization_id, ${actor.id}, 'clinic.insurance_provider_updated',
              'clinic_insurance_providers', id,
              jsonb_build_object('fields', ${JSON.stringify(fields)}::jsonb)
            FROM updated RETURNING id
          ),
          platform_audit AS (
            INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
            SELECT ${actor.id}, 'clinic', 'clinic.insurance_provider_updated',
              'clinic_insurance_providers', id,
              jsonb_build_object('fields', ${JSON.stringify(fields)}::jsonb), ${ip}
            FROM updated RETURNING id
          )
          SELECT * FROM updated
        `;
        if (!rows[0]) throw new ApiError(404, "INSURANCE_PROVIDER_NOT_FOUND", "Insurance provider was not found.");
        return c.json({ provider: rows[0] });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(409, "INSURANCE_PROVIDER_CODE_IN_USE", "A provider with this code already exists.");
        }
        throw error;
      }
    },
  );

  billing.delete(
    "/clinic/insurance-providers/:id",
    requireRole("clinic_admin"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        actor,
        c.req.query("organization_id"),
      );
      const ip = helpers.requestIp(c);
      const rows = await sql`
        WITH deactivated AS (
          UPDATE clinic_insurance_providers
          SET active = FALSE
          WHERE id = ${id} AND organization_id = ${organizationId} AND active IS TRUE
          RETURNING *
        ),
        local_audit AS (
          INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
          SELECT organization_id, ${actor.id}, 'clinic.insurance_provider_deactivated',
            'clinic_insurance_providers', id, '{}'::jsonb
          FROM deactivated RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
          SELECT ${actor.id}, 'clinic', 'clinic.insurance_provider_deactivated',
            'clinic_insurance_providers', id, '{}'::jsonb, ${ip}
          FROM deactivated RETURNING id
        )
        SELECT * FROM deactivated
      `;
      if (!rows[0]) {
        throw new ApiError(404, "INSURANCE_PROVIDER_NOT_FOUND", "Active insurance provider was not found.");
      }
      return c.json({ provider: rows[0] });
    },
  );

  billing.get(
    "/clinic/patients/:id/insurance",
    requireRole(...PROVIDER_READ_ROLES),
    async (c) => {
      const patientId = pathUuid(c.req.param("id"), "patient_id");
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        c.get("user"),
        c.req.query("organization_id"),
      );
      const rows = await sql`
        SELECT p.id AS patient_id, p.insurance_provider_id, p.insurance_member_number,
          p.insurance_valid_until, provider.name AS provider_name,
          provider.coverage_percent, provider.active AS provider_active
        FROM clinic_patients p
        LEFT JOIN clinic_insurance_providers provider
          ON provider.id = p.insurance_provider_id
          AND provider.organization_id = p.organization_id
        WHERE p.id = ${patientId} AND p.organization_id = ${organizationId}
        LIMIT 1
      `;
      if (!rows[0]) throw new ApiError(404, "CLINIC_PATIENT_NOT_FOUND", "Clinic patient was not found.");
      return c.json({ insurance: rows[0] });
    },
  );

  billing.patch(
    "/clinic/patients/:id/insurance",
    requireRole("clinic_admin", "receptionist", "nurse"),
    async (c) => {
      const patientId = pathUuid(c.req.param("id"), "patient_id");
      const body = await readJson(c);
      assertAllowedKeys(body, ["provider_id", "member_number", "valid_until"]);
      const providerId = body.provider_id === undefined
        ? undefined
        : optionalUuid(body.provider_id, "provider_id");
      const memberNumber = optionalText(body.member_number, "member_number", 120);
      const validUntil = body.valid_until === undefined
        ? undefined
        : dateValue(body.valid_until, "valid_until");
      const fields = Object.keys(body);
      if (!fields.length) throw new ApiError(400, "VALIDATION_ERROR", "Provide an insurance field to update.");
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        actor,
        c.req.query("organization_id"),
      );
      if (providerId) {
        const providerRows = await sql`
          SELECT id FROM clinic_insurance_providers
          WHERE id = ${providerId} AND organization_id = ${organizationId} AND active IS TRUE
          LIMIT 1
        `;
        if (!providerRows[0]) {
          throw new ApiError(400, "INVALID_INSURANCE_PROVIDER", "Choose an active provider in this clinic.");
        }
      }
      const ip = helpers.requestIp(c);
      const rows = await sql`
        WITH updated AS (
          UPDATE clinic_patients
          SET insurance_provider_id = CASE WHEN ${providerId !== undefined} THEN ${providerId ?? null} ELSE insurance_provider_id END,
            insurance_member_number = CASE WHEN ${memberNumber !== undefined} THEN ${memberNumber ?? null} ELSE insurance_member_number END,
            insurance_valid_until = CASE WHEN ${validUntil !== undefined} THEN ${validUntil ?? null}::date ELSE insurance_valid_until END,
            updated_at = NOW()
          WHERE id = ${patientId} AND organization_id = ${organizationId}
          RETURNING *
        ),
        local_audit AS (
          INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
          SELECT organization_id, ${actor.id}, 'clinic.patient_insurance_updated',
            'clinic_patients', id, jsonb_build_object('fields', ${JSON.stringify(fields)}::jsonb)
          FROM updated RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
          SELECT ${actor.id}, 'clinic', 'clinic.patient_insurance_updated',
            'clinic_patients', id, jsonb_build_object('fields', ${JSON.stringify(fields)}::jsonb), ${ip}
          FROM updated RETURNING id
        )
        SELECT * FROM updated
      `;
      if (!rows[0]) throw new ApiError(404, "CLINIC_PATIENT_NOT_FOUND", "Clinic patient was not found.");
      return c.json({ patient: rows[0] });
    },
  );

  billing.post(
    "/clinic/patients/:id/create-portal-access",
    requireRole("clinic_admin", "receptionist"),
    async (c) => {
      const patientId = pathUuid(c.req.param("id"), "patient_id");
      const body = await readJson(c);
      assertAllowedKeys(body, ["email", "password"]);
      const email = requiredText(body.email, "email", 254).toLowerCase();
      if (!validEmail(email)) {
        throw new ApiError(400, "VALIDATION_ERROR", "email must be a valid email address.");
      }
      const password = requiredText(body.password, "password", 128);
      if (password.length < 8) {
        throw new ApiError(400, "VALIDATION_ERROR", "password must be at least 8 characters.");
      }
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        actor,
        c.req.query("organization_id"),
      );
      const patientRows = await sql`
        SELECT id, organization_id, first_name, last_name, phone, user_id, portal_enabled, status
        FROM clinic_patients
        WHERE id = ${patientId} AND organization_id = ${organizationId}
        LIMIT 1
      `;
      const patient = patientRows[0] as {
        id: string;
        first_name: string;
        last_name: string;
        phone: string | null;
        user_id: string | null;
        portal_enabled: boolean;
        status: string;
      } | undefined;
      if (!patient) throw new ApiError(404, "CLINIC_PATIENT_NOT_FOUND", "Clinic patient was not found.");
      if (patient.status !== "active") {
        throw new ApiError(409, "INACTIVE_PATIENT", "Portal access cannot be created for an inactive patient.");
      }
      if (patient.user_id || patient.portal_enabled) {
        throw new ApiError(409, "PORTAL_ALREADY_ENABLED", "This patient already has portal access.");
      }
      const passwordHash = await hashPassword(password);
      const ip = helpers.requestIp(c);
      const name = `${patient.first_name} ${patient.last_name}`.trim();
      let rows: Array<Record<string, unknown>>;
      try {
        rows = await sql`
          WITH created_user AS (
            INSERT INTO users (name, email, phone, password_hash, role, sector, waitlist)
            VALUES (${name}, ${email}, ${patient.phone}, ${passwordHash}, 'patient', 'clinic', FALSE)
            RETURNING id, name, email
          ),
          linked_patient AS (
            UPDATE clinic_patients p
            SET user_id = created_user.id,
              email = ${email},
              portal_enabled = TRUE,
              updated_at = NOW()
            FROM created_user
            WHERE p.id = ${patientId}
              AND p.organization_id = ${organizationId}
              AND p.user_id IS NULL
              AND p.portal_enabled IS FALSE
              AND p.status = 'active'
            RETURNING p.id, p.organization_id, p.user_id, p.first_name, p.last_name, p.email
          ),
          portal_log AS (
            INSERT INTO clinic_portal_log (patient_id, action, metadata)
            SELECT id, 'portal_access_created',
              jsonb_build_object('actor_id', ${actor.id}, 'email', email)
            FROM linked_patient RETURNING id
          ),
          local_audit AS (
            INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
            SELECT organization_id, ${actor.id}, 'clinic.patient_portal_enabled',
              'clinic_patients', id, jsonb_build_object('user_id', user_id, 'email', email)
            FROM linked_patient RETURNING id
          ),
          platform_audit AS (
            INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
            SELECT ${actor.id}, 'clinic', 'clinic.patient_portal_enabled',
              'clinic_patients', id, jsonb_build_object('user_id', user_id, 'email', email), ${ip}
            FROM linked_patient RETURNING id
          )
          SELECT linked_patient.*, created_user.email AS account_email
          FROM linked_patient
          JOIN created_user ON created_user.id = linked_patient.user_id
        `;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(409, "EMAIL_IN_USE", "That email is already linked to an APSHULE account or patient.");
        }
        throw error;
      }
      if (!rows[0]) {
        throw new ApiError(409, "PORTAL_ALREADY_ENABLED", "This patient already has portal access or is no longer active.");
      }
      const emailSent = await sendEmail(c.env, {
        to: email,
        subject: "Your APSHULE Clinic patient portal is ready",
        html: welcomeEmailTemplate(name, "Clinic patient", null, c.env.APP_URL),
      });
      return c.json({ user_id: rows[0].user_id, email, email_sent: emailSent }, 201);
    },
  );

  billing.get(
    "/clinic/invoices/suggestions",
    requireRole(...BILLING_ROLES),
    async (c) => {
      const visitId = pathUuid(c.req.query("visit_id") ?? "", "visit_id");
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        c.get("user"),
        c.req.query("organization_id"),
      );
      const rows = await sql`
        SELECT v.id AS visit_id, v.patient_id, v.branch_id, v.visit_number,
          COALESCE(settings.consultation_fee, 0)::numeric AS consultation_fee,
          (
            SELECT COALESCE(json_agg(json_build_object(
              'item_type', 'prescription',
              'description', concat_ws(' — ', item.medicine_name, item.dosage),
              'reference_id', item.id,
              'quantity', item.quantity,
              'unit_price', COALESCE(medicine.selling_price, 0)
            ) ORDER BY item.created_at), '[]'::json)
            FROM clinic_prescriptions rx
            JOIN clinic_prescription_items item ON item.prescription_id = rx.id
            LEFT JOIN clinic_medicines medicine ON medicine.id = item.medicine_id
            WHERE rx.organization_id = v.organization_id
              AND rx.patient_id = v.patient_id
              AND rx.visit_id = v.id
              AND rx.status <> 'cancelled'
          ) AS prescriptions
        FROM clinic_visits v
        LEFT JOIN clinic_settings settings ON settings.organization_id = v.organization_id
        WHERE v.id = ${visitId}
          AND v.organization_id = ${organizationId}
          AND v.deleted_at IS NULL
          AND v.status <> 'voided'
        LIMIT 1
      `;
      if (!rows[0]) throw new ApiError(404, "VISIT_NOT_FOUND", "Visit was not found in this clinic.");
      return c.json({ suggestions: rows[0] });
    },
  );

  billing.post(
    "/clinic/invoices",
    requireRole(...BILLING_ROLES),
    async (c) => {
      const body = await readJson(c);
      assertAllowedKeys(body, [
        "patient_id", "visit_id", "items", "discount", "due_date", "notes", "status",
      ]);
      const patientId = pathUuid(requiredText(body.patient_id, "patient_id", 36), "patient_id");
      const visitId = optionalUuid(body.visit_id, "visit_id");
      const discountCents = moneyCents(body.discount ?? 0, "discount");
      const dueDate = dateValue(body.due_date, "due_date");
      const notes = optionalText(body.notes, "notes", 4000) ?? null;
      const statusValue = body.status === undefined ? "issued" : body.status;
      if (statusValue !== "draft" && statusValue !== "issued") {
        throw new ApiError(400, "VALIDATION_ERROR", "status must be draft or issued.");
      }
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        actor,
        c.req.query("organization_id"),
      );
      const { items, subtotalCents } = await prepareItems(sql, organizationId, patientId, body.items);
      if (discountCents > subtotalCents) {
        throw new ApiError(400, "VALIDATION_ERROR", "discount cannot exceed the invoice subtotal.");
      }
      const totalCents = subtotalCents - discountCents;
      const patientRows = await sql`
        SELECT p.id, p.branch_id, p.insurance_provider_id,
          CASE
            WHEN provider.active IS TRUE
              AND (p.insurance_valid_until IS NULL
                OR p.insurance_valid_until >= (NOW() AT TIME ZONE 'Africa/Kampala')::date)
            THEN provider.coverage_percent
            ELSE 0
          END AS coverage_percent,
          COALESCE(settings.currency, 'UGX') AS currency
        FROM clinic_patients p
        LEFT JOIN clinic_insurance_providers provider
          ON provider.id = p.insurance_provider_id
          AND provider.organization_id = p.organization_id
        LEFT JOIN clinic_settings settings ON settings.organization_id = p.organization_id
        WHERE p.id = ${patientId}
          AND p.organization_id = ${organizationId}
          AND p.status = 'active'
        LIMIT 1
      `;
      const patient = patientRows[0] as {
        branch_id: string | null;
        insurance_provider_id: string | null;
        coverage_percent: string | number;
        currency: string;
      } | undefined;
      if (!patient) throw new ApiError(404, "CLINIC_PATIENT_NOT_FOUND", "Active clinic patient was not found.");

      let visitBranchId: string | null = null;
      if (visitId) {
        const visitRows = await sql`
          SELECT branch_id
          FROM clinic_visits
          WHERE id = ${visitId}
            AND organization_id = ${organizationId}
            AND patient_id = ${patientId}
            AND deleted_at IS NULL
            AND status <> 'voided'
          LIMIT 1
        `;
        if (!visitRows[0]) {
          throw new ApiError(400, "INVALID_VISIT", "The visit must belong to this patient and clinic.");
        }
        visitBranchId = (visitRows[0] as { branch_id: string | null }).branch_id;
      }
      const coverageBps = coverageBasisPoints(patient.coverage_percent ?? 0);
      const insuranceCents = calculateInsurancePortionCents(
        subtotalCents,
        totalCents,
        coverageBps,
      );
      const patientCents = totalCents - insuranceCents;
      const itemsJson = JSON.stringify(items);
      const ip = helpers.requestIp(c);
      const rows = await sql`
        WITH number_counter AS (
          INSERT INTO clinic_billing_number_counters (
            organization_id, period, number_type, last_value
          )
          VALUES (
            ${organizationId},
            to_char(NOW() AT TIME ZONE 'Africa/Kampala', 'YYYYMM'),
            'invoice',
            1
          )
          ON CONFLICT (organization_id, period, number_type)
          DO UPDATE SET last_value = clinic_billing_number_counters.last_value + 1
          RETURNING period, last_value
        ),
        target_patient AS MATERIALIZED (
          SELECT id, branch_id
          FROM clinic_patients
          WHERE id = ${patientId}
            AND organization_id = ${organizationId}
            AND status = 'active'
            AND (
              ${visitId === null}
              OR EXISTS (
                SELECT 1 FROM clinic_visits visit
                WHERE visit.id = ${visitId}
                  AND visit.organization_id = ${organizationId}
                  AND visit.patient_id = ${patientId}
                  AND visit.deleted_at IS NULL
                  AND visit.status <> 'voided'
              )
            )
        ),
        created AS (
          INSERT INTO clinic_invoices (
            organization_id, branch_id, patient_id, visit_id, insurance_provider_id,
            invoice_number, subtotal, discount, tax, total, insurance_covered,
            patient_portion, patient_portion_paid, insurance_portion_paid,
            amount_paid, balance_due, currency, status, due_date, notes, created_by
          )
          SELECT ${organizationId}, COALESCE(${visitBranchId}, target_patient.branch_id),
            ${patientId}, ${visitId}, ${patient.insurance_provider_id},
            'INV-' || number_counter.period || '-' || lpad(number_counter.last_value::text, 4, '0'),
            ${centsDecimal(subtotalCents)}::numeric,
            ${centsDecimal(discountCents)}::numeric,
            0,
            ${centsDecimal(totalCents)}::numeric,
            ${centsDecimal(insuranceCents)}::numeric,
            ${centsDecimal(patientCents)}::numeric,
            0, 0, 0, ${centsDecimal(totalCents)}::numeric,
            ${patient.currency || "UGX"}, ${statusValue}, ${dueDate}::date,
            ${notes}, ${actor.id}
          FROM number_counter
          CROSS JOIN target_patient
          RETURNING *
        ),
        inserted_items AS (
          INSERT INTO clinic_invoice_items (
            invoice_id, item_type, description, reference_id, quantity, unit_price, total
          )
          SELECT created.id, items.item_type, items.description, items.reference_id,
            items.quantity, items.unit_price, items.total
          FROM created
          CROSS JOIN jsonb_to_recordset(${itemsJson}::jsonb) AS items(
            item_type text, description text, reference_id uuid, quantity numeric,
            unit_price numeric, total numeric
          )
          RETURNING invoice_id
        ),
        local_audit AS (
          INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
          SELECT organization_id, ${actor.id}, 'clinic.invoice_created',
            'clinic_invoices', id,
            jsonb_build_object(
              'invoice_number', invoice_number,
              'status', status,
              'patient_portion', patient_portion,
              'insurance_portion', insurance_covered,
              'balance_due', balance_due
            )
          FROM created RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
          SELECT ${actor.id}, 'clinic', 'clinic.invoice_created',
            'clinic_invoices', id,
            jsonb_build_object('invoice_number', invoice_number, 'total', total), ${ip}
          FROM created RETURNING id
        )
        SELECT * FROM created
      `;
      if (!rows[0]) {
        throw new ApiError(409, "INVOICE_TARGET_CHANGED", "The patient or visit changed while creating the invoice. Retry.");
      }
      return c.json({ invoice: rows[0] }, 201);
    },
  );

  billing.get(
    "/clinic/invoices",
    requireRole(...BILLING_ROLES),
    async (c) => {
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        c.get("user"),
        c.req.query("organization_id"),
      );
      const status = c.req.query("status") || "all";
      if (status !== "all" && ![
        "draft", "issued", "partial", "patient_settled", "insurance_settled", "paid", "cancelled",
      ].includes(status)) {
        throw new ApiError(400, "VALIDATION_ERROR", "status is invalid.");
      }
      const patientId = optionalUuid(c.req.query("patient_id"), "patient_id");
      const from = dateValue(c.req.query("from"), "from");
      const to = dateValue(c.req.query("to"), "to");
      if (from && to && from > to) {
        throw new ApiError(400, "VALIDATION_ERROR", "from must be before or equal to to.");
      }
      const limit = parseLimit(c.req.query("limit"), 100);
      const rows = await sql`
        SELECT invoice.id, invoice.organization_id, invoice.branch_id, invoice.patient_id,
          invoice.visit_id, invoice.invoice_number, invoice.subtotal, invoice.discount,
          invoice.total, invoice.insurance_covered AS insurance_portion,
          invoice.patient_portion, invoice.patient_portion_paid,
          invoice.insurance_portion_paid, invoice.amount_paid, invoice.balance_due,
          invoice.currency, invoice.status, invoice.due_date, invoice.created_at,
          concat_ws(' ', patient.first_name, patient.last_name) AS patient_name,
          patient.patient_number,
          provider.name AS insurance_provider_name,
          claim.status AS claim_status
        FROM clinic_invoices invoice
        JOIN clinic_patients patient ON patient.id = invoice.patient_id
        LEFT JOIN clinic_insurance_providers provider ON provider.id = invoice.insurance_provider_id
        LEFT JOIN clinic_insurance_claims claim ON claim.invoice_id = invoice.id
        WHERE invoice.organization_id = ${organizationId}
          AND (${status === "all"} OR invoice.status = ${status})
          AND (${patientId === null} OR invoice.patient_id = ${patientId})
          AND (${from === null} OR (invoice.created_at AT TIME ZONE 'Africa/Kampala')::date >= ${from}::date)
          AND (${to === null} OR (invoice.created_at AT TIME ZONE 'Africa/Kampala')::date <= ${to}::date)
        ORDER BY invoice.created_at DESC
        LIMIT ${limit}
      `;
      return c.json({ invoices: rows });
    },
  );

  billing.get(
    "/clinic/invoices/:id",
    requireRole(...BILLING_ROLES),
    async (c) => {
      const invoiceId = pathUuid(c.req.param("id"), "invoice_id");
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        c.get("user"),
        c.req.query("organization_id"),
      );
      const invoiceRows = await sql`
        SELECT invoice.*, invoice.insurance_covered AS insurance_portion,
          concat_ws(' ', patient.first_name, patient.last_name) AS patient_name,
          patient.patient_number, patient.phone AS patient_phone, patient.email AS patient_email,
          provider.name AS insurance_provider_name, branch.name AS branch_name
        FROM clinic_invoices invoice
        JOIN clinic_patients patient ON patient.id = invoice.patient_id
        LEFT JOIN clinic_insurance_providers provider ON provider.id = invoice.insurance_provider_id
        LEFT JOIN clinic_branches branch ON branch.id = invoice.branch_id
        WHERE invoice.id = ${invoiceId} AND invoice.organization_id = ${organizationId}
        LIMIT 1
      `;
      const invoice = invoiceRows[0];
      if (!invoice) throw new ApiError(404, "INVOICE_NOT_FOUND", "Invoice was not found.");
      const items = await sql`
        SELECT id, item_type, description, reference_id, quantity, unit_price, total, created_at
        FROM clinic_invoice_items
        WHERE invoice_id = ${invoiceId}
        ORDER BY created_at, id
      `;
      const payments = await sql`
        SELECT id, receipt_number, amount, applied_amount, payment_method,
          payment_reference, paid_at, notes, reversed, reversed_at, reversal_reason
        FROM clinic_payments
        WHERE invoice_id = ${invoiceId} AND organization_id = ${organizationId}
        ORDER BY paid_at DESC, created_at DESC
      `;
      const claims = await sql`
        SELECT claim.id, claim.claim_number, claim.claim_amount, claim.approved_amount,
          claim.status, claim.submitted_at, claim.responded_at, claim.payment_received_at,
          claim.rejection_reason, provider.name AS provider_name
        FROM clinic_insurance_claims claim
        LEFT JOIN clinic_insurance_providers provider ON provider.id = claim.provider_id
        WHERE claim.invoice_id = ${invoiceId} AND claim.organization_id = ${organizationId}
        ORDER BY claim.created_at DESC
      `;
      return c.json({ invoice, items, payments, claims });
    },
  );

  billing.patch(
    "/clinic/invoices/:id",
    requireRole("clinic_admin"),
    async (c) => {
      const invoiceId = pathUuid(c.req.param("id"), "invoice_id");
      const body = await readJson(c);
      assertAllowedKeys(body, ["discount", "due_date", "notes", "status"]);
      const discountCents = body.discount === undefined
        ? undefined
        : moneyCents(body.discount, "discount");
      const dueDate = body.due_date === undefined
        ? undefined
        : dateValue(body.due_date, "due_date");
      const notes = optionalText(body.notes, "notes", 4000);
      const newStatus = body.status;
      if (newStatus !== undefined && newStatus !== "draft" && newStatus !== "issued") {
        throw new ApiError(400, "VALIDATION_ERROR", "status must be draft or issued.");
      }
      if (!Object.keys(body).length) {
        throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one invoice field to update.");
      }
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        actor,
        c.req.query("organization_id"),
      );
      const currentRows = await sql`
        SELECT invoice.*,
          CASE WHEN provider.active IS TRUE THEN provider.coverage_percent ELSE 0 END AS coverage_percent
        FROM clinic_invoices invoice
        LEFT JOIN clinic_insurance_providers provider
          ON provider.id = invoice.insurance_provider_id
          AND provider.organization_id = invoice.organization_id
        WHERE invoice.id = ${invoiceId} AND invoice.organization_id = ${organizationId}
        LIMIT 1
      `;
      const current = currentRows[0] as Record<string, unknown> | undefined;
      if (!current) throw new ApiError(404, "INVOICE_NOT_FOUND", "Invoice was not found.");
      if (["paid", "cancelled", "patient_settled", "insurance_settled", "partial"].includes(String(current.status))) {
        throw new ApiError(409, "INVOICE_LOCKED", "An invoice with payments or a final status cannot be edited.");
      }
      const oldPaid = moneyCents(String(current.amount_paid ?? "0"), "amount_paid");
      if (oldPaid > 0n) {
        throw new ApiError(409, "INVOICE_LOCKED", "Reverse the invoice payments before editing it.");
      }
      const subtotalCents = moneyCents(String(current.subtotal), "subtotal");
      const oldDiscountCents = moneyCents(String(current.discount), "discount");
      const newDiscount = discountCents ?? oldDiscountCents;
      if (newDiscount > subtotalCents) {
        throw new ApiError(400, "VALIDATION_ERROR", "discount cannot exceed the invoice subtotal.");
      }
      const taxCents = moneyCents(String(current.tax ?? "0"), "tax");
      const totalCents = subtotalCents - newDiscount + taxCents;
      const coverage = coverageBasisPoints(current.coverage_percent ?? 0);
      const insuranceCents = calculateInsurancePortionCents(
        subtotalCents,
        totalCents,
        coverage,
      );
      const patientCents = totalCents - insuranceCents;
      if (newStatus === "draft" && current.status === "issued") {
        throw new ApiError(409, "INVALID_INVOICE_TRANSITION", "An issued invoice cannot be returned to draft.");
      }
      const ip = helpers.requestIp(c);
      const rows = await sql`
        WITH updated AS (
          UPDATE clinic_invoices
          SET discount = ${centsDecimal(newDiscount)}::numeric,
            total = ${centsDecimal(totalCents)}::numeric,
            insurance_covered = ${centsDecimal(insuranceCents)}::numeric,
            patient_portion = ${centsDecimal(patientCents)}::numeric,
            balance_due = ${centsDecimal(totalCents)}::numeric,
            due_date = CASE WHEN ${dueDate !== undefined} THEN ${dueDate ?? null}::date ELSE due_date END,
            notes = CASE WHEN ${notes !== undefined} THEN ${notes ?? null} ELSE notes END,
            status = CASE WHEN ${newStatus !== undefined} THEN ${newStatus} ELSE status END,
            updated_at = NOW()
          WHERE id = ${invoiceId}
            AND organization_id = ${organizationId}
            AND amount_paid = 0
            AND status NOT IN ('paid', 'cancelled', 'partial', 'patient_settled', 'insurance_settled')
          RETURNING *
        ),
        local_audit AS (
          INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
          SELECT organization_id, ${actor.id}, 'clinic.invoice_updated',
            'clinic_invoices', id,
            jsonb_build_object('fields', ${JSON.stringify(Object.keys(body))}::jsonb)
          FROM updated RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
          SELECT ${actor.id}, 'clinic', 'clinic.invoice_updated',
            'clinic_invoices', id,
            jsonb_build_object('fields', ${JSON.stringify(Object.keys(body))}::jsonb), ${ip}
          FROM updated RETURNING id
        )
        SELECT * FROM updated
      `;
      if (!rows[0]) {
        throw new ApiError(409, "INVOICE_LOCKED", "Invoice changed or now has payments; reload before editing.");
      }
      return c.json({ invoice: rows[0] });
    },
  );

  billing.post(
    "/clinic/invoices/:id/cancel",
    requireRole("clinic_admin"),
    async (c) => {
      const invoiceId = pathUuid(c.req.param("id"), "invoice_id");
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        actor,
        c.req.query("organization_id"),
      );
      const ip = helpers.requestIp(c);
      const rows = await sql`
        WITH cancelled AS (
          UPDATE clinic_invoices invoice
          SET status = 'cancelled', updated_at = NOW()
          WHERE invoice.id = ${invoiceId}
            AND invoice.organization_id = ${organizationId}
            AND invoice.status NOT IN ('paid', 'cancelled')
            AND invoice.amount_paid = 0
            AND NOT EXISTS (
              SELECT 1 FROM clinic_insurance_claims claim
              WHERE claim.invoice_id = invoice.id
                AND claim.status NOT IN ('rejected')
            )
          RETURNING invoice.*
        ),
        local_audit AS (
          INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
          SELECT organization_id, ${actor.id}, 'clinic.invoice_cancelled',
            'clinic_invoices', id, jsonb_build_object('invoice_number', invoice_number)
          FROM cancelled RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
          SELECT ${actor.id}, 'clinic', 'clinic.invoice_cancelled',
            'clinic_invoices', id, jsonb_build_object('invoice_number', invoice_number), ${ip}
          FROM cancelled RETURNING id
        )
        SELECT * FROM cancelled
      `;
      if (!rows[0]) {
        throw new ApiError(409, "INVOICE_CANNOT_BE_CANCELLED", "Only invoices without payments or active claims can be cancelled.");
      }
      return c.json({ invoice: rows[0] });
    },
  );

  billing.get(
    "/clinic/billing/stats",
    requireRole(...BILLING_ROLES),
    async (c) => {
      const sql = getDb(c.env);
      const organizationId = await helpers.organizationForRequest(
        sql,
        c.get("user"),
        c.req.query("organization_id"),
      );
      const rows = await sql`
        SELECT
          (SELECT COUNT(*)::int FROM clinic_invoices invoice
            WHERE invoice.organization_id = ${organizationId}
              AND (invoice.created_at AT TIME ZONE 'Africa/Kampala')::date =
                (NOW() AT TIME ZONE 'Africa/Kampala')::date
              AND invoice.status <> 'cancelled') AS invoices_today,
          (SELECT COALESCE(SUM(payment.applied_amount), 0)::numeric
            FROM clinic_payments payment
            WHERE payment.organization_id = ${organizationId}
              AND payment.reversed IS FALSE
              AND (payment.paid_at AT TIME ZONE 'Africa/Kampala')::date =
                (NOW() AT TIME ZONE 'Africa/Kampala')::date) AS collected_today,
          (SELECT COALESCE(SUM(invoice.balance_due), 0)::numeric
            FROM clinic_invoices invoice
            WHERE invoice.organization_id = ${organizationId}
              AND invoice.status <> 'cancelled') AS outstanding_total,
          (SELECT COUNT(*)::int FROM clinic_insurance_claims claim
            WHERE claim.organization_id = ${organizationId}
              AND claim.status IN ('submitted', 'approved')) AS pending_claims,
          (SELECT COUNT(*)::int FROM clinic_insurance_claims claim
            WHERE claim.organization_id = ${organizationId}
              AND claim.status = 'paid') AS paid_claims
      `;
      return c.json({ stats: rows[0] ?? {} });
    },
  );

  return billing;
}
