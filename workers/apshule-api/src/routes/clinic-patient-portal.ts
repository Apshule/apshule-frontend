import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { authMiddleware } from "../auth.js";
import { ApiError, getDb } from "../db.js";
import { readJson } from "../http.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";
import {
  assertAllowedKeys,
  optionalText,
  requiredText,
} from "./clinic-billing-shared.js";

const portal = new Hono<AppEnv>();

const requireClinicPatient = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user.role !== "patient" || user.sector !== "clinic") {
    throw new ApiError(403, "CLINIC_PATIENT_REQUIRED", "This endpoint is for clinic patient accounts.");
  }
  await next();
});

portal.use("/clinic-patient/*", authMiddleware, requireClinicPatient);

async function linkedPatient(sql: ReturnType<typeof getDb>, user: AuthenticatedUser) {
  const rows = await sql`
    SELECT patient.id, patient.organization_id, patient.user_id,
      patient.first_name, patient.last_name, patient.phone, patient.email,
      patient.patient_number, patient.branch_id, patient.insurance_provider_id,
      patient.insurance_member_number, patient.insurance_valid_until,
      provider.name AS insurance_provider_name,
      provider.coverage_percent,
      organization.name AS organization_name,
      organization.logo_base64 AS organization_logo,
      organization.brand_color AS organization_brand_color,
      branch.name AS branch_name
    FROM clinic_patients patient
    JOIN clinic_organizations organization ON organization.id = patient.organization_id
    LEFT JOIN clinic_insurance_providers provider
      ON provider.id = patient.insurance_provider_id
      AND provider.organization_id = patient.organization_id
    LEFT JOIN clinic_branches branch ON branch.id = patient.branch_id
    WHERE patient.user_id = ${user.id}
      AND patient.portal_enabled IS TRUE
      AND patient.status = 'active'
    LIMIT 1
  `;
  if (!rows[0]) {
    throw new ApiError(404, "CLINIC_PATIENT_PORTAL_NOT_FOUND", "This account is not linked to an active clinic patient record.");
  }
  return rows[0] as Record<string, unknown> & {
    id: string;
    organization_id: string;
    user_id: string;
    first_name: string;
    last_name: string;
  };
}

portal.get("/clinic-patient/me", async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const patient = await linkedPatient(sql, user);
  const [appointmentRows, visitRows, balanceRows] = await Promise.all([
    sql`
      SELECT id, appointment_number, scheduled_for, duration_minutes, reason, status
      FROM clinic_appointments
      WHERE organization_id = ${patient.organization_id}
        AND patient_id = ${patient.id}
        AND status IN ('scheduled', 'checked_in', 'in_progress')
        AND scheduled_for >= NOW()
      ORDER BY scheduled_for ASC
      LIMIT 1
    `,
    sql`
      SELECT id, visit_number, visit_started_at, chief_complaint, diagnosis, status
      FROM clinic_visits
      WHERE organization_id = ${patient.organization_id}
        AND patient_id = ${patient.id}
        AND deleted_at IS NULL
        AND status <> 'voided'
      ORDER BY visit_started_at DESC
      LIMIT 1
    `,
    sql`
      SELECT
        COALESCE(SUM(GREATEST(invoice.patient_portion - invoice.patient_portion_paid, 0)), 0)::numeric
          AS patient_balance_due,
        COALESCE(SUM(GREATEST(invoice.insurance_covered - invoice.insurance_portion_paid, 0)), 0)::numeric
          AS insurance_balance_due,
        COALESCE(SUM(invoice.balance_due), 0)::numeric AS total_balance_due
      FROM clinic_invoices invoice
      WHERE invoice.organization_id = ${patient.organization_id}
        AND invoice.patient_id = ${patient.id}
        AND invoice.status <> 'cancelled'
    `,
  ]);
  return c.json({
    patient: {
      id: patient.id,
      patient_number: patient.patient_number,
      first_name: patient.first_name,
      last_name: patient.last_name,
      phone: patient.phone,
      email: patient.email,
      branch_name: patient.branch_name,
      insurance_provider_id: patient.insurance_provider_id,
      insurance_provider_name: patient.insurance_provider_name,
      insurance_member_number: patient.insurance_member_number,
      insurance_valid_until: patient.insurance_valid_until,
    },
    organization: {
      name: patient.organization_name,
      logo_base64: patient.organization_logo,
      brand_color: patient.organization_brand_color,
    },
    upcoming_appointment: appointmentRows[0] ?? null,
    recent_visit: visitRows[0] ?? null,
    balance: balanceRows[0] ?? {
      patient_balance_due: "0.00",
      insurance_balance_due: "0.00",
      total_balance_due: "0.00",
    },
  });
});

