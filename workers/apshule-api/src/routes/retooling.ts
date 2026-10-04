import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { Hono } from "hono";
import { ApiError, getDb } from "../db.js";
import { authMiddleware, requireRealSuperAdmin, requireRole } from "../auth.js";
import { optionalString, readJson, requiredString } from "../http.js";
import {
  MAX_PRACTICAL_PHOTO_BASE64_CHARS,
  RetoolingValidationError,
  canCompleteRetoolingModule,
  gradeRetoolingQuiz,
  isValidPracticalPhotoBase64,
  validateQuizQuestionSet,
} from "../retooling-domain.js";
import type { RetoolingQuizQuestion } from "../retooling-domain.js";
import { requestIp, requiredInteger, routeUuid } from "../ncdc-helpers.js";
import type { AppEnv } from "../types.js";

const retoolingRoutes = new Hono<AppEnv>();

type RetoolingModule = {
  id: number;
  title: string;
  description: string | null;
  youtube_id: string | null;
  pdf_url: string | null;
  quiz_questions: unknown;
  pass_score: number;
  display_order: number;
  active: boolean;
};

type ModuleProgress = {
  module_started_at: string | null;
  pdf_read_at: string | null;
  quiz_score: number | null;
  quiz_passed: boolean;
  has_practical_photo: boolean;
  completed: boolean;
  certificate_issued: boolean;
  completed_at: string | null;
};

function moduleIdFromParam(value: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1 || id > 10) {
    throw new ApiError(400, "VALIDATION_ERROR", "moduleId must be an integer from 1 to 10.");
  }
  return id;
}

function validationError(error: unknown): ApiError {
  return new ApiError(
    400,
    "VALIDATION_ERROR",
    error instanceof RetoolingValidationError
      ? error.message
      : "The retooling course data is invalid.",
  );
}

function redactQuizQuestions(value: unknown): Array<{
  q: string;
  options: string[];
}> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const question = item as RetoolingQuizQuestion;
    return { q: question.q, options: question.options };
  });
}

function effectiveCompleted(
  module: Pick<RetoolingModule, "pdf_url">,
  progress: Partial<ModuleProgress> | null | undefined,
): boolean {
  if (!progress) return false;
  return (
    progress.completed === true &&
    canCompleteRetoolingModule({
      started: Boolean(progress.module_started_at),
      quizPassed: progress.quiz_passed === true,
      hasPracticalPhoto: progress.has_practical_photo === true,
      pdfConfigured: Boolean(module.pdf_url),
      pdfRead: Boolean(progress.pdf_read_at),
    })
  );
}

async function getModule(
  sql: ReturnType<typeof getDb>,
  moduleId: number,
  includeInactive = false,
): Promise<RetoolingModule> {
  const rows = await sql`
    SELECT id, title, description, youtube_id, pdf_url, quiz_questions,
           pass_score, display_order, active
    FROM retooling_modules
    WHERE id = ${moduleId}
      AND (${includeInactive} OR active IS TRUE)
    LIMIT 1
  `;
  if (!rows[0]) {
    throw new ApiError(404, "MODULE_NOT_FOUND", "This retooling module was not found.");
  }
  return rows[0] as RetoolingModule;
}

async function getProgress(
  sql: ReturnType<typeof getDb>,
  teacherId: string,
  moduleId: number,
): Promise<ModuleProgress | null> {
  const rows = await sql`
    SELECT module_started_at, pdf_read_at, quiz_score, quiz_passed,
           practical_photo_base64 IS NOT NULL AS has_practical_photo,
           completed, certificate_issued, completed_at
    FROM teacher_retooling_progress
    WHERE teacher_id = ${teacherId} AND module_id = ${moduleId}
    LIMIT 1
  `;
  return (rows[0] as ModuleProgress | undefined) ?? null;
}

async function toBase64(bytes: Uint8Array): Promise<string> {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function centerText(
  page: Awaited<ReturnType<PDFDocument["getPage"]>>,
  text: string,
  y: number,
  size: number,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  color = rgb(0.16, 0.13, 0.32),
) {
  const width = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: (page.getWidth() - width) / 2, y, size, font, color });
}

