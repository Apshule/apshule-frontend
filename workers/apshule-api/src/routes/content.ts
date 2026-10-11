import { Hono } from "hono";
import { ApiError, getDb, isUniqueViolation } from "../db.js";
import { authMiddleware, requireRealSuperAdmin, requireRole } from "../auth.js";
import { optionalString, readJson, requiredString } from "../http.js";
import { detectDocKind } from "../document-kind.js";
import type { AppEnv } from "../types.js";

const content = new Hono<AppEnv>();

function normalizePdfClassLevel(value: string | null | undefined): string {
  return value?.trim() || "unassigned";
}

function normalizePdfCoverColor(value: string | null | undefined): string {
  const color = value?.trim() || "#FF8C42";
  if (!/^#[0-9a-f]{6}$/iu.test(color)) {
    throw new ApiError(400, "VALIDATION_ERROR", "cover_color must be a six-digit hex color.");
  }
  return color;
}

function normalizePdfDisplayOrder(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 2147483647
  ) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "display_order must be a non-negative 32-bit integer.",
    );
  }
  return value;
}

const PDF_CATEGORIES = [
  { code: "lesson_notes", name: "Lesson Notes", icon: "📖" },
  { code: "past_papers", name: "Past Papers", icon: "📝" },
  { code: "holiday_packages", name: "Holiday Packages", icon: "🎒" },
  { code: "schemes_of_work", name: "Schemes of Work", icon: "📋" },
  { code: "revision", name: "Revision", icon: "🔁" },
  { code: "topical", name: "Topical", icon: "📊" },
  { code: "pre_ple", name: "Pre-PLE", icon: "🎯" },
  { code: "other", name: "Other", icon: "📄" },
] as const;

function normalizePdfCategory(value: string | null | undefined): string {
  const category = value?.trim() || "lesson_notes";
  if (!PDF_CATEGORIES.some((item) => item.code === category)) {
    throw new ApiError(400, "VALIDATION_ERROR", "category is not supported.");
  }
  return category;
}

function normalizePdfSubjectCode(value: string | null | undefined, subjectName?: string | null): string | null {
  const source = value?.trim() || subjectName?.trim() || "";
  if (!source) return null;
  const code = source.toLocaleLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 120);
  if (!code) throw new ApiError(400, "VALIDATION_ERROR", "subject_code must contain letters or numbers.");
  return code;
}

function normalizePdfSortOrder(value: unknown): number {
  return normalizePdfDisplayOrder(value);
}

