import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { ApiError, getDb } from "../db.js";
import { authMiddleware, hashPassword, requireRole } from "../auth.js";
import { readJson, validEmail } from "../http.js";
import { sendEmail, welcomeEmailTemplate } from "../email.js";
import { linkedSchoolId, requestIp } from "../ncdc-helpers.js";
import type { AppEnv } from "../types.js";

const bulkImportRoutes = new Hono<AppEnv>();
const MAX_IMPORT_ROWS = 100;
const MAX_LIST_ITEMS = 30;
const CLASS_LEVELS = [
  "Baby",
  "Middle",
  "Top",
  "P1",
  "P2",
  "P3",
  "P4",
  "P5",
  "P6",
  "P7",
  "S1",
  "S2",
  "S3",
  "S4",
  "S5",
  "S6",
] as const;

type ImportType = "students" | "teachers";
type ImportRow = {
  name: string;
  email: string;
  phone: string | null;
  gender: string | null;
  classLevel: string | null;
  lin: string | null;
  subjectsTaught: string[];
  assignedClasses: string[];
  defaultPassword: string;
  passwordHash: string;
  sourceRow: number;
};
type RowError = { row: number; reason: string; errors: string[] };

const rejectImpersonatedImports = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("user").impersonatedBy) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Bulk imports are unavailable during an impersonation session.",
    );
  }
  await next();
});
const importAccess = [
  authMiddleware,
  requireRole("school", "superadmin"),
  rejectImpersonatedImports,
] as const;

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    .test(value);
}

function cellText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value).trim();
  return "";
}

function canonicalClass(value: string): string | null {
  return CLASS_LEVELS.find((item) => item.toLowerCase() === value.toLowerCase()) ?? null;
}

function normalizeGender(value: string): string | null | undefined {
  if (!value) return null;
  const normalized = value.toLowerCase().replaceAll(" ", "_");
  const choices: Record<string, string> = {
    f: "female",
    female: "female",
    m: "male",
    male: "male",
    other: "other",
    prefer_not_to_say: "prefer_not_to_say",
  };
  return choices[normalized];
}

function listValue(value: unknown): string[] | null {
  let parts: unknown[];
  if (Array.isArray(value)) {
    parts = value;
  } else if (typeof value === "string") {
    parts = value.split(",");
  } else if (value === undefined || value === null || value === "") {
    return [];
  } else {
    return null;
  }

  if (parts.length > MAX_LIST_ITEMS || parts.some((item) => typeof item !== "string")) {
    return null;
  }
  return [...new Set(parts.map((item) => (item as string).trim()).filter(Boolean))];
}

export function generateDefaultPassword(name: string, phone: string | null): string {
  const digits = phone?.replace(/\D/gu, "") ?? "";
  if (!digits) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    const ceiling = Math.floor(256 / alphabet.length) * alphabet.length;
    const password: string[] = [];
    while (password.length < 8) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      for (const byte of bytes) {
        if (byte < ceiling) password.push(alphabet[byte % alphabet.length]!);
        if (password.length === 8) break;
      }
    }
    return password.join("");
  }

  const namePrefix = Array.from(name).slice(0, 4).join("").padEnd(4, "x");
  const phoneSuffix = digits.slice(-4).padStart(4, "0");
  return namePrefix + phoneSuffix;
}

function validateRow(
  type: ImportType,
  value: unknown,
  index: number,
): { row?: Omit<ImportRow, "defaultPassword" | "passwordHash">; errors?: RowError } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const messages = ["Row must contain an object of fields."];
    return {
      errors: { row: index + 2, reason: messages.join(" "), errors: messages },
    };
  }

  const source = value as Record<string, unknown>;
  const name = cellText(source.name);
  const email = cellText(source.email).toLowerCase();
  const phoneText = cellText(source.phone);
  const phone = phoneText || null;
  const genderText = cellText(source.gender);
  const gender = normalizeGender(genderText);
  const classText = cellText(source.class_level ?? source.classLevel);
  const classLevel = type === "students" ? canonicalClass(classText) : null;
  const linText = cellText(source.lin);
  const subjectsTaught = type === "teachers"
    ? listValue(source.subjects_taught ?? source.subjectsTaught)
    : [];
  const assignedClasses = type === "teachers"
    ? listValue(source.assigned_classes ?? source.assignedClasses)
    : [];
  const errors: string[] = [];

  if (!name || name.length > 120) errors.push("Name is required and must be 120 characters or fewer.");
  if (!email || email.length > 254 || !validEmail(email)) {
    errors.push("Email must be a valid address of 254 characters or fewer.");
  }
  if (phone && phone.length > 40) errors.push("Phone must be 40 characters or fewer.");
  if (genderText && gender === undefined) {
    errors.push("Gender must be F, M, Female, Male, Other, or Prefer not to say.");
  }
  if (type === "students" && !classLevel) {
    errors.push("Class level must be Baby, Middle, Top, P1–P7, or S1–S6.");
  }
  if (type === "students" && linText.length > 50) {
    errors.push("LIN must be 50 characters or fewer.");
  }
  if (type === "teachers" && subjectsTaught === null) {
    errors.push("Subjects taught must be a comma-separated list of at most 30 values.");
  }
  if (
    type === "teachers" &&
    assignedClasses === null
  ) {
    errors.push("Assigned classes must be a list of at most 30 supported class levels.");
  }

  const normalizedAssignedClasses = assignedClasses?.map(canonicalClass);
  if (
    type === "teachers" &&
    normalizedAssignedClasses?.some((item) => item === null)
  ) {
    errors.push("Assigned classes may contain only Baby, Middle, Top, P1–P7, or S1–S6.");
  }
  if (type === "teachers") {
    for (const subject of subjectsTaught ?? []) {
      if (!subject || subject.length > 80) {
        errors.push("Each subject must be between 1 and 80 characters.");
        break;
      }
    }
  }

  if (errors.length) {
    return { errors: { row: index + 2, reason: errors.join(" "), errors } };
  }
  return {
    row: {
      name,
      email,
      phone,
      gender: gender ?? null,
      classLevel,
      lin: type === "students" ? linText || null : null,
      subjectsTaught: type === "teachers" ? subjectsTaught! : [],
      assignedClasses: type === "teachers"
        ? normalizedAssignedClasses as string[]
        : [],
      sourceRow: index + 2,
    },
  };
}

async function resolveSchoolId(
  c: Context<AppEnv>,
  requestedId?: unknown,
): Promise<string> {
  const user = c.get("user");
  if (user.role === "school") return linkedSchoolId(user);

  const schoolId = typeof requestedId === "string" ? requestedId.trim() : "";
  if (!validUuid(schoolId)) {
    throw new ApiError(400, "VALIDATION_ERROR", "A valid school_id is required for Super Admin imports.");
  }
  const sql = getDb(c.env);
  const rows = await sql`SELECT id FROM schools WHERE id = ${schoolId}::uuid LIMIT 1`;
  if (!rows.length) {
    throw new ApiError(404, "SCHOOL_NOT_FOUND", "The selected school was not found.");
  }
  return schoolId;
}

function csvTemplate(type: ImportType): string {
  if (type === "students") {
    return [
      "name,email,phone,gender,class_level,lin",
      "Example Student,student@example.com,0700000000,F,P1,LIN0001",
    ].join("\r\n") + "\r\n";
  }
  return [
    "name,email,phone,gender,subjects_taught,assigned_classes",
    "Example Teacher,teacher@example.com,0700000000,M,Mathematics,P1",
  ].join("\r\n") + "\r\n";
}

bulkImportRoutes.get(
  "/school/bulk-import/template",
  ...importAccess,
  async (c) => {
    const type = c.req.query("type");
    if (type !== "students" && type !== "teachers") {
      throw new ApiError(400, "VALIDATION_ERROR", "type must be students or teachers.");
    }
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="${type}-template.csv"`);
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(csvTemplate(type));
  },
);

bulkImportRoutes.get(
  "/school/bulk-import/history",
  ...importAccess,
  async (c) => {
    const schoolId = await resolveSchoolId(c, c.req.query("school_id"));
    const sql = getDb(c.env);
    const history = await sql`
      SELECT id, import_type, total_rows, created_count, skipped_count,
        error_count, errors, created_at
      FROM bulk_import_log
      WHERE school_id = ${schoolId}::uuid
      ORDER BY created_at DESC
      LIMIT 20
    `;
    return c.json({ school_id: schoolId, imports: history });
  },
);

async function importAccounts(
  c: Context<AppEnv>,
  type: ImportType,
) {
  const body = await readJson(c);
  const values = body.rows;
  if (!Array.isArray(values) || values.length === 0) {
    throw new ApiError(400, "VALIDATION_ERROR", "rows must be a non-empty array.");
  }
  if (values.length > MAX_IMPORT_ROWS) {
    throw new ApiError(
      413,
      "IMPORT_TOO_LARGE",
      `A single import can contain at most ${MAX_IMPORT_ROWS} rows.`,
    );
  }

  const actor = c.get("user");
  const schoolId = await resolveSchoolId(c, body.school_id);
  const validRows: Omit<ImportRow, "defaultPassword" | "passwordHash">[] = [];
  const errors: RowError[] = [];
  values.forEach((value, index) => {
    const result = validateRow(type, value, index);
    if (result.row) validRows.push(result.row);
    if (result.errors) errors.push(result.errors);
  });

  const rowsWithCredentials: ImportRow[] = await mapWithConcurrency(
    validRows,
    8,
    async (row) => {
      const defaultPassword = generateDefaultPassword(row.name, row.phone);
      return {
        ...row,
        defaultPassword,
        passwordHash: await hashPassword(defaultPassword),
      };
    },
  );
  const isTeacher = type === "teachers";
  const records = rowsWithCredentials.map((row) => ({
    name: row.name,
    email: row.email,
    phone: row.phone,
    gender: row.gender,
    class_level: row.classLevel,
    lin: row.lin,
    password_hash: row.passwordHash,
    subjects_taught: row.subjectsTaught.join(","),
    assigned_classes: row.assignedClasses.join(","),
    input_order: row.sourceRow,
  }));
  const sql = getDb(c.env);
  const auditAction = isTeacher ? "bulk_import_teachers" : "bulk_import_students";
  const resultRows = await sql`
    WITH incoming AS (
      SELECT *
      FROM jsonb_to_recordset(${JSON.stringify(records)}::jsonb) AS source(
        name text,
        email text,
        phone text,
        gender text,
        class_level text,
        lin text,
        password_hash text,
        subjects_taught text,
        assigned_classes text,
        input_order integer
      )
    ),
    created AS (
      INSERT INTO users (
        name, email, phone, password_hash, role, sector, waitlist, school_id,
        class_level, subjects_taught, assigned_classes, lin, gender
      )
      SELECT
        incoming.name,
        incoming.email,
        incoming.phone,
        incoming.password_hash,
        ${isTeacher ? "teacher" : "individual"},
        'education',
        FALSE,
        ${schoolId}::uuid,
        CASE WHEN ${isTeacher} THEN NULL ELSE incoming.class_level END,
        CASE
          WHEN ${isTeacher} AND incoming.subjects_taught <> ''
            THEN string_to_array(incoming.subjects_taught, ',')
          ELSE ARRAY[]::text[]
        END,
        CASE
          WHEN ${isTeacher} AND incoming.assigned_classes <> ''
            THEN string_to_array(incoming.assigned_classes, ',')
          ELSE ARRAY[]::text[]
        END,
        CASE WHEN ${isTeacher} THEN NULL ELSE incoming.lin END,
        incoming.gender
      FROM incoming
      ORDER BY incoming.input_order
      ON CONFLICT DO NOTHING
      RETURNING id, name, email
    ),
    logged AS (
      INSERT INTO bulk_import_log (
        school_id, imported_by, import_type, total_rows, created_count,
        skipped_count, error_count, errors
      )
      VALUES (
        ${schoolId}::uuid,
        ${actor.id}::uuid,
        ${type},
        ${values.length},
        (SELECT COUNT(*)::int FROM created),
        ${validRows.length} - (SELECT COUNT(*)::int FROM created),
        ${errors.length},
        ${JSON.stringify(errors)}::jsonb
      )
      RETURNING id
    ),
    audited AS (
      INSERT INTO audit_log (
        actor_id, sector, action, target_table, target_id, metadata, ip
      )
      SELECT
        ${actor.id}::uuid,
        'education',
        ${auditAction},
        'bulk_import_log',
        logged.id,
        jsonb_build_object(
          'import_type', ${type},
          'school_id', ${schoolId},
          'total_rows', ${values.length},
          'created_count', (SELECT COUNT(*)::int FROM created),
          'skipped_count', ${validRows.length} - (SELECT COUNT(*)::int FROM created),
          'error_count', ${errors.length}
        ),
        ${requestIp(c.req.raw.headers)}
      FROM logged
      RETURNING id
    )
    SELECT logged.id AS import_id, created.id, created.name, created.email
    FROM logged
    CROSS JOIN audited
    LEFT JOIN created ON TRUE
  `;

  const importId = resultRows[0]?.import_id as string | undefined;
  if (!importId) {
    throw new ApiError(500, "IMPORT_LOG_FAILED", "The import could not be recorded.");
  }
  const inserted = resultRows.filter((row) => typeof row.id === "string");
  const createdEmails = new Set(inserted.map((row) => String(row.email).toLowerCase()));
  const firstRowByEmail = new Map<string, ImportRow>();
  for (const row of rowsWithCredentials) {
    if (!firstRowByEmail.has(row.email)) firstRowByEmail.set(row.email, row);
  }

  const credentials = inserted.map((row) => {
    const source = firstRowByEmail.get(String(row.email).toLowerCase());
    if (!source) {
      throw new ApiError(500, "IMPORT_RESULT_INVALID", "Created account details could not be matched.");
    }
    return {
      name: String(row.name),
      email: String(row.email),
      default_password: source.defaultPassword,
    };
  });
  c.executionCtx.waitUntil(
    Promise.allSettled(
      credentials.map((credential) =>
        sendEmail(c.env, {
          to: credential.email,
          subject: "Welcome to APSHULE",
          html: welcomeEmailTemplate(
            credential.name,
            isTeacher ? "teacher" : "student",
            credential.default_password,
            c.env.APP_URL,
          ),
        }),
      ),
    ),
  );
  const skippedRows = rowsWithCredentials
    .filter((row) => !createdEmails.has(row.email) || firstRowByEmail.get(row.email) !== row)
    .map((row) => ({
      row: row.sourceRow,
      email: row.email,
      reason: "Email already exists or appears more than once in this import.",
    }));
  const skippedCount = validRows.length - credentials.length;

  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  return c.json({
    import_id: importId,
    import_type: type,
    school_id: schoolId,
    total_rows: values.length,
    created_count: credentials.length,
    skipped_count: skippedCount,
    error_count: errors.length,
    credentials,
    created: credentials.length,
    skipped: skippedCount,
    skipped_rows: skippedRows,
    errors,
  }, 201);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await mapper(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

bulkImportRoutes.post(
  "/school/bulk-import/students",
  ...importAccess,
  async (c) => importAccounts(c, "students"),
);

bulkImportRoutes.post(
  "/school/bulk-import/teachers",
  ...importAccess,
  async (c) => importAccounts(c, "teachers"),
);

export default bulkImportRoutes;