portal.get("/clinic-patient/me/visits", async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const patient = await linkedPatient(sql, user);
  const rows = await sql`
    SELECT visit.id, visit.visit_number, visit.visit_started_at, visit.visit_ended_at,
      visit.chief_complaint, visit.symptoms, visit.diagnosis, visit.diagnosis_code,
      visit.treatment_plan, visit.referral, visit.follow_up_date, visit.status,
      (
        SELECT COALESCE(json_agg(json_build_object(
          'prescription_number', prescription.prescription_number,
          'status', prescription.status,
          'items', (
            SELECT COALESCE(json_agg(json_build_object(
              'medicine_name', item.medicine_name,
              'dosage', item.dosage,
              'frequency', item.frequency,
              'duration', item.duration,
              'route', item.route,
              'quantity', item.quantity,
              'instructions', item.instructions
            ) ORDER BY item.created_at), '[]'::json)
            FROM clinic_prescription_items item
            WHERE item.prescription_id = prescription.id
          )
        ) ORDER BY prescription.created_at), '[]'::json)
        FROM clinic_prescriptions prescription
        WHERE prescription.visit_id = visit.id
          AND prescription.organization_id = visit.organization_id
          AND prescription.patient_id = visit.patient_id
          AND prescription.status <> 'cancelled'
      ) AS prescriptions
    FROM clinic_visits visit
    WHERE visit.organization_id = ${patient.organization_id}
      AND visit.patient_id = ${patient.id}
      AND visit.deleted_at IS NULL
      AND visit.status <> 'voided'
    ORDER BY visit.visit_started_at DESC
    LIMIT 100
  `;
  return c.json({ visits: rows });
});

portal.get("/clinic-patient/me/prescriptions", async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const patient = await linkedPatient(sql, user);
  const rows = await sql`
    SELECT prescription.id, prescription.prescription_number, prescription.status,
      prescription.notes, prescription.dispensed_at, prescription.created_at,
      visit.visit_number,
      (
        SELECT COALESCE(json_agg(json_build_object(
          'medicine_name', item.medicine_name,
          'dosage', item.dosage,
          'frequency', item.frequency,
          'duration', item.duration,
          'route', item.route,
          'quantity', item.quantity,
          'dispensed_quantity', item.dispensed_quantity,
          'instructions', item.instructions
        ) ORDER BY item.created_at), '[]'::json)
        FROM clinic_prescription_items item
        WHERE item.prescription_id = prescription.id
      ) AS items
    FROM clinic_prescriptions prescription
    LEFT JOIN clinic_visits visit
      ON visit.id = prescription.visit_id
      AND visit.organization_id = prescription.organization_id
    WHERE prescription.organization_id = ${patient.organization_id}
      AND prescription.patient_id = ${patient.id}
      AND prescription.status <> 'cancelled'
    ORDER BY prescription.created_at DESC
    LIMIT 100
  `;
  return c.json({ prescriptions: rows });
});