function validatePdfUrl(url: string): string {
  try {
    const parsedUrl = new URL(url);
    if (
      (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") ||
      !parsedUrl.hostname ||
      parsedUrl.username ||
      parsedUrl.password
    ) {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", "url must be an absolute HTTP or HTTPS URL.");
  }
  return url;
}

function isDirectHttpsPdfUrl(url: string | null): url is string {
  if (!url) return false;
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "https:" && parsedUrl.pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

content.get("/pdfs", async (c) => {
  const sql = getDb(c.env);
  const requestedClassLevel = c.req.query("class_level")?.trim();
  if (requestedClassLevel && requestedClassLevel.length > 30) {
    throw new ApiError(400, "VALIDATION_ERROR", "class_level must be no longer than 30 characters.");
  }
  const requestedCategory = c.req.query("category")?.trim() || null;
  const requestedSubject = c.req.query("subject")?.trim().toLocaleLowerCase() || null;
  if (requestedCategory) normalizePdfCategory(requestedCategory);
  if (requestedSubject && requestedSubject.length > 120) {
    throw new ApiError(400, "VALIDATION_ERROR", "subject must be no longer than 120 characters.");
  }
  const rows = await sql`
    SELECT id, title, url, doc_kind, class_level, category, subject, subject_code,
           cover_color, display_order, sort_order, storage_type, file_size, mime_type,
           resolve_status, resolve_reason, resolved_at, created_at
    FROM pdfs
    WHERE (${requestedClassLevel}::text IS NULL OR class_level = ${requestedClassLevel})
      AND (${requestedCategory}::text IS NULL OR category = ${requestedCategory})
      AND (
        ${requestedSubject}::text IS NULL
        OR (${requestedSubject} = 'uncategorized' AND subject_code IS NULL AND NULLIF(trim(subject), '') IS NULL)
        OR lower(COALESCE(subject_code, regexp_replace(trim(subject), '[^a-zA-Z0-9]+', '_', 'g'))) = ${requestedSubject}
        OR lower(trim(subject)) = ${requestedSubject}
      )
    ORDER BY sort_order ASC, display_order ASC, created_at DESC
  `;
  return c.json({ pdfs: rows });
});

content.get("/pdfs/categories", async (c) => {
  const sql = getDb(c.env);
  const classLevel = c.req.query("class_level")?.trim() || null;
  if (classLevel && classLevel.length > 30) {
    throw new ApiError(400, "VALIDATION_ERROR", "class_level must be no longer than 30 characters.");
  }
  const rows = await sql`
    SELECT category AS code, COUNT(*)::int AS count
    FROM pdfs
    WHERE (${classLevel}::text IS NULL OR class_level = ${classLevel})
    GROUP BY category
  `;
  const counts = new Map((rows as Array<{ code: string; count: number }>).map((row) => [row.code, row.count]));
  const isP7 = /^(p7|primary 7)$/iu.test(classLevel || "");
  return c.json({
    categories: PDF_CATEGORIES
      .filter((category) => category.code !== "pre_ple" || isP7)
      .map((category) => ({ ...category, count: counts.get(category.code) ?? 0 })),
  });
});

content.get("/pdfs/subjects", async (c) => {
  const sql = getDb(c.env);
  const classLevel = c.req.query("class_level")?.trim() || null;
  const category = c.req.query("category")?.trim() || null;
  if (classLevel && classLevel.length > 30) {
    throw new ApiError(400, "VALIDATION_ERROR", "class_level must be no longer than 30 characters.");
  }
  if (category) normalizePdfCategory(category);
  const rows = await sql`
    SELECT COALESCE(subject_code, lower(regexp_replace(trim(subject), '[^a-zA-Z0-9]+', '_', 'g'))) AS subject_code,
           MIN(NULLIF(trim(subject), '')) AS subject_name,
           COUNT(*)::int AS count
    FROM pdfs
    WHERE (${classLevel}::text IS NULL OR class_level = ${classLevel})
      AND (${category}::text IS NULL OR category = ${category})
      AND (subject_code IS NOT NULL OR NULLIF(trim(subject), '') IS NOT NULL)
    GROUP BY COALESCE(subject_code, lower(regexp_replace(trim(subject), '[^a-zA-Z0-9]+', '_', 'g')))
    ORDER BY subject_name NULLS LAST, subject_code
  `;
  const subjects = (rows as Array<{ subject_code: string; subject_name: string | null; count: number }>).map((row) => ({
      ...row,
      subject_name: row.subject_name || row.subject_code.replaceAll("_", " "),
    }));
  const unassigned = await sql`
    SELECT COUNT(*)::int AS count
    FROM pdfs
    WHERE (${classLevel}::text IS NULL OR class_level = ${classLevel})
      AND (${category}::text IS NULL OR category = ${category})
      AND subject_code IS NULL AND NULLIF(trim(subject), '') IS NULL
  `;
  if (Number(unassigned[0]?.count ?? 0) > 0) {
    subjects.push({ subject_code: "uncategorized", subject_name: "General", count: Number(unassigned[0].count) });
  }
  return c.json({ subjects });
});

content.post("/pdfs", authMiddleware, requireRole("superadmin"), async (c) => {
  const body = await readJson(c);
  const title = requiredString(body, "title", { max: 200 });
  const url = validatePdfUrl(requiredString(body, "url", { max: 2048 }));
  const docKind = detectDocKind(url);
  const classLevel = normalizePdfClassLevel(
    optionalString(body, "class_level", { max: 30, allowNull: true }),
  );
  const subject = optionalString(body, "subject", { max: 120, allowNull: true });
  const subjectCode = normalizePdfSubjectCode(
    optionalString(body, "subject_code", { max: 120, allowNull: true }),
    subject,
  );
  const category = normalizePdfCategory(optionalString(body, "category", { max: 40, allowNull: true }));
  const coverColor = normalizePdfCoverColor(
    optionalString(body, "cover_color", { max: 20, allowNull: true }),
  );
  const displayOrder = normalizePdfDisplayOrder(body.display_order);
  const sortOrder = normalizePdfSortOrder(body.sort_order ?? body.display_order);
  const sql = getDb(c.env);
  const rows = await sql`
    INSERT INTO pdfs (title, url, doc_kind, class_level, category, subject, subject_code, cover_color, display_order, sort_order)
    VALUES (${title}, ${url}, ${docKind}, ${classLevel}, ${category}, ${subject}, ${subjectCode}, ${coverColor}, ${displayOrder}, ${sortOrder})
    RETURNING id, title, url, doc_kind, class_level, category, subject, subject_code, cover_color, display_order, sort_order,
              resolve_status, resolve_reason, resolved_at, created_at
  `;
  return c.json({ pdf: rows[0] }, 201);
});

content.get("/pdfs/:id", authMiddleware, requireRealSuperAdmin(), async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, title, url, resolved_pdf_url, doc_kind, class_level, category, cover_color,
           display_order, sort_order, subject, subject_code, storage_type, r2_key, file_size, mime_type,
           resolve_status, resolve_reason, resolved_at, created_at
    FROM pdfs
    WHERE id = ${c.req.param("id")}
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(404, "PDF_NOT_FOUND", "Document was not found.");
  return c.json({ pdf: rows[0] });
});

content.patch("/pdfs/:id", authMiddleware, requireRole("superadmin"), async (c) => {
  const body = await readJson(c);
  const editableFields = ["title", "url", "class_level", "category", "subject", "subject_code", "cover_color", "display_order", "sort_order"] as const;
  if (!editableFields.some((field) => field in body)) {
    throw new ApiError(400, "VALIDATION_ERROR", "Provide at least one PDF field to update.");
  }

  const hasTitle = "title" in body;
  const hasUrl = "url" in body;
  const hasClassLevel = "class_level" in body;
  const hasCategory = "category" in body;
  const hasSubject = "subject" in body;
  const hasSubjectCode = "subject_code" in body;
  const hasCoverColor = "cover_color" in body;
  const hasDisplayOrder = "display_order" in body;
  const hasSortOrder = "sort_order" in body;
  const title = hasTitle ? requiredString(body, "title", { max: 200 }) : null;
  const url = hasUrl ? validatePdfUrl(requiredString(body, "url", { max: 2048 })) : null;
  const docKind = hasUrl ? detectDocKind(url) : null;
  const directPdf = hasUrl && isDirectHttpsPdfUrl(url);
  const classLevel = hasClassLevel
    ? normalizePdfClassLevel(optionalString(body, "class_level", { max: 30, allowNull: true }))
    : null;
  const subject = hasSubject ? optionalString(body, "subject", { max: 120, allowNull: true }) : null;
  const subjectCode = hasSubjectCode || hasSubject
    ? normalizePdfSubjectCode(
      hasSubjectCode ? optionalString(body, "subject_code", { max: 120, allowNull: true }) : null,
      subject,
    )
    : null;
  const category = hasCategory
    ? normalizePdfCategory(optionalString(body, "category", { max: 40, allowNull: true }))
    : null;
  const coverColor = hasCoverColor
    ? normalizePdfCoverColor(optionalString(body, "cover_color", { max: 20, allowNull: true }))
    : null;
  const displayOrder = hasDisplayOrder ? normalizePdfDisplayOrder(body.display_order) : null;
  const sortOrder = hasSortOrder ? normalizePdfSortOrder(body.sort_order) : null;
  const sql = getDb(c.env);
  const rows = await sql`
    UPDATE pdfs
    SET title = CASE WHEN ${hasTitle} THEN ${title} ELSE title END,
        url = CASE WHEN ${hasUrl} THEN ${url} ELSE url END,
        doc_kind = CASE WHEN ${directPdf} THEN 'pdf' WHEN ${hasUrl} THEN ${docKind} ELSE doc_kind END,
        resolved_pdf_url = CASE WHEN ${hasUrl} THEN ${directPdf ? url : null} ELSE resolved_pdf_url END,
        resolve_status = CASE WHEN ${hasUrl} THEN ${directPdf ? "resolved" : "unresolved"} ELSE resolve_status END,
        resolve_reason = CASE WHEN ${hasUrl} THEN NULL ELSE resolve_reason END,
        resolved_at = CASE WHEN ${hasUrl} THEN CASE WHEN ${directPdf} THEN NOW() ELSE NULL END ELSE resolved_at END,
        class_level = CASE WHEN ${hasClassLevel} THEN ${classLevel} ELSE class_level END,
        category = CASE WHEN ${hasCategory} THEN ${category} ELSE category END,
        subject = CASE WHEN ${hasSubject} THEN ${subject} ELSE subject END,
        subject_code = CASE WHEN ${hasSubjectCode || hasSubject} THEN ${subjectCode} ELSE subject_code END,
        cover_color = CASE WHEN ${hasCoverColor} THEN ${coverColor} ELSE cover_color END,
        display_order = CASE WHEN ${hasDisplayOrder} THEN ${displayOrder} ELSE display_order END,
        sort_order = CASE WHEN ${hasSortOrder} THEN ${sortOrder} ELSE sort_order END
     WHERE id = ${c.req.param("id")}
       AND (NOT ${hasUrl} OR COALESCE(storage_type, 'url') <> 'r2')
     RETURNING id, title, url, resolved_pdf_url, doc_kind, class_level, category, subject, subject_code, cover_color, display_order, sort_order,
              resolve_status, resolve_reason, resolved_at, created_at
  `;
  if (!rows[0]) {
    const existing = await sql`
      SELECT storage_type FROM pdfs WHERE id = ${c.req.param("id")} LIMIT 1
    `;
    if (hasUrl && (existing[0] as { storage_type?: string } | undefined)?.storage_type === "r2") {
      throw new ApiError(
        409,
        "R2_FILE_IMMUTABLE",
        "Upload a replacement file through the document upload flow instead.",
      );
    }
    throw new ApiError(404, "PDF_NOT_FOUND", "Document was not found.");
  }
  return c.json({ pdf: rows[0] });
});

content.delete("/pdfs/:id", authMiddleware, requireRole("superadmin"), async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, storage_type, r2_key FROM pdfs WHERE id = ${c.req.param("id")} LIMIT 1
  `;
  const row = rows[0] as { id: string; storage_type?: string | null; r2_key?: string | null } | undefined;
  if (!row) throw new ApiError(404, "PDF_NOT_FOUND", "Document was not found.");
  if (row.storage_type === "r2") {
    if (!row.r2_key || !c.env.DOCS_BUCKET) {
      throw new ApiError(503, "R2_NOT_CONFIGURED", "Document storage is not configured.");
    }
    await c.env.DOCS_BUCKET.delete(row.r2_key);
  }
  await sql`DELETE FROM pdfs WHERE id = ${row.id}`;
  return c.json({ message: "Document deleted.", id: row.id });
});

content.get("/video-mappings", async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`SELECT key, youtube_id FROM video_mappings ORDER BY key`;
  const mappings: Record<string, string> = {};
  for (const row of rows as Array<{ key: string; youtube_id: string }>) {
    mappings[row.key] = row.youtube_id;
  }
  return c.json(mappings);
});

content.get(
  "/video-mappings/admin",
  authMiddleware,
  requireRealSuperAdmin(),
  async (c) => {
    const sql = getDb(c.env);
    const [mappings, teachers] = await Promise.all([
      sql`
        SELECT vm.key, vm.subject, vm.class_key, vm.youtube_id, vm.teacher_id,
          teacher.name AS teacher_name
        FROM video_mappings vm
        LEFT JOIN users teacher ON teacher.id = vm.teacher_id
        ORDER BY vm.key
      `,
      sql`
        SELECT id, name, email
        FROM users
        WHERE role = 'teacher' AND sector = 'education'
        ORDER BY name, email
      `,
    ]);
    return c.json({ mappings, teachers });
  },
);

content.post("/video-mappings", authMiddleware, requireRealSuperAdmin(), async (c) => {
  const body = await readJson(c);
  const key = requiredString(body, "key", { max: 160 });
  const subject = requiredString(body, "subject", { max: 120 });
  const classKey = requiredString(body, "classKey", { max: 120 });
  const youtubeId = requiredString(body, "youtubeId", { max: 40 });
  if (!/^[A-Za-z0-9_-]{6,40}$/u.test(youtubeId)) {
    throw new ApiError(400, "VALIDATION_ERROR", "youtubeId is not a valid YouTube video identifier.");
  }
  const hasTeacherId = Object.hasOwn(body, "teacherId");
  const teacherId = hasTeacherId
    ? optionalString(body, "teacherId", { max: 36, allowNull: true }) ?? null
    : null;
  if (teacherId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(teacherId)) {
    throw new ApiError(400, "VALIDATION_ERROR", "teacherId must be a valid UUID or null.");
  }
  const sql = getDb(c.env);
  if (teacherId) {
    const teachers = await sql`
      SELECT id FROM users
      WHERE id = ${teacherId}::uuid AND role = 'teacher' AND sector = 'education'
      LIMIT 1
    `;
    if (!teachers[0]) {
      throw new ApiError(400, "INVALID_TEACHER", "teacherId must identify an Education teacher.");
    }
  }
  try {
    const rows = await sql`
      WITH saved AS (
        INSERT INTO video_mappings (key, subject, class_key, youtube_id, teacher_id)
        VALUES (${key}, ${subject}, ${classKey}, ${youtubeId}, ${teacherId}::uuid)
        ON CONFLICT (key) DO UPDATE
        SET subject = EXCLUDED.subject,
            class_key = EXCLUDED.class_key,
            youtube_id = EXCLUDED.youtube_id,
            teacher_id = CASE WHEN ${hasTeacherId}
              THEN EXCLUDED.teacher_id ELSE video_mappings.teacher_id END
        RETURNING id, key, subject, class_key, youtube_id, teacher_id, created_at
      ),
      logged AS (
        INSERT INTO audit_log (actor_id, sector, action, target_table, target_id, metadata)
        SELECT ${c.get("user").id}, 'education', 'video_mapping.owner_updated',
          'video_mappings', saved.id,
          jsonb_build_object('lesson_key', saved.key, 'teacher_id', saved.teacher_id)
        FROM saved
      )
      SELECT saved.id, saved.key, saved.subject, saved.class_key, saved.youtube_id,
        saved.teacher_id, teacher.name AS teacher_name, saved.created_at
      FROM saved
      LEFT JOIN users teacher ON teacher.id = saved.teacher_id
    `;
    return c.json({ mapping: rows[0] }, 201);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ApiError(409, "MAPPING_CONFLICT", "A mapping already exists for this key.");
    }
    throw error;
  }
});

content.get("/subjects", async (c) => {
  const sql = getDb(c.env);
  const rows = await sql`SELECT level, list FROM subjects ORDER BY level`;
  const result: { nursery: string[]; primary: string[]; secondary: string[] } = {
    nursery: [],
    primary: [],
    secondary: [],
  };
  for (const row of rows as Array<{ level: string; list: string[] }>) {
    if (row.level === "nursery" || row.level === "primary" || row.level === "secondary") {
      result[row.level] = row.list;
    }
  }
  return c.json(result);
});

content.put(
  "/subjects/:level",
  authMiddleware,
  requireRole("superadmin"),
  async (c) => {
    const level = c.req.param("level");
    if (level !== "nursery" && level !== "primary" && level !== "secondary") {
      throw new ApiError(400, "VALIDATION_ERROR", "level must be nursery, primary, or secondary.");
    }
    const body = await readJson(c);
    const subjects = body.subjects;
    if (
      !Array.isArray(subjects) ||
      subjects.length > 100 ||
      subjects.some(
        (subject) =>
          typeof subject !== "string" ||
          !subject.trim() ||
          subject.trim().length > 120,
      )
    ) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "subjects must be an array of up to 100 non-empty strings.",
      );
    }
    const uniqueSubjects = [...new Set(subjects.map((subject) => (subject as string).trim()))];
    const sql = getDb(c.env);
    const rows = await sql`
      INSERT INTO subjects (level, list)
      VALUES (${level}, ${uniqueSubjects})
      ON CONFLICT (level) DO UPDATE SET list = EXCLUDED.list
      RETURNING level, list
    `;
    return c.json({ [level]: (rows[0] as { list: string[] }).list });
  },
);

content.get("/feedbacks", authMiddleware, requireRole("superadmin"), async (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ApiError(400, "VALIDATION_ERROR", "limit must be a positive integer.");
  }
  const boundedLimit = Math.min(limit, 200);
  const sql = getDb(c.env);
  const rows = await sql`
    SELECT id, lesson, rating, comment, user_name, user_email, timestamp
    FROM feedbacks
    ORDER BY timestamp DESC
    LIMIT ${boundedLimit}
  `;
  return c.json({ feedbacks: rows });
});

content.post("/feedbacks", async (c) => {
  const body = await readJson(c);
  const lesson = optionalString(body, "lesson", { max: 200 }) ?? null;
  const comment = optionalString(body, "comment", { max: 4000 }) ?? null;
  const userName = optionalString(body, "userName", { max: 120 }) ?? null;
  const userEmail = optionalString(body, "userEmail", { max: 254 })?.toLowerCase() ?? null;
  let rating: number | null = null;
  if (body.rating !== undefined && body.rating !== null) {
    if (!Number.isInteger(body.rating) || Number(body.rating) < 1 || Number(body.rating) > 5) {
      throw new ApiError(400, "VALIDATION_ERROR", "rating must be an integer from 1 to 5.");
    }
    rating = Number(body.rating);
  }
  const sql = getDb(c.env);
  const rows = await sql`
    INSERT INTO feedbacks (lesson, rating, comment, user_name, user_email)
    VALUES (${lesson}, ${rating}, ${comment}, ${userName}, ${userEmail})
    RETURNING id, lesson, rating, comment, user_name, user_email, timestamp
  `;
  return c.json({ feedback: rows[0] }, 201);
});

content.get(
  "/video-views/stats",
  authMiddleware,
  requireRealSuperAdmin(),
  async (c) => {
    const sql = getDb(c.env);
    const [totals, bySubject, byClass] = await Promise.all([
      sql`SELECT COUNT(*)::int AS total FROM video_views`,
      sql`
        SELECT subject, COUNT(*)::int AS views
        FROM video_views
        GROUP BY subject
        ORDER BY views DESC, subject ASC
      `,
      sql`
        SELECT class_id, class_name, COUNT(*)::int AS views
        FROM video_views
        GROUP BY class_id, class_name
        ORDER BY views DESC, class_name ASC
      `,
    ]);
    return c.json({
      total: (totals[0] as { total: number } | undefined)?.total ?? 0,
      bySubject,
      byClass,
    });
  },
);

export default content;