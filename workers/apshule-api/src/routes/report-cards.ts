import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { ApiError, getDb } from "../db.js";
import { authMiddleware, requireRole } from "../auth.js";
import { optionalString, readJson, requiredString } from "../http.js";
import {
  assertTeacherCanAccessLearner,
  linkedSchoolId,
  requestIp,
  requireTeacherScope,
} from "../ncdc-helpers.js";
import {
  calculateReportMark,
  templateLevelForClass,
  type ReportTemplateLevel,
} from "../report-cards-domain.js";
import {
  generateReportPDF,
  type ReportCardPdfData,
  type ReportImage,
} from "../pdf/report.js";
import type { AppEnv, AuthenticatedUser } from "../types.js";

const reportRoutes = new Hono<AppEnv>();
const STAFF_ROLES: AuthenticatedUser["role"][] = ["teacher", "school", "superadmin"];

const educationAccess = createMiddleware<AppEnv>(async (c, next) => {
  const user = c.get("user");
  if (user.role !== "superadmin" && user.sector !== "education") {
    throw new ApiError(403, "FORBIDDEN", "Report cards are available in the Education sector only.");
  }
  await next();
});

function routeUuid(value: string, field = "id"): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a valid UUID.`);
  }
  return value;
}

function queryText(value: string | undefined, field: string, max: number): string | null {
  if (value === undefined || value.trim() === "") return null;
  const text = value.trim();
  if (text.length > max) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be no longer than ${max} characters.`);
  }
  return text;
}

function parseYear(value: unknown, field = "year"): number {
  const year = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be a year from 2000 to 2100.`);
  }
  return year;
}

function optionalYear(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  return parseYear(value);
}

function scoreValue(value: unknown, field: string, required: boolean): number | null {
  if (value === undefined || value === null || value === "") {
    if (required) {
      throw new ApiError(400, "VALIDATION_ERROR", `${field} is required and must be between 0 and 100.`);
    }
    return null;
  }
  const score = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} must be between 0 and 100.`);
  }
  return Math.round(score * 100) / 100;
}

function imageBytesFromBase64(source: string, maxBytes: number): ReportImage {
  const match = source.match(/^data:(image\/(?:png|jpeg|jpg));base64,([A-Za-z0-9+/=\s]+)$/iu);
  if (!match) {
    throw new ApiError(422, "INVALID_IMAGE", "Image data must be a PNG or JPEG data URL.");
  }
  const mimeType = match[1]!.toLowerCase() === "image/png" ? "image/png" : "image/jpeg";
  const encoded = match[2]!.replace(/\s+/gu, "");
  if (encoded.length > Math.ceil((maxBytes * 4) / 3) + 8) {
    throw new ApiError(413, "IMAGE_TOO_LARGE", "Image must be no larger than 800 KB.");
  }
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new ApiError(422, "INVALID_IMAGE", "Image data is not valid base64.");
  }
  if (binary.length > maxBytes) {
    throw new ApiError(413, "IMAGE_TOO_LARGE", "Image must be no larger than 800 KB.");
  }
  return {
    mimeType,
    bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  };
}

function assertPublicHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(422, "INVALID_IMAGE_URL", "The image URL is invalid.");
  }
  const hostname = url.hostname.toLowerCase();
  const blocked =
    url.protocol !== "https:" ||
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    /^127\./u.test(hostname) ||
    /^10\./u.test(hostname) ||
    /^192\.168\./u.test(hostname) ||
    /^169\.254\./u.test(hostname) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./u.test(hostname);
  if (blocked) {
    throw new ApiError(422, "INVALID_IMAGE_URL", "Image URLs must use a public HTTPS host.");
  }
  return url;
}

async function readLimitedImageResponse(response: Response): Promise<ReportImage> {
  if (!response.ok) {
    throw new ApiError(422, "IMAGE_UNAVAILABLE", "The configured image could not be loaded.");
  }
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
    throw new ApiError(422, "UNSUPPORTED_IMAGE", "Only PNG or JPEG images can be embedded in a report.");
  }
  const maxBytes = 800_000;
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) {
    throw new ApiError(413, "IMAGE_TOO_LARGE", "Image must be no larger than 800 KB.");
  }
  if (!response.body) {
    throw new ApiError(422, "IMAGE_UNAVAILABLE", "The configured image had no readable content.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ApiError(413, "IMAGE_TOO_LARGE", "Image must be no larger than 800 KB.");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, mimeType };
}

async function loadReportImage(value: string | null | undefined): Promise<ReportImage | undefined> {
  const source = value?.trim();
  if (!source) return undefined;
  if (source.startsWith("data:")) return imageBytesFromBase64(source, 800_000);
  const url = assertPublicHttpsUrl(source);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "image/png,image/jpeg" },
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new ApiError(422, "IMAGE_UNAVAILABLE", "The configured image could not be loaded.");
  }
  if (response.status >= 300 && response.status < 400) {
    throw new ApiError(422, "IMAGE_REDIRECT_BLOCKED", "Image URLs that redirect cannot be embedded.");
  }
  return readLimitedImageResponse(response);
}

async function loadEducationLearner(
  sql: ReturnType<typeof getDb>,
  learnerId: string,
) {
  const rows = await sql`
    SELECT id, name, role, sector, school_id, class_level, lin, gender
    FROM users
    WHERE id = ${learnerId}
      AND role = 'individual'
      AND sector = 'education'
    LIMIT 1
  `;
  const learner = rows[0] as
    | {
        id: string;
        name: string;
        role: string;
        sector: string;
        school_id: string | null;
        class_level: string | null;
        lin: string | null;
        gender: string | null;
      }
    | undefined;
  if (!learner) throw new ApiError(404, "LEARNER_NOT_FOUND", "Education learner was not found.");
  return learner;
}

