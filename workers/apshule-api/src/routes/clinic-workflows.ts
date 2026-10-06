import { Hono } from "hono";
import { ApiError, getDb, isUniqueViolation } from "../db.js";
import { requireRole } from "../auth.js";
import { parseLimit, readJson } from "../http.js";
import { isClinicDate } from "../clinic-domain.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";

type Sql = ReturnType<typeof getDb>;
type OrganizationResolver = (
  sql: Sql,
  user: AuthenticatedUser,
  requestedId?: string,
) => Promise<string>;
type RequestIp = (c: { req: { header(name: string): string | undefined } }) => string | null;

interface ClinicWorkflowHelpers {
  organizationForRequest: OrganizationResolver;
  requestIp: RequestIp;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const APPOINTMENT_STATUSES = [
  "scheduled",
  "checked_in",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
] as const;
const VISIT_STATUSES = ["in_progress", "completed", "referred", "voided"] as const;
const VITALS_RANGES: Record<string, [number, number]> = {
  temperature_c: [30, 45],
  weight_kg: [0.1, 500],
  height_cm: [30, 250],
  pulse_bpm: [20, 250],
  respiratory_rate: [4, 80],
};
const VITAL_KEYS = new Set([
  "blood_pressure",
  "temperature_c",
  "weight_kg",
  "height_cm",
  "pulse_bpm",
  "respiratory_rate",
]);

function pathUuid(value: string, field = "id"): string {
  if (!UUID_PATTERN.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a valid UUID.`);
  }
  return value;
}

function queryUuid(value: string | undefined, field: string): string | null {
  if (!value) return null;
  return pathUuid(value, field);
}

function assertAllowedKeys(body: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `Unsupported field: ${unexpected[0]}.`,
    );
  }
}

function requiredText(body: Record<string, unknown>, key: string, max: number): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} is required.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must contain 1-${max} characters.`);
  }
  return normalized;
}

function optionalText(
  body: Record<string, unknown>,
  key: string,
  max: number,
): string | null | undefined {
  if (!(key in body)) return undefined;
  const value = body[key];
  if (value === null) return null;
  if (typeof value !== "string" || value.length > max) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be text of at most ${max} characters.`);
  }
  const normalized = value.trim();
  return normalized || null;
}

function optionalUuid(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = optionalText(body, key, 36);
  if (value === undefined || value === null) return value;
  return pathUuid(value, key);
}

function requiredUuid(body: Record<string, unknown>, key: string): string {
  const value = requiredText(body, key, 36);
  return pathUuid(value, key);
}

function optionalDate(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = optionalText(body, key, 10);
  if (value === undefined || value === null) return value;
  if (!isClinicDate(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a valid YYYY-MM-DD date.`);
  }
  return value;
}

function requiredDateTime(body: Record<string, unknown>, key: string): string {
  const value = requiredText(body, key, 64);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/iu.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must include a timezone offset.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be a valid date and time.`);
  }
  if (parsed.getTime() <= Date.now()) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} must be in the future.`);
  }
  return parsed.toISOString();
}

function optionalNumber(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  integer = false,
): number | undefined {
  if (!(key in body)) return undefined;
  const raw = body[key];
  const value = typeof raw === "number" || typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new ApiError(400, "VALIDATION_ERROR", `${key} is outside the allowed range.`);
  }
  return value;
}

function monthInKampala(date: Date): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  if (!year || !month) {
    throw new ApiError(500, "DATE_FORMAT_ERROR", "Could not determine the Clinic numbering period.");
  }
  return `${year}${month}`;
}

function todayInKampala(): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new ApiError(500, "DATE_FORMAT_ERROR", "Could not determine the Clinic date.");
  }
  return `${year}-${month}-${day}`;
}

function clinicDateBounds(date: string): [string, string] {
  if (!isClinicDate(date)) {
    throw new ApiError(400, "VALIDATION_ERROR", "date must be a valid YYYY-MM-DD date.");
  }
  const start = new Date(`${date}T00:00:00.000+03:00`);
  return [
    start.toISOString(),
    new Date(start.getTime() + 86_400_000).toISOString(),
  ];
}