async function createCertificatePdf(
  teacherName: string,
  certificateNumber: string,
  issuedAt: Date,
): Promise<string> {
  const document = await PDFDocument.create();
  const page = document.addPage([841.89, 595.28]);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.16, 0.13, 0.32);
  const purple = rgb(0.29, 0.20, 0.60);
  const gold = rgb(0.79, 0.57, 0.18);
  const muted = rgb(0.36, 0.34, 0.40);
  const width = page.getWidth();
  const height = page.getHeight();
  page.drawRectangle({
    x: 22,
    y: 22,
    width: width - 44,
    height: height - 44,
    borderColor: purple,
    borderWidth: 2,
  });
  page.drawRectangle({
    x: 30,
    y: 30,
    width: width - 60,
    height: height - 60,
    borderColor: gold,
    borderWidth: 0.7,
  });
  centerText(page, "APSHULE · Continuous Professional Development", 508, 23, bold, purple);
  centerText(page, "CERTIFICATE OF COMPLETION", 440, 16, bold, gold);
  centerText(page, "This certifies that", 389, 15, regular, muted);
  centerText(page, teacherName.slice(0, 100), 345, 31, bold, ink);
  centerText(
    page,
    "has successfully completed the NCDC 10-Module Teacher Retooling Course",
    301,
    15,
    regular,
    muted,
  );
  centerText(page, "20 CPD points", 263, 15, bold, purple);
  const dateText = new Intl.DateTimeFormat("en-UG", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(issuedAt);
  centerText(page, `Issued ${dateText}`, 222, 12, regular, muted);
  centerText(page, `Certificate Number: ${certificateNumber}`, 195, 12, bold, ink);

  page.drawLine({
    start: { x: 120, y: 110 },
    end: { x: 330, y: 110 },
    thickness: 1,
    color: muted,
  });
  page.drawLine({
    start: { x: width - 330, y: 110 },
    end: { x: width - 120, y: 110 },
    thickness: 1,
    color: muted,
  });
  page.drawText("APSHULE", { x: 190, y: 88, size: 10, font: bold, color: purple });
  page.drawText("Continuous Professional Development", {
    x: width - 300,
    y: 88,
    size: 10,
    font: regular,
    color: purple,
  });
  return toBase64(await document.save());
}