portal.get("/clinic-patient/me/invoices", async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const patient = await linkedPatient(sql, user);
  const rows = await sql`
    SELECT invoice.id, invoice.invoice_number, invoice.visit_id, invoice.subtotal,
      invoice.discount, invoice.total, invoice.currency, invoice.patient_portion,
      invoice.patient_portion_paid,
      GREATEST(invoice.patient_portion - invoice.patient_portion_paid, 0)::numeric
        AS patient_balance_due,
      invoice.insurance_covered AS insurance_portion,
      invoice.insurance_portion_paid,
      GREATEST(invoice.insurance_covered - invoice.insurance_portion_paid, 0)::numeric
        AS insurance_balance_due,
      invoice.amount_paid, invoice.balance_due, invoice.status, invoice.due_date,
      invoice.created_at, provider.name AS insurance_provider_name,
      claim.claim_number AS insurance_claim_number,
      claim.status AS insurance_claim_status
    FROM clinic_invoices invoice
    LEFT JOIN clinic_insurance_providers provider
      ON provider.id = invoice.insurance_provider_id
    LEFT JOIN clinic_insurance_claims claim ON claim.invoice_id = invoice.id
    WHERE invoice.organization_id = ${patient.organization_id}
      AND invoice.patient_id = ${patient.id}
      AND invoice.status <> 'cancelled'
    ORDER BY invoice.created_at DESC
    LIMIT 100
  `;
  return c.json({ invoices: rows });
});

portal.get("/clinic-patient/me/invoices/:id", async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const patient = await linkedPatient(sql, user);
  const invoiceId = c.req.param("id");
  const invoiceRows = await sql`
    SELECT invoice.id, invoice.invoice_number, invoice.visit_id, invoice.subtotal,
      invoice.discount, invoice.tax, invoice.total, invoice.currency,
      invoice.patient_portion, invoice.patient_portion_paid,
      GREATEST(invoice.patient_portion - invoice.patient_portion_paid, 0)::numeric
        AS patient_balance_due,
      invoice.insurance_covered AS insurance_portion,
      invoice.insurance_portion_paid,
      GREATEST(invoice.insurance_covered - invoice.insurance_portion_paid, 0)::numeric
        AS insurance_balance_due,
      invoice.amount_paid, invoice.balance_due, invoice.status, invoice.due_date,
      invoice.created_at, invoice.notes,
      claim.claim_number AS insurance_claim_number,
      claim.claim_amount AS insurance_claim_amount,
      claim.approved_amount AS insurance_approved_amount,
      claim.status AS insurance_claim_status,
      claim.submitted_at AS insurance_claim_submitted_at,
      claim.responded_at AS insurance_claim_responded_at
    FROM clinic_invoices invoice
    LEFT JOIN clinic_insurance_claims claim ON claim.invoice_id = invoice.id
    WHERE invoice.id = ${invoiceId}
      AND invoice.organization_id = ${patient.organization_id}
      AND invoice.patient_id = ${patient.id}
      AND invoice.status <> 'cancelled'
    LIMIT 1
  `;
  const invoice = invoiceRows[0];
  if (!invoice) throw new ApiError(404, "INVOICE_NOT_FOUND", "Invoice was not found.");
  const [items, payments] = await Promise.all([
    sql`
      SELECT item_type, description, quantity, unit_price, total
      FROM clinic_invoice_items
      WHERE invoice_id = ${invoiceId}
      ORDER BY created_at, id
    `,
    sql`
      SELECT receipt_number, amount, applied_amount, payment_method, paid_at,
        payment_reference, reversed, reversed_at, reversal_reason
      FROM clinic_payments
      WHERE invoice_id = ${invoiceId}
        AND organization_id = ${patient.organization_id}
      ORDER BY paid_at DESC
    `,
  ]);
  return c.json({ invoice, items, payments });
});