async function assertStaffCanAccessCard(
  sql: ReturnType<typeof getDb>,
  user: AuthenticatedUser,
  card: { school_id: string | null; class_name: string },
): Promise<void> {
  if (user.role === "superadmin") return;
  if (user.role === "school") {
    if (linkedSchoolId(user) !== card.school_id) {
      throw new ApiError(403, "FORBIDDEN", "This report card is outside your school.");
    }
    return;
  }
  if (user.role === "teacher") {
    const teacher = await requireTeacherScope(sql, user.id);
    if (
      !teacher.assigned_classes.includes(card.class_name) ||
      (teacher.school_id !== null && teacher.school_id !== card.school_id)
    ) {
      throw new ApiError(403, "FORBIDDEN", "This report card is outside your assigned classes or school.");
    }
    return;
  }
  throw new ApiError(403, "FORBIDDEN", "This account cannot access staff report cards.");
}

async function loadReportCard(
  sql: ReturnType<typeof getDb>,
  id: string,
): Promise<Record<string, unknown>> {
  const rows = await sql`
    SELECT
      card.id, card.template_level, card.learner_id, card.school_id, card.class_name,
      card.term, card.year, card.status, card.published_at, card.created_by,
      card.teacher_id, card.created_at,
      learner.name AS learner_name, learner.lin AS learner_lin,
      learner.gender AS learner_gender, learner.school_id AS learner_school_id,
      school.name AS school_name, school.logo AS school_logo,
      school.contact AS school_contact, school.location AS school_location,
      settings.term_dates, settings.fees,
      template.name AS template_name, template.description AS template_description,
      template.fields AS template_fields,
      comments.class_teacher_comment, comments.headteacher_comment,
      comments.principal_comment, comments.auto_comments
    FROM report_cards card
    INNER JOIN users learner ON learner.id = card.learner_id
    LEFT JOIN schools school ON school.id = card.school_id
    LEFT JOIN school_report_settings settings ON settings.school_id = card.school_id
    LEFT JOIN report_templates template ON template.level = card.template_level
    LEFT JOIN report_comments comments ON comments.report_card_id = card.id
    WHERE card.id = ${id}
    LIMIT 1
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new ApiError(404, "REPORT_CARD_NOT_FOUND", "Report card was not found.");
  return row;
}

async function getClassPosition(
  sql: ReturnType<typeof getDb>,
  card: Record<string, unknown>,
): Promise<number | null> {
  if (card.template_level !== "primary" || !card.learner_id) return null;
  const rows = await sql`
    SELECT ranked.class_position
    FROM (
      SELECT
        candidate.learner_id,
        RANK() OVER (ORDER BY AVG(mark.pct_100) DESC NULLS LAST)::int AS class_position
      FROM report_cards candidate
      LEFT JOIN report_marks mark ON mark.report_card_id = candidate.id
      WHERE candidate.class_name = ${card.class_name}
        AND candidate.term = ${card.term}
        AND candidate.year = ${card.year}
        AND candidate.school_id IS NOT DISTINCT FROM ${card.school_id}
      GROUP BY candidate.learner_id
    ) ranked
    WHERE ranked.learner_id = ${card.learner_id}
    LIMIT 1
  `;
  return rows[0] ? Number(rows[0].class_position) : null;
}

async function reportDetailResponse(
  sql: ReturnType<typeof getDb>,
  card: Record<string, unknown>,
) {
  const markRows = await sql`
    SELECT id, report_card_id, subject_code, subject_name, a1, a2, a3, avg,
      pct_20, eot, pct_80, pct_100, identifier, grade, remarks,
      teacher_initials, created_at
    FROM report_marks
    WHERE report_card_id = ${card.id}
    ORDER BY subject_name ASC
  `;
  const classPosition = await getClassPosition(sql, card);
  const {
    school_logo: _logo,
    ...safeCard
  } = card;
  return {
    report_card: { ...safeCard, class_position: classPosition },
    marks: markRows,
    comments: {
      class_teacher_comment: card.class_teacher_comment ?? null,
      headteacher_comment: card.headteacher_comment ?? null,
      principal_comment: card.principal_comment ?? null,
      auto_comments: card.auto_comments ?? [],
    },
    template: {
      level: card.template_level,
      name: card.template_name,
      description: card.template_description,
      fields: card.template_fields ?? {},
    },
  };
}

reportRoutes.get(
  "/report-templates",
  authMiddleware,
  educationAccess,
  async (c) => {
    const sql = getDb(c.env);
    const templates = await sql`
      SELECT id, name, level, description, fields, created_at
      FROM report_templates
      ORDER BY CASE level
        WHEN 'nursery' THEN 1
        WHEN 'primary' THEN 2
        WHEN 'o_level' THEN 3
        WHEN 'a_level' THEN 4
        ELSE 5
      END
    `;
    return c.json({ templates });
  },
);

reportRoutes.get(
  "/report-cards/learners",
  authMiddleware,
  educationAccess,
  requireRole(...STAFF_ROLES),
  async (c) => {
    const user = c.get("user");
    const className = queryText(c.req.query("class_name"), "class_name", 40);
    const requestedSchool = queryText(c.req.query("school_id"), "school_id", 60);
    const sql = getDb(c.env);
    let schoolId: string | null = null;
    let teacherClasses: string[] | null = null;

    if (user.role === "school") schoolId = linkedSchoolId(user);
    else if (user.role === "teacher") {
      const teacher = await requireTeacherScope(sql, user.id);
      teacherClasses = teacher.assigned_classes;
      if (teacher.school_id) schoolId = teacher.school_id;
      if (className && !teacherClasses.includes(className)) {
        throw new ApiError(403, "FORBIDDEN", "You can only view learners in your assigned classes.");
      }
    } else if (requestedSchool) {
      schoolId = routeUuid(requestedSchool, "school_id");
    }

    const learners = await sql`
      SELECT id, name, email, school_id, class_level, lin, gender
      FROM users
      WHERE role = 'individual'
        AND sector = 'education'
        AND (${schoolId === null} OR school_id = ${schoolId})
        AND (${className === null} OR class_level = ${className})
        AND (${teacherClasses === null} OR class_level = ANY(${teacherClasses}::text[]))
      ORDER BY class_level ASC NULLS LAST, name ASC
      LIMIT 2000
    `;
    return c.json({ learners });
  },
);

reportRoutes.post(
  "/report-cards/bulk",
  authMiddleware,
  educationAccess,
  requireRole(...STAFF_ROLES),
  async (c) => {
    const body = await readJson(c);
    const className = requiredString(body, "class_name", { max: 40 });
    const term = requiredString(body, "term", { max: 40 });
    const year = parseYear(body.year);
    const requestedSchool = optionalString(body, "school_id", { max: 60 });
    const user = c.get("user");
    const sql = getDb(c.env);
    let schoolId: string;

    if (user.role === "school") {
      schoolId = linkedSchoolId(user);
    } else if (user.role === "teacher") {
      const teacher = await requireTeacherScope(sql, user.id);
      if (!teacher.assigned_classes.includes(className)) {
        throw new ApiError(403, "FORBIDDEN", "You can only bulk-generate cards for assigned classes.");
      }
      if (!teacher.school_id) {
        throw new ApiError(403, "SCHOOL_NOT_LINKED", "A school-linked teacher account is required to bulk-generate cards.");
      }
      schoolId = teacher.school_id;
    } else {
      if (!requestedSchool) {
        throw new ApiError(400, "VALIDATION_ERROR", "school_id is required for superadmin bulk generation.");
      }
      schoolId = routeUuid(requestedSchool, "school_id");
    }

    const templateLevel = templateLevelForClass(className);
    if (!templateLevel) {
      throw new ApiError(400, "UNSUPPORTED_CLASS", "The selected class does not match a supported report-card template.");
    }
    const metadata = JSON.stringify({ class_name: className, term, year, school_id: schoolId });
    const rows = await sql`
      WITH inserted AS (
        INSERT INTO report_cards (
          template_level, learner_id, school_id, class_name, term, year,
          status, created_by, teacher_id
        )
        SELECT
          ${templateLevel}, learner.id, learner.school_id, learner.class_level,
          ${term}, ${year}, 'draft', ${user.id},
          CASE WHEN ${user.role === "teacher"} THEN ${user.id}::uuid ELSE NULL END
        FROM users learner
        WHERE learner.role = 'individual'
          AND learner.sector = 'education'
          AND learner.school_id = ${schoolId}
          AND learner.class_level = ${className}
        ON CONFLICT (learner_id, term, year) DO NOTHING
        RETURNING id, learner_id
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        VALUES (
          ${user.id}, 'education', 'report_cards.bulk_create', 'report_cards',
          NULL, ${metadata}::jsonb, ${requestIp(c.req.raw.headers)}
        )
        RETURNING id
      )
      SELECT inserted.id, inserted.learner_id
      FROM inserted
      CROSS JOIN audit
    `;
    const learnerRows = await sql`
      SELECT COUNT(*)::int AS count
      FROM users
      WHERE role = 'individual'
        AND sector = 'education'
        AND school_id = ${schoolId}
        AND class_level = ${className}
    `;
    return c.json(
      {
        created: rows.length,
        skipped: Math.max(0, Number(learnerRows[0]?.count ?? 0) - rows.length),
        card_ids: rows.map((row) => row.id),
      },
      201,
    );
  },
);

reportRoutes.post(
  "/report-cards/reset-download",
  authMiddleware,
  educationAccess,
  requireRole("school", "superadmin"),
  async (c) => {
    const body = await readJson(c);
    const cardId = routeUuid(requiredString(body, "report_card_id", { max: 50 }), "report_card_id");
    const studentId = routeUuid(requiredString(body, "student_id", { max: 50 }), "student_id");
    const user = c.get("user");
    const sql = getDb(c.env);
    const card = await loadReportCard(sql, cardId);
    if (user.role === "school" && linkedSchoolId(user) !== card.school_id) {
      throw new ApiError(403, "FORBIDDEN", "You can only reset downloads for your school's report cards.");
    }
    if (card.learner_id !== studentId) {
      throw new ApiError(400, "VALIDATION_ERROR", "student_id does not own this report card.");
    }
    const metadata = JSON.stringify({ student_id: studentId });
    const rows = await sql`
      WITH removed AS (
        DELETE FROM report_download_logs
        WHERE report_card_id = ${cardId}
          AND student_id = ${studentId}
        RETURNING id
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        VALUES (
          ${user.id}, 'education', 'report_card.download_reset', 'report_cards',
          ${cardId}, ${metadata}::jsonb, ${requestIp(c.req.raw.headers)}
        )
        RETURNING id
      )
      SELECT (SELECT COUNT(*)::int FROM removed) AS removed_count
      FROM audit
    `;
    return c.json({ message: "Student download access reset.", removed: Number(rows[0]?.removed_count ?? 0) });
  },
);

reportRoutes.get(
  "/report-cards",
  authMiddleware,
  educationAccess,
  requireRole(...STAFF_ROLES),
  async (c) => {
    const user = c.get("user");
    const className = queryText(c.req.query("class_name"), "class_name", 40);
    const term = queryText(c.req.query("term"), "term", 40);
    const year = optionalYear(c.req.query("year"));
    const statusValue = queryText(c.req.query("status"), "status", 20);
    if (statusValue && !["draft", "published", "all"].includes(statusValue)) {
      throw new ApiError(400, "VALIDATION_ERROR", "status must be draft, published, or all.");
    }
    const requestedSchool = queryText(c.req.query("school_id"), "school_id", 60);
    const sql = getDb(c.env);
    let schoolId: string | null = null;
    let teacherClasses: string[] | null = null;

    if (user.role === "school") schoolId = linkedSchoolId(user);
    else if (user.role === "teacher") {
      const teacher = await requireTeacherScope(sql, user.id);
      teacherClasses = teacher.assigned_classes;
      if (teacher.school_id) schoolId = teacher.school_id;
      if (className && !teacherClasses.includes(className)) {
        throw new ApiError(403, "FORBIDDEN", "You can only view report cards for assigned classes.");
      }
    } else if (requestedSchool) {
      schoolId = routeUuid(requestedSchool, "school_id");
    }

    const cards = await sql`
      SELECT
        card.id, card.template_level, card.learner_id, card.school_id, card.class_name,
        card.term, card.year, card.status, card.published_at, card.created_at,
        learner.name AS learner_name, learner.lin AS learner_lin,
        COALESCE(download.download_count, 0)::int AS download_count,
        (SELECT COUNT(*)::int FROM report_marks mark WHERE mark.report_card_id = card.id) AS mark_count
      FROM report_cards card
      INNER JOIN users learner ON learner.id = card.learner_id
      LEFT JOIN report_download_logs download
        ON download.report_card_id = card.id AND download.student_id = card.learner_id
      WHERE (${schoolId === null} OR card.school_id = ${schoolId})
        AND (${className === null} OR card.class_name = ${className})
        AND (${term === null} OR card.term = ${term})
        AND (${year === null} OR card.year = ${year})
        AND (${statusValue === null || statusValue === "all"} OR card.status = ${statusValue})
        AND (${teacherClasses === null} OR card.class_name = ANY(${teacherClasses}::text[]))
      ORDER BY card.year DESC, card.term ASC, card.class_name ASC, learner.name ASC
      LIMIT 2000
    `;
    return c.json({ report_cards: cards });
  },
);

reportRoutes.post(
  "/report-cards",
  authMiddleware,
  educationAccess,
  requireRole(...STAFF_ROLES),
  async (c) => {
    const body = await readJson(c);
    const templateLevel = requiredString(body, "template_level", { max: 20 }) as ReportTemplateLevel;
    if (!["nursery", "primary", "o_level", "a_level"].includes(templateLevel)) {
      throw new ApiError(400, "VALIDATION_ERROR", "template_level is not supported.");
    }
    const learnerId = routeUuid(requiredString(body, "learner_id", { max: 50 }), "learner_id");
    const className = requiredString(body, "class_name", { max: 40 });
    const term = requiredString(body, "term", { max: 40 });
    const year = parseYear(body.year);
    const user = c.get("user");
    const sql = getDb(c.env);
    const learner = await loadEducationLearner(sql, learnerId);

    if (!learner.class_level || learner.class_level !== className) {
      throw new ApiError(400, "CLASS_MISMATCH", "The selected learner is not in the requested class.");
    }
    if (templateLevelForClass(learner.class_level) !== templateLevel) {
      throw new ApiError(400, "TEMPLATE_MISMATCH", "The report template must match the learner's class.");
    }

    if (user.role === "school" && linkedSchoolId(user) !== learner.school_id) {
      throw new ApiError(403, "FORBIDDEN", "You can only create cards for learners in your school.");
    }
    if (user.role === "teacher") {
      const teacher = await requireTeacherScope(sql, user.id);
      assertTeacherCanAccessLearner(teacher, learner);
    }
    const duplicate = await sql`
      SELECT id FROM report_cards
      WHERE learner_id = ${learnerId} AND term = ${term} AND year = ${year}
      LIMIT 1
    `;
    if (duplicate[0]) {
      throw new ApiError(409, "DUPLICATE_REPORT_CARD", "A report card already exists for this learner, term, and year.");
    }

    const metadata = JSON.stringify({
      learner_id: learnerId,
      class_name: className,
      term,
      year,
      template_level: templateLevel,
    });
    const rows = await sql`
      WITH inserted AS (
        INSERT INTO report_cards (
          template_level, learner_id, school_id, class_name, term, year,
          status, created_by, teacher_id
        )
        VALUES (
          ${templateLevel}, ${learnerId}, ${learner.school_id}, ${learner.class_level},
          ${term}, ${year}, 'draft', ${user.id},
          CASE WHEN ${user.role === "teacher"} THEN ${user.id}::uuid ELSE NULL END
        )
        RETURNING id, template_level, learner_id, school_id, class_name, term,
          year, status, published_at, created_at
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'report_card.create', 'report_cards',
          inserted.id, ${metadata}::jsonb, ${requestIp(c.req.raw.headers)}
        FROM inserted
        RETURNING target_id
      )
      SELECT inserted.*
      FROM inserted
      INNER JOIN audit ON audit.target_id = inserted.id
    `;
    if (!rows[0]) throw new ApiError(500, "REPORT_CARD_CREATE_FAILED", "Could not create report card.");
    return c.json({ report_card: rows[0] }, 201);
  },
);

reportRoutes.get(
  "/my/report-cards",
  authMiddleware,
  educationAccess,
  requireRole("individual"),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const cards = await sql`
      SELECT
        card.id, card.template_level, card.class_name, card.term, card.year,
        card.status, card.published_at, card.created_at,
        template.name AS template_name,
        COALESCE(download.download_count, 0)::int AS download_count,
        (SELECT COUNT(*)::int FROM report_marks mark WHERE mark.report_card_id = card.id) AS mark_count
      FROM report_cards card
      LEFT JOIN report_templates template ON template.level = card.template_level
      LEFT JOIN report_download_logs download
        ON download.report_card_id = card.id AND download.student_id = ${user.id}
      WHERE card.learner_id = ${user.id}
        AND card.status = 'published'
      ORDER BY card.year DESC, card.term ASC, card.created_at DESC
    `;
    return c.json({ report_cards: cards });
  },
);

reportRoutes.get(
  "/report-cards/:id",
  authMiddleware,
  educationAccess,
  async (c) => {
    const user = c.get("user");
    const id = routeUuid(c.req.param("id"));
    const sql = getDb(c.env);
    const card = await loadReportCard(sql, id);
    if (user.role === "individual") {
      if (card.learner_id !== user.id || card.status !== "published") {
        throw new ApiError(404, "REPORT_CARD_NOT_FOUND", "Published report card was not found.");
      }
    } else {
      await assertStaffCanAccessCard(sql, user, {
        school_id: (card.school_id as string | null) ?? null,
        class_name: String(card.class_name),
      });
    }
    return c.json(await reportDetailResponse(sql, card));
  },
);

reportRoutes.post(
  "/report-cards/:id/marks",
  authMiddleware,
  educationAccess,
  requireRole(...STAFF_ROLES),
  async (c) => {
    const id = routeUuid(c.req.param("id"));
    const body = await readJson(c);
    const subjectName = requiredString(body, "subject_name", { max: 120 });
    const subjectCode = optionalString(body, "subject_code", { max: 30, allowNull: true });
    const teacherInitials = optionalString(body, "teacher_initials", { max: 12, allowNull: true });
    const user = c.get("user");
    const sql = getDb(c.env);
    const card = await loadReportCard(sql, id);
    if (card.status === "published") {
      throw new ApiError(409, "REPORT_CARD_PUBLISHED", "Published report cards are read-only.");
    }
    await assertStaffCanAccessCard(sql, user, {
      school_id: (card.school_id as string | null) ?? null,
      class_name: String(card.class_name),
    });
    const level = String(card.template_level) as ReportTemplateLevel;
    const nursery = level === "nursery";
    const a1 = nursery ? null : scoreValue(body.a1, "a1", true);
    const a2 = nursery ? null : scoreValue(body.a2, "a2", true);
    const a3 = nursery ? null : scoreValue(body.a3, "a3", true);
    const eot = scoreValue(body.eot ?? body.score, nursery ? "score" : "eot", true)!;
    const calculated = calculateReportMark(level, a1, a2, a3, eot);
    const ruleRows = await sql`
      SELECT comment FROM report_auto_rules
      WHERE level = ${level} AND grade_pattern = ${calculated.grade}
      ORDER BY priority DESC
      LIMIT 1
    `;
    const remarks =
      (ruleRows[0]?.comment as string | undefined) ??
      (calculated.grade === "A"
        ? "Excellent work. Keep it up."
        : calculated.grade === "B"
          ? "Good effort. Keep improving."
          : calculated.grade === "C"
            ? "More practice is recommended."
            : "Additional guided practice is recommended.");
    const metadata = JSON.stringify({
      report_card_id: id,
      subject_name: subjectName,
      grade: calculated.grade,
      pct_100: calculated.pct_100,
    });
    const rows = await sql`
      WITH upserted AS (
        INSERT INTO report_marks (
          report_card_id, subject_code, subject_name, a1, a2, a3, avg,
          pct_20, eot, pct_80, pct_100, identifier, grade, remarks,
          teacher_initials, teacher_id
        )
        VALUES (
          ${id}, ${subjectCode ?? null}, ${subjectName}, ${a1}, ${a2}, ${a3},
          ${calculated.avg}, ${calculated.pct_20}, ${eot}, ${calculated.pct_80},
          ${calculated.pct_100}, ${calculated.identifier}, ${calculated.grade},
          ${remarks}, ${teacherInitials ?? null},
          CASE WHEN ${user.role === "teacher"} THEN ${user.id}::uuid ELSE NULL END
        )
        ON CONFLICT (report_card_id, subject_name)
        DO UPDATE SET
          subject_code = EXCLUDED.subject_code,
          a1 = EXCLUDED.a1, a2 = EXCLUDED.a2, a3 = EXCLUDED.a3,
          avg = EXCLUDED.avg, pct_20 = EXCLUDED.pct_20, eot = EXCLUDED.eot,
          pct_80 = EXCLUDED.pct_80, pct_100 = EXCLUDED.pct_100,
          identifier = EXCLUDED.identifier, grade = EXCLUDED.grade,
          remarks = EXCLUDED.remarks, teacher_initials = EXCLUDED.teacher_initials,
          teacher_id = COALESCE(EXCLUDED.teacher_id, report_marks.teacher_id)
        RETURNING id, report_card_id, subject_code, subject_name, a1, a2, a3,
          avg, pct_20, eot, pct_80, pct_100, identifier, grade, remarks,
          teacher_initials, created_at
      ), card_teacher AS (
        UPDATE report_cards
        SET teacher_id = CASE WHEN ${user.role === "teacher"} THEN ${user.id}::uuid ELSE teacher_id END
        WHERE id = ${id}
        RETURNING id
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'report_card.mark_upsert', 'report_marks',
          upserted.id, ${metadata}::jsonb, ${requestIp(c.req.raw.headers)}
        FROM upserted
        RETURNING target_id
      )
      SELECT upserted.*
      FROM upserted
      INNER JOIN card_teacher ON card_teacher.id = upserted.report_card_id
      INNER JOIN audit ON audit.target_id = upserted.id
    `;
    return c.json({ mark: rows[0] }, 201);
  },
);

reportRoutes.post(
  "/report-cards/:id/comment",
  authMiddleware,
  educationAccess,
  requireRole(...STAFF_ROLES),
  async (c) => {
    const id = routeUuid(c.req.param("id"));
    const body = await readJson(c);
    const suppliedClassComment = optionalString(body, "class_teacher_comment", { max: 1200 });
    const headteacherComment = optionalString(body, "headteacher_comment", { max: 1200, allowNull: true });
    const principalComment = optionalString(body, "principal_comment", { max: 1200, allowNull: true });
    const user = c.get("user");
    const sql = getDb(c.env);
    const card = await loadReportCard(sql, id);
    if (card.status === "published") {
      throw new ApiError(409, "REPORT_CARD_PUBLISHED", "Published report cards are read-only.");
    }
    await assertStaffCanAccessCard(sql, user, {
      school_id: (card.school_id as string | null) ?? null,
      class_name: String(card.class_name),
    });
    const markRows = await sql`
      SELECT subject_name, grade, remarks, pct_100
      FROM report_marks
      WHERE report_card_id = ${id}
      ORDER BY subject_name
    `;
    const gradeCounts = new Map<string, number>();
    for (const row of markRows) {
      const grade = String(row.grade ?? "");
      if (grade) gradeCounts.set(grade, (gradeCounts.get(grade) ?? 0) + 1);
    }
    const averageScore =
      markRows.length > 0
        ? markRows.reduce((total, row) => total + Number(row.pct_100 ?? 0), 0) / markRows.length
        : null;
    const overallGrade =
      averageScore === null
        ? null
        : averageScore >= 80
          ? "A"
          : averageScore >= 70
            ? "B"
            : averageScore >= 60
              ? "C"
              : averageScore >= 50
                ? "D"
                : "E";
    const dominantGrade = [...gradeCounts.entries()].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )[0]?.[0];
    const automaticGrade = overallGrade ?? dominantGrade;
    let autoClassComment = "Marks have not been entered yet.";
    if (automaticGrade) {
      const rules = await sql`
        SELECT comment FROM report_auto_rules
        WHERE level = ${card.template_level} AND grade_pattern = ${automaticGrade}
        ORDER BY priority DESC
        LIMIT 1
      `;
      autoClassComment =
        (rules[0]?.comment as string | undefined) ??
        "Continue building on strengths and work steadily on areas that need improvement.";
    }
    const classTeacherComment =
      suppliedClassComment?.trim() || `Overall performance: ${autoClassComment}`;
    const autoComments = JSON.stringify(
      markRows.map((row) => ({
        subject_name: row.subject_name,
        grade: row.grade,
        comment: row.remarks,
      })),
    );
    const metadata = JSON.stringify({
      report_card_id: id,
      class_teacher_comment: classTeacherComment,
      headteacher_comment: headteacherComment ?? null,
      principal_comment: principalComment ?? null,
    });
    const rows = await sql`
      WITH upserted AS (
        INSERT INTO report_comments (
          report_card_id, class_teacher_comment, headteacher_comment,
          principal_comment, auto_comments, updated_at
        )
        VALUES (
          ${id}, ${classTeacherComment}, ${headteacherComment ?? null},
          ${principalComment ?? null}, ${autoComments}::jsonb, NOW()
        )
        ON CONFLICT (report_card_id)
        DO UPDATE SET
          class_teacher_comment = EXCLUDED.class_teacher_comment,
          headteacher_comment = EXCLUDED.headteacher_comment,
          principal_comment = EXCLUDED.principal_comment,
          auto_comments = EXCLUDED.auto_comments,
          updated_at = NOW()
        RETURNING id, report_card_id, class_teacher_comment, headteacher_comment,
          principal_comment, auto_comments, updated_at
      ), card_teacher AS (
        UPDATE report_cards
        SET teacher_id = CASE WHEN ${user.role === "teacher"} THEN ${user.id}::uuid ELSE teacher_id END
        WHERE id = ${id}
        RETURNING id
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'report_card.comment_upsert', 'report_comments',
          upserted.id, ${metadata}::jsonb, ${requestIp(c.req.raw.headers)}
        FROM upserted
        RETURNING target_id
      )
      SELECT upserted.*
      FROM upserted
      INNER JOIN card_teacher ON card_teacher.id = upserted.report_card_id
      INNER JOIN audit ON audit.target_id = upserted.id
    `;
    return c.json({ comments: rows[0] });
  },
);

reportRoutes.patch(
  "/report-cards/:id/publish",
  authMiddleware,
  educationAccess,
  requireRole(...STAFF_ROLES),
  async (c) => {
    const id = routeUuid(c.req.param("id"));
    const user = c.get("user");
    const sql = getDb(c.env);
    const card = await loadReportCard(sql, id);
    if (card.status === "published") {
      throw new ApiError(409, "REPORT_CARD_PUBLISHED", "This report card has already been published.");
    }
    await assertStaffCanAccessCard(sql, user, {
      school_id: (card.school_id as string | null) ?? null,
      class_name: String(card.class_name),
    });
    const marks = await sql`SELECT id FROM report_marks WHERE report_card_id = ${id} LIMIT 1`;
    if (!marks[0]) {
      throw new ApiError(409, "REPORT_CARD_EMPTY", "Add at least one subject mark before publishing.");
    }
    const metadata = JSON.stringify({ report_card_id: id });
    const rows = await sql`
      WITH updated AS (
        UPDATE report_cards
        SET status = 'published',
            published_at = COALESCE(published_at, NOW())
        WHERE id = ${id}
        RETURNING id, status, published_at
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'report_card.publish', 'report_cards',
          updated.id, ${metadata}::jsonb, ${requestIp(c.req.raw.headers)}
        FROM updated
        RETURNING target_id
      )
      SELECT updated.*
      FROM updated
      INNER JOIN audit ON audit.target_id = updated.id
    `;
    return c.json({ report_card: rows[0] });
  },
);

reportRoutes.get(
  "/report-cards/:id/pdf",
  authMiddleware,
  educationAccess,
  async (c) => {
    const user = c.get("user");
    const id = routeUuid(c.req.param("id"));
    const sql = getDb(c.env);
    const card = await loadReportCard(sql, id);
    const isStudentOwner = user.role === "individual" && card.learner_id === user.id;
    if (isStudentOwner) {
      if (card.status !== "published") {
        throw new ApiError(404, "REPORT_CARD_NOT_FOUND", "Published report card was not found.");
      }
      const previous = await sql`
        SELECT download_count
        FROM report_download_logs
        WHERE report_card_id = ${id} AND student_id = ${user.id}
        LIMIT 1
      `;
      if (Number(previous[0]?.download_count ?? 0) >= 1) {
        throw new ApiError(403, "ALREADY_DOWNLOADED", "Already downloaded. Contact admin.");
      }
    } else {
      await assertStaffCanAccessCard(sql, user, {
        school_id: (card.school_id as string | null) ?? null,
        class_name: String(card.class_name),
      });
    }

    const [markRows, signatureRows] = await Promise.all([
      sql`
        SELECT subject_code, subject_name, a1, a2, a3, avg, pct_20, eot,
          pct_80, pct_100, identifier, grade, remarks, teacher_initials
        FROM report_marks
        WHERE report_card_id = ${id}
        ORDER BY subject_name
      `,
      card.teacher_id
        ? sql`
            SELECT signature_image_url, signature_draw_base64
            FROM teacher_signatures
            WHERE teacher_id = ${card.teacher_id}
            LIMIT 1
          `
        : Promise.resolve([]),
    ]);
    const classPosition = await getClassPosition(sql, card);
    const report = {
      template_level: String(card.template_level),
      class_name: String(card.class_name),
      term: String(card.term),
      year: Number(card.year),
      learner_name: String(card.learner_name),
      learner_lin: (card.learner_lin as string | null) ?? null,
      learner_gender: (card.learner_gender as string | null) ?? null,
      school_name: String(card.school_name ?? "APSHULE"),
      school_contact: (card.school_contact as string | null) ?? null,
      school_location: (card.school_location as string | null) ?? null,
      term_dates: (card.term_dates as string | null) ?? null,
      fees: (card.fees as string | null) ?? null,
      class_position: classPosition,
    };
    const signature = signatureRows[0] as
      | { signature_image_url: string | null; signature_draw_base64: string | null }
      | undefined;
    const signatureSource = signature?.signature_draw_base64 ?? signature?.signature_image_url ?? null;
    const pdfData: ReportCardPdfData = {
      report,
      marks: markRows as ReportCardPdfData["marks"],
      comments: {
        class_teacher_comment: (card.class_teacher_comment as string | null) ?? null,
        headteacher_comment: (card.headteacher_comment as string | null) ?? null,
        principal_comment: (card.principal_comment as string | null) ?? null,
      },
      schoolLogo: await loadReportImage((card.school_logo as string | null) ?? null),
      teacherSignature: await loadReportImage(signatureSource),
    };
    const pdfBytes = await generateReportPDF(pdfData);

    if (isStudentOwner) {
      const logged = await sql`
        INSERT INTO report_download_logs (report_card_id, student_id, download_count, downloaded_at)
        VALUES (${id}, ${user.id}, 1, NOW())
        ON CONFLICT (report_card_id, student_id)
        DO UPDATE SET download_count = 1, downloaded_at = NOW()
        WHERE report_download_logs.download_count < 1
        RETURNING id
      `;
      if (!logged[0]) {
        throw new ApiError(403, "ALREADY_DOWNLOADED", "Already downloaded. Contact admin.");
      }
    }
    const filenameBase = `${report.learner_name}-${report.class_name}-${report.term}-${report.year}`
      .replace(/[^A-Za-z0-9_-]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
    const responseBytes = new ArrayBuffer(pdfBytes.byteLength);
    new Uint8Array(responseBytes).set(pdfBytes);
    return new Response(responseBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filenameBase || "report-card"}.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  },
);

reportRoutes.post(
  "/teacher/signature",
  authMiddleware,
  educationAccess,
  requireRole("teacher"),
  async (c) => {
    const body = await readJson(c);
    const rawSignature = optionalString(body, "signature_draw_base64", { max: 1_100_000, allowNull: true });
    const imageUrl = optionalString(body, "signature_image_url", { max: 2000, allowNull: true });
    if ((rawSignature ?? null) === null && (imageUrl ?? null) === null) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide a signature image or drawn signature.");
    }
    if (rawSignature && !rawSignature.startsWith("data:image/")) {
      throw new ApiError(422, "INVALID_IMAGE", "Drawn signatures must be PNG or JPEG data URLs.");
    }
    if (rawSignature) imageBytesFromBase64(rawSignature, 800_000);
    if (imageUrl) assertPublicHttpsUrl(imageUrl);
    const user = c.get("user");
    const sql = getDb(c.env);
    const metadata = JSON.stringify({ signature_kind: rawSignature ? "drawn_or_uploaded" : "url" });
    const rows = await sql`
      WITH upserted AS (
        INSERT INTO teacher_signatures (
          teacher_id, signature_image_url, signature_draw_base64, updated_at
        )
        VALUES (${user.id}, ${imageUrl ?? null}, ${rawSignature ?? null}, NOW())
        ON CONFLICT (teacher_id)
        DO UPDATE SET
          signature_image_url = EXCLUDED.signature_image_url,
          signature_draw_base64 = EXCLUDED.signature_draw_base64,
          updated_at = NOW()
        RETURNING teacher_id, signature_image_url, signature_draw_base64, updated_at
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'teacher.signature_upsert', 'teacher_signatures',
          user_row.id, ${metadata}::jsonb, ${requestIp(c.req.raw.headers)}
        FROM users user_row
        INNER JOIN upserted ON upserted.teacher_id = user_row.id
        RETURNING target_id
      )
      SELECT upserted.teacher_id, upserted.signature_image_url,
        upserted.signature_draw_base64, upserted.updated_at
      FROM upserted
      INNER JOIN audit ON audit.target_id = upserted.teacher_id
    `;
    return c.json({ signature: rows[0] });
  },
);

reportRoutes.get(
  "/teacher/signature",
  authMiddleware,
  educationAccess,
  requireRole("teacher"),
  async (c) => {
    const sql = getDb(c.env);
    const rows = await sql`
      SELECT teacher_id, signature_image_url, signature_draw_base64, updated_at
      FROM teacher_signatures
      WHERE teacher_id = ${c.get("user").id}
      LIMIT 1
    `;
    return c.json({ signature: rows[0] ?? null });
  },
);

reportRoutes.get(
  "/school/report-settings",
  authMiddleware,
  educationAccess,
  requireRole("school", "superadmin"),
  async (c) => {
    const user = c.get("user");
    const requestedSchool = queryText(c.req.query("school_id"), "school_id", 60);
    const schoolId =
      user.role === "school"
        ? linkedSchoolId(user)
        : requestedSchool
          ? routeUuid(requestedSchool, "school_id")
          : null;
    if (!schoolId) {
      throw new ApiError(400, "VALIDATION_ERROR", "school_id is required for superadmin.");
    }
    const sql = getDb(c.env);
    const rows = await sql`
      SELECT school_id, term_dates, fees, updated_by, updated_at
      FROM school_report_settings
      WHERE school_id = ${schoolId}
      LIMIT 1
    `;
    return c.json({
      settings: rows[0] ?? { school_id: schoolId, term_dates: null, fees: null },
    });
  },
);

reportRoutes.put(
  "/school/report-settings",
  authMiddleware,
  educationAccess,
  requireRole("school", "superadmin"),
  async (c) => {
    const body = await readJson(c);
    const termDates = optionalString(body, "term_dates", { max: 1200, allowNull: true });
    const fees = optionalString(body, "fees", { max: 1200, allowNull: true });
    if (termDates === undefined && fees === undefined) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide term_dates, fees, or both.");
    }
    const user = c.get("user");
    const requestedSchool = optionalString(body, "school_id", { max: 60 });
    const schoolId =
      user.role === "school"
        ? linkedSchoolId(user)
        : requestedSchool
          ? routeUuid(requestedSchool, "school_id")
          : null;
    if (!schoolId) {
      throw new ApiError(400, "VALIDATION_ERROR", "school_id is required for superadmin.");
    }
    const metadata = JSON.stringify({
      fields: [
        ...(termDates !== undefined ? ["term_dates"] : []),
        ...(fees !== undefined ? ["fees"] : []),
      ],
    });
    const sql = getDb(c.env);
    const rows = await sql`
      WITH upserted AS (
        INSERT INTO school_report_settings (school_id, term_dates, fees, updated_by, updated_at)
        VALUES (${schoolId}, ${termDates ?? null}, ${fees ?? null}, ${user.id}, NOW())
        ON CONFLICT (school_id)
        DO UPDATE SET
          term_dates = CASE WHEN ${termDates !== undefined} THEN ${termDates ?? null} ELSE school_report_settings.term_dates END,
          fees = CASE WHEN ${fees !== undefined} THEN ${fees ?? null} ELSE school_report_settings.fees END,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
        RETURNING school_id, term_dates, fees, updated_by, updated_at
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'school.report_settings_update',
          'school_report_settings', upserted.school_id, ${metadata}::jsonb,
          ${requestIp(c.req.raw.headers)}
        FROM upserted
        RETURNING target_id
      )
      SELECT upserted.*
      FROM upserted
      INNER JOIN audit ON audit.target_id = upserted.school_id
    `;
    return c.json({ settings: rows[0] });
  },
);

export default reportRoutes;