async function issueCertificateIfEligible(
  sql: ReturnType<typeof getDb>,
  teacherId: string,
  actorId: string,
  ip: string | null,
): Promise<{ certificate_number: string; issued_at: string; revoked: boolean } | null> {
  const eligibility = await sql`
    SELECT COUNT(DISTINCT module.id)::int AS eligible_count
    FROM retooling_modules AS module
    INNER JOIN teacher_retooling_progress AS progress
      ON progress.module_id = module.id
     AND progress.teacher_id = ${teacherId}
    WHERE module.id BETWEEN 1 AND 10
      AND progress.completed IS TRUE
      AND progress.module_started_at IS NOT NULL
      AND progress.quiz_passed IS TRUE
      AND progress.practical_photo_base64 IS NOT NULL
      AND (module.pdf_url IS NULL OR progress.pdf_read_at IS NOT NULL)
  `;
  if (Number(eligibility[0]?.eligible_count ?? 0) !== 10) return null;

  const existing = await sql`
    SELECT certificate_number, issued_at, revoked
    FROM cpd_certificates
    WHERE teacher_id = ${teacherId}
    LIMIT 1
  `;
  if (existing[0]) {
    await sql`
      UPDATE teacher_retooling_progress
      SET certificate_issued = TRUE,
          certificate_url = '/api/teacher/retooling/certificate',
          updated_at = NOW()
      WHERE teacher_id = ${teacherId}
        AND module_id BETWEEN 1 AND 10
    `;
    return existing[0] as {
      certificate_number: string;
      issued_at: string;
      revoked: boolean;
    };
  }

  const teachers = await sql`
    SELECT name
    FROM users
    WHERE id = ${teacherId} AND role = 'teacher'
    LIMIT 1
  `;
  if (!teachers[0]) {
    throw new ApiError(404, "TEACHER_NOT_FOUND", "The teacher account was not found.");
  }
  const sequenceRows = await sql`SELECT nextval('cpd_certificate_number_seq')::int AS value`;
  const issuedAt = new Date();
  const certificateNumber =
    `CPD-${issuedAt.getUTCFullYear()}-${String(sequenceRows[0].value).padStart(6, "0")}`;
  const pdfBase64 = await createCertificatePdf(
    String(teachers[0].name ?? "Teacher"),
    certificateNumber,
    issuedAt,
  );
  const metadata = JSON.stringify({
    teacher_id: teacherId,
    certificate_number: certificateNumber,
    points: 20,
  });
  const inserted = await sql`
    WITH certificate AS (
      INSERT INTO cpd_certificates (
        teacher_id, certificate_number, issued_at, pdf_base64, points
      )
      VALUES (
        ${teacherId}, ${certificateNumber}, ${issuedAt.toISOString()}, ${pdfBase64}, 20
      )
      ON CONFLICT (teacher_id) DO NOTHING
      RETURNING id, certificate_number, issued_at, revoked
    ), audit AS (
      INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
      SELECT ${actorId}, 'education', 'cpd_certificate.issue',
             'cpd_certificates', certificate.id, ${metadata}::jsonb, ${ip}
      FROM certificate
      RETURNING target_id
    )
    SELECT certificate.*
    FROM certificate
    INNER JOIN audit ON audit.target_id = certificate.id
  `;
  const finalRows = inserted.length
    ? inserted
    : await sql`
        SELECT certificate_number, issued_at, revoked
        FROM cpd_certificates
        WHERE teacher_id = ${teacherId}
        LIMIT 1
      `;
  if (!finalRows[0]) return null;

  await sql`
    UPDATE teacher_retooling_progress
    SET certificate_issued = TRUE,
        certificate_url = '/api/teacher/retooling/certificate',
        updated_at = NOW()
    WHERE teacher_id = ${teacherId}
      AND module_id BETWEEN 1 AND 10
  `;
  return finalRows[0] as {
    certificate_number: string;
    issued_at: string;
    revoked: boolean;
  };
}

retoolingRoutes.get(
  "/retooling-modules",
  authMiddleware,
  requireRole("teacher", "school", "superadmin"),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const teacherId = user.role === "teacher" ? user.id : null;
    const rows = await sql`
      SELECT module.id, module.title, module.description, module.youtube_id,
             module.pdf_url, module.pass_score, module.display_order,
             module.active,
             CASE WHEN ${user.role === "superadmin"}
               THEN module.quiz_questions ELSE NULL END AS quiz_questions,
             progress.module_started_at, progress.pdf_read_at,
             progress.quiz_score, progress.quiz_passed,
             progress.practical_photo_base64 IS NOT NULL AS has_practical_photo,
             progress.completed, progress.certificate_issued, progress.completed_at
      FROM retooling_modules AS module
      LEFT JOIN teacher_retooling_progress AS progress
        ON progress.teacher_id = ${teacherId}
       AND progress.module_id = module.id
      WHERE module.active IS TRUE
      ORDER BY module.display_order ASC, module.id ASC
    `;
    const modules = rows.map((row) => {
      const module = row as RetoolingModule & ModuleProgress;
      return {
        ...module,
        completed: effectiveCompleted(module, module),
      };
    });
    return c.json({ modules });
  },
);

retoolingRoutes.get(
  "/retooling-modules/:id",
  authMiddleware,
  requireRole("teacher", "superadmin"),
  async (c) => {
    const user = c.get("user");
    const id = moduleIdFromParam(c.req.param("id"));
    const sql = getDb(c.env);
    const module = await getModule(sql, id, user.role === "superadmin");
    const progress = user.role === "teacher"
      ? await getProgress(sql, user.id, id)
      : null;
    const safeQuestions = user.role === "superadmin"
      ? module.quiz_questions
      : redactQuizQuestions(module.quiz_questions);
    return c.json({
      module: {
        ...module,
        quiz_questions: safeQuestions,
        progress: {
          ...(progress ?? {
            module_started_at: null,
            pdf_read_at: null,
            quiz_score: null,
            quiz_passed: false,
            has_practical_photo: false,
            completed: false,
            certificate_issued: false,
            completed_at: null,
          }),
          completed: effectiveCompleted(module, progress),
        },
      },
    });
  },
);

retoolingRoutes.patch(
  "/retooling-modules/:id",
  authMiddleware,
  requireRealSuperAdmin(),
  async (c) => {
    const id = moduleIdFromParam(c.req.param("id"));
    const body = await readJson(c);
    const fields = [
      "title",
      "description",
      "youtube_id",
      "pdf_url",
      "quiz_questions",
      "pass_score",
    ] as const;
    const changedFields = fields.filter((field) => field in body);
    if (changedFields.length === 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one module field to update.");
    }

    const has = Object.fromEntries(
      fields.map((field) => [field, field in body]),
    ) as Record<(typeof fields)[number], boolean>;
    let title: string | null = null;
    let description: string | null | undefined;
    let youtubeId: string | null | undefined;
    let pdfUrl: string | null | undefined;
    let quizQuestions: RetoolingQuizQuestion[] | null = null;
    let passScore: number | null = null;
    if (has.title) title = requiredString(body, "title", { max: 160 });
    if (has.description) {
      description = optionalString(body, "description", { max: 2000, allowNull: true }) ?? null;
    }
    if (has.youtube_id) {
      youtubeId = optionalString(body, "youtube_id", { max: 11, allowNull: true }) || null;
      if (youtubeId && !/^[A-Za-z0-9_-]{11}$/u.test(youtubeId)) {
        throw new ApiError(400, "VALIDATION_ERROR", "youtube_id must be an 11-character YouTube video ID.");
      }
    }
    if (has.pdf_url) {
      pdfUrl = optionalString(body, "pdf_url", { max: 2048, allowNull: true }) || null;
      if (pdfUrl) {
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(pdfUrl);
        } catch {
          throw new ApiError(400, "VALIDATION_ERROR", "pdf_url must be an absolute HTTP or HTTPS URL.");
        }
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          throw new ApiError(400, "VALIDATION_ERROR", "pdf_url must use HTTP or HTTPS.");
        }
      }
    }
    if (has.quiz_questions) {
      try {
        quizQuestions = validateQuizQuestionSet(body.quiz_questions, true);
      } catch (error) {
        throw validationError(error);
      }
    }
    if (has.pass_score) {
      passScore = requiredInteger(body, "pass_score", { min: 1, max: 100 });
    }

    const sql = getDb(c.env);
    const user = c.get("user");
    const metadata = JSON.stringify({ module_id: id, changed_fields: changedFields });
    const rows = await sql`
      WITH updated AS (
        UPDATE retooling_modules
        SET title = CASE WHEN ${has.title} THEN ${title} ELSE title END,
            description = CASE WHEN ${has.description} THEN ${description ?? null}::text ELSE description END,
            youtube_id = CASE WHEN ${has.youtube_id} THEN ${youtubeId ?? null}::text ELSE youtube_id END,
            pdf_url = CASE WHEN ${has.pdf_url} THEN ${pdfUrl ?? null}::text ELSE pdf_url END,
            quiz_questions = CASE WHEN ${has.quiz_questions}
              THEN ${quizQuestions === null ? null : JSON.stringify(quizQuestions)}::jsonb
              ELSE quiz_questions END,
            pass_score = CASE WHEN ${has.pass_score} THEN ${passScore} ELSE pass_score END
        WHERE id = ${id}
        RETURNING id, title, description, youtube_id, pdf_url,
                  quiz_questions, pass_score, display_order, active
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, metadata, ip)
        SELECT ${user.id}, 'education', 'retooling_module.update',
               'retooling_modules', ${metadata}::jsonb, ${requestIp(c.req.raw.headers)}
        FROM updated
        RETURNING id
      )
      SELECT updated.*
      FROM updated
      CROSS JOIN audit
    `;
    if (!rows[0]) {
      throw new ApiError(404, "MODULE_NOT_FOUND", "This retooling module was not found.");
    }
    return c.json({ module: rows[0] });
  },
);