function optionalStatus<T extends readonly string[]>(
  value: string | undefined,
  allowed: T,
  field: string,
): T[number] | null {
  if (!value || value === "all") return null;
  if (!allowed.includes(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} is invalid.`);
  }
  return value as T[number];
}

async function resolveOrganization(
  c: { env: AppEnv["Bindings"]; get(key: "user"): AuthenticatedUser; req: { query(name: string): string | undefined } },
  organizationForRequest: OrganizationResolver,
): Promise<string> {
  return organizationForRequest(
    getDb(c.env),
    c.get("user"),
    c.req.query("organization_id"),
  );
}

async function assertActivePatient(
  sql: Sql,
  organizationId: string,
  patientId: string,
): Promise<{ branch_id: string | null }> {
  const rows = await sql`
    SELECT id, branch_id
    FROM clinic_patients
    WHERE id = ${patientId}
      AND organization_id = ${organizationId}
      AND status = 'active'
    LIMIT 1
  `;
  if (!rows[0]) {
    throw new ApiError(404, "CLINIC_PATIENT_NOT_FOUND", "Active Clinic patient was not found.");
  }
  return rows[0] as { branch_id: string | null };
}

async function assertActiveDoctor(
  sql: Sql,
  organizationId: string,
  doctorId: string,
): Promise<{ branch_id: string | null; name: string }> {
  const rows = await sql`
    SELECT u.id, u.name, s.branch_id
    FROM clinic_staff s
    JOIN users u ON u.id = s.user_id
    WHERE s.user_id = ${doctorId}
      AND s.organization_id = ${organizationId}
      AND s.role = 'doctor'
      AND s.active IS TRUE
      AND u.role = 'doctor'
      AND u.sector = 'clinic'
    LIMIT 1
  `;
  if (!rows[0]) {
    throw new ApiError(400, "DOCTOR_NOT_FOUND", "The selected doctor is not active in this organization.");
  }
  return rows[0] as { branch_id: string | null; name: string };
}

async function assertBranchIsActive(
  sql: Sql,
  organizationId: string,
  branchId: string | null,
): Promise<void> {
  if (!branchId) return;
  const rows = await sql`
    SELECT id FROM clinic_branches
    WHERE id = ${branchId} AND organization_id = ${organizationId} AND active IS TRUE
    LIMIT 1
  `;
  if (!rows[0]) {
    throw new ApiError(409, "CLINIC_BRANCH_INACTIVE", "The appointment branch is not active.");
  }
}

async function listAppointments(
  sql: Sql,
  organizationId: string,
  filters: {
    date?: string | null;
    doctorId?: string | null;
    patientId?: string | null;
    status?: string | null;
    limit?: number;
  },
) {
  const [start, end] = filters.date ? clinicDateBounds(filters.date) : [null, null];
  return sql`
    SELECT a.id, a.organization_id, a.branch_id, a.patient_id, a.doctor_id,
      a.appointment_number, a.scheduled_for, a.duration_minutes, a.reason,
      a.status, a.created_at, a.updated_at,
      p.first_name || ' ' || p.last_name AS patient_name,
      p.patient_number,
      d.name AS doctor_name,
      b.name AS branch_name
    FROM clinic_appointments a
    JOIN clinic_patients p
      ON p.id = a.patient_id AND p.organization_id = a.organization_id
    LEFT JOIN users d ON d.id = a.doctor_id
    LEFT JOIN clinic_branches b
      ON b.id = a.branch_id AND b.organization_id = a.organization_id
    WHERE a.organization_id = ${organizationId}
      AND (${start === null} OR (
        a.scheduled_for >= ${start}::timestamptz
        AND a.scheduled_for < ${end}::timestamptz
      ))
      AND (${filters.doctorId === null || filters.doctorId === undefined}
        OR a.doctor_id = ${filters.doctorId ?? null})
      AND (${filters.patientId === null || filters.patientId === undefined}
        OR a.patient_id = ${filters.patientId ?? null})
      AND (${filters.status === null || filters.status === undefined}
        OR a.status = ${filters.status ?? null})
    ORDER BY a.scheduled_for ASC, a.created_at ASC
    LIMIT ${filters.limit ?? 100}
  `;
}

async function appointmentById(
  sql: Sql,
  organizationId: string,
  id: string,
  actor: AuthenticatedUser,
) {
  const rows = await sql`
    SELECT a.id, a.organization_id, a.branch_id, a.patient_id, a.doctor_id,
      a.appointment_number, a.scheduled_for, a.duration_minutes, a.reason,
      a.cancellation_reason, a.status, a.notes, a.created_by, a.created_at, a.updated_at,
      p.first_name || ' ' || p.last_name AS patient_name, p.patient_number,
      d.name AS doctor_name, b.name AS branch_name
    FROM clinic_appointments a
    JOIN clinic_patients p
      ON p.id = a.patient_id AND p.organization_id = a.organization_id
    LEFT JOIN users d ON d.id = a.doctor_id
    LEFT JOIN clinic_branches b
      ON b.id = a.branch_id AND b.organization_id = a.organization_id
    WHERE a.id = ${id}
      AND a.organization_id = ${organizationId}
      AND (${actor.role !== "doctor"} OR a.doctor_id = ${actor.id})
    LIMIT 1
  `;
  if (!rows[0]) {
    throw new ApiError(404, "CLINIC_APPOINTMENT_NOT_FOUND", "Clinic appointment was not found.");
  }
  return rows[0];
}

function optionalVitals(body: Record<string, unknown>): Record<string, number | string | null> | undefined {
  if (!("vitals" in body)) return undefined;
  const raw = body.vitals;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "VALIDATION_ERROR", "vitals must be an object.");
  }
  const source = raw as Record<string, unknown>;
  const unexpected = Object.keys(source).find((key) => !VITAL_KEYS.has(key));
  if (unexpected) {
    throw new ApiError(400, "VALIDATION_ERROR", `Unsupported vital: ${unexpected}.`);
  }
  const result: Record<string, number | string | null> = {};
  for (const key of VITAL_KEYS) {
    if (!(key in source)) continue;
    const value = source[key];
    if (value === null || value === "") {
      result[key] = null;
      continue;
    }
    if (key === "blood_pressure") {
      if (typeof value !== "string" || !/^\d{2,3}\/\d{2,3}$/u.test(value.trim())) {
        throw new ApiError(400, "VALIDATION_ERROR", "blood_pressure must use the form 120/80.");
      }
      result[key] = value.trim();
      continue;
    }
    const [minimum, maximum] = VITALS_RANGES[key]!;
    const numeric = typeof value === "number" || typeof value === "string"
      ? Number(value)
      : Number.NaN;
    if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) {
      throw new ApiError(400, "VALIDATION_ERROR", `${key} is outside the allowed range.`);
    }
    result[key] = numeric;
  }
  return result;
}

async function listVisits(
  sql: Sql,
  organizationId: string,
  filters: {
    actor: AuthenticatedUser;
    date?: string | null;
    doctorId?: string | null;
    patientId?: string | null;
    status?: string | null;
    limit?: number;
  },
) {
  const [start, end] = filters.date ? clinicDateBounds(filters.date) : [null, null];
  return sql`
    SELECT v.id, v.organization_id, v.branch_id, v.patient_id, v.appointment_id,
      v.doctor_id, v.visit_number, v.visit_started_at, v.visit_ended_at,
      v.chief_complaint, v.symptoms, v.vitals, v.examination_notes, v.diagnosis,
      v.diagnosis_code, v.treatment_plan, v.referral, v.follow_up_date,
      v.status, v.created_by, v.created_at, v.updated_at,
      p.first_name || ' ' || p.last_name AS patient_name,
      p.patient_number, d.name AS doctor_name
    FROM clinic_visits v
    JOIN clinic_patients p
      ON p.id = v.patient_id AND p.organization_id = v.organization_id
    LEFT JOIN users d ON d.id = v.doctor_id
    WHERE v.organization_id = ${organizationId}
      AND (${filters.status === "voided"} OR v.deleted_at IS NULL)
      AND (${filters.status === "voided"} OR v.status <> 'voided')
      AND (${start === null} OR (
        v.visit_started_at >= ${start}::timestamptz
        AND v.visit_started_at < ${end}::timestamptz
      ))
      AND (${filters.doctorId === null || filters.doctorId === undefined}
        OR v.doctor_id = ${filters.doctorId ?? null})
      AND (${filters.patientId === null || filters.patientId === undefined}
        OR v.patient_id = ${filters.patientId ?? null})
      AND (${filters.status === null || filters.status === undefined}
        OR v.status = ${filters.status ?? null})
      AND (${filters.actor.role !== "doctor"} OR v.doctor_id = ${filters.actor.id})
    ORDER BY v.visit_started_at DESC
    LIMIT ${filters.limit ?? 100}
  `;
}

async function visitById(
  sql: Sql,
  organizationId: string,
  id: string,
  actor: AuthenticatedUser,
) {
  const rows = await sql`
    SELECT v.id, v.organization_id, v.branch_id, v.patient_id, v.appointment_id,
      v.doctor_id, v.visit_number, v.visit_started_at, v.visit_ended_at,
      v.chief_complaint, v.symptoms, v.vitals, v.examination_notes, v.diagnosis,
      v.diagnosis_code, v.treatment_plan, v.referral, v.follow_up_date,
      v.status, v.created_by, v.created_at, v.updated_at,
      p.first_name || ' ' || p.last_name AS patient_name,
      p.patient_number, p.allergies AS patient_allergies,
      d.name AS doctor_name
    FROM clinic_visits v
    JOIN clinic_patients p
      ON p.id = v.patient_id AND p.organization_id = v.organization_id
    LEFT JOIN users d ON d.id = v.doctor_id
    WHERE v.id = ${id}
      AND v.organization_id = ${organizationId}
      AND v.deleted_at IS NULL
      AND v.status <> 'voided'
      AND (${actor.role !== "doctor"} OR v.doctor_id = ${actor.id})
    LIMIT 1
  `;
  if (!rows[0]) {
    throw new ApiError(404, "CLINIC_VISIT_NOT_FOUND", "Clinic visit was not found.");
  }
  return rows[0];
}

export function createClinicWorkflowRoutes(
  helpers: ClinicWorkflowHelpers,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get(
    "/clinic/doctors",
    requireRole("superadmin", "clinic_admin", "doctor", "nurse", "receptionist"),
    async (c) => {
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      const doctors = await sql`
        SELECT u.id, u.id AS user_id, s.id AS staff_id,
          s.branch_id, s.specialization, u.name
        FROM clinic_staff s
        JOIN users u ON u.id = s.user_id
        WHERE s.organization_id = ${organizationId}
          AND s.role = 'doctor' AND s.active IS TRUE
          AND u.role = 'doctor' AND u.sector = 'clinic'
        ORDER BY u.name ASC
      `;
      return c.json({ doctors });
    },
  );

  routes.get(
    "/clinic/appointments",
    requireRole("superadmin", "clinic_admin", "doctor", "nurse", "receptionist"),
    async (c) => {
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      const date = c.req.query("date") || null;
      if (date) clinicDateBounds(date);
      const requestedDoctorId = queryUuid(c.req.query("doctor_id"), "doctor_id");
      const patientId = queryUuid(c.req.query("patient_id"), "patient_id");
      const status = optionalStatus(c.req.query("status"), APPOINTMENT_STATUSES, "status");
      const appointments = await listAppointments(sql, organizationId, {
        date,
        doctorId: actor.role === "doctor" ? actor.id : requestedDoctorId,
        patientId,
        status,
        limit: parseLimit(c.req.query("limit"), 100),
      });
      return c.json({ appointments });
    },
  );

  routes.post(
    "/clinic/appointments",
    requireRole("clinic_admin", "receptionist", "nurse"),
    async (c) => {
      const body = await readJson(c);
      assertAllowedKeys(body, [
        "patient_id",
        "doctor_id",
        "scheduled_for",
        "duration_minutes",
        "reason",
      ]);
      const patientId = requiredUuid(body, "patient_id");
      const doctorId = requiredUuid(body, "doctor_id");
      const scheduledFor = requiredDateTime(body, "scheduled_for");
      const duration = optionalNumber(body, "duration_minutes", 5, 480, true) ?? 30;
      const reason = optionalText(body, "reason", 2000);
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      const [patient, doctor] = await Promise.all([
        assertActivePatient(sql, organizationId, patientId),
        assertActiveDoctor(sql, organizationId, doctorId),
      ]);
      if (patient.branch_id && doctor.branch_id && patient.branch_id !== doctor.branch_id) {
        throw new ApiError(409, "CLINIC_BRANCH_MISMATCH", "The patient and doctor are assigned to different branches.");
      }
      const branchId = patient.branch_id || doctor.branch_id;
      await assertBranchIsActive(sql, organizationId, branchId);
      const period = monthInKampala(new Date(scheduledFor));
      const ip = helpers.requestIp(c);
      let rows: Record<string, unknown>[];
      try {
        rows = await sql`
          WITH allocation AS (
            INSERT INTO clinic_number_counters (
              organization_id, period, record_type, current_value
            )
            VALUES (${organizationId}, ${period}, 'appointment', 1)
            ON CONFLICT (organization_id, period, record_type)
            DO UPDATE SET current_value = clinic_number_counters.current_value + 1,
              updated_at = NOW()
            WHERE clinic_number_counters.current_value < 9999
            RETURNING current_value
          ),
          created AS (
            INSERT INTO clinic_appointments (
              organization_id, branch_id, patient_id, doctor_id, appointment_number,
              scheduled_for, duration_minutes, reason, status, created_by
            )
            SELECT ${organizationId}, ${branchId}, ${patientId}, ${doctorId},
              ${`APT-${period}-`} || lpad(allocation.current_value::text, 4, '0'),
              ${scheduledFor}::timestamptz, ${duration}, ${reason ?? null},
              'scheduled', ${actor.id}
            FROM allocation
            RETURNING *
          ),
          local_audit AS (
            INSERT INTO clinic_audit (
              organization_id, actor_id, action, target_table, target_id, metadata
            )
            SELECT organization_id, ${actor.id}, 'clinic.appointment_created',
              'clinic_appointments', id,
              jsonb_build_object('appointment_number', appointment_number)
            FROM created RETURNING id
          ),
          platform_audit AS (
            INSERT INTO audit_log (
              actor_id, sector, action, target_table, target_id, metadata, ip
            )
            SELECT ${actor.id}, 'clinic', 'clinic.appointment_created',
              'clinic_appointments', id,
              jsonb_build_object('appointment_number', appointment_number), ${ip}
            FROM created RETURNING id
          )
          SELECT * FROM created
        `;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(409, "APPOINTMENT_NUMBER_CONFLICT", "Could not allocate a unique appointment number. Please retry.");
        }
        throw error;
      }
      if (!rows[0]) {
        throw new ApiError(409, "APPOINTMENT_NUMBER_EXHAUSTED", "This organization has reached its monthly appointment-number limit.");
      }
      return c.json({ appointment: rows[0] }, 201);
    },
  );

  routes.get(
    "/clinic/appointments/:id",
    requireRole("superadmin", "clinic_admin", "doctor", "nurse", "receptionist"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      const appointment = await appointmentById(sql, organizationId, id, actor);
      return c.json({ appointment });
    },
  );

  routes.patch(
    "/clinic/appointments/:id",
    requireRole("clinic_admin", "receptionist", "nurse"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const body = await readJson(c);
      assertAllowedKeys(body, ["doctor_id", "scheduled_for", "duration_minutes", "reason"]);
      const doctorId = optionalUuid(body, "doctor_id");
      const scheduledFor = "scheduled_for" in body
        ? requiredDateTime(body, "scheduled_for")
        : undefined;
      const duration = optionalNumber(body, "duration_minutes", 5, 480, true);
      const reason = optionalText(body, "reason", 2000);
      const fields = ["doctor_id", "scheduled_for", "duration_minutes", "reason"]
        .filter((field) => field in body);
      if (!fields.length) {
        throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one appointment field to update.");
      }
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      const currentRows = await sql`
        SELECT patient_id, branch_id, status
        FROM clinic_appointments
        WHERE id = ${id} AND organization_id = ${organizationId}
        LIMIT 1
      `;
      if (!currentRows[0]) {
        throw new ApiError(404, "CLINIC_APPOINTMENT_NOT_FOUND", "Clinic appointment was not found.");
      }
      const current = currentRows[0] as {
        patient_id: string;
        branch_id: string | null;
        status: string;
      };
      if (current.status !== "scheduled") {
        throw new ApiError(409, "APPOINTMENT_NOT_EDITABLE", "Only scheduled appointments can be changed.");
      }
      let resolvedDoctorId = doctorId;
      if (doctorId === null) {
        throw new ApiError(400, "VALIDATION_ERROR", "doctor_id cannot be cleared.");
      }
      if (doctorId) {
        const doctor = await assertActiveDoctor(sql, organizationId, doctorId);
        if (current.branch_id && doctor.branch_id && current.branch_id !== doctor.branch_id) {
          throw new ApiError(409, "CLINIC_BRANCH_MISMATCH", "The doctor is assigned to a different branch.");
        }
        resolvedDoctorId = doctorId;
      }
      const metadata = JSON.stringify({ fields });
      const ip = helpers.requestIp(c);
      const rows = await sql`
        WITH updated AS (
          UPDATE clinic_appointments
          SET doctor_id = CASE WHEN ${doctorId !== undefined}
                THEN ${resolvedDoctorId ?? null} ELSE doctor_id END,
            scheduled_for = CASE WHEN ${scheduledFor !== undefined}
                THEN ${scheduledFor ?? null}::timestamptz ELSE scheduled_for END,
            duration_minutes = CASE WHEN ${duration !== undefined}
                THEN ${duration ?? null} ELSE duration_minutes END,
            reason = CASE WHEN ${reason !== undefined}
                THEN ${reason ?? null} ELSE reason END,
            updated_at = NOW()
          WHERE id = ${id}
            AND organization_id = ${organizationId}
            AND status = 'scheduled'
          RETURNING *
        ),
        local_audit AS (
          INSERT INTO clinic_audit (
            organization_id, actor_id, action, target_table, target_id, metadata
          )
          SELECT organization_id, ${actor.id}, 'clinic.appointment_updated',
            'clinic_appointments', id, ${metadata}::jsonb
          FROM updated RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (
            actor_id, sector, action, target_table, target_id, metadata, ip
          )
          SELECT ${actor.id}, 'clinic', 'clinic.appointment_updated',
            'clinic_appointments', id, ${metadata}::jsonb, ${ip}
          FROM updated RETURNING id
        )
        SELECT * FROM updated
      `;
      if (!rows[0]) {
        throw new ApiError(409, "APPOINTMENT_NOT_EDITABLE", "The appointment changed before it could be saved.");
      }
      return c.json({ appointment: rows[0] });
    },
  );

  routes.post(
    "/clinic/appointments/:id/check-in",
    requireRole("receptionist", "nurse"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      const ip = helpers.requestIp(c);
      const rows = await sql`
        WITH updated AS (
          UPDATE clinic_appointments
          SET status = 'checked_in', updated_at = NOW()
          WHERE id = ${id} AND organization_id = ${organizationId}
            AND status = 'scheduled'
          RETURNING *
        ),
        local_audit AS (
          INSERT INTO clinic_audit (
            organization_id, actor_id, action, target_table, target_id, metadata
          )
          SELECT organization_id, ${actor.id}, 'clinic.appointment_checked_in',
            'clinic_appointments', id, jsonb_build_object('status', status)
          FROM updated RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (
            actor_id, sector, action, target_table, target_id, metadata, ip
          )
          SELECT ${actor.id}, 'clinic', 'clinic.appointment_checked_in',
            'clinic_appointments', id, jsonb_build_object('status', status), ${ip}
          FROM updated RETURNING id
        )
        SELECT * FROM updated
      `;
      if (!rows[0]) {
        throw new ApiError(409, "APPOINTMENT_NOT_CHECKINABLE", "Only scheduled appointments can be checked in.");
      }
      return c.json({ appointment: rows[0] });
    },
  );

  routes.post(
    "/clinic/appointments/:id/cancel",
    requireRole("clinic_admin", "receptionist", "nurse"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const body = await readJson(c);
      assertAllowedKeys(body, ["reason"]);
      const reason = requiredText(body, "reason", 500);
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      const ip = helpers.requestIp(c);
      const rows = await sql`
        WITH updated AS (
          UPDATE clinic_appointments
          SET status = 'cancelled', cancellation_reason = ${reason},
            updated_at = NOW()
          WHERE id = ${id} AND organization_id = ${organizationId}
            AND status IN ('scheduled', 'checked_in')
          RETURNING *
        ),
        local_audit AS (
          INSERT INTO clinic_audit (
            organization_id, actor_id, action, target_table, target_id, metadata
          )
          SELECT organization_id, ${actor.id}, 'clinic.appointment_cancelled',
            'clinic_appointments', id,
            jsonb_build_object('status', status, 'reason_provided', TRUE)
          FROM updated RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (
            actor_id, sector, action, target_table, target_id, metadata, ip
          )
          SELECT ${actor.id}, 'clinic', 'clinic.appointment_cancelled',
            'clinic_appointments', id,
            jsonb_build_object('status', status, 'reason_provided', TRUE), ${ip}
          FROM updated RETURNING id
        )
        SELECT * FROM updated
      `;
      if (!rows[0]) {
        throw new ApiError(409, "APPOINTMENT_NOT_CANCELLABLE", "This appointment can no longer be cancelled.");
      }
      return c.json({ appointment: rows[0] });
    },
  );

  routes.post(
    "/clinic/appointments/:id/no-show",
    requireRole("receptionist"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      const ip = helpers.requestIp(c);
      const rows = await sql`
        WITH updated AS (
          UPDATE clinic_appointments
          SET status = 'no_show', updated_at = NOW()
          WHERE id = ${id} AND organization_id = ${organizationId}
            AND status IN ('scheduled', 'checked_in')
          RETURNING *
        ),
        local_audit AS (
          INSERT INTO clinic_audit (
            organization_id, actor_id, action, target_table, target_id, metadata
          )
          SELECT organization_id, ${actor.id}, 'clinic.appointment_no_show',
            'clinic_appointments', id, jsonb_build_object('status', status)
          FROM updated RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (
            actor_id, sector, action, target_table, target_id, metadata, ip
          )
          SELECT ${actor.id}, 'clinic', 'clinic.appointment_no_show',
            'clinic_appointments', id, jsonb_build_object('status', status), ${ip}
          FROM updated RETURNING id
        )
        SELECT * FROM updated
      `;
      if (!rows[0]) {
        throw new ApiError(409, "APPOINTMENT_NOT_MARKABLE", "This appointment cannot be marked as a no-show.");
      }
      return c.json({ appointment: rows[0] });
    },
  );

  routes.get(
    "/clinic/stats/appointments",
    requireRole("superadmin", "clinic_admin", "doctor", "nurse", "receptionist"),
    async (c) => {
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      const [start, end] = clinicDateBounds(todayInKampala());
      const rows = await sql`
        SELECT
          COUNT(*) AS today_count,
          COUNT(*) FILTER (WHERE status = 'scheduled') AS scheduled_count,
          COUNT(*) FILTER (WHERE status = 'checked_in') AS checked_in_count,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
          COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_count,
          COUNT(*) FILTER (WHERE status = 'no_show') AS no_show_count,
          COUNT(*) FILTER (WHERE status = 'in_progress') AS in_progress_count
        FROM clinic_appointments
        WHERE organization_id = ${organizationId}
          AND scheduled_for >= ${start}::timestamptz
          AND scheduled_for < ${end}::timestamptz
          AND (${actor.role !== "doctor"} OR doctor_id = ${actor.id})
      `;
      return c.json({ stats: rows[0] || {} });
    },
  );

  routes.get(
    "/clinic/visits",
    requireRole("superadmin", "clinic_admin", "doctor", "nurse"),
    async (c) => {
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      const date = c.req.query("date") || null;
      if (date) clinicDateBounds(date);
      const requestedDoctorId = queryUuid(c.req.query("doctor_id"), "doctor_id");
      const patientId = queryUuid(c.req.query("patient_id"), "patient_id");
      const status = optionalStatus(c.req.query("status"), VISIT_STATUSES, "status");
      if (status === "voided" && actor.role !== "clinic_admin" && actor.role !== "superadmin") {
        throw new ApiError(403, "FORBIDDEN", "Only a clinic administrator can view voided visits.");
      }
      const visits = await listVisits(sql, organizationId, {
        actor,
        date,
        doctorId: actor.role === "doctor" ? actor.id : requestedDoctorId,
        patientId,
        status,
        limit: parseLimit(c.req.query("limit"), 100),
      });
      return c.json({ visits });
    },
  );

  routes.post(
    "/clinic/visits",
    requireRole("clinic_admin", "doctor", "nurse"),
    async (c) => {
      const body = await readJson(c);
      assertAllowedKeys(body, ["patient_id", "appointment_id", "chief_complaint", "symptoms"]);
      const patientId = requiredUuid(body, "patient_id");
      const appointmentId = optionalUuid(body, "appointment_id") ?? null;
      const chiefComplaint = optionalText(body, "chief_complaint", 2000);
      const symptoms = optionalText(body, "symptoms", 4000);
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      const patient = await assertActivePatient(sql, organizationId, patientId);

      let doctorId: string | null = null;
      let branchId: string | null = patient.branch_id;
      if (appointmentId) {
        const appointmentRows = await sql`
          SELECT id, patient_id, doctor_id, branch_id, status
          FROM clinic_appointments
          WHERE id = ${appointmentId} AND organization_id = ${organizationId}
          LIMIT 1
        `;
        if (!appointmentRows[0]) {
          throw new ApiError(404, "CLINIC_APPOINTMENT_NOT_FOUND", "Clinic appointment was not found.");
        }
        const appointment = appointmentRows[0] as {
          patient_id: string;
          doctor_id: string | null;
          branch_id: string | null;
          status: string;
        };
        if (appointment.patient_id !== patientId) {
          throw new ApiError(400, "APPOINTMENT_PATIENT_MISMATCH", "The appointment belongs to a different patient.");
        }
        if (appointment.status !== "checked_in") {
          throw new ApiError(409, "APPOINTMENT_NOT_READY", "Check the patient in before starting the visit.");
        }
        if (!appointment.doctor_id) {
          throw new ApiError(409, "APPOINTMENT_DOCTOR_REQUIRED", "Assign an active doctor before starting the visit.");
        }
        if (actor.role === "doctor" && appointment.doctor_id !== actor.id) {
          throw new ApiError(403, "VISIT_DOCTOR_FORBIDDEN", "You can only start a visit for your own appointment.");
        }
        await assertActiveDoctor(sql, organizationId, appointment.doctor_id);
        doctorId = appointment.doctor_id;
        branchId = appointment.branch_id || patient.branch_id;
      } else {
        if (actor.role !== "doctor") {
          throw new ApiError(400, "APPOINTMENT_REQUIRED", "Nurses and clinic administrators must start visits from a checked-in appointment.");
        }
        await assertActiveDoctor(sql, organizationId, actor.id);
        doctorId = actor.id;
      }
      await assertBranchIsActive(sql, organizationId, branchId);

      const period = monthInKampala(new Date());
      const ip = helpers.requestIp(c);
      let rows: Record<string, unknown>[];
      try {
        rows = await sql`
          WITH eligible_appointment AS (
            SELECT id
            FROM clinic_appointments
            WHERE id = ${appointmentId}
              AND organization_id = ${organizationId}
              AND patient_id = ${patientId}
              AND status = 'checked_in'
            FOR UPDATE
          ),
          allocation AS (
            INSERT INTO clinic_number_counters (
              organization_id, period, record_type, current_value
            )
            VALUES (${organizationId}, ${period}, 'visit', 1)
            ON CONFLICT (organization_id, period, record_type)
            DO UPDATE SET current_value = clinic_number_counters.current_value + 1,
              updated_at = NOW()
            WHERE clinic_number_counters.current_value < 9999
            RETURNING current_value
          ),
          created AS (
            INSERT INTO clinic_visits (
              organization_id, branch_id, patient_id, appointment_id, doctor_id,
              visit_number, chief_complaint, symptoms, status, created_by
            )
            SELECT ${organizationId}, ${branchId}, ${patientId}, ${appointmentId},
              ${doctorId}, ${`VIS-${period}-`} || lpad(allocation.current_value::text, 4, '0'),
              ${chiefComplaint ?? null}, ${symptoms ?? null}, 'in_progress', ${actor.id}
            FROM allocation
            LEFT JOIN eligible_appointment ON TRUE
            WHERE ${appointmentId === null} OR eligible_appointment.id IS NOT NULL
            RETURNING *
          ),
          appointment_updated AS (
            UPDATE clinic_appointments a
            SET status = 'in_progress', updated_at = NOW()
            FROM created v
            WHERE a.id = v.appointment_id
              AND a.organization_id = ${organizationId}
              AND a.status = 'checked_in'
            RETURNING a.id
          ),
          local_audit AS (
            INSERT INTO clinic_audit (
              organization_id, actor_id, action, target_table, target_id, metadata
            )
            SELECT organization_id, ${actor.id}, 'clinic.visit_started',
              'clinic_visits', id,
              jsonb_build_object(
                'visit_number', visit_number,
                'appointment_linked', appointment_id IS NOT NULL
              )
            FROM created RETURNING id
          ),
          platform_audit AS (
            INSERT INTO audit_log (
              actor_id, sector, action, target_table, target_id, metadata, ip
            )
            SELECT ${actor.id}, 'clinic', 'clinic.visit_started',
              'clinic_visits', id,
              jsonb_build_object(
                'visit_number', visit_number,
                'appointment_linked', appointment_id IS NOT NULL
              ), ${ip}
            FROM created RETURNING id
          )
          SELECT * FROM created
        `;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ApiError(409, "APPOINTMENT_VISIT_EXISTS", "A visit already exists for this appointment.");
        }
        throw error;
      }
      if (!rows[0]) {
        throw new ApiError(409, "APPOINTMENT_NOT_READY", "The appointment changed before the visit could be started.");
      }
      return c.json({ visit: rows[0] }, 201);
    },
  );

  routes.get(
    "/clinic/visits/:id",
    requireRole("superadmin", "clinic_admin", "doctor", "nurse"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      const visit = await visitById(sql, organizationId, id, actor);
      return c.json({ visit });
    },
  );

  routes.patch(
    "/clinic/visits/:id",
    requireRole("doctor"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const body = await readJson(c);
      const allowed = [
        "chief_complaint",
        "symptoms",
        "vitals",
        "examination_notes",
        "diagnosis",
        "diagnosis_code",
        "treatment_plan",
        "referral",
        "follow_up_date",
      ];
      assertAllowedKeys(body, allowed);
      const chiefComplaint = optionalText(body, "chief_complaint", 2000);
      const symptoms = optionalText(body, "symptoms", 4000);
      const vitals = optionalVitals(body);
      const examinationNotes = optionalText(body, "examination_notes", 8000);
      const diagnosis = optionalText(body, "diagnosis", 2000);
      const diagnosisCode = optionalText(body, "diagnosis_code", 100);
      const treatmentPlan = optionalText(body, "treatment_plan", 8000);
      const referral = optionalText(body, "referral", 4000);
      const followUpDate = optionalDate(body, "follow_up_date");
      const fields = allowed.filter((field) => field in body);
      if (!fields.length) {
        throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one visit field to update.");
      }
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      const metadata = JSON.stringify({ fields });
      const ip = helpers.requestIp(c);
      const rows = await sql`
        WITH updated AS (
          UPDATE clinic_visits
          SET chief_complaint = CASE WHEN ${chiefComplaint !== undefined}
                THEN ${chiefComplaint ?? null} ELSE chief_complaint END,
            symptoms = CASE WHEN ${symptoms !== undefined}
                THEN ${symptoms ?? null} ELSE symptoms END,
            vitals = CASE WHEN ${vitals !== undefined}
                THEN ${JSON.stringify(vitals ?? {})}::jsonb ELSE vitals END,
            examination_notes = CASE WHEN ${examinationNotes !== undefined}
                THEN ${examinationNotes ?? null} ELSE examination_notes END,
            diagnosis = CASE WHEN ${diagnosis !== undefined}
                THEN ${diagnosis ?? null} ELSE diagnosis END,
            diagnosis_code = CASE WHEN ${diagnosisCode !== undefined}
                THEN ${diagnosisCode ?? null} ELSE diagnosis_code END,
            treatment_plan = CASE WHEN ${treatmentPlan !== undefined}
                THEN ${treatmentPlan ?? null} ELSE treatment_plan END,
            referral = CASE WHEN ${referral !== undefined}
                THEN ${referral ?? null} ELSE referral END,
            follow_up_date = CASE WHEN ${followUpDate !== undefined}
                THEN ${followUpDate ?? null}::date ELSE follow_up_date END,
            updated_at = NOW()
          WHERE id = ${id}
            AND organization_id = ${organizationId}
            AND doctor_id = ${actor.id}
            AND status = 'in_progress'
            AND deleted_at IS NULL
          RETURNING *
        ),
        local_audit AS (
          INSERT INTO clinic_audit (
            organization_id, actor_id, action, target_table, target_id, metadata
          )
          SELECT organization_id, ${actor.id}, 'clinic.visit_updated',
            'clinic_visits', id, ${metadata}::jsonb
          FROM updated RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (
            actor_id, sector, action, target_table, target_id, metadata, ip
          )
          SELECT ${actor.id}, 'clinic', 'clinic.visit_updated',
            'clinic_visits', id, ${metadata}::jsonb, ${ip}
          FROM updated RETURNING id
        )
        SELECT * FROM updated
      `;
      if (!rows[0]) {
        throw new ApiError(404, "CLINIC_VISIT_NOT_FOUND", "An editable visit assigned to you was not found.");
      }
      return c.json({ visit: rows[0] });
    },
  );

  routes.post(
    "/clinic/visits/:id/complete",
    requireRole("doctor"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      const currentRows = await sql`
        SELECT diagnosis
        FROM clinic_visits
        WHERE id = ${id} AND organization_id = ${organizationId}
          AND doctor_id = ${actor.id} AND status = 'in_progress'
          AND deleted_at IS NULL
        LIMIT 1
      `;
      if (!currentRows[0]) {
        throw new ApiError(404, "CLINIC_VISIT_NOT_FOUND", "An active visit assigned to you was not found.");
      }
      if (!String((currentRows[0] as { diagnosis?: string | null }).diagnosis || "").trim()) {
        throw new ApiError(409, "VISIT_DIAGNOSIS_REQUIRED", "Add a diagnosis before completing this visit.");
      }
      const ip = helpers.requestIp(c);
      const rows = await sql`
        WITH updated AS (
          UPDATE clinic_visits
          SET status = 'completed', visit_ended_at = NOW(), updated_at = NOW()
          WHERE id = ${id} AND organization_id = ${organizationId}
            AND doctor_id = ${actor.id} AND status = 'in_progress'
            AND deleted_at IS NULL
            AND NULLIF(BTRIM(diagnosis), '') IS NOT NULL
          RETURNING *
        ),
        appointment_updated AS (
          UPDATE clinic_appointments a
          SET status = 'completed', updated_at = NOW()
          FROM updated v
          WHERE a.id = v.appointment_id
            AND a.organization_id = ${organizationId}
            AND a.status = 'in_progress'
          RETURNING a.id
        ),
        local_audit AS (
          INSERT INTO clinic_audit (
            organization_id, actor_id, action, target_table, target_id, metadata
          )
          SELECT organization_id, ${actor.id}, 'clinic.visit_completed',
            'clinic_visits', id,
            jsonb_build_object('status', status, 'appointment_linked', appointment_id IS NOT NULL)
          FROM updated RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (
            actor_id, sector, action, target_table, target_id, metadata, ip
          )
          SELECT ${actor.id}, 'clinic', 'clinic.visit_completed',
            'clinic_visits', id,
            jsonb_build_object('status', status, 'appointment_linked', appointment_id IS NOT NULL),
            ${ip}
          FROM updated RETURNING id
        )
        SELECT * FROM updated
      `;
      if (!rows[0]) {
        throw new ApiError(409, "VISIT_NOT_COMPLETABLE", "The visit changed before it could be completed.");
      }
      return c.json({ visit: rows[0] });
    },
  );

  routes.post(
    "/clinic/visits/:id/refer",
    requireRole("doctor"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const body = await readJson(c);
      assertAllowedKeys(body, ["referral", "follow_up_date"]);
      const referral = requiredText(body, "referral", 4000);
      const followUpDate = optionalDate(body, "follow_up_date");
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      const metadata = JSON.stringify({ fields: ["referral", ...(followUpDate !== undefined ? ["follow_up_date"] : [])], status: "referred" });
      const ip = helpers.requestIp(c);
      const rows = await sql`
        WITH updated AS (
          UPDATE clinic_visits
          SET referral = ${referral},
            follow_up_date = CASE WHEN ${followUpDate !== undefined}
              THEN ${followUpDate ?? null}::date ELSE follow_up_date END,
            status = 'referred', visit_ended_at = NOW(), updated_at = NOW()
          WHERE id = ${id} AND organization_id = ${organizationId}
            AND doctor_id = ${actor.id} AND status = 'in_progress'
            AND deleted_at IS NULL
          RETURNING *
        ),
        appointment_updated AS (
          UPDATE clinic_appointments a
          SET status = 'completed', updated_at = NOW()
          FROM updated v
          WHERE a.id = v.appointment_id
            AND a.organization_id = ${organizationId}
            AND a.status = 'in_progress'
          RETURNING a.id
        ),
        local_audit AS (
          INSERT INTO clinic_audit (
            organization_id, actor_id, action, target_table, target_id, metadata
          )
          SELECT organization_id, ${actor.id}, 'clinic.visit_referred',
            'clinic_visits', id, ${metadata}::jsonb
          FROM updated RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (
            actor_id, sector, action, target_table, target_id, metadata, ip
          )
          SELECT ${actor.id}, 'clinic', 'clinic.visit_referred',
            'clinic_visits', id, ${metadata}::jsonb, ${ip}
          FROM updated RETURNING id
        )
        SELECT * FROM updated
      `;
      if (!rows[0]) {
        throw new ApiError(404, "CLINIC_VISIT_NOT_FOUND", "An active visit assigned to you was not found.");
      }
      return c.json({ visit: rows[0] });
    },
  );

  routes.delete(
    "/clinic/visits/:id",
    requireRole("clinic_admin"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      const metadata = JSON.stringify({ effect: "soft-deleted; clinical record retained" });
      const ip = helpers.requestIp(c);
      const rows = await sql`
        WITH deleted AS (
          UPDATE clinic_visits
          SET status = 'voided', deleted_at = NOW(),
            visit_ended_at = COALESCE(visit_ended_at, NOW()), updated_at = NOW()
          WHERE id = ${id} AND organization_id = ${organizationId}
            AND deleted_at IS NULL AND status <> 'voided'
          RETURNING *
        ),
        local_audit AS (
          INSERT INTO clinic_audit (
            organization_id, actor_id, action, target_table, target_id, metadata
          )
          SELECT organization_id, ${actor.id}, 'clinic.visit_voided',
            'clinic_visits', id, ${metadata}::jsonb
          FROM deleted RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (
            actor_id, sector, action, target_table, target_id, metadata, ip
          )
          SELECT ${actor.id}, 'clinic', 'clinic.visit_voided',
            'clinic_visits', id, ${metadata}::jsonb, ${ip}
          FROM deleted RETURNING id
        )
        SELECT id, visit_number, status, deleted_at FROM deleted
      `;
      if (!rows[0]) {
        throw new ApiError(404, "CLINIC_VISIT_NOT_FOUND", "Active Clinic visit was not found.");
      }
      return c.json({ visit: rows[0], deleted: true });
    },
  );

  routes.get(
    "/clinic/visits/:id/notes",
    requireRole("clinic_admin", "doctor", "nurse"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      await visitById(sql, organizationId, id, actor);
      const notes = await sql`
        SELECT n.id, n.visit_id, n.note_type, n.note_text, n.created_by,
          n.created_at, u.name AS author_name
        FROM clinic_visit_notes n
        JOIN clinic_visits v
          ON v.id = n.visit_id AND v.organization_id = n.organization_id
        LEFT JOIN users u ON u.id = n.created_by
        WHERE n.visit_id = ${id}
          AND n.organization_id = ${organizationId}
          AND v.deleted_at IS NULL AND v.status <> 'voided'
          AND (${actor.role !== "doctor"} OR v.doctor_id = ${actor.id})
        ORDER BY n.created_at ASC
        LIMIT 200
      `;
      return c.json({ notes });
    },
  );

  routes.post(
    "/clinic/visits/:id/notes",
    requireRole("doctor", "nurse"),
    async (c) => {
      const id = pathUuid(c.req.param("id"));
      const body = await readJson(c);
      assertAllowedKeys(body, ["note_type", "note_text"]);
      const noteType = optionalText(body, "note_type", 50);
      const noteText = requiredText(body, "note_text", 5000);
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      const visit = await visitById(sql, organizationId, id, actor) as { status: string };
      if (visit.status !== "in_progress") {
        throw new ApiError(409, "VISIT_NOT_EDITABLE", "Notes can only be added while the visit is in progress.");
      }
      const metadata = JSON.stringify({ note_length: noteText.length });
      const ip = helpers.requestIp(c);
      const rows = await sql`
        WITH created AS (
          INSERT INTO clinic_visit_notes (
            organization_id, visit_id, note_type, note_text, created_by
          )
          SELECT ${organizationId}, v.id, ${noteType ?? null}, ${noteText}, ${actor.id}
          FROM clinic_visits v
          WHERE v.id = ${id} AND v.organization_id = ${organizationId}
            AND v.status = 'in_progress' AND v.deleted_at IS NULL
            AND (${actor.role !== "doctor"} OR v.doctor_id = ${actor.id})
          RETURNING *
        ),
        local_audit AS (
          INSERT INTO clinic_audit (
            organization_id, actor_id, action, target_table, target_id, metadata
          )
          SELECT organization_id, ${actor.id}, 'clinic.visit_note_created',
            'clinic_visit_notes', id, ${metadata}::jsonb
          FROM created RETURNING id
        ),
        platform_audit AS (
          INSERT INTO audit_log (
            actor_id, sector, action, target_table, target_id, metadata, ip
          )
          SELECT ${actor.id}, 'clinic', 'clinic.visit_note_created',
            'clinic_visit_notes', id, ${metadata}::jsonb, ${ip}
          FROM created RETURNING id
        )
        SELECT created.*, users.name AS author_name
        FROM created
        LEFT JOIN users ON users.id = created.created_by
      `;
      if (!rows[0]) {
        throw new ApiError(409, "VISIT_NOT_EDITABLE", "The visit changed before the note could be saved.");
      }
      return c.json({ note: rows[0] }, 201);
    },
  );

  routes.get(
    "/clinic/today",
    requireRole("superadmin", "clinic_admin", "doctor", "nurse", "receptionist", "pharmacist"),
    async (c) => {
      const actor = c.get("user");
      const sql = getDb(c.env);
      const organizationId = await resolveOrganization(c, helpers.organizationForRequest);
      const date = todayInKampala();
      const [start, end] = clinicDateBounds(date);
      const [appointmentRows, countRows, visitRows] = await Promise.all([
        listAppointments(sql, organizationId, {
          date,
          doctorId: actor.role === "doctor" ? actor.id : null,
          limit: 250,
        }),
        sql`
          SELECT
            COUNT(*) FILTER (WHERE status = 'scheduled') AS scheduled_count,
            COUNT(*) FILTER (WHERE status = 'checked_in') AS checked_in_count,
            COUNT(*) FILTER (WHERE status = 'completed') AS completed_count
          FROM clinic_appointments
          WHERE organization_id = ${organizationId}
            AND scheduled_for >= ${start}::timestamptz
            AND scheduled_for < ${end}::timestamptz
            AND (${actor.role !== "doctor"} OR doctor_id = ${actor.id})
        `,
        sql`
          SELECT v.id, v.visit_number, v.patient_id, v.doctor_id,
            v.chief_complaint,
            v.visit_started_at, p.first_name || ' ' || p.last_name AS patient_name,
            p.patient_number, d.name AS doctor_name
          FROM clinic_visits v
          JOIN clinic_patients p
            ON p.id = v.patient_id AND p.organization_id = v.organization_id
          LEFT JOIN users d ON d.id = v.doctor_id
          WHERE v.organization_id = ${organizationId}
            AND v.status = 'in_progress' AND v.deleted_at IS NULL
            AND (${actor.role !== "doctor"} OR v.doctor_id = ${actor.id})
          ORDER BY v.visit_started_at DESC
          LIMIT 200
        `,
      ]);
      const restrictedRole = actor.role === "pharmacist";
      return c.json({
        date,
        appointments_today: restrictedRole ? [] : appointmentRows,
        scheduled_count: countRows[0]?.scheduled_count ?? 0,
        checked_in_count: countRows[0]?.checked_in_count ?? 0,
        completed_count: countRows[0]?.completed_count ?? 0,
        in_progress_visits: restrictedRole ? [] : visitRows,
      });
    },
  );

  return routes;
}