portal.get("/clinic-patient/me/statements", async (c) => {
  const user = c.get("user");
  const sql = getDb(c.env);
  const patient = await linkedPatient(sql, user);
  const rows = await sql`
    SELECT invoice.id, invoice.invoice_number, invoice.created_at, invoice.due_date,
      invoice.currency, invoice.total, invoice.patient_portion, invoice.patient_portion_paid,
      GREATEST(invoice.patient_portion - invoice.patient_portion_paid, 0)::numeric
        AS patient_balance_due,
      invoice.insurance_covered AS insurance_portion,
      invoice.insurance_portion_paid,
      GREATEST(invoice.insurance_covered - invoice.insurance_portion_paid, 0)::numeric
        AS insurance_balance_due,
      invoice.balance_due, invoice.status,
      claim.status AS insurance_claim_status
    FROM clinic_invoices invoice
    LEFT JOIN clinic_insurance_claims claim ON claim.invoice_id = invoice.id
    WHERE invoice.organization_id = ${patient.organization_id}
      AND invoice.patient_id = ${patient.id}
      AND invoice.status <> 'cancelled'
    ORDER BY invoice.created_at DESC
    LIMIT 200
  `;
  return c.json({ statements: rows });
});

portal.patch("/clinic-patient/me", async (c) => {
  const user = c.get("user");
  const body = await readJson(c);
  assertAllowedKeys(body, ["first_name", "last_name", "phone"]);
  const firstName = body.first_name === undefined
    ? undefined
    : requiredText(body.first_name, "first_name", 100);
  const lastName = body.last_name === undefined
    ? undefined
    : requiredText(body.last_name, "last_name", 100);
  const phone = optionalText(body.phone, "phone", 40);
  const fields = Object.keys(body);
  if (!fields.length) {
    throw new ApiError(400, "VALIDATION_ERROR", "Provide a name or phone field to update.");
  }
  const sql = getDb(c.env);
  const patient = await linkedPatient(sql, user);
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || null;
  const rows = await sql`
    WITH updated_patient AS (
      UPDATE clinic_patients
      SET first_name = CASE WHEN ${firstName !== undefined} THEN ${firstName ?? null} ELSE first_name END,
        last_name = CASE WHEN ${lastName !== undefined} THEN ${lastName ?? null} ELSE last_name END,
        phone = CASE WHEN ${phone !== undefined} THEN ${phone ?? null} ELSE phone END,
        updated_at = NOW()
      WHERE id = ${patient.id}
        AND organization_id = ${patient.organization_id}
        AND user_id = ${user.id}
        AND portal_enabled IS TRUE
      RETURNING id, organization_id, user_id, first_name, last_name, phone
    ),
    updated_user AS (
      UPDATE users account
      SET name = concat_ws(' ', updated_patient.first_name, updated_patient.last_name),
        phone = updated_patient.phone
      FROM updated_patient
      WHERE account.id = updated_patient.user_id
      RETURNING account.id
    ),
    portal_log AS (
      INSERT INTO clinic_portal_log (patient_id, action, metadata)
      SELECT id, 'profile_updated',
        jsonb_build_object('fields', ${JSON.stringify(fields)}::jsonb)
      FROM updated_patient RETURNING id
    ),
    local_audit AS (
      INSERT INTO clinic_audit (organization_id, actor_id, action, target_table, target_id, metadata)
      SELECT organization_id, ${user.id}, 'clinic.patient_portal_profile_updated',
        'clinic_patients', id, jsonb_build_object('fields', ${JSON.stringify(fields)}::jsonb)
      FROM updated_patient RETURNING id
    ),
    platform_audit AS (
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT ${user.id}, 'clinic', 'clinic.patient_portal_profile_updated',
        'clinic_patients', id, jsonb_build_object('fields', ${JSON.stringify(fields)}::jsonb), ${ip}
      FROM updated_patient RETURNING id
    )
    SELECT * FROM updated_patient
  `;
  if (!rows[0]) throw new ApiError(409, "PATIENT_PROFILE_UPDATE_FAILED", "The patient profile could not be updated.");
  return c.json({ patient: rows[0] });
});

export default portal;