retoolingRoutes.post(
  "/teacher/retooling/:moduleId/start",
  authMiddleware,
  requireRole("teacher"),
  async (c) => {
    const id = moduleIdFromParam(c.req.param("moduleId"));
    const sql = getDb(c.env);
    await getModule(sql, id);
    const user = c.get("user");
    const metadata = JSON.stringify({ module_id: id });
    const rows = await sql`
      WITH updated AS (
        INSERT INTO teacher_retooling_progress (
          teacher_id, module_id, completed, module_started_at
        )
        VALUES (${user.id}, ${id}, FALSE, NOW())
        ON CONFLICT (teacher_id, module_id)
        DO UPDATE SET
          module_started_at = COALESCE(
            teacher_retooling_progress.module_started_at,
            NOW()
          ),
          updated_at = NOW()
        RETURNING id, teacher_id, module_id, module_started_at, pdf_read_at,
                  quiz_score, quiz_passed,
                  practical_photo_base64 IS NOT NULL AS has_practical_photo,
                  completed, certificate_issued, completed_at
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'teacher_retooling.started',
               'teacher_retooling_progress', updated.id, ${metadata}::jsonb,
               ${requestIp(c.req.raw.headers)}
        FROM updated
        RETURNING target_id
      )
      SELECT updated.*
      FROM updated
      INNER JOIN audit ON audit.target_id = updated.id
    `;
    const certificate = await issueCertificateIfEligible(
      sql,
      user.id,
      user.id,
      requestIp(c.req.raw.headers),
    );
    return c.json({ progress: rows[0], certificate });
  },
);

retoolingRoutes.post(
  "/teacher/retooling/:moduleId/pdf-read",
  authMiddleware,
  requireRole("teacher"),
  async (c) => {
    const id = moduleIdFromParam(c.req.param("moduleId"));
    const sql = getDb(c.env);
    const module = await getModule(sql, id);
    if (!module.pdf_url) {
      throw new ApiError(400, "PDF_NOT_CONFIGURED", "This module does not have a PDF summary yet.");
    }
    const user = c.get("user");
    const rows = await sql`
      UPDATE teacher_retooling_progress
      SET pdf_read_at = COALESCE(pdf_read_at, NOW()),
          completed = quiz_passed IS TRUE
            AND practical_photo_base64 IS NOT NULL
            AND module_started_at IS NOT NULL,
          completed_at = CASE
            WHEN quiz_passed IS TRUE
              AND practical_photo_base64 IS NOT NULL
              AND module_started_at IS NOT NULL
              THEN COALESCE(completed_at, NOW())
            ELSE NULL
          END,
          updated_at = NOW()
      WHERE teacher_id = ${user.id}
        AND module_id = ${id}
        AND module_started_at IS NOT NULL
      RETURNING module_started_at, pdf_read_at, quiz_score, quiz_passed,
                practical_photo_base64 IS NOT NULL AS has_practical_photo,
                completed, certificate_issued, completed_at
    `;
    if (!rows[0]) {
      throw new ApiError(409, "MODULE_NOT_STARTED", "Mark the video as watched before recording the PDF review.");
    }
    const certificate = await issueCertificateIfEligible(
      sql,
      user.id,
      user.id,
      requestIp(c.req.raw.headers),
    );
    return c.json({ progress: rows[0], certificate });
  },
);

retoolingRoutes.post(
  "/teacher/retooling/:moduleId/quiz",
  authMiddleware,
  requireRole("teacher"),
  async (c) => {
    const id = moduleIdFromParam(c.req.param("moduleId"));
    const body = await readJson(c);
    const sql = getDb(c.env);
    const module = await getModule(sql, id);
    let questions: RetoolingQuizQuestion[];
    let result: ReturnType<typeof gradeRetoolingQuiz>;
    try {
      questions = validateQuizQuestionSet(module.quiz_questions);
      result = gradeRetoolingQuiz(questions, body.answers);
    } catch (error) {
      throw validationError(error);
    }
    const user = c.get("user");
    const progress = await getProgress(sql, user.id, id);
    if (!progress?.module_started_at) {
      throw new ApiError(409, "MODULE_NOT_STARTED", "Mark the video as watched before taking the quiz.");
    }
    if (module.pdf_url && !progress.pdf_read_at) {
      throw new ApiError(409, "PDF_NOT_REVIEWED", "Open the PDF summary and record that you have reviewed it first.");
    }
    const passed = result.score >= module.pass_score;
    const metadata = JSON.stringify({
      module_id: id,
      score: result.score,
      passed,
    });
    const rows = await sql`
      WITH updated AS (
        UPDATE teacher_retooling_progress
        SET quiz_answers = ${JSON.stringify(result.passableAnswers)}::jsonb,
            quiz_score = ${result.score},
            quiz_passed = ${passed},
            completed = ${passed}
              AND practical_photo_base64 IS NOT NULL
              AND module_started_at IS NOT NULL
              AND (${!module.pdf_url} OR pdf_read_at IS NOT NULL),
            completed_at = CASE
              WHEN ${passed}
                AND practical_photo_base64 IS NOT NULL
                AND module_started_at IS NOT NULL
                AND (${!module.pdf_url} OR pdf_read_at IS NOT NULL)
                THEN COALESCE(completed_at, NOW())
              ELSE NULL
            END,
            updated_at = NOW()
        WHERE teacher_id = ${user.id} AND module_id = ${id}
        RETURNING id, teacher_id, module_id, module_started_at, pdf_read_at,
                  quiz_score, quiz_passed,
                  practical_photo_base64 IS NOT NULL AS has_practical_photo,
                  completed, certificate_issued, completed_at
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'teacher_retooling.quiz_submitted',
               'teacher_retooling_progress', updated.id, ${metadata}::jsonb,
               ${requestIp(c.req.raw.headers)}
        FROM updated
        RETURNING target_id
      )
      SELECT updated.*
      FROM updated
      INNER JOIN audit ON audit.target_id = updated.id
    `;
    if (!rows[0]) {
      throw new ApiError(409, "MODULE_NOT_STARTED", "Start this module before submitting a quiz.");
    }
    const certificate = await issueCertificateIfEligible(
      sql,
      user.id,
      user.id,
      requestIp(c.req.raw.headers),
    );
    return c.json({
      score: result.score,
      pass: passed,
      correct_answers: result.correctAnswers,
      progress: rows[0],
      certificate,
    });
  },
);

retoolingRoutes.post(
  "/teacher/retooling/:moduleId/practical",
  authMiddleware,
  requireRole("teacher"),
  async (c) => {
    const id = moduleIdFromParam(c.req.param("moduleId"));
    const body = await readJson(c);
    const photo = body.photo_base64;
    if (!isValidPracticalPhotoBase64(photo)) {
      throw new ApiError(
        400,
        "INVALID_PRACTICAL_PHOTO",
        `photo_base64 must be a PNG, JPEG, or WebP data URL no longer than ${MAX_PRACTICAL_PHOTO_BASE64_CHARS.toLocaleString()} characters (500 KB base64).`,
      );
    }
    const sql = getDb(c.env);
    const module = await getModule(sql, id);
    const user = c.get("user");
    const current = await getProgress(sql, user.id, id);
    if (!current?.module_started_at) {
      throw new ApiError(409, "MODULE_NOT_STARTED", "Mark the video as watched before submitting practical evidence.");
    }
    if (current.quiz_passed !== true) {
      throw new ApiError(409, "QUIZ_NOT_PASSED", "Pass the module quiz before submitting practical evidence.");
    }
    if (module.pdf_url && !current.pdf_read_at) {
      throw new ApiError(409, "PDF_NOT_REVIEWED", "Review the PDF summary before submitting practical evidence.");
    }
    const metadata = JSON.stringify({
      module_id: id,
      photo_base64_chars: photo.length,
    });
    const rows = await sql`
      WITH updated AS (
        UPDATE teacher_retooling_progress
        SET practical_photo_base64 = ${photo},
            practical_upload_path = 'base64',
            completed = quiz_passed IS TRUE
              AND module_started_at IS NOT NULL
              AND (${!module.pdf_url} OR pdf_read_at IS NOT NULL),
            completed_at = CASE
              WHEN quiz_passed IS TRUE
                AND module_started_at IS NOT NULL
                AND (${!module.pdf_url} OR pdf_read_at IS NOT NULL)
                THEN COALESCE(completed_at, NOW())
              ELSE NULL
            END,
            updated_at = NOW()
        WHERE teacher_id = ${user.id} AND module_id = ${id}
        RETURNING id, teacher_id, module_id, module_started_at, pdf_read_at,
                  quiz_score, quiz_passed,
                  practical_photo_base64 IS NOT NULL AS has_practical_photo,
                  completed, certificate_issued, completed_at
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'teacher_retooling.practical_submitted',
               'teacher_retooling_progress', updated.id, ${metadata}::jsonb,
               ${requestIp(c.req.raw.headers)}
        FROM updated
        RETURNING target_id
      )
      SELECT updated.*
      FROM updated
      INNER JOIN audit ON audit.target_id = updated.id
    `;
    if (!rows[0]) {
      throw new ApiError(409, "MODULE_NOT_STARTED", "Start this module before submitting practical evidence.");
    }
    const certificate = await issueCertificateIfEligible(
      sql,
      user.id,
      user.id,
      requestIp(c.req.raw.headers),
    );
    return c.json({
      completed: effectiveCompleted(module, rows[0] as ModuleProgress),
      progress: rows[0],
      certificate,
    });
  },
);

retoolingRoutes.get(
  "/teacher/retooling/certificate",
  authMiddleware,
  requireRole("teacher"),
  async (c) => {
    const user = c.get("user");
    const sql = getDb(c.env);
    const rows = await sql`
      SELECT id, certificate_number, issued_at, revoked, revoked_at,
             revoke_reason, pdf_base64, points
      FROM cpd_certificates
      WHERE teacher_id = ${user.id}
      LIMIT 1
    `;
    if (!rows[0]) {
      throw new ApiError(404, "CERTIFICATE_NOT_FOUND", "Your CPD certificate has not been issued yet.");
    }
    return c.json({ certificate: rows[0] });
  },
);

retoolingRoutes.get(
  "/superadmin/cpd-certificates",
  authMiddleware,
  requireRealSuperAdmin(),
  async (c) => {
    const search = optionalString(
      { search: c.req.query("search") ?? "" },
      "search",
      { max: 200 },
    ) || null;
    const revokedParam = c.req.query("revoked");
    if (revokedParam && revokedParam !== "true" && revokedParam !== "false") {
      throw new ApiError(400, "VALIDATION_ERROR", "revoked must be true or false.");
    }
    const page = Number(c.req.query("page") ?? "1");
    const pageSize = Number(c.req.query("page_size") ?? "20");
    if (!Number.isInteger(page) || page < 1) {
      throw new ApiError(400, "VALIDATION_ERROR", "page must be a positive integer.");
    }
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new ApiError(400, "VALIDATION_ERROR", "page_size must be between 1 and 100.");
    }
    const sql = getDb(c.env);
    const revoked = revokedParam === undefined ? null : revokedParam === "true";
    const likeSearch = search ? `%${search}%` : null;
    const offset = (page - 1) * pageSize;
    const [rows, totals] = await Promise.all([
      sql`
        SELECT certificate.id, certificate.certificate_number, certificate.issued_at,
               certificate.revoked, certificate.revoked_at, certificate.revoke_reason,
               certificate.points, teacher.id AS teacher_id,
               teacher.name AS teacher_name, teacher.email AS teacher_email
        FROM cpd_certificates AS certificate
        INNER JOIN users AS teacher ON teacher.id = certificate.teacher_id
        WHERE (${revoked}::boolean IS NULL OR certificate.revoked = ${revoked})
          AND (
            ${likeSearch}::text IS NULL
            OR teacher.name ILIKE ${likeSearch}
            OR teacher.email ILIKE ${likeSearch}
            OR certificate.certificate_number ILIKE ${likeSearch}
          )
        ORDER BY certificate.issued_at DESC, certificate.id ASC
        LIMIT ${pageSize} OFFSET ${offset}
      `,
      sql`
        SELECT COUNT(*)::int AS total
        FROM cpd_certificates AS certificate
        INNER JOIN users AS teacher ON teacher.id = certificate.teacher_id
        WHERE (${revoked}::boolean IS NULL OR certificate.revoked = ${revoked})
          AND (
            ${likeSearch}::text IS NULL
            OR teacher.name ILIKE ${likeSearch}
            OR teacher.email ILIKE ${likeSearch}
            OR certificate.certificate_number ILIKE ${likeSearch}
          )
      `,
    ]);
    const total = Number(totals[0]?.total ?? 0);
    return c.json({
      certificates: rows,
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: Math.ceil(total / pageSize),
      },
    });
  },
);

retoolingRoutes.get(
  "/superadmin/cpd-certificates/:id",
  authMiddleware,
  requireRealSuperAdmin(),
  async (c) => {
    const id = routeUuid(c.req.param("id"), "certificate_id");
    const sql = getDb(c.env);
    const rows = await sql`
      SELECT certificate.id, certificate.certificate_number, certificate.issued_at,
             certificate.revoked, certificate.pdf_base64, certificate.points,
             teacher.name AS teacher_name, teacher.email AS teacher_email
      FROM cpd_certificates AS certificate
      INNER JOIN users AS teacher ON teacher.id = certificate.teacher_id
      WHERE certificate.id = ${id}::uuid
      LIMIT 1
    `;
    if (!rows[0]) {
      throw new ApiError(404, "CERTIFICATE_NOT_FOUND", "The CPD certificate was not found.");
    }
    return c.json({ certificate: rows[0] });
  },
);

retoolingRoutes.post(
  "/superadmin/cpd-certificates/:id/revoke",
  authMiddleware,
  requireRealSuperAdmin(),
  async (c) => {
    const id = routeUuid(c.req.param("id"), "certificate_id");
    const body = await readJson(c);
    const reason = requiredString(body, "reason", { max: 1000 });
    const user = c.get("user");
    const sql = getDb(c.env);
    const metadata = JSON.stringify({ reason });
    const rows = await sql`
      WITH revoked AS (
        UPDATE cpd_certificates
        SET revoked = TRUE, revoked_at = NOW(), revoke_reason = ${reason}
        WHERE id = ${id} AND revoked IS FALSE
        RETURNING id, teacher_id, certificate_number, revoked_at, revoke_reason
      ), audit AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata, ip)
        SELECT ${user.id}, 'education', 'cpd_certificate.revoke',
               'cpd_certificates', revoked.id, ${metadata}::jsonb,
               ${requestIp(c.req.raw.headers)}
        FROM revoked
        RETURNING target_id
      )
      SELECT revoked.*
      FROM revoked
      INNER JOIN audit ON audit.target_id = revoked.id
    `;
    if (!rows[0]) {
      const existing = await sql`
        SELECT revoked
        FROM cpd_certificates
        WHERE id = ${id}
        LIMIT 1
      `;
      if (!existing[0]) {
        throw new ApiError(404, "CERTIFICATE_NOT_FOUND", "The CPD certificate was not found.");
      }
      throw new ApiError(409, "CERTIFICATE_REVOKED", "This certificate has already been revoked.");
    }
    return c.json({ certificate: rows[0] });
  },
);

retoolingRoutes.get("/cpd-certificates/:number/verify", async (c) => {
  const number = c.req.param("number");
  if (!/^CPD-\d{4}-\d{6}$/u.test(number)) {
    return c.json({ valid: false });
  }
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT teacher.name AS name, certificate.issued_at
    FROM cpd_certificates AS certificate
    INNER JOIN users AS teacher ON teacher.id = certificate.teacher_id
    WHERE certificate.certificate_number = ${number}
      AND certificate.revoked IS FALSE
    LIMIT 1
  `;
  if (!rows[0]) return c.json({ valid: false });
  return c.json({
    valid: true,
    name: rows[0].name,
    issued_at: rows[0].issued_at,
    certificate_number: number,
  });
});

export default retoolingRoutes;