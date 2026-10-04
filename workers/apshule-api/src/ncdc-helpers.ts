import { ApiError, getDb } from "./db.js";
import { optionalString, requiredString } from "./http.js";
import type { AuthenticatedUser } from "./types.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_INT32 = 2_147_483_647;

export function validateUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a valid UUID.`);
  }
  return value;
}

export function requiredBodyUuid(
  body: Record<string, unknown>,
  field: string,
): string {
  return validateUuid(requiredString(body, field, { max: 36 }), field);
}

export function optionalBodyUuid(
  body: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = optionalString(body, field, { max: 36, allowNull: true });
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return validateUuid(value, field);
}

export function optionalBodyText(
  body: Record<string, unknown>,
  field: string,
  max: number,
): string | null | undefined {
  const value = optionalString(body, field, { max, allowNull: true });
  return value === "" ? null : value;
}

export function optionalBodyHttpsUrl(
  body: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = optionalBodyText(body, field, 499);
  if (value === undefined || value === null) return value;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `${field} must be a valid HTTPS URL shorter than 500 characters.`,
    );
  }
  if (!value.startsWith("https://") || parsed.protocol !== "https:" || !parsed.hostname) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `${field} must be a valid HTTPS URL shorter than 500 characters.`,
    );
  }
  return value;
}

export function queryText(
  value: string | undefined,
  field: string,
  max: number,
): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `${field} must be no longer than ${max} characters.`,
    );
  }
  return trimmed;
}

export function queryUuid(value: string | undefined, field: string): string | null {
  const parsed = queryText(value, field, 36);
  return parsed === null ? null : validateUuid(parsed, field);
}

export function routeUuid(value: string, field = "id"): string {
  return validateUuid(value, field);
}

export function optionalBoolean(
  body: Record<string, unknown>,
  field: string,
): boolean | undefined {
  if (!(field in body)) return undefined;
  if (typeof body[field] !== "boolean") {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a boolean.`);
  }
  return body[field] as boolean;
}

export function requiredBoolean(
  body: Record<string, unknown>,
  field: string,
  fallback: boolean,
): boolean {
  return optionalBoolean(body, field) ?? fallback;
}

export function optionalInteger(
  body: Record<string, unknown>,
  field: string,
  options: { min?: number; max?: number; allowNull?: boolean } = {},
): number | null | undefined {
  if (!(field in body)) return undefined;
  const value = body[field];
  if (value === null && options.allowNull) return null;
  const min = options.min ?? 0;
  const max = options.max ?? MAX_INT32;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `${field} must be an integer between ${min} and ${max}.`,
    );
  }
  return value;
}

export function requiredInteger(
  body: Record<string, unknown>,
  field: string,
  options: { min?: number; max?: number } = {},
): number {
  const value = optionalInteger(body, field, options);
  if (value === undefined || value === null) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} is required.`);
  }
  return value;
}

export function optionalTimestamp(
  body: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = optionalBodyText(body, field, 80);
  if (value === undefined || value === null) return value;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a valid date and time.`);
  }
  return new Date(milliseconds).toISOString();
}

export function linkedSchoolId(user: AuthenticatedUser): string {
  if (!user.schoolId) {
    throw new ApiError(
      403,
      "SCHOOL_NOT_LINKED",
      "This account is not linked to a school.",
    );
  }
  return user.schoolId;
}

export function requestIp(headers: Headers): string | null {
  return (
    headers.get("CF-Connecting-IP") ??
    headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    null
  )?.slice(0, 255) ?? null;
}

type LinkedUser = { id: string; role: string; school_id: string | null };
type LearnerUser = LinkedUser & { class_level: string | null };
export type TeacherScope = LinkedUser & {
  assigned_classes: string[];
  subjects_taught: string[];
};

export async function requireLearner(
  sql: ReturnType<typeof getDb>,
  id: string,
): Promise<LearnerUser> {
  const rows = await sql`
    SELECT id, role, school_id, class_level
    FROM users
    WHERE id = ${id}
    LIMIT 1
  `;
  const learner = rows[0] as LearnerUser | undefined;
  if (!learner || learner.role !== "individual") {
    throw new ApiError(404, "LEARNER_NOT_FOUND", "Learner was not found.");
  }
  return learner;
}

export async function requireTeacherScope(
  sql: ReturnType<typeof getDb>,
  id: string,
): Promise<TeacherScope> {
  const rows = await sql`
    SELECT id, role, school_id, assigned_classes, subjects_taught
    FROM users
    WHERE id = ${id}
    LIMIT 1
  `;
  const teacher = rows[0] as
    | (LinkedUser & {
        assigned_classes: string[] | null;
        subjects_taught: string[] | null;
      })
    | undefined;
  if (!teacher || teacher.role !== "teacher") {
    throw new ApiError(404, "TEACHER_NOT_FOUND", "Teacher was not found.");
  }
  return {
    ...teacher,
    assigned_classes: teacher.assigned_classes ?? [],
    subjects_taught: teacher.subjects_taught ?? [],
  };
}

export function teacherHasClass(
  teacher: TeacherScope,
  classLevel: string | null | undefined,
): boolean {
  return Boolean(classLevel && teacher.assigned_classes.includes(classLevel));
}

export function assertTeacherCanAccessLearner(
  teacher: TeacherScope,
  learner: LearnerUser,
): void {
  if (
    !teacherHasClass(teacher, learner.class_level) ||
    (teacher.school_id !== null && teacher.school_id !== learner.school_id)
  ) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "This learner is outside your assigned classes or school.",
    );
  }
}

export async function requireTeacher(
  sql: ReturnType<typeof getDb>,
  id: string,
): Promise<LinkedUser> {
  const rows = await sql`
    SELECT id, role, school_id
    FROM users
    WHERE id = ${id}
    LIMIT 1
  `;
  const teacher = rows[0] as LinkedUser | undefined;
  if (!teacher || teacher.role !== "teacher") {
    throw new ApiError(404, "TEACHER_NOT_FOUND", "Teacher was not found.");
  }
  return teacher;
}

export function assertSameSchool(
  recordSchoolId: string | null,
  actorSchoolId: string,
  resource: string,
): void {
  if (recordSchoolId !== actorSchoolId) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      `You can only manage ${resource} for your school.`,
    );
  }
}

export function validateScore(value: number | null | undefined, field: string) {
  if (value !== undefined && value !== null && value > MAX_INT32) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} is outside the supported integer range.`);
  }